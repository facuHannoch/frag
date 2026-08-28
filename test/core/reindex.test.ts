import assert from "node:assert/strict";
import test from "node:test";

import {
  ConcurrentModificationError,
  DimensionMismatchError,
  EstimateTokenCounter,
  ReindexService,
  contentHash,
  embeddingFingerprint,
  metadataHash,
  representationHash,
  type CollectionConfig,
  type Embedder,
  type EmbedderConfig,
  type Metadata,
  type QueryResult,
  type Source,
  type SourceStore,
  type StoredChunk,
  type Transactional,
  type Tx,
  type VectorStore,
} from "../../src/core/index.js";

function config(revision: string): EmbedderConfig {
  const identity = { apiStyle: "openai" as const, model: "test", revision, dim: 2 };
  return {
    name: "embedder",
    apiStyle: "openai",
    baseUrl: "http://example.invalid",
    model: identity.model,
    revision,
    dim: 2,
    maxTokens: 100,
    recommendedChunkSize: 20,
    tokenCounter: "estimate",
    tokenSafetyMargin: 0.8,
    apiKeyEnv: null,
    fingerprint: embeddingFingerprint(identity),
  };
}

const collection: CollectionConfig = {
  name: "notes",
  description: "Notes",
  embedder: "embedder",
  db: "db",
  stateBackend: "same-as-db",
  mirrors: [],
};

function staleSource(): Source {
  const chunks = ["first summary", "second summary"];
  const metadata: Metadata = { status: "approved" };
  return {
    id: 4,
    collection: "notes",
    sourceKey: "entry",
    content: "original source content",
    contentHash: contentHash("original source content"),
    representationHash: representationHash({ mode: "explicit", chunkSize: null, chunks }),
    metadataHash: metadataHash(metadata),
    embeddingFingerprint: config("1").fingerprint,
    embeddingDim: 2,
    chunkingMode: "explicit",
    chunkSize: null,
    metadata,
    origin: null,
    rowVersion: 6n,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function storedChunks(source: Source): StoredChunk[] {
  return ["first summary", "second summary"].map((content, chunkIndex, all) => ({
    id: chunkIndex + 10,
    sourceId: source.id,
    collection: source.collection,
    content,
    embedding: [0, 0],
    contentHash: contentHash(content),
    chunkIndex,
    chunkCount: all.length,
    metadata: source.metadata,
  }));
}

function harness(input: { dimensions?: number[]; race?: boolean } = {}) {
  const currentConfig = config("2");
  let source = staleSource();
  const chunks = storedChunks(source);
  let embeddingCalls = 0;
  let transactions = 0;
  let vectorUpdates = 0;
  let identityUpdates = 0;
  let inTransaction = false;
  const sourceStore = {
    async listDimensions() {
      return input.dimensions ?? [2];
    },
    async listStale() {
      return [source];
    },
    async get() {
      if (input.race) return { source: { ...source, rowVersion: 7n }, rowVersion: 7n };
      return { source, rowVersion: source.rowVersion };
    },
    async updateEmbeddingIdentity(
      _tx: Tx,
      _id: number,
      _version: bigint,
      fingerprint: string,
    ) {
      identityUpdates += 1;
      source = { ...source, embeddingFingerprint: fingerprint, rowVersion: source.rowVersion + 1n };
      return source;
    },
  } as unknown as SourceStore;
  const vectorStore = {
    async listChunksBySource() {
      return chunks;
    },
    async updateChunkEmbeddings(
      _tx: Tx,
      _sourceId: number,
      _dim: number,
      embeddings: readonly (readonly number[])[],
    ) {
      vectorUpdates += 1;
      assert.deepEqual(embeddings, [
        [1, 0],
        [0, 1],
      ]);
    },
  } as unknown as VectorStore;
  const transactional: Transactional = {
    async withTransaction<T>(fn: (tx: Tx) => Promise<T>) {
      transactions += 1;
      inTransaction = true;
      try {
        return await fn({
          async query(): Promise<QueryResult> {
            return { rows: [], rowCount: 1 };
          },
        } as Tx);
      } finally {
        inTransaction = false;
      }
    },
  };
  const embedder: Embedder = {
    config: currentConfig,
    async embed() {
      embeddingCalls += 1;
      assert.equal(inTransaction, false);
      return [
        [1, 0],
        [0, 1],
      ];
    },
  };
  const service = new ReindexService({
    collection,
    embedderConfig: currentConfig,
    embedder,
    tokenCounter: new EstimateTokenCounter(),
    sourceStore,
    vectorStore,
    transactional,
    lockNamespace: "db",
  });
  return {
    service,
    chunks,
    source: () => source,
    embeddingCalls: () => embeddingCalls,
    transactions: () => transactions,
    vectorUpdates: () => vectorUpdates,
    identityUpdates: () => identityUpdates,
  };
}

test("dry-run inventories stale sources and chunks without embedding or writing", async () => {
  const testHarness = harness();
  const result = await testHarness.service.reindex({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.sources, 1);
  assert.equal(result.chunks, 2);
  assert.deepEqual(result.storedFingerprintGroups, { [config("1").fingerprint]: 1 });
  assert.equal(testHarness.embeddingCalls(), 0);
  assert.equal(testHarness.transactions(), 0);
});

test("reindex replaces only vectors and stored fingerprint at the same dimension", async () => {
  const testHarness = harness();
  const before = structuredClone(testHarness.chunks);
  const sourceBefore = testHarness.source();
  const result = await testHarness.service.reindex();
  assert.equal(result.dryRun, false);
  assert.equal(testHarness.embeddingCalls(), 1);
  assert.equal(testHarness.transactions(), 1);
  assert.equal(testHarness.vectorUpdates(), 1);
  assert.equal(testHarness.identityUpdates(), 1);
  assert.deepEqual(testHarness.chunks, before);
  assert.equal(testHarness.source().content, sourceBefore.content);
  assert.equal(testHarness.source().representationHash, sourceBefore.representationHash);
  assert.equal(testHarness.source().metadataHash, sourceBefore.metadataHash);
  assert.equal(testHarness.source().embeddingFingerprint, config("2").fingerprint);
});

test("dimension mismatch refuses reindex before reading chunks or embedding", async () => {
  const testHarness = harness({ dimensions: [3] });
  await assert.rejects(testHarness.service.reindex(), DimensionMismatchError);
  assert.equal(testHarness.embeddingCalls(), 0);
  assert.equal(testHarness.transactions(), 0);
});

test("concurrent source change aborts after embedding but before vector update", async () => {
  const testHarness = harness({ race: true });
  await assert.rejects(testHarness.service.reindex(), ConcurrentModificationError);
  assert.equal(testHarness.embeddingCalls(), 1);
  assert.equal(testHarness.vectorUpdates(), 0);
  assert.equal(testHarness.identityUpdates(), 0);
});
