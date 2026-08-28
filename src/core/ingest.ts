import {
  ConcurrentModificationError,
  SourceKeyConflictError,
} from "./errors.js";
import { embedChunks } from "./embedding.js";
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
      embeddings = await embedChunks(
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
