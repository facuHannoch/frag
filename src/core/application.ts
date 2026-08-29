import { readFile } from "node:fs/promises";

import { EstimateTokenCounter } from "./chunking.js";
import { parseFragConfig, resolveConfiguredEnvironment } from "./config.js";
import { CollectionUnreachableError } from "./errors.js";
import { embeddingFingerprint } from "./hash.js";
import type { FragControlPlane } from "./global-registry.js";
import { IngestService } from "./ingest.js";
import { PostgresDatabase } from "./postgres/database.js";
import { PostgresSourceStore } from "./postgres/source-store.js";
import { bootstrapSchema, acquireSourceLock } from "./postgres/sql.js";
import { PostgresStateStore } from "./postgres/state-store.js";
import { PostgresVectorStore } from "./postgres/vector-store.js";
import { EndpointTokenCounter, OpenAICompatibleEmbedder, TiktokenCounter } from "./providers.js";
import { FragRegistry, type CollectionRuntime, type UnreachableCollection } from "./registry.js";
import { ReindexService } from "./reindex.js";
import { SearchService, type SearchLogger } from "./search.js";
import { MirrorFanout, TransferService, type TransferEndpoint } from "./transfer.js";
import type { FragConfig, ReindexResult, Source, TokenCounter, TransferResult } from "./types.js";

export interface FragApplicationOptions {
  readonly allowedCollections?: Iterable<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly logger?: SearchLogger;
}

export class FragApplication {
  readonly registry: FragRegistry;
  readonly #endpoints: ReadonlyMap<string, TransferEndpoint>;
  readonly #reindex: ReadonlyMap<string, ReindexService>;
  readonly #databases: readonly PostgresDatabase[];
  readonly #unreachable: ReadonlyMap<string, string>;

  constructor(input: {
    registry: FragRegistry;
    endpoints: ReadonlyMap<string, TransferEndpoint>;
    reindex: ReadonlyMap<string, ReindexService>;
    databases: readonly PostgresDatabase[];
    unreachable?: ReadonlyMap<string, string>;
  }) {
    this.registry = input.registry;
    this.#endpoints = input.endpoints;
    this.#reindex = input.reindex;
    this.#databases = input.databases;
    this.#unreachable = input.unreachable ?? new Map();
  }

  async listSources(collection: string): Promise<Source[]> {
    return this.#endpoint(collection).sourceStore.list(collection);
  }

  async reindex(collection: string, dryRun = false): Promise<ReindexResult> {
    const service = this.#reindex.get(collection);
    if (service === undefined) this.#unknown(collection);
    return service.reindex({ dryRun });
  }

  async promote(
    sourceCollection: string,
    targetCollection: string,
    sourceKey: string,
    targetSourceKey?: string,
  ): Promise<TransferResult> {
    return new TransferService().promote(
      this.#endpoint(sourceCollection),
      this.#endpoint(targetCollection),
      sourceKey,
      targetSourceKey,
    );
  }

  async remove(collection: string, sourceKey: string): Promise<void> {
    const endpoint = this.#endpoint(collection);
    await endpoint.transactional.withTransaction(async (tx) => {
      await acquireSourceLock(tx, endpoint.lockNamespace, collection, sourceKey);
      await endpoint.stateStore.deleteTargetReceipt(tx, collection, sourceKey);
      await endpoint.sourceStore.delete(tx, collection, sourceKey);
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.#databases.map((database) => database.close()));
  }

  #endpoint(collection: string): TransferEndpoint {
    const endpoint = this.#endpoints.get(collection);
    if (endpoint === undefined) this.#unknown(collection);
    return endpoint;
  }

  #unknown(collection: string): never {
    const reason = this.#unreachable.get(collection);
    if (reason !== undefined) throw new CollectionUnreachableError(collection, reason);
    throw new RangeError(`Unknown collection: ${collection}`);
  }
}

function tokenCounter(
  kind: string,
  baseUrl: string,
  apiKey: string | null,
): TokenCounter {
  if (kind === "estimate") return new EstimateTokenCounter();
  if (kind === "tiktoken") return new TiktokenCounter();
  return new EndpointTokenCounter(baseUrl, apiKey);
}

function emptyConfig(): FragConfig {
  return { dbs: new Map(), embedders: new Map(), collections: new Map() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createFragApplication(
  config: FragConfig,
  options: FragApplicationOptions = {},
): Promise<FragApplication> {
  const environment = options.environment ?? process.env;

  // Each database and embedder is resolved independently so that one
  // unreachable dependency does not block every other collection: the
  // affected collections are marked unreachable below instead of throwing.
  const databaseErrors = new Map<string, string>();
  const databaseUrls = new Map<string, string>();
  for (const database of config.dbs.values()) {
    try {
      const resolved = resolveConfiguredEnvironment(
        { ...emptyConfig(), dbs: new Map([[database.name, database]]) },
        environment,
      );
      databaseUrls.set(database.name, resolved.databaseUrls.get(database.name)!);
    } catch (error) {
      databaseErrors.set(database.name, errorMessage(error));
    }
  }

  const embedderErrors = new Map<string, string>();
  const embedderBaseUrls = new Map<string, string>();
  const embedderApiKeys = new Map<string, string | null>();
  for (const embedder of config.embedders.values()) {
    try {
      const resolved = resolveConfiguredEnvironment(
        { ...emptyConfig(), embedders: new Map([[embedder.name, embedder]]) },
        environment,
      );
      embedderBaseUrls.set(embedder.name, resolved.embedderBaseUrls.get(embedder.name)!);
      embedderApiKeys.set(embedder.name, resolved.embedderApiKeys.get(embedder.name)!);
    } catch (error) {
      embedderErrors.set(embedder.name, errorMessage(error));
    }
  }

  const databases = new Map<string, PostgresDatabase>();
  for (const [name, url] of databaseUrls) {
    databases.set(name, new PostgresDatabase(url));
  }
  try {
    for (const database of config.dbs.values()) {
      if (databaseErrors.has(database.name)) continue;
      const dimensions = [...config.collections.values()]
        .filter(
          (collection) =>
            collection.db === database.name && !embedderErrors.has(collection.embedder),
        )
        .map((collection) => config.embedders.get(collection.embedder)!.dim);
      if (dimensions.length === 0) continue;
      try {
        await bootstrapSchema(databases.get(database.name)!, dimensions);
      } catch (error) {
        databaseErrors.set(database.name, errorMessage(error));
      }
    }

    const endpoints = new Map<string, TransferEndpoint>();
    const unreachable: UnreachableCollection[] = [];
    for (const collection of config.collections.values()) {
      const reason = databaseErrors.get(collection.db) ?? embedderErrors.get(collection.embedder);
      if (reason !== undefined) {
        unreachable.push({ config: collection, reason });
        continue;
      }
      const embedderConfig = config.embedders.get(collection.embedder)!;
      const database = databases.get(collection.db)!;
      const baseUrl = embedderBaseUrls.get(embedderConfig.name)!;
      const apiKey = embedderApiKeys.get(embedderConfig.name)!;
      endpoints.set(collection.name, {
        collection,
        embedderConfig,
        embedder: new OpenAICompatibleEmbedder(embedderConfig, baseUrl, apiKey),
        tokenCounter: tokenCounter(embedderConfig.tokenCounter, baseUrl, apiKey),
        sourceStore: new PostgresSourceStore(database),
        vectorStore: new PostgresVectorStore(database),
        stateStore: new PostgresStateStore(database),
        transactional: database,
        lockNamespace: collection.db,
      });
    }

    const runtimes: CollectionRuntime[] = [];
    const reindex = new Map<string, ReindexService>();
    for (const endpoint of endpoints.values()) {
      const search = new SearchService({
        collection: endpoint.collection,
        embedderConfig: endpoint.embedderConfig,
        embedder: endpoint.embedder,
        tokenCounter: endpoint.tokenCounter,
        sourceStore: endpoint.sourceStore,
        vectorStore: endpoint.vectorStore,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      const ingest = new IngestService({
        collection: endpoint.collection,
        embedderConfig: endpoint.embedderConfig,
        embedder: endpoint.embedder,
        tokenCounter: endpoint.tokenCounter,
        sourceStore: endpoint.sourceStore,
        vectorStore: endpoint.vectorStore,
        transactional: endpoint.transactional,
        lockNamespace: endpoint.lockNamespace,
        mirrors: new MirrorFanout(endpoint, endpoints),
      });
      runtimes.push({ config: endpoint.collection, search, ingest });
      reindex.set(
        endpoint.collection.name,
        new ReindexService({
          collection: endpoint.collection,
          embedderConfig: endpoint.embedderConfig,
          embedder: endpoint.embedder,
          tokenCounter: endpoint.tokenCounter,
          sourceStore: endpoint.sourceStore,
          vectorStore: endpoint.vectorStore,
          transactional: endpoint.transactional,
          lockNamespace: endpoint.lockNamespace,
        }),
      );
    }
    const registry = new FragRegistry(runtimes, {
      ...(options.allowedCollections === undefined
        ? {}
        : { allowedCollections: options.allowedCollections }),
      unreachable,
    });
    await registry.inspectCollections();
    return new FragApplication({
      registry,
      endpoints,
      reindex,
      databases: [...databases.values()],
      unreachable: new Map(unreachable.map(({ config: c, reason }) => [c.name, reason])),
    });
  } catch (error) {
    await Promise.all([...databases.values()].map((database) => database.close()));
    throw error;
  }
}

export async function loadFragApplication(
  configPath: string,
  options: FragApplicationOptions = {},
): Promise<FragApplication> {
  return createFragApplication(parseFragConfig(await readFile(configPath, "utf8")), options);
}

export function configFromControlPlane(controlPlane: FragControlPlane): FragConfig {
  const embedders = new Map(
    controlPlane.embedders.list().map((record) => {
      const identity = {
        apiStyle: record.apiStyle,
        model: record.model,
        revision: record.revision,
        dim: record.dim,
      };
      return [record.id, {
        name: record.id,
        apiStyle: record.apiStyle,
        ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
        ...(record.baseUrlEnv === undefined ? {} : { baseUrlEnv: record.baseUrlEnv }),
        model: record.model,
        ...(record.requestModel === undefined ? {} : { requestModel: record.requestModel }),
        revision: record.revision,
        dim: record.dim,
        maxTokens: record.maxTokens,
        recommendedChunkSize: record.recommendedChunkSize,
        tokenCounter: record.tokenCounter,
        ...(record.tokenSafetyMargin === undefined ? {} : { tokenSafetyMargin: record.tokenSafetyMargin }),
        apiKeyEnv: record.apiKeyEnv,
        fingerprint: embeddingFingerprint(identity),
      }];
    }),
  );
  const dbs = new Map(
    controlPlane.databases.list().map((record) => [record.id, {
      name: record.id,
      ...(record.connectionUrl === undefined ? {} : { url: record.connectionUrl }),
      ...(record.urlEnv === undefined ? {} : { urlEnv: record.urlEnv }),
    }]),
  );
  const collections = new Map(
    controlPlane.systems.list().map((system) => [system.name, {
      name: system.name,
      description: system.description,
      embedder: system.embedderId,
      db: system.databaseId,
      stateBackend: "same-as-db" as const,
      mirrors: system.mirrors.map((target) => ({ target })),
    }]),
  );
  return { embedders, dbs, collections };
}

export function createFragApplicationFromControlPlane(
  controlPlane: FragControlPlane,
  options: FragApplicationOptions = {},
): Promise<FragApplication> {
  return createFragApplication(configFromControlPlane(controlPlane), options);
}
