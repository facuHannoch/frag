export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type Metadata = Readonly<Record<string, JsonValue>>;

export type ChunkingMode = "manual" | "explicit" | "auto";
export type Operation = "promote" | "mirror";
export type ApiStyle = "openai" | "azure-openai";
export type TokenCounterKind = "tiktoken" | "endpoint" | "estimate";

export interface EmbedderConfig {
  readonly name: string;
  readonly apiStyle: ApiStyle;
  readonly baseUrl?: string;
  readonly baseUrlEnv?: string;
  readonly model: string;
  readonly revision: string;
  readonly dim: number;
  readonly maxTokens: number;
  readonly recommendedChunkSize: number;
  readonly tokenCounter: TokenCounterKind;
  readonly tokenSafetyMargin?: number;
  readonly apiKeyEnv: string | null;
  readonly fingerprint: string;
}

export interface DatabaseConfig {
  readonly name: string;
  readonly urlEnv: string;
}

export interface MirrorConfig {
  readonly target: string;
}

export interface CollectionConfig {
  readonly name: string;
  readonly description: string;
  readonly embedder: string;
  readonly db: string;
  readonly stateBackend: "same-as-db";
  readonly mirrors: readonly MirrorConfig[];
}

export interface FragConfig {
  readonly collections: ReadonlyMap<string, CollectionConfig>;
  readonly embedders: ReadonlyMap<string, EmbedderConfig>;
  readonly dbs: ReadonlyMap<string, DatabaseConfig>;
}

export interface SourceOrigin {
  readonly collection: string;
  readonly sourceKey: string;
}

export interface Source {
  readonly id: number;
  readonly collection: string;
  readonly sourceKey: string;
  readonly content: string;
  readonly contentHash: string;
  readonly representationHash: string;
  readonly metadataHash: string;
  readonly embeddingFingerprint: string;
  readonly embeddingDim: number;
  readonly chunkingMode: ChunkingMode;
  readonly chunkSize: number | null;
  readonly metadata: Metadata;
  readonly origin: SourceOrigin | null;
  readonly rowVersion: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredChunk {
  readonly id: string | number;
  readonly sourceId: number;
  readonly collection: string;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly contentHash: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly metadata: Metadata;
}

export interface SourceSnapshot {
  readonly source: Source | null;
  readonly rowVersion: bigint | null;
}

export interface WriteResult {
  readonly source_id: number;
  readonly chunks_inserted: number;
  readonly changed: boolean;
  readonly reembedded: boolean;
  readonly warnings?: readonly string[];
}

export interface SearchOptions {
  readonly limit?: number;
}

export interface SearchResult {
  readonly sourceKey: string;
  readonly content: string;
  readonly score: number;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly metadata: Metadata;
}

export interface SearchResponse {
  readonly results: readonly SearchResult[];
  readonly stale_embeddings?: boolean;
}

export interface ReindexResult {
  readonly dryRun: boolean;
  readonly sources: number;
  readonly chunks: number;
  readonly configuredFingerprint: string;
  readonly storedFingerprintGroups: Readonly<Record<string, number>>;
}

export interface TokenCounter {
  count(text: string): Promise<number>;
  isExact(): boolean;
}

export interface Embedder {
  readonly config: EmbedderConfig;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
