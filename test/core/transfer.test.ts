import assert from "node:assert/strict";
import test from "node:test";

import {
  EstimateTokenCounter,
  MirrorFanout,
  SourceKeyConflictError,
  TransferService,
  contentHash,
  embeddingFingerprint,
  metadataHash,
  representationHash,
  type CollectionConfig,
  type Embedder,
  type EmbedderConfig,
  type Metadata,
  type NewSource,
  type QueryResult,
  type Source,
  type SourceStore,
  type StateReceipt,
  type StateStore,
  type StoredChunk,
  type Transactional,
  type TransferEndpoint,
  type Tx,
  type VectorStore,
} from "../../src/core/index.js";

interface MemoryState {
  sources: Map<string, Source>;
  chunks: Map<number, StoredChunk[]>;
  receipts: Map<string, StateReceipt>;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    sources: structuredClone(state.sources),
    chunks: structuredClone(state.chunks),
    receipts: structuredClone(state.receipts),
  };
}

class MemoryEndpoint {
  state: MemoryState = { sources: new Map(), chunks: new Map(), receipts: new Map() };
  readonly endpoint: TransferEndpoint;
  embeddingCalls = 0;
  failInsertOnce = false;
  #nextId = 10;

  constructor(input: {
    name: string;
    model?: string;
    mirrors?: string[];
    maxTokens?: number;
    recommendedChunkSize?: number;
  }) {
    const model = input.model ?? "shared";
    const identity = { apiStyle: "openai" as const, model, revision: "1", dim: 2 };
    const embedderConfig: EmbedderConfig = {
      name: `${input.name}-embedder`,
      apiStyle: "openai",
      baseUrl: "http://example.invalid",
      model,
      revision: "1",
      dim: 2,
      maxTokens: input.maxTokens ?? 100,
      recommendedChunkSize: input.recommendedChunkSize ?? 20,
      tokenCounter: "estimate",
      tokenSafetyMargin: 1,
      apiKeyEnv: null,
      fingerprint: embeddingFingerprint(identity),
    };
    const collection: CollectionConfig = {
      name: input.name,
      description: input.name,
      embedder: embedderConfig.name,
      db: `${input.name}-db`,
      stateBackend: "same-as-db",
      mirrors: (input.mirrors ?? []).map((target) => ({ target })),
    };
    const sourceStore = this.#sourceStore();
    const vectorStore = this.#vectorStore();
    const stateStore = this.#stateStore();
    const embedder: Embedder = {
      config: embedderConfig,
      embed: async (texts) => {
        this.embeddingCalls += 1;
        return texts.map((_, index) => [index + 0.1, index + 0.2]);
      },
    };
    const transactional: Transactional = {
      withTransaction: async <T>(fn: (tx: Tx) => Promise<T>) => {
        const before = cloneState(this.state);
        try {
          return await fn({
            query: async (): Promise<QueryResult> => ({ rows: [], rowCount: 1 }),
          } as Tx);
        } catch (error) {
          this.state = before;
          throw error;
        }
      },
    };
    this.endpoint = {
      collection,
      embedderConfig,
      embedder,
      tokenCounter: new EstimateTokenCounter(),
      sourceStore,
      vectorStore,
      stateStore,
      transactional,
      lockNamespace: collection.db,
    };
  }

  addSource(input: {
    key?: string;
    content?: string;
    chunks?: string[];
    metadata?: Metadata;
    origin?: Source["origin"];
  } = {}): Source {
    const key = input.key ?? "entry";
    const content = input.content ?? "original source";
    const chunks = input.chunks ?? ["first", "second"];
    const metadata = input.metadata ?? { status: "draft" };
    const source: Source = {
      id: this.#nextId++,
      collection: this.endpoint.collection.name,
      sourceKey: key,
      content,
      contentHash: contentHash(content),
      representationHash: representationHash({ mode: "explicit", chunkSize: null, chunks }),
      metadataHash: metadataHash(metadata),
      embeddingFingerprint: this.endpoint.embedderConfig.fingerprint,
      embeddingDim: 2,
      chunkingMode: "explicit",
      chunkSize: null,
      metadata,
      origin: input.origin ?? null,
      rowVersion: 1n,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.state.sources.set(key, source);
    this.state.chunks.set(
      source.id,
      chunks.map((chunk, chunkIndex) => ({
        id: this.#nextId++,
        sourceId: source.id,
        collection: source.collection,
        content: chunk,
        embedding: [chunkIndex + 1, chunkIndex + 2],
        contentHash: contentHash(chunk),
        chunkIndex,
        chunkCount: chunks.length,
        metadata,
      })),
    );
    return source;
  }

  updateSourceMetadata(key: string, metadata: Metadata): Source {
    const source = this.state.sources.get(key)!;
    const updated = {
      ...source,
      metadata,
      metadataHash: metadataHash(metadata),
      rowVersion: source.rowVersion + 1n,
    };
    this.state.sources.set(key, updated);
    return updated;
  }

  #sourceStore(): SourceStore {
    return {
      get: async (_collection, sourceKey) => {
        const source = this.state.sources.get(sourceKey) ?? null;
        return { source, rowVersion: source?.rowVersion ?? null };
      },
      list: async () => [...this.state.sources.values()],
      listStale: async () => [],
      listDimensions: async () => [...new Set([...this.state.sources.values()].map(({ embeddingDim }) => embeddingDim))],
      insert: async (_tx, input: NewSource) => {
        const source: Source = {
          id: this.#nextId++,
          ...input,
          rowVersion: 1n,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.state.sources.set(input.sourceKey, source);
        return source;
      },
      updateRepresentation: async (_tx, sourceId, _version, input) => {
        const old = [...this.state.sources.values()].find(({ id }) => id === sourceId)!;
        const source: Source = { ...old, ...input, rowVersion: old.rowVersion + 1n, updatedAt: new Date() };
        this.state.sources.set(source.sourceKey, source);
        return source;
      },
      updateMetadata: async (_tx, sourceId, _version, metadata, hash) => {
        const old = [...this.state.sources.values()].find(({ id }) => id === sourceId)!;
        const source = { ...old, metadata, metadataHash: hash, rowVersion: old.rowVersion + 1n };
        this.state.sources.set(source.sourceKey, source);
        return source;
      },
      updateEmbeddingIdentity: async () => {
        throw new Error("not used");
      },
      delete: async () => undefined,
    };
  }

  #vectorStore(): VectorStore {
    return {
      insertChunk: async (_tx, collection, sourceId, content, embedding, chunkIndex, chunkCount, metadata) => {
        if (this.failInsertOnce) {
          this.failInsertOnce = false;
          throw new Error("injected target insert failure");
        }
        const chunks = this.state.chunks.get(sourceId) ?? [];
        const id = this.#nextId++;
        chunks.push({
          id,
          sourceId,
          collection,
          content,
          embedding,
          contentHash: contentHash(content),
          chunkIndex,
          chunkCount,
          metadata,
        });
        this.state.chunks.set(sourceId, chunks);
        return { id };
      },
      similaritySearch: async () => [],
      listChunksBySource: async (sourceId) => this.state.chunks.get(sourceId) ?? [],
      deleteChunksBySource: async (_tx, sourceId) => {
        this.state.chunks.set(sourceId, []);
      },
      updateChunkEmbeddings: async () => undefined,
      updateChunkMetadata: async (_tx, sourceId, _dim, metadata) => {
        this.state.chunks.set(
          sourceId,
          (this.state.chunks.get(sourceId) ?? []).map((chunk) => ({ ...chunk, metadata })),
        );
      },
    };
  }

  #stateStore(): StateStore {
    return {
      replaceReceipt: async (_tx, operation, source, sourceKey, target, targetSourceKey, ref) => {
        this.state.receipts.set(targetSourceKey, {
          sourceCollection: source,
          sourceKey,
          targetCollection: target,
          targetSourceKey,
          operation,
          ref,
          createdAt: new Date(),
        });
      },
      hasOperation: async (operation, source, target, ref) =>
        [...this.state.receipts.values()].some(
          (receipt) =>
            receipt.operation === operation &&
            receipt.sourceCollection === source &&
            receipt.targetCollection === target &&
            receipt.ref === ref,
        ),
      getTargetReceipt: async (_target, targetSourceKey) => this.state.receipts.get(targetSourceKey) ?? null,
      deleteTargetReceipt: async (_tx, _target, targetSourceKey) => {
        this.state.receipts.delete(targetSourceKey);
      },
    };
  }
}

test("same-fingerprint promote carries chunks and reuses stored vectors", async () => {
  const source = new MemoryEndpoint({ name: "source", model: "same" });
  const target = new MemoryEndpoint({ name: "target", model: "same" });
  const original = source.addSource();
  const result = await new TransferService().promote(source.endpoint, target.endpoint, "entry");
  assert.equal(result.reusedVectors, true);
  assert.equal(result.reembedded, false);
  assert.equal(target.embeddingCalls, 0);
  const copied = target.state.sources.get("entry")!;
  assert.deepEqual(
    target.state.chunks.get(copied.id)?.map(({ embedding }) => embedding),
    source.state.chunks.get(original.id)?.map(({ embedding }) => embedding),
  );
  assert.deepEqual(copied.origin, { collection: "source", sourceKey: "entry" });
});

test("stale stored source vectors are not reused merely because configs match", async () => {
  const source = new MemoryEndpoint({ name: "source", model: "same" });
  const target = new MemoryEndpoint({ name: "target", model: "same" });
  const row = source.addSource();
  source.state.sources.set("entry", {
    ...row,
    embeddingFingerprint: embeddingFingerprint({
      apiStyle: "openai",
      model: "old-model",
      revision: "1",
      dim: 2,
    }),
  });
  const result = await new TransferService().promote(source.endpoint, target.endpoint, "entry");
  assert.equal(result.reusedVectors, false);
  assert.equal(result.reembedded, true);
  assert.equal(target.embeddingCalls, 1);
});

test("different-fingerprint promote embeds once and retry skips from current receipt", async () => {
  const source = new MemoryEndpoint({ name: "source", model: "source-model" });
  const target = new MemoryEndpoint({ name: "target", model: "target-model" });
  source.addSource();
  const transfer = new TransferService();
  const first = await transfer.promote(source.endpoint, target.endpoint, "entry");
  const second = await transfer.promote(source.endpoint, target.endpoint, "entry");
  assert.equal(first.reembedded, true);
  assert.equal(target.embeddingCalls, 1);
  assert.equal(second.skipped, true);
  assert.equal(target.embeddingCalls, 1);
});

test("metadata-only re-promote preserves valid different-fingerprint target vectors", async () => {
  const source = new MemoryEndpoint({ name: "source", model: "source-model" });
  const target = new MemoryEndpoint({ name: "target", model: "target-model" });
  source.addSource();
  const transfer = new TransferService();
  await transfer.promote(source.endpoint, target.endpoint, "entry");
  const copied = target.state.sources.get("entry")!;
  const vectorsBefore = structuredClone(target.state.chunks.get(copied.id));
  source.updateSourceMetadata("entry", { status: "approved" });
  const result = await transfer.promote(source.endpoint, target.endpoint, "entry");
  assert.equal(result.changed, true);
  assert.equal(result.reembedded, false);
  assert.equal(target.embeddingCalls, 1);
  assert.deepEqual(
    target.state.chunks.get(copied.id)?.map(({ embedding }) => embedding),
    vectorsBefore?.map(({ embedding }) => embedding),
  );
  assert.equal(target.state.sources.get("entry")?.metadata.status, "approved");
});

test("one oversized carried chunk causes full target auto-chunking", async () => {
  const source = new MemoryEndpoint({ name: "source" });
  const target = new MemoryEndpoint({
    name: "target",
    model: "other",
    maxTokens: 4,
    recommendedChunkSize: 2,
  });
  source.addSource({
    content: "abcdefghijklmnopqrstuvwxyz0123456789",
    chunks: ["short", "x".repeat(40)],
  });
  await new TransferService().promote(source.endpoint, target.endpoint, "entry");
  const copied = target.state.sources.get("entry")!;
  const contents = target.state.chunks.get(copied.id)!.map(({ content }) => content);
  assert.equal(copied.chunkingMode, "auto");
  assert.equal(copied.chunkSize, 2);
  assert.equal(contents.includes("short"), false);
  assert.equal(contents.includes("x".repeat(40)), false);
  assert.ok(contents.length > 1);
});

test("target-side failure rolls back data and receipt and succeeds on retry", async () => {
  const source = new MemoryEndpoint({ name: "source" });
  const target = new MemoryEndpoint({ name: "target", model: "other" });
  source.addSource();
  target.failInsertOnce = true;
  const transfer = new TransferService();
  await assert.rejects(transfer.promote(source.endpoint, target.endpoint, "entry"), /injected/);
  assert.equal(target.state.sources.size, 0);
  assert.equal(target.state.receipts.size, 0);
  await transfer.promote(source.endpoint, target.endpoint, "entry");
  assert.equal(target.state.sources.size, 1);
  assert.equal(target.state.receipts.size, 1);
});

test("different origin cannot silently overwrite a target key", async () => {
  const source = new MemoryEndpoint({ name: "source" });
  const target = new MemoryEndpoint({ name: "target" });
  source.addSource();
  target.addSource({ key: "entry", origin: null });
  await assert.rejects(
    new TransferService().promote(source.endpoint, target.endpoint, "entry"),
    SourceKeyConflictError,
  );
});

test("failed mirror warns and an identical retry repairs the missing target", async () => {
  const source = new MemoryEndpoint({ name: "source", mirrors: ["cache"] });
  const cache = new MemoryEndpoint({ name: "cache", model: "other" });
  const sourceRow = source.addSource();
  const fanout = new MirrorFanout(source.endpoint, new Map([["cache", cache.endpoint]]));
  cache.failInsertOnce = true;
  const firstWarnings = await fanout.onIngest({
    source: sourceRow,
    prepared: {
      mode: sourceRow.chunkingMode,
      chunkSize: sourceRow.chunkSize,
      chunks: source.state.chunks.get(sourceRow.id)!.map(({ content }) => content),
      contentHash: sourceRow.contentHash,
      representationHash: sourceRow.representationHash,
      metadata: sourceRow.metadata,
      metadataHash: sourceRow.metadataHash,
    },
  });
  assert.match(firstWarnings[0] ?? "", /Mirror cache failed/);
  assert.equal(cache.state.receipts.size, 0);
  const secondWarnings = await fanout.onIngest({
    source: sourceRow,
    prepared: {
      mode: sourceRow.chunkingMode,
      chunkSize: sourceRow.chunkSize,
      chunks: source.state.chunks.get(sourceRow.id)!.map(({ content }) => content),
      contentHash: sourceRow.contentHash,
      representationHash: sourceRow.representationHash,
      metadata: sourceRow.metadata,
      metadataHash: sourceRow.metadataHash,
    },
  });
  assert.deepEqual(secondWarnings, []);
  assert.equal(cache.state.receipts.size, 1);
});

test("mirror targets with one fingerprint share embedding work", async () => {
  const source = new MemoryEndpoint({ name: "source", model: "source", mirrors: ["one", "two"] });
  const one = new MemoryEndpoint({ name: "one", model: "target" });
  const two = new MemoryEndpoint({ name: "two", model: "target" });
  const sourceRow = source.addSource();
  const fanout = new MirrorFanout(
    source.endpoint,
    new Map([
      ["one", one.endpoint],
      ["two", two.endpoint],
    ]),
  );
  const warnings = await fanout.onIngest({
    source: sourceRow,
    prepared: {
      mode: sourceRow.chunkingMode,
      chunkSize: sourceRow.chunkSize,
      chunks: source.state.chunks.get(sourceRow.id)!.map(({ content }) => content),
      contentHash: sourceRow.contentHash,
      representationHash: sourceRow.representationHash,
      metadata: sourceRow.metadata,
      metadataHash: sourceRow.metadataHash,
    },
  });
  assert.deepEqual(warnings, []);
  assert.equal(one.embeddingCalls + two.embeddingCalls, 1);
  assert.equal(one.state.sources.size, 1);
  assert.equal(two.state.sources.size, 1);
});
