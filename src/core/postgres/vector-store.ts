import { contentHash } from "../hash.js";
import type { Queryable, Tx, VectorStore } from "../store.js";
import type { Metadata, StoredChunk, VectorSearchResult } from "../types.js";
import { chunkTable, parseVector, vectorLiteral } from "./sql.js";

type ChunkRow = Record<string, unknown> & {
  id: string | number;
  source_id: string | number;
  collection: string;
  content: string;
  embedding: unknown;
  content_hash: string;
  chunk_index: number;
  chunk_count: number;
  metadata: Metadata;
};

function safeNumber(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} is outside JavaScript safe range`);
  return parsed;
}

function storedChunk(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    sourceId: safeNumber(row.source_id, "source id"),
    collection: row.collection,
    content: row.content,
    embedding: parseVector(row.embedding),
    contentHash: row.content_hash,
    chunkIndex: Number(row.chunk_index),
    chunkCount: Number(row.chunk_count),
    metadata: row.metadata,
  };
}

export class PostgresVectorStore implements VectorStore {
  readonly #database: Queryable;

  constructor(database: Queryable) {
    this.#database = database;
  }

  async insertChunk(
    tx: Tx,
    collection: string,
    sourceId: number,
    content: string,
    embedding: readonly number[],
    chunkIndex: number,
    chunkCount: number,
    metadata: Metadata,
  ): Promise<{ id: string | number }> {
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
      throw new RangeError("Invalid chunk position");
    }
    const table = chunkTable(embedding.length);
    const result = await tx.query<Record<string, unknown> & { id: string | number }>(
      `INSERT INTO ${table} (
         source_id, collection, content, embedding, content_hash,
         chunk_index, chunk_count, metadata
       ) VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8::jsonb)
       RETURNING id`,
      [
        sourceId,
        collection,
        content,
        vectorLiteral(embedding),
        contentHash(content),
        chunkIndex,
        chunkCount,
        JSON.stringify(metadata),
      ],
    );
    return { id: result.rows[0]!.id };
  }

  async similaritySearch(
    collection: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Search limit must be positive");
    const table = chunkTable(embedding.length);
    const result = await this.#database.query<
      Record<string, unknown> & {
        source_key: string;
        content: string;
        score: string | number;
        chunk_index: number;
        chunk_count: number;
        metadata: Metadata;
      }
    >(
      `SELECT s.source_key, c.content,
              1 - (c.embedding <=> $2::vector) AS score,
              c.chunk_index, c.chunk_count, s.metadata
       FROM ${table} c
       JOIN sources s ON s.id = c.source_id
       WHERE c.collection = $1
       ORDER BY c.embedding <=> $2::vector
       LIMIT $3`,
      [collection, vectorLiteral(embedding), limit],
    );
    return result.rows.map((row) => ({
      sourceKey: row.source_key,
      content: row.content,
      score: Number(row.score),
      chunkIndex: Number(row.chunk_index),
      chunkCount: Number(row.chunk_count),
      metadata: row.metadata,
    }));
  }

  async listChunksBySource(
    sourceId: number,
    embeddingDim: number,
    queryable: Queryable = this.#database,
  ): Promise<StoredChunk[]> {
    const table = chunkTable(embeddingDim);
    const result = await queryable.query<ChunkRow>(
      `SELECT id, source_id, collection, content, embedding, content_hash,
              chunk_index, chunk_count, metadata
       FROM ${table} WHERE source_id = $1 ORDER BY chunk_index`,
      [sourceId],
    );
    return result.rows.map(storedChunk);
  }

  async deleteChunksBySource(tx: Tx, sourceId: number, embeddingDim: number): Promise<void> {
    await tx.query(`DELETE FROM ${chunkTable(embeddingDim)} WHERE source_id = $1`, [sourceId]);
  }

  async updateChunkEmbeddings(
    tx: Tx,
    sourceId: number,
    embeddingDim: number,
    embeddings: readonly (readonly number[])[],
  ): Promise<void> {
    const table = chunkTable(embeddingDim);
    for (const [index, embedding] of embeddings.entries()) {
      const result = await tx.query(
        `UPDATE ${table} SET embedding = $3::vector
         WHERE source_id = $1 AND chunk_index = $2`,
        [sourceId, index, vectorLiteral(embedding, embeddingDim)],
      );
      if (result.rowCount !== 1) {
        throw new RangeError(`Missing chunk ${index} while updating source ${sourceId}`);
      }
    }
    const count = await tx.query<Record<string, unknown> & { count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE source_id = $1`,
      [sourceId],
    );
    if (Number(count.rows[0]?.count ?? -1) !== embeddings.length) {
      throw new RangeError(`Embedding count does not match stored chunks for source ${sourceId}`);
    }
  }

  async updateChunkMetadata(
    tx: Tx,
    sourceId: number,
    embeddingDim: number,
    metadata: Metadata,
  ): Promise<void> {
    await tx.query(`UPDATE ${chunkTable(embeddingDim)} SET metadata = $2::jsonb WHERE source_id = $1`, [
      sourceId,
      JSON.stringify(metadata),
    ]);
  }
}
