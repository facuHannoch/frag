import assert from "node:assert/strict";
import test from "node:test";

import {
  ConcurrentModificationError,
  PostgresSourceStore,
  PostgresStateStore,
  PostgresVectorStore,
  acquireSourceLock,
  advisoryLockKey,
  bootstrapSchema,
  chunkTable,
  parseVector,
  vectorLiteral,
  type Metadata,
  type QueryResult,
  type Queryable,
  type Tx,
} from "../../src/core/index.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

class Recorder implements Queryable {
  readonly queries: RecordedQuery[] = [];
  responses: QueryResult[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as QueryResult<Row>;
  }

  asTx(): Tx {
    return this as unknown as Tx;
  }
}

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "7",
    collection: "notes",
    source_key: "entry",
    content: "hello",
    content_hash: "content",
    representation_hash: "representation",
    metadata_hash: "metadata",
    embedding_fingerprint: "fingerprint-old",
    embedding_dim: 768,
    chunking_mode: "manual",
    chunk_size: null,
    metadata: { status: "draft" },
    origin_collection: null,
    origin_source_key: null,
    row_version: "3",
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

test("schema bootstrap is deterministic, idempotent SQL for unique dimensions", async () => {
  const recorder = new Recorder();
  await bootstrapSchema(recorder, [1536, 768, 768]);
  const sql = recorder.queries.map(({ text }) => text).join("\n");
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sources/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS _frag_state/);
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS chunks_768/g) ?? []).length, 1);
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS chunks_1536/g) ?? []).length, 1);
  assert.match(sql, /UNIQUE \(source_id, chunk_index\)/);
  assert.match(sql, /UNIQUE \(target_collection, target_source_key\)/);
  assert.equal(sql.includes("chunks_768_embedding_hnsw_idx"), true);
});

test("dimension identifiers and vector literals are validated before SQL", () => {
  assert.equal(chunkTable(768), "chunks_768");
  assert.throws(() => chunkTable(Number.NaN), RangeError);
  assert.throws(() => chunkTable(1.5), RangeError);
  assert.equal(vectorLiteral([0, -1.5, 2]), "[0,-1.5,2]");
  assert.throws(() => vectorLiteral([1], 2), RangeError);
  assert.throws(() => vectorLiteral([Number.POSITIVE_INFINITY]), RangeError);
  assert.deepEqual(parseVector("[1,-2.5,0]"), [1, -2.5, 0]);
  assert.throws(() => parseVector("not-a-vector"), TypeError);
});

test("advisory source lock is stable, namespaced, and uses a bigint parameter", async () => {
  const first = advisoryLockKey("db", "notes", "entry");
  assert.equal(first, advisoryLockKey("db", "notes", "entry"));
  assert.notEqual(first, advisoryLockKey("db", "notes", "other"));
  assert.notEqual(first, advisoryLockKey("other-db", "notes", "entry"));

  const recorder = new Recorder();
  await acquireSourceLock(recorder.asTx(), "db", "notes", "entry");
  assert.match(recorder.queries[0]!.text, /pg_advisory_xact_lock\(\$1::bigint\)/);
  assert.equal(recorder.queries[0]!.values[0], first.toString());
});

test("source metadata update preserves vector identity columns in SQL", async () => {
  const recorder = new Recorder();
  recorder.responses.push({ rows: [sourceRow({ metadata: { status: "approved" }, row_version: "4" })], rowCount: 1 });
  const store = new PostgresSourceStore(recorder);
  const updated = await store.updateMetadata(
    recorder.asTx(),
    7,
    3n,
    { status: "approved" } as Metadata,
    "new-metadata",
  );
  const sql = recorder.queries[0]!.text;
  assert.match(sql, /metadata = \$3::jsonb/);
  assert.match(sql, /row_version = row_version \+ 1/);
  assert.equal(sql.includes("embedding_fingerprint ="), false);
  assert.equal(sql.includes("embedding_dim ="), false);
  assert.equal(updated.embeddingFingerprint, "fingerprint-old");
  assert.equal(updated.rowVersion, 4n);
});

test("guarded source updates surface concurrent modification", async () => {
  const recorder = new Recorder();
  const store = new PostgresSourceStore(recorder);
  await assert.rejects(
    store.updateEmbeddingIdentity(recorder.asTx(), 7, 3n, "new", 768),
    ConcurrentModificationError,
  );
});

test("state store replaces and removes the single current target receipt", async () => {
  const recorder = new Recorder();
  const store = new PostgresStateStore(recorder);
  await store.replaceReceipt(
    recorder.asTx(),
    "mirror",
    "source",
    "entry",
    "cache",
    "entry",
    "ref-1",
  );
  assert.match(
    recorder.queries[0]!.text,
    /ON CONFLICT \(target_collection, target_source_key\) DO UPDATE/,
  );
  await store.deleteTargetReceipt(recorder.asTx(), "cache", "entry");
  assert.match(recorder.queries[1]!.text, /DELETE FROM _frag_state/);
});

test("vector store keeps positional duplicates and validates replacement counts", async () => {
  const recorder = new Recorder();
  recorder.responses.push({ rows: [{ id: "11" }], rowCount: 1 });
  const store = new PostgresVectorStore(recorder);
  await store.insertChunk(recorder.asTx(), "notes", 7, "same", [0, 1], 0, 2, {});
  recorder.responses.push({ rows: [{ id: "12" }], rowCount: 1 });
  await store.insertChunk(recorder.asTx(), "notes", 7, "same", [0, 1], 1, 2, {});
  assert.equal(recorder.queries[0]!.values[4], recorder.queries[1]!.values[4]);
  assert.notEqual(recorder.queries[0]!.values[5], recorder.queries[1]!.values[5]);

  const updates = new Recorder();
  updates.responses.push({ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 });
  updates.responses.push({ rows: [{ count: "2" }], rowCount: 1 });
  await new PostgresVectorStore(updates).updateChunkEmbeddings(
    updates.asTx(),
    7,
    2,
    [
      [1, 0],
      [0, 1],
    ],
  );
  assert.equal(updates.queries.filter(({ text }) => /SET embedding/.test(text)).length, 2);
});
