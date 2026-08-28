import { ConcurrentModificationError } from "../errors.js";
import type { Queryable, SourceStore, Tx } from "../store.js";
import type {
  Metadata,
  NewSource,
  RepresentationUpdate,
  Source,
  SourceSnapshot,
} from "../types.js";

type SourceRow = Record<string, unknown> & {
  id: string | number;
  collection: string;
  source_key: string;
  content: string;
  content_hash: string;
  representation_hash: string;
  metadata_hash: string;
  embedding_fingerprint: string;
  embedding_dim: number;
  chunking_mode: "manual" | "explicit" | "auto";
  chunk_size: number | null;
  metadata: Metadata;
  origin_collection: string | null;
  origin_source_key: string | null;
  row_version: string | number | bigint;
  created_at: Date | string;
  updated_at: Date | string;
};

function safeId(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`Source id is outside JavaScript safe range: ${value}`);
  return result;
}

function sourceFromRow(row: SourceRow): Source {
  return {
    id: safeId(row.id),
    collection: row.collection,
    sourceKey: row.source_key,
    content: row.content,
    contentHash: row.content_hash,
    representationHash: row.representation_hash,
    metadataHash: row.metadata_hash,
    embeddingFingerprint: row.embedding_fingerprint,
    embeddingDim: Number(row.embedding_dim),
    chunkingMode: row.chunking_mode,
    chunkSize: row.chunk_size === null ? null : Number(row.chunk_size),
    metadata: row.metadata,
    origin:
      row.origin_collection === null || row.origin_source_key === null
        ? null
        : { collection: row.origin_collection, sourceKey: row.origin_source_key },
    rowVersion: BigInt(row.row_version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const sourceColumns = `
  id, collection, source_key, content, content_hash, representation_hash,
  metadata_hash, embedding_fingerprint, embedding_dim, chunking_mode, chunk_size,
  metadata, origin_collection, origin_source_key, row_version, created_at, updated_at
`;

export class PostgresSourceStore implements SourceStore {
  readonly #database: Queryable;

  constructor(database: Queryable) {
    this.#database = database;
  }

  async get(
    collection: string,
    sourceKey: string,
    queryable: Queryable = this.#database,
  ): Promise<SourceSnapshot> {
    const result = await queryable.query<SourceRow>(
      `SELECT ${sourceColumns} FROM sources WHERE collection = $1 AND source_key = $2`,
      [collection, sourceKey],
    );
    const row = result.rows[0];
    if (row === undefined) return { source: null, rowVersion: null };
    const source = sourceFromRow(row);
    return { source, rowVersion: source.rowVersion };
  }

  async list(collection: string, queryable: Queryable = this.#database): Promise<Source[]> {
    const result = await queryable.query<SourceRow>(
      `SELECT ${sourceColumns} FROM sources WHERE collection = $1 ORDER BY source_key`,
      [collection],
    );
    return result.rows.map(sourceFromRow);
  }

  async listStale(
    collection: string,
    currentFingerprint: string,
    embeddingDim: number,
    queryable: Queryable = this.#database,
  ): Promise<Source[]> {
    const result = await queryable.query<SourceRow>(
      `SELECT ${sourceColumns}
       FROM sources
       WHERE collection = $1 AND embedding_dim = $2 AND embedding_fingerprint <> $3
       ORDER BY source_key`,
      [collection, embeddingDim, currentFingerprint],
    );
    return result.rows.map(sourceFromRow);
  }

  async listDimensions(collection: string, queryable: Queryable = this.#database): Promise<number[]> {
    const result = await queryable.query<Record<string, unknown> & { embedding_dim: number }>(
      "SELECT DISTINCT embedding_dim FROM sources WHERE collection = $1 ORDER BY embedding_dim",
      [collection],
    );
    return result.rows.map(({ embedding_dim }) => Number(embedding_dim));
  }

  async insert(tx: Tx, input: NewSource): Promise<Source> {
    const result = await tx.query<SourceRow>(
      `INSERT INTO sources (
         collection, source_key, content, content_hash, representation_hash,
         metadata_hash, embedding_fingerprint, embedding_dim, chunking_mode,
         chunk_size, metadata, origin_collection, origin_source_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       RETURNING ${sourceColumns}`,
      [
        input.collection,
        input.sourceKey,
        input.content,
        input.contentHash,
        input.representationHash,
        input.metadataHash,
        input.embeddingFingerprint,
        input.embeddingDim,
        input.chunkingMode,
        input.chunkSize,
        JSON.stringify(input.metadata),
        input.origin?.collection ?? null,
        input.origin?.sourceKey ?? null,
      ],
    );
    return sourceFromRow(result.rows[0]!);
  }

  async updateRepresentation(
    tx: Tx,
    sourceId: number,
    expectedRowVersion: bigint,
    input: RepresentationUpdate,
  ): Promise<Source> {
    const result = await tx.query<SourceRow>(
      `UPDATE sources SET
         content = $3, content_hash = $4, representation_hash = $5,
         metadata_hash = $6, embedding_fingerprint = $7, embedding_dim = $8,
         chunking_mode = $9, chunk_size = $10, metadata = $11::jsonb,
         row_version = row_version + 1, updated_at = now()
       WHERE id = $1 AND row_version = $2
       RETURNING ${sourceColumns}`,
      [
        sourceId,
        expectedRowVersion.toString(),
        input.content,
        input.contentHash,
        input.representationHash,
        input.metadataHash,
        input.embeddingFingerprint,
        input.embeddingDim,
        input.chunkingMode,
        input.chunkSize,
        JSON.stringify(input.metadata),
      ],
    );
    return this.#updatedOrThrow(result.rows[0], sourceId);
  }

  async updateMetadata(
    tx: Tx,
    sourceId: number,
    expectedRowVersion: bigint,
    metadata: Metadata,
    metadataHash: string,
  ): Promise<Source> {
    const result = await tx.query<SourceRow>(
      `UPDATE sources SET metadata = $3::jsonb, metadata_hash = $4,
         row_version = row_version + 1, updated_at = now()
       WHERE id = $1 AND row_version = $2
       RETURNING ${sourceColumns}`,
      [sourceId, expectedRowVersion.toString(), JSON.stringify(metadata), metadataHash],
    );
    return this.#updatedOrThrow(result.rows[0], sourceId);
  }

  async updateEmbeddingIdentity(
    tx: Tx,
    sourceId: number,
    expectedRowVersion: bigint,
    fingerprint: string,
    dim: number,
  ): Promise<Source> {
    const result = await tx.query<SourceRow>(
      `UPDATE sources SET embedding_fingerprint = $3, embedding_dim = $4,
         row_version = row_version + 1, updated_at = now()
       WHERE id = $1 AND row_version = $2
       RETURNING ${sourceColumns}`,
      [sourceId, expectedRowVersion.toString(), fingerprint, dim],
    );
    return this.#updatedOrThrow(result.rows[0], sourceId);
  }

  async delete(tx: Tx, collection: string, sourceKey: string): Promise<void> {
    await tx.query("DELETE FROM sources WHERE collection = $1 AND source_key = $2", [
      collection,
      sourceKey,
    ]);
  }

  #updatedOrThrow(row: SourceRow | undefined, sourceId: number): Source {
    if (row === undefined) {
      throw new ConcurrentModificationError("<by-id>", String(sourceId));
    }
    return sourceFromRow(row);
  }
}
