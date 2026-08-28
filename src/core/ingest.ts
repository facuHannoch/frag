import {
  ConcurrentModificationError,
  EmbedderLengthError,
  SourceKeyConflictError,
} from "./errors.js";
import { prepareRepresentation, validateChunkLimits } from "./chunking.js";
import { acquireSourceLock } from "./postgres/sql.js";
import type { SourceStore, Transactional, Tx, VectorStore } from "./store.js";
import type {
  CollectionConfig,
  Embedder,
  EmbedderConfig,
  IngestInput,
  PreparedRepresentation,
  Source,
  SourceSnapshot,
  TokenCounter,
  WriteResult,
} from "./types.js";
import { assertCollectionDimension } from "./collection-status.js";

export interface MirrorIngestEvent {
  readonly source: Source;
  readonly prepared: PreparedRepresentation;
  readonly embeddings?: readonly (readonly number[])[];
}

export interface MirrorDispatcher {
  onIngest(event: MirrorIngestEvent): Promise<readonly string[]>;
}

export interface IngestServiceDependencies {
  readonly collection: CollectionConfig;
  readonly embedderConfig: EmbedderConfig;
  readonly embedder: Embedder;
  readonly tokenCounter: TokenCounter;
  readonly sourceStore: SourceStore;
  readonly vectorStore: VectorStore;
  readonly transactional: Transactional;
  readonly lockNamespace: string;
  readonly mirrors?: MirrorDispatcher;
}

function generatedSourceKey(hash: string): string {
  return `note-${hash.slice(0, 16)}`;
}

function sameSnapshot(initial: SourceSnapshot, current: SourceSnapshot): boolean {
  if (initial.source === null || current.source === null) {
    return initial.source === null && current.source === null;
  }
  return initial.source.id === current.source.id && initial.rowVersion === current.rowVersion;
}

function providerLengthIndex(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { chunkIndex?: unknown }).chunkIndex;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function isProviderLengthError(error: unknown): boolean {
  if (error instanceof EmbedderLengthError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return (
    candidate.status === 413 ||
    (candidate.status === 400 && /(token|context|length|too long)/u.test(message)) ||
    /(context_length|too_many_tokens|input_too_long)/u.test(code)
  );
}

async function validateEmbeddings(
  embeddings: readonly (readonly number[])[],
  expectedCount: number,
  expectedDim: number,
): Promise<readonly (readonly number[])[]> {
  if (embeddings.length !== expectedCount) {
    throw new RangeError(`Embedder returned ${embeddings.length} vectors for ${expectedCount} chunks`);
  }
  for (const [index, embedding] of embeddings.entries()) {
    if (embedding.length !== expectedDim || embedding.some((value) => !Number.isFinite(value))) {
      throw new RangeError(`Embedder returned an invalid vector for chunk ${index}`);
    }
  }
  return embeddings;
}

async function embedPrepared(
  embedder: Embedder,
  sourceKey: string,
  chunks: readonly string[],
  expectedDim: number,
): Promise<readonly (readonly number[])[]> {
  try {
    return await validateEmbeddings(await embedder.embed(chunks), chunks.length, expectedDim);
  } catch (error) {
    if (!isProviderLengthError(error)) throw error;
    if (error instanceof EmbedderLengthError) throw error;
    const identified = providerLengthIndex(error);
    if (identified !== null && identified < chunks.length) {
      throw new EmbedderLengthError(sourceKey, identified, { cause: error });
    }
    if (chunks.length === 1) {
      throw new EmbedderLengthError(sourceKey, 0, { cause: error });
    }

    const isolated: (readonly number[])[] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      try {
        const result = await embedder.embed([chunk]);
        isolated.push(...(await validateEmbeddings(result, 1, expectedDim)));
      } catch (individualError) {
        if (isProviderLengthError(individualError)) {
          throw new EmbedderLengthError(sourceKey, chunkIndex, { cause: individualError });
        }
        throw individualError;
      }
    }
    return isolated;
  }
}

export class IngestService {
  readonly #dependencies: IngestServiceDependencies;

  constructor(dependencies: IngestServiceDependencies) {
    if (dependencies.collection.embedder !== dependencies.embedderConfig.name) {
      throw new TypeError("Collection and embedder configuration do not match");
    }
    if (dependencies.embedder.config.fingerprint !== dependencies.embedderConfig.fingerprint) {
      throw new TypeError("Embedder instance and configuration fingerprints do not match");
    }
    this.#dependencies = dependencies;
  }

  async ingest(input: IngestInput): Promise<WriteResult> {
    const dependencies = this.#dependencies;
    if (input.collection !== dependencies.collection.name) {
      throw new TypeError(`Ingest service for ${dependencies.collection.name} cannot write ${input.collection}`);
    }
    await this.#assertDimensionValid();
    const prepared = await prepareRepresentation(
      input,
      dependencies.embedderConfig,
      dependencies.tokenCounter,
    );
    const sourceKey = input.sourceKey ?? generatedSourceKey(prepared.contentHash);
    const initial = await dependencies.sourceStore.get(input.collection, sourceKey);
    if (initial.source?.origin !== null && initial.source !== null) {
      throw new SourceKeyConflictError(input.collection, sourceKey, {
        collection: initial.source.origin.collection,
        sourceKey: initial.source.origin.sourceKey,
      });
    }

    const representationChanged =
      initial.source === null ||
      initial.source.contentHash !== prepared.contentHash ||
      initial.source.representationHash !== prepared.representationHash;
    const metadataChanged = initial.source === null || initial.source.metadataHash !== prepared.metadataHash;
    let source: Source;
    let changed = false;
    let reembedded = false;
    let chunksInserted = 0;
    let embeddings: readonly (readonly number[])[] | undefined;
    const warnings: string[] = [];

    if (representationChanged) {
      const counts = await validateChunkLimits(
        sourceKey,
        prepared.chunks,
        dependencies.embedderConfig,
        dependencies.tokenCounter,
      );
      if (
        prepared.mode === "manual" &&
        counts[0]! > dependencies.embedderConfig.recommendedChunkSize
      ) {
        warnings.push(
          `Manual chunk is ${counts[0]} tokens; recommended size is ${dependencies.embedderConfig.recommendedChunkSize}`,
        );
      }
      embeddings = await embedPrepared(
        dependencies.embedder,
        sourceKey,
        prepared.chunks,
        dependencies.embedderConfig.dim,
      );
      source = await dependencies.transactional.withTransaction(async (tx) => {
        await this.#lockAndRevalidate(tx, sourceKey, initial);
        let persisted: Source;
        if (initial.source === null) {
          persisted = await dependencies.sourceStore.insert(tx, {
            collection: input.collection,
            sourceKey,
            content: input.content,
            contentHash: prepared.contentHash,
            representationHash: prepared.representationHash,
            metadataHash: prepared.metadataHash,
            embeddingFingerprint: dependencies.embedderConfig.fingerprint,
            embeddingDim: dependencies.embedderConfig.dim,
            chunkingMode: prepared.mode,
            chunkSize: prepared.chunkSize,
            metadata: prepared.metadata,
            origin: null,
          });
        } else {
          await dependencies.vectorStore.deleteChunksBySource(
            tx,
            initial.source.id,
            initial.source.embeddingDim,
          );
          persisted = await dependencies.sourceStore.updateRepresentation(
            tx,
            initial.source.id,
            initial.source.rowVersion,
            {
              content: input.content,
              contentHash: prepared.contentHash,
              representationHash: prepared.representationHash,
              metadataHash: prepared.metadataHash,
              embeddingFingerprint: dependencies.embedderConfig.fingerprint,
              embeddingDim: dependencies.embedderConfig.dim,
              chunkingMode: prepared.mode,
              chunkSize: prepared.chunkSize,
              metadata: prepared.metadata,
            },
          );
        }
        for (const [index, chunk] of prepared.chunks.entries()) {
          await dependencies.vectorStore.insertChunk(
            tx,
            input.collection,
            persisted.id,
            chunk,
            embeddings![index]!,
            index,
            prepared.chunks.length,
            prepared.metadata,
          );
        }
        return persisted;
      });
      changed = true;
      reembedded = true;
      chunksInserted = prepared.chunks.length;
    } else if (metadataChanged) {
      source = await dependencies.transactional.withTransaction(async (tx) => {
        await this.#lockAndRevalidate(tx, sourceKey, initial);
        const persisted = await dependencies.sourceStore.updateMetadata(
          tx,
          initial.source!.id,
          initial.source!.rowVersion,
          prepared.metadata,
          prepared.metadataHash,
        );
        await dependencies.vectorStore.updateChunkMetadata(
          tx,
          persisted.id,
          persisted.embeddingDim,
          prepared.metadata,
        );
        return persisted;
      });
      changed = true;
    } else {
      source = initial.source!;
    }

    if (dependencies.mirrors !== undefined) {
      try {
        warnings.push(...(await dependencies.mirrors.onIngest({ source, prepared, ...(embeddings === undefined ? {} : { embeddings }) })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Mirror fan-out failed: ${message}`);
      }
    }

    return {
      source_id: source.id,
      chunks_inserted: chunksInserted,
      changed,
      reembedded,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  async #assertDimensionValid(): Promise<void> {
    await assertCollectionDimension(
      this.#dependencies.collection.name,
      this.#dependencies.embedderConfig,
      this.#dependencies.sourceStore,
    );
  }

  async #lockAndRevalidate(tx: Tx, sourceKey: string, initial: SourceSnapshot): Promise<void> {
    await acquireSourceLock(
      tx,
      this.#dependencies.lockNamespace,
      this.#dependencies.collection.name,
      sourceKey,
    );
    const current = await this.#dependencies.sourceStore.get(
      this.#dependencies.collection.name,
      sourceKey,
      tx,
    );
    if (!sameSnapshot(initial, current)) {
      throw new ConcurrentModificationError(this.#dependencies.collection.name, sourceKey);
    }
  }
}
