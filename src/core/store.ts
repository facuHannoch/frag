import type {
  Metadata,
  NewSource,
  Operation,
  RepresentationUpdate,
  Source,
  SourceSnapshot,
  StateReceipt,
  StoredChunk,
  VectorSearchResult,
} from "./types.js";

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

declare const transactionBrand: unique symbol;

export interface Tx extends Queryable {
  readonly [transactionBrand]: true;
}

export interface Transactional {
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface SourceStore {
  get(collection: string, sourceKey: string, queryable?: Queryable): Promise<SourceSnapshot>;
  list(collection: string, queryable?: Queryable): Promise<Source[]>;
  listStale(
    collection: string,
    currentFingerprint: string,
    embeddingDim: number,
    queryable?: Queryable,
  ): Promise<Source[]>;
  listDimensions(collection: string, queryable?: Queryable): Promise<number[]>;
  insert(tx: Tx, input: NewSource): Promise<Source>;
  updateRepresentation(
    tx: Tx,
    sourceId: number,
    expectedRowVersion: bigint,
    input: RepresentationUpdate,
  ): Promise<Source>;
  updateMetadata(
    tx: Tx,
    sourceId: number,
    expectedRowVersion: bigint,
    metadata: Metadata,
    metadataHash: string,
  ): Promise<Source>;
  updateEmbeddingIdentity(
    tx: Tx,
    sourceId: number,
    expectedRowVersion: bigint,
    fingerprint: string,
    dim: number,
  ): Promise<Source>;
  delete(tx: Tx, collection: string, sourceKey: string): Promise<void>;
}

export interface VectorStore {
  insertChunk(
    tx: Tx,
    collection: string,
    sourceId: number,
    content: string,
    embedding: readonly number[],
    chunkIndex: number,
    chunkCount: number,
    metadata: Metadata,
  ): Promise<{ id: string | number }>;
  similaritySearch(
    collection: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<VectorSearchResult[]>;
  listChunksBySource(
    sourceId: number,
    embeddingDim: number,
    queryable?: Queryable,
  ): Promise<StoredChunk[]>;
  deleteChunksBySource(tx: Tx, sourceId: number, embeddingDim: number): Promise<void>;
  updateChunkEmbeddings(
    tx: Tx,
    sourceId: number,
    embeddingDim: number,
    embeddings: readonly (readonly number[])[],
  ): Promise<void>;
  updateChunkMetadata(
    tx: Tx,
    sourceId: number,
    embeddingDim: number,
    metadata: Metadata,
  ): Promise<void>;
}

export interface StateStore {
  replaceReceipt(
    tx: Tx,
    operation: Operation,
    source: string,
    sourceKey: string,
    target: string,
    targetSourceKey: string,
    ref: string,
  ): Promise<void>;
  hasOperation(
    operation: Operation,
    source: string,
    target: string,
    ref: string,
    queryable?: Queryable,
  ): Promise<boolean>;
  getTargetReceipt(
    target: string,
    targetSourceKey: string,
    queryable?: Queryable,
  ): Promise<StateReceipt | null>;
  deleteTargetReceipt(tx: Tx, target: string, targetSourceKey: string): Promise<void>;
}
