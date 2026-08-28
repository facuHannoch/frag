import assert from "node:assert/strict";
import test from "node:test";

import {
  ConcurrentModificationError,
  EmbedderLengthError,
  EstimateTokenCounter,
  IngestService,
  contentHash,
  embeddingFingerprint,
  metadataHash,
  representationHash,
  splitAutomatically,
  type CollectionConfig,
  type Embedder,
  type EmbedderConfig,
  type Metadata,
  type QueryResult,
  type Source,
  type SourceSnapshot,
  type SourceStore,
  type Transactional,
  type Tx,
  type VectorStore,
} from "../../src/core/index.js";

const collection: CollectionConfig = {
  name: "notes",
  description: "Notes",
  embedder: "test",
  db: "db",
  stateBackend: "same-as-db",
  mirrors: [],
};

function embedderConfig(revision = "1", overrides: Partial<EmbedderConfig> = {}): EmbedderConfig {
  const identity = { apiStyle: "openai" as const, model: "test-model", revision, dim: 2 };
  return {
    name: "test",
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
    ...overrides,
  };
}

function existingSource(input: {
  content?: string;
  metadata?: Metadata;
  fingerprint?: string;
  rowVersion?: bigint;
} = {}): Source {
  const content = input.content ?? "same text";
  const metadata = input.metadata ?? {};
  return {
    id: 1,
    collection: "notes",
    sourceKey: "entry",
    content,
    contentHash: contentHash(content),
    representationHash: representationHash({ mode: "manual", chunkSize: null, chunks: [content] }),
    metadataHash: metadataHash(metadata),
    embeddingFingerprint: input.fingerprint ?? embedderConfig().fingerprint,
    embeddingDim: 2,
    chunkingMode: "manual",
    chunkSize: null,
    metadata,
    origin: null,
    rowVersion: input.rowVersion ?? 1n,
    createdAt: new Date("2026-08-28T00:00:00Z"),
    updatedAt: new Date("2026-08-28T00:00:00Z"),
  };
}

class FakeTransactional implements Transactional {
  inTransaction = false;
  count = 0;

  async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.count += 1;
    this.inTransaction = true;
    const tx = {
      async query(): Promise<QueryResult> {
        return { rows: [], rowCount: 1 };
      },
    } as Tx;
    try {
      return await fn(tx);
    } finally {
      this.inTransaction = false;
    }
  }
}

class FakeSources {
  source: Source | null;
  raceOnLockedRead: (() => void) | undefined;
  writes: string[] = [];

  constructor(source: Source | null) {
    this.source = source;
  }

  async get(_collection: string, _sourceKey: string, queryable?: unknown): Promise<SourceSnapshot> {
    if (queryable !== undefined && this.raceOnLockedRead !== undefined) {
      const race = this.raceOnLockedRead;
      this.raceOnLockedRead = undefined;
      race();
    }
    return { source: this.source, rowVersion: this.source?.rowVersion ?? null };
  }

  async listDimensions(): Promise<number[]> {
    return this.source === null ? [] : [this.source.embeddingDim];
  }

  async insert(_tx: Tx, input: Record<string, unknown>): Promise<Source> {
    this.writes.push("insert");
    this.source = {
      id: 2,
      collection: input.collection as string,
      sourceKey: input.sourceKey as string,
      content: input.content as string,
      contentHash: input.contentHash as string,
      representationHash: input.representationHash as string,
      metadataHash: input.metadataHash as string,
      embeddingFingerprint: input.embeddingFingerprint as string,
      embeddingDim: input.embeddingDim as number,
      chunkingMode: input.chunkingMode as Source["chunkingMode"],
      chunkSize: input.chunkSize as number | null,
      metadata: input.metadata as Metadata,
      origin: null,
      rowVersion: 1n,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return this.source;
  }

  async updateRepresentation(
    _tx: Tx,
    _id: number,
    _version: bigint,
    input: Record<string, unknown>,
  ): Promise<Source> {
    this.writes.push("representation");
    this.source = {
      ...this.source!,
      content: input.content as string,
      contentHash: input.contentHash as string,
      representationHash: input.representationHash as string,
      metadataHash: input.metadataHash as string,
      embeddingFingerprint: input.embeddingFingerprint as string,
      embeddingDim: input.embeddingDim as number,
      chunkingMode: input.chunkingMode as Source["chunkingMode"],
      chunkSize: input.chunkSize as number | null,
      metadata: input.metadata as Metadata,
      rowVersion: this.source!.rowVersion + 1n,
    };
    return this.source;
  }

  async updateMetadata(
    _tx: Tx,
    _id: number,
    _version: bigint,
    metadata: Metadata,
    hash: string,
  ): Promise<Source> {
    this.writes.push("metadata");
    this.source = {
      ...this.source!,
      metadata,
      metadataHash: hash,
      rowVersion: this.source!.rowVersion + 1n,
    };
    return this.source;
  }
}

class FakeVectors {
  operations: string[] = [];

  async deleteChunksBySource(): Promise<void> {
    this.operations.push("delete");
  }

  async insertChunk(): Promise<{ id: number }> {
    this.operations.push("insert");
    return { id: this.operations.length };
  }

  async updateChunkMetadata(): Promise<void> {
    this.operations.push("metadata");
  }
}

function service(input: {
  source: Source | null;
  config?: EmbedderConfig;
  embed?: Embedder["embed"];
}) {
  const config = input.config ?? embedderConfig();
  const transactional = new FakeTransactional();
  const sources = new FakeSources(input.source);
  const vectors = new FakeVectors();
  let embeddingCalls = 0;
  const embedder: Embedder = {
    config,
    async embed(texts) {
      embeddingCalls += 1;
      assert.equal(transactional.inTransaction, false, "embedding must occur outside a transaction");
      if (input.embed !== undefined) return input.embed(texts);
      return texts.map(() => [0.25, 0.75]);
    },
  };
  const ingest = new IngestService({
    collection,
    embedderConfig: config,
    embedder,
    tokenCounter: new EstimateTokenCounter(),
    sourceStore: sources as unknown as SourceStore,
    vectorStore: vectors as unknown as VectorStore,
    transactional,
    lockNamespace: "test-db",
  });
  return { ingest, sources, vectors, transactional, embeddingCalls: () => embeddingCalls };
}

test("identical ingest after revision bump is a zero-embedding no-op", async () => {
  const old = embedderConfig("1");
  const harness = service({ source: existingSource({ fingerprint: old.fingerprint }), config: embedderConfig("2") });
  const result = await harness.ingest.ingest({ collection: "notes", sourceKey: "entry", content: "same text" });
  assert.deepEqual(result, { source_id: 1, chunks_inserted: 0, changed: false, reembedded: false });
  assert.equal(harness.embeddingCalls(), 0);
  assert.equal(harness.transactional.count, 0);
});

test("metadata-only ingest updates snapshots without changing vector identity", async () => {
  const oldFingerprint = embedderConfig("1").fingerprint;
  const harness = service({
    source: existingSource({ metadata: { status: "draft" }, fingerprint: oldFingerprint }),
    config: embedderConfig("2"),
  });
  const result = await harness.ingest.ingest({
    collection: "notes",
    sourceKey: "entry",
    content: "same text",
    metadata: { status: "approved" },
  });
  assert.equal(result.changed, true);
  assert.equal(result.reembedded, false);
  assert.equal(harness.embeddingCalls(), 0);
  assert.equal(harness.sources.source?.embeddingFingerprint, oldFingerprint);
  assert.deepEqual(harness.vectors.operations, ["metadata"]);
});

test("representation update embeds before its transaction and atomically replaces chunks", async () => {
  const harness = service({ source: existingSource() });
  const result = await harness.ingest.ingest({ collection: "notes", sourceKey: "entry", content: "new text" });
  assert.equal(result.changed, true);
  assert.equal(result.reembedded, true);
  assert.equal(result.chunks_inserted, 1);
  assert.equal(harness.embeddingCalls(), 1);
  assert.equal(harness.transactional.count, 1);
  assert.deepEqual(harness.vectors.operations, ["delete", "insert"]);
});

test("existing-source race aborts after lock revalidation without writes", async () => {
  const harness = service({ source: existingSource() });
  harness.sources.raceOnLockedRead = () => {
    harness.sources.source = { ...harness.sources.source!, rowVersion: 2n };
  };
  await assert.rejects(
    harness.ingest.ingest({ collection: "notes", sourceKey: "entry", content: "changed" }),
    ConcurrentModificationError,
  );
  assert.deepEqual(harness.sources.writes, []);
  assert.deepEqual(harness.vectors.operations, []);
});

test("absent-source race aborts cleanly rather than attempting insert", async () => {
  const harness = service({ source: null });
  harness.sources.raceOnLockedRead = () => {
    harness.sources.source = existingSource();
  };
  await assert.rejects(
    harness.ingest.ingest({ collection: "notes", sourceKey: "entry", content: "new" }),
    ConcurrentModificationError,
  );
  assert.deepEqual(harness.sources.writes, []);
});

test("provider length rejection reports the identified explicit chunk", async () => {
  const error = Object.assign(new Error("maximum token length exceeded"), { status: 400, chunkIndex: 1 });
  const harness = service({
    source: null,
    embed: async () => {
      throw error;
    },
  });
  await assert.rejects(
    harness.ingest.ingest({
      collection: "notes",
      sourceKey: "entry",
      content: "original",
      chunks: ["first", "second"],
    }),
    (caught: unknown) => caught instanceof EmbedderLengthError && caught.details.chunkIndex === 1,
  );
  assert.deepEqual(harness.sources.writes, []);
});

test("automatic splitting makes ordered overlapping chunks within the target", async () => {
  const counter = new EstimateTokenCounter();
  const chunks = await splitAutomatically("abcdefghijklmnopqrstuvwxyz", 3, counter, 1);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok((await counter.count(chunk)) <= 3);
  assert.equal(chunks[0]?.slice(-4), chunks[1]?.slice(0, 4));
});
