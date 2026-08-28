import { createHash } from "node:crypto";

import type { Queryable, Tx } from "../store.js";

export function assertEmbeddingDimension(dim: number): number {
  if (!Number.isSafeInteger(dim) || dim <= 0) {
    throw new RangeError(`Invalid embedding dimension: ${dim}`);
  }
  return dim;
}

export function chunkTable(dim: number): string {
  return `chunks_${assertEmbeddingDimension(dim)}`;
}

export function vectorLiteral(embedding: readonly number[], expectedDim = embedding.length): string {
  assertEmbeddingDimension(expectedDim);
  if (embedding.length !== expectedDim) {
    throw new RangeError(`Expected a ${expectedDim}-dimensional embedding, received ${embedding.length}`);
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Embedding contains a non-finite value");
  }
  return `[${embedding.join(",")}]`;
}

export function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    const parsed = value.map(Number);
    if (parsed.some((item) => !Number.isFinite(item))) throw new TypeError("Invalid vector value");
    return parsed;
  }
  if (typeof value !== "string" || !value.startsWith("[") || !value.endsWith("]")) {
    throw new TypeError("Invalid vector value returned by Postgres");
  }
  if (value === "[]") return [];
  const parsed = value.slice(1, -1).split(",").map(Number);
  if (parsed.some((item) => !Number.isFinite(item))) throw new TypeError("Invalid vector value");
  return parsed;
}

export function advisoryLockKey(namespace: string, collection: string, sourceKey: string): bigint {
  const hash = createHash("sha256");
  for (const field of ["frag:source-lock:v1", namespace, collection, sourceKey]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest().readBigInt64BE(0);
}

export async function acquireSourceLock(
  tx: Tx,
  namespace: string,
  collection: string,
  sourceKey: string,
): Promise<void> {
  const key = advisoryLockKey(namespace, collection, sourceKey);
  await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [key.toString()]);
}

export async function bootstrapSchema(queryable: Queryable, dimensions: Iterable<number>): Promise<void> {
  const uniqueDimensions = [...new Set([...dimensions].map(assertEmbeddingDimension))].sort(
    (left, right) => left - right,
  );

  await queryable.query("CREATE EXTENSION IF NOT EXISTS vector");
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id BIGSERIAL PRIMARY KEY,
      collection TEXT NOT NULL,
      source_key TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      representation_hash TEXT NOT NULL,
      metadata_hash TEXT NOT NULL,
      embedding_fingerprint TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL CHECK (embedding_dim > 0),
      chunking_mode TEXT NOT NULL CHECK (chunking_mode IN ('manual', 'explicit', 'auto')),
      chunk_size INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      origin_collection TEXT,
      origin_source_key TEXT,
      row_version BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (collection, source_key),
      CHECK (
        (origin_collection IS NULL AND origin_source_key IS NULL) OR
        (origin_collection IS NOT NULL AND origin_source_key IS NOT NULL)
      )
    )
  `);
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS sources_collection_fingerprint_idx ON sources (collection, embedding_fingerprint)",
  );
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS sources_collection_dim_idx ON sources (collection, embedding_dim)",
  );
  await queryable.query(
    "CREATE INDEX IF NOT EXISTS sources_origin_idx ON sources (collection, origin_collection, origin_source_key)",
  );
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS _frag_state (
      id BIGSERIAL PRIMARY KEY,
      source_collection TEXT NOT NULL,
      source_key TEXT NOT NULL,
      target_collection TEXT NOT NULL,
      target_source_key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('promote', 'mirror')),
      ref TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (target_collection, target_source_key)
    )
  `);

  for (const dim of uniqueDimensions) {
    const table = chunkTable(dim);
    await queryable.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id BIGSERIAL PRIMARY KEY,
        source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        collection TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding VECTOR(${dim}) NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
        chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_id, chunk_index),
        CHECK (chunk_index < chunk_count)
      )
    `);
    await queryable.query(
      `CREATE INDEX IF NOT EXISTS ${table}_collection_idx ON ${table} (collection)`,
    );
    await queryable.query(`CREATE INDEX IF NOT EXISTS ${table}_source_idx ON ${table} (source_id)`);
    await queryable.query(
      `CREATE INDEX IF NOT EXISTS ${table}_content_hash_idx ON ${table} (content_hash)`,
    );
    await queryable.query(
      `CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx ON ${table} USING hnsw (embedding vector_cosine_ops)`,
    );
  }
}
