import assert from "node:assert/strict";
import test from "node:test";

import {
  CollectionNotAllowedError,
  DimensionMismatchError,
  EstimateTokenCounter,
  FragRegistry,
  SearchService,
  UnknownCollectionError,
  embeddingFingerprint,
  type CollectionConfig,
  type CollectionRuntime,
  type Embedder,
  type EmbedderConfig,
  type IngestService,
  type SourceStore,
  type VectorSearchResult,
  type VectorStore,
} from "../../src/core/index.js";

function fixture(input: { dimensions?: number[]; stale?: boolean } = {}) {
  const identity = { apiStyle: "openai" as const, model: "test", revision: "1", dim: 2 };
  const config: EmbedderConfig = {
    name: "embedder",
    apiStyle: "openai",
    baseUrl: "http://example.invalid",
    model: identity.model,
    revision: identity.revision,
    dim: identity.dim,
    maxTokens: 100,
    recommendedChunkSize: 20,
    tokenCounter: "estimate",
    tokenSafetyMargin: 0.8,
    apiKeyEnv: null,
    fingerprint: embeddingFingerprint(identity),
  };
  const collection: CollectionConfig = {
    name: "notes",
    description: "Private notes",
    embedder: "embedder",
    db: "db",
    stateBackend: "same-as-db",
    mirrors: [],
  };
  let embeddingCalls = 0;
  let similarityCalls = 0;
  const warnings: string[] = [];
  const results: VectorSearchResult[] = [
    {
      sourceKey: "entry",
      content: "matching chunk",
      score: 0.9,
      chunkIndex: 0,
      chunkCount: 1,
      metadata: { status: "approved" },
    },
  ];
  const embedder: Embedder = {
    config,
    async embed() {
      embeddingCalls += 1;
      return [[0.2, 0.8]];
    },
  };
  const sourceStore = {
    async listDimensions() {
      return input.dimensions ?? [2];
    },
    async listStale() {
      return input.stale ? [{}] : [];
    },
  } as unknown as SourceStore;
  const vectorStore = {
    async similaritySearch(_collection: string, _embedding: readonly number[], limit: number) {
      similarityCalls += 1;
      return results.slice(0, limit);
    },
  } as unknown as VectorStore;
  const search = new SearchService({
    collection,
    embedderConfig: config,
    embedder,
    tokenCounter: new EstimateTokenCounter(),
    sourceStore,
    vectorStore,
    logger: { warn: (message) => warnings.push(message) },
  });
  const ingest = {
    async ingest() {
      return { source_id: 1, chunks_inserted: 0, changed: false, reembedded: false };
    },
  } as IngestService;
  const runtime: CollectionRuntime = { config: collection, search, ingest };
  return {
    search,
    runtime,
    warnings,
    embeddingCalls: () => embeddingCalls,
    similarityCalls: () => similarityCalls,
  };
}

test("search embeds text and returns chunk-level information", async () => {
  const harness = fixture();
  const response = await harness.search.search("what is approved?", { limit: 3 });
  assert.equal(harness.embeddingCalls(), 1);
  assert.equal(harness.similarityCalls(), 1);
  assert.equal(response.results[0]?.sourceKey, "entry");
  assert.equal(response.results[0]?.metadata.status, "approved");
  assert.equal(response.stale_embeddings, undefined);
});

test("same-dimension fingerprint drift warns and marks returned results stale", async () => {
  const harness = fixture({ stale: true });
  const response = await harness.search.search("query");
  assert.equal(response.results.length, 1);
  assert.equal(response.stale_embeddings, true);
  assert.match(harness.warnings[0] ?? "", /frag reindex notes/);
});

test("dimension mismatch fails before query embedding or vector table access", async () => {
  const harness = fixture({ dimensions: [2, 3] });
  await assert.rejects(harness.search.search("query"), DimensionMismatchError);
  assert.equal(harness.embeddingCalls(), 0);
  assert.equal(harness.similarityCalls(), 0);
});

test("startup inspection distinguishes stale and dimension-invalid collections", async () => {
  const stale = fixture({ stale: true });
  assert.equal((await stale.search.inspectStatus()).state, "stale");
  const invalid = fixture({ dimensions: [3] });
  const status = await invalid.search.inspectStatus();
  assert.equal(status.state, "dimension-invalid");
  assert.deepEqual(status.storedDimensions, [3]);
});

test("registry allow-list filters discovery and gates before collection lookup", async () => {
  const notes = fixture();
  const registry = new FragRegistry([notes.runtime], { allowedCollections: ["notes"] });
  assert.deepEqual(registry.listCollections(), [{ name: "notes", description: "Private notes" }]);
  await assert.rejects(registry.search("secret", "query"), CollectionNotAllowedError);

  const hidden = new FragRegistry([notes.runtime], { allowedCollections: [] });
  assert.deepEqual(hidden.listCollections(), []);
  await assert.rejects(hidden.search("notes", "query"), CollectionNotAllowedError);

  const unrestricted = new FragRegistry([notes.runtime]);
  await assert.rejects(unrestricted.search("absent", "query"), UnknownCollectionError);
});

test("registry delegates allowed ingest without a default collection", async () => {
  const notes = fixture();
  const registry = new FragRegistry([notes.runtime]);
  const result = await registry.ingest({ collection: "notes", content: "same" });
  assert.equal(result.changed, false);
});
