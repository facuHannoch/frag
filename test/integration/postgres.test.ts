import assert from "node:assert/strict";
import test from "node:test";

import {
  ConcurrentModificationError,
  EstimateTokenCounter,
  IngestService,
  PostgresDatabase,
  PostgresSourceStore,
  PostgresStateStore,
  PostgresVectorStore,
  ReindexService,
  SearchService,
  bootstrapSchema,
  createFragApplication,
  embeddingFingerprint,
  type CollectionConfig,
  type Embedder,
  type EmbedderConfig,
  type FragConfig,
  type Tx,
  type VectorStore,
} from "../../src/core/index.js";

const databaseUrl = process.env.FRAG_TEST_DATABASE_URL;

function config(revision: string): EmbedderConfig {
  const identity = { apiStyle: "openai" as const, model: "integration", revision, dim: 2 };
  return {
    name: "integration",
    apiStyle: "openai",
    baseUrl: "http://example.invalid",
    model: identity.model,
    revision,
    dim: 2,
    maxTokens: 100,
    recommendedChunkSize: 20,
    tokenCounter: "estimate",
    tokenSafetyMargin: 1,
    apiKeyEnv: null,
    fingerprint: embeddingFingerprint(identity),
  };
}

test(
  "live pgvector bootstrap, ingest, rollback, concurrency, search, and reindex",
  { skip: databaseUrl === undefined ? "set FRAG_TEST_DATABASE_URL to run" : false },
  async () => {
    const database = new PostgresDatabase(databaseUrl!);
    const suffix = `${process.pid}-${Date.now()}`;
    const collectionName = `frag-integration-${suffix}`;
    const collection: CollectionConfig = {
      name: collectionName,
      description: "integration",
      embedder: "integration",
      db: "integration-db",
      stateBackend: "same-as-db",
      mirrors: [],
    };
    const sources = new PostgresSourceStore(database);
    const vectors = new PostgresVectorStore(database);
    const state = new PostgresStateStore(database);
    const counter = new EstimateTokenCounter();
    let embeddingCalls = 0;
    let activeConfig = config("1");
    const embedder: Embedder = {
      get config() {
        return activeConfig;
      },
      async embed(texts) {
        embeddingCalls += 1;
        return texts.map((text, index) => [text.length / 100, (index + 1) / 10]);
      },
    };
    const ingestion = (vectorStore: VectorStore = vectors, configured = activeConfig) =>
      new IngestService({
        collection,
        embedderConfig: configured,
        embedder,
        tokenCounter: counter,
        sourceStore: sources,
        vectorStore,
        transactional: database,
        lockNamespace: collection.db,
      });

    try {
      const freshCollection = `${collectionName}-fresh`;
      const freshConfig: FragConfig = {
        collections: new Map([
          [
            freshCollection,
            {
              ...collection,
              name: freshCollection,
            },
          ],
        ]),
        embedders: new Map([[activeConfig.name, activeConfig]]),
        dbs: new Map([["integration-db", { name: "integration-db", urlEnv: "TEST_DB_URL" }]]),
      };
      const freshApplication = await createFragApplication(freshConfig, {
        environment: { TEST_DB_URL: databaseUrl },
      });
      assert.deepEqual(freshApplication.registry.listCollections(), [
        { name: freshCollection, description: "integration" },
      ]);
      await freshApplication.close();

      await bootstrapSchema(database, [2]);
      await bootstrapSchema(database, [2]);

      await ingestion().ingest({
        collection: collectionName,
        sourceKey: "one",
        content: "original one",
        chunks: ["shared paragraph", "shared paragraph"],
      });
      await ingestion().ingest({
        collection: collectionName,
        sourceKey: "two",
        content: "original two",
        chunks: ["shared paragraph"],
      });
      assert.equal((await sources.list(collectionName)).length, 2);
      const one = (await sources.get(collectionName, "one")).source!;
      assert.deepEqual(
        (await vectors.listChunksBySource(one.id, 2)).map(({ chunkIndex }) => chunkIndex),
        [0, 1],
      );

      const callsBeforeMetadata = embeddingCalls;
      const metadata = await ingestion().ingest({
        collection: collectionName,
        sourceKey: "one",
        content: "original one",
        chunks: ["shared paragraph", "shared paragraph"],
        metadata: { status: "approved" },
      });
      assert.equal(metadata.reembedded, false);
      assert.equal(embeddingCalls, callsBeforeMetadata);

      let inserted = 0;
      const failingVectors: VectorStore = new Proxy(vectors, {
        get(target, property, receiver) {
          if (property !== "insertChunk") return Reflect.get(target, property, receiver) as unknown;
          return async (...args: Parameters<VectorStore["insertChunk"]>) => {
            inserted += 1;
            if (inserted === 2) throw new Error("injected chunk failure");
            return target.insertChunk(...args);
          };
        },
      });
      await assert.rejects(
        ingestion(failingVectors).ingest({
          collection: collectionName,
          sourceKey: "one",
          content: "replacement",
          chunks: ["new first", "new second"],
        }),
        /injected chunk failure/,
      );
      const afterRollback = (await sources.get(collectionName, "one")).source!;
      assert.equal(afterRollback.content, "original one");
      assert.deepEqual(
        (await vectors.listChunksBySource(afterRollback.id, 2)).map(({ content }) => content),
        ["shared paragraph", "shared paragraph"],
      );

      let waiting = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const concurrentEmbedder: Embedder = {
        config: activeConfig,
        async embed(texts) {
          waiting += 1;
          if (waiting === 2) release();
          await barrier;
          return texts.map(() => [0.4, 0.6]);
        },
      };
      const concurrentService = new IngestService({
        collection,
        embedderConfig: activeConfig,
        embedder: concurrentEmbedder,
        tokenCounter: counter,
        sourceStore: sources,
        vectorStore: vectors,
        transactional: database,
        lockNamespace: collection.db,
      });
      const concurrent = await Promise.allSettled([
        concurrentService.ingest({ collection: collectionName, sourceKey: "race", content: "left" }),
        concurrentService.ingest({ collection: collectionName, sourceKey: "race", content: "right" }),
      ]);
      assert.equal(concurrent.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = concurrent.find(({ status }) => status === "rejected");
      assert.ok(rejected?.status === "rejected" && rejected.reason instanceof ConcurrentModificationError);

      activeConfig = config("2");
      const currentEmbedder: Embedder = {
        config: activeConfig,
        async embed(texts) {
          return texts.map(() => [0.5, 0.5]);
        },
      };
      const search = new SearchService({
        collection,
        embedderConfig: activeConfig,
        embedder: currentEmbedder,
        tokenCounter: counter,
        sourceStore: sources,
        vectorStore: vectors,
      });
      assert.equal((await search.search("shared")).stale_embeddings, true);
      const reindex = new ReindexService({
        collection,
        embedderConfig: activeConfig,
        embedder: currentEmbedder,
        tokenCounter: counter,
        sourceStore: sources,
        vectorStore: vectors,
        transactional: database,
        lockNamespace: collection.db,
      });
      const dryRun = await reindex.reindex({ dryRun: true });
      assert.ok(dryRun.sources >= 3);
      await reindex.reindex();
      assert.equal((await search.search("shared")).stale_embeddings, undefined);

      await database.withTransaction(async (tx: Tx) => {
        await state.deleteTargetReceipt(tx, collectionName, "one");
      });
    } finally {
      await database.query("DELETE FROM _frag_state WHERE target_collection = $1", [collectionName]);
      await database.query("DELETE FROM sources WHERE collection = $1", [collectionName]);
      await database.close();
    }
  },
);
