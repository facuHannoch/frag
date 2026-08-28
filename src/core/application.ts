import { readFile } from "node:fs/promises";

import { EstimateTokenCounter } from "./chunking.js";
import { parseFragConfig, resolveConfiguredEnvironment } from "./config.js";
import { IngestService } from "./ingest.js";
import { PostgresDatabase } from "./postgres/database.js";
import { PostgresSourceStore } from "./postgres/source-store.js";
import { bootstrapSchema, acquireSourceLock } from "./postgres/sql.js";
import { PostgresStateStore } from "./postgres/state-store.js";
import { PostgresVectorStore } from "./postgres/vector-store.js";
import { EndpointTokenCounter, OpenAICompatibleEmbedder, TiktokenCounter } from "./providers.js";
import { FragRegistry, type CollectionRuntime } from "./registry.js";
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

  constructor(input: {
    registry: FragRegistry;
    endpoints: ReadonlyMap<string, TransferEndpoint>;
    reindex: ReadonlyMap<string, ReindexService>;
    databases: readonly PostgresDatabase[];
  }) {
    this.registry = input.registry;
    this.#endpoints = input.endpoints;
    this.#reindex = input.reindex;
    this.#databases = input.databases;
  }

  async listSources(collection: string): Promise<Source[]> {
    return this.#endpoint(collection).sourceStore.list(collection);
  }

  async reindex(collection: string, dryRun = false): Promise<ReindexResult> {
    const service = this.#reindex.get(collection);
    if (service === undefined) throw new RangeError(`Unknown collection: ${collection}`);
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
    if (endpoint === undefined) throw new RangeError(`Unknown collection: ${collection}`);
    return endpoint;
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

export async function createFragApplication(
  config: FragConfig,
  options: FragApplicationOptions = {},
): Promise<FragApplication> {
  const resolved = resolveConfiguredEnvironment(config, options.environment ?? process.env);
  const databases = new Map<string, PostgresDatabase>();
  for (const database of config.dbs.values()) {
    databases.set(database.name, new PostgresDatabase(resolved.databaseUrls.get(database.name)!));
  }
  try {
    for (const database of config.dbs.values()) {
      const dimensions = [...config.collections.values()]
        .filter((collection) => collection.db === database.name)
        .map((collection) => config.embedders.get(collection.embedder)!.dim);
      await bootstrapSchema(databases.get(database.name)!, dimensions);
    }

    const endpoints = new Map<string, TransferEndpoint>();
    for (const collection of config.collections.values()) {
      const embedderConfig = config.embedders.get(collection.embedder)!;
      const database = databases.get(collection.db)!;
      const baseUrl = resolved.embedderBaseUrls.get(embedderConfig.name)!;
      const apiKey = resolved.embedderApiKeys.get(embedderConfig.name)!;
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
    const registry = new FragRegistry(
      runtimes,
      options.allowedCollections === undefined
        ? {}
        : { allowedCollections: options.allowedCollections },
    );
    await registry.inspectCollections();
    return new FragApplication({
      registry,
      endpoints,
      reindex,
      databases: [...databases.values()],
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
