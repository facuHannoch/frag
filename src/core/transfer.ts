import { ChunkTooLongError, ConcurrentModificationError, SourceKeyConflictError } from "./errors.js";
import { splitAutomatically, validateChunkLimits } from "./chunking.js";
import { assertCollectionDimension } from "./collection-status.js";
import { embedChunks } from "./embedding.js";
import { operationRef, representationHash } from "./hash.js";
import type { MirrorDispatcher, MirrorIngestEvent } from "./ingest.js";
import { acquireSourceLock } from "./postgres/sql.js";
import type { SourceStore, StateStore, Transactional, Tx, VectorStore } from "./store.js";
import type {
  ChunkingMode,
  CollectionConfig,
  Embedder,
  EmbedderConfig,
  Operation,
  Source,
  SourceSnapshot,
  StoredChunk,
  TokenCounter,
  TransferResult,
} from "./types.js";

export interface TransferEndpoint {
  readonly collection: CollectionConfig;
  readonly embedderConfig: EmbedderConfig;
  readonly embedder: Embedder;
  readonly tokenCounter: TokenCounter;
  readonly sourceStore: SourceStore;
  readonly vectorStore: VectorStore;
  readonly stateStore: StateStore;
  readonly transactional: Transactional;
  readonly lockNamespace: string;
}

interface ConsistentSource {
  readonly source: Source;
  readonly chunks: readonly StoredChunk[];
}

interface TargetRepresentation {
  readonly mode: ChunkingMode;
  readonly chunkSize: number | null;
  readonly chunks: readonly string[];
  readonly representationHash: string;
  readonly carried: boolean;
}

function sameSnapshot(left: SourceSnapshot, right: SourceSnapshot): boolean {
  if (left.source === null || right.source === null) return left.source === null && right.source === null;
  return left.source.id === right.source.id && left.rowVersion === right.rowVersion;
}

function assertOrigin(target: Source | null, source: Source): void {
  if (target === null) return;
  if (
    target.origin?.collection !== source.collection ||
    target.origin.sourceKey !== source.sourceKey
  ) {
    throw new SourceKeyConflictError(target.collection, target.sourceKey, {
      collection: target.origin?.collection ?? null,
      sourceKey: target.origin?.sourceKey ?? null,
    });
  }
}

async function readConsistentSource(
  endpoint: TransferEndpoint,
  sourceKey: string,
  expected?: Source,
): Promise<ConsistentSource> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await endpoint.sourceStore.get(endpoint.collection.name, sourceKey);
    if (before.source === null) {
      throw new RangeError(`Source ${endpoint.collection.name}/${sourceKey} does not exist`);
    }
    if (
      expected !== undefined &&
      (before.source.id !== expected.id || before.rowVersion !== expected.rowVersion)
    ) {
      throw new ConcurrentModificationError(endpoint.collection.name, sourceKey);
    }
    const chunks = await endpoint.vectorStore.listChunksBySource(
      before.source.id,
      before.source.embeddingDim,
    );
    const after = await endpoint.sourceStore.get(endpoint.collection.name, sourceKey);
    if (sameSnapshot(before, after)) {
      for (const [position, chunk] of chunks.entries()) {
        if (chunk.chunkIndex !== position || chunk.chunkCount !== chunks.length) {
          throw new RangeError(`Stored chunks for ${endpoint.collection.name}/${sourceKey} are not contiguous`);
        }
      }
      return { source: before.source, chunks };
    }
  }
  throw new ConcurrentModificationError(endpoint.collection.name, sourceKey);
}

async function prepareTarget(
  source: Source,
  sourceChunks: readonly StoredChunk[],
  target: TransferEndpoint,
): Promise<TargetRepresentation> {
  const carriedContents = sourceChunks.map(({ content }) => content);
  try {
    await validateChunkLimits(
      source.sourceKey,
      carriedContents,
      target.embedderConfig,
      target.tokenCounter,
    );
    return {
      mode: source.chunkingMode,
      chunkSize: source.chunkSize,
      chunks: carriedContents,
      representationHash: representationHash({
        mode: source.chunkingMode,
        chunkSize: source.chunkSize,
        chunks: carriedContents,
      }),
      carried: true,
    };
  } catch (error) {
    if (!(error instanceof ChunkTooLongError)) throw error;
  }
  const chunkSize = target.embedderConfig.recommendedChunkSize;
  const chunks = await splitAutomatically(source.content, chunkSize, target.tokenCounter);
  await validateChunkLimits(
    source.sourceKey,
    chunks,
    target.embedderConfig,
    target.tokenCounter,
  );
  return {
    mode: "auto",
    chunkSize,
    chunks,
    representationHash: representationHash({ mode: "auto", chunkSize, chunks }),
    carried: false,
  };
}

export class TransferService {
  async promote(
    source: TransferEndpoint,
    target: TransferEndpoint,
    sourceKey: string,
    targetSourceKey = sourceKey,
  ): Promise<TransferResult> {
    if (source.collection.name === target.collection.name) {
      throw new RangeError("Source and target collections must differ");
    }
    const consistent = await readConsistentSource(source, sourceKey);
    return this.#transfer("promote", consistent, target, targetSourceKey, new Map());
  }

  async mirror(
    source: TransferEndpoint,
    target: TransferEndpoint,
    event: MirrorIngestEvent,
    embeddingCache: Map<string, readonly (readonly number[])[]> = new Map(),
  ): Promise<TransferResult> {
    const consistent = await readConsistentSource(source, event.source.sourceKey, event.source);
    return this.#transfer("mirror", consistent, target, event.source.sourceKey, embeddingCache);
  }

  async #transfer(
    operation: Operation,
    consistent: ConsistentSource,
    target: TransferEndpoint,
    targetSourceKey: string,
    embeddingCache: Map<string, readonly (readonly number[])[]>,
  ): Promise<TransferResult> {
    const source = consistent.source;
    await assertCollectionDimension(
      target.collection.name,
      target.embedderConfig,
      target.sourceStore,
    );
    const ref = operationRef({
      sourceKey: source.sourceKey,
      contentHash: source.contentHash,
      representationHash: source.representationHash,
      metadataHash: source.metadataHash,
      targetSourceKey,
      targetEmbeddingFingerprint: target.embedderConfig.fingerprint,
    });
    if (
      await target.stateStore.hasOperation(
        operation,
        source.collection,
        target.collection.name,
        ref,
      )
    ) {
      return {
        operation,
        sourceCollection: source.collection,
        sourceKey: source.sourceKey,
        targetCollection: target.collection.name,
        targetSourceKey,
        skipped: true,
        changed: false,
        reembedded: false,
        reusedVectors: false,
      };
    }

    const prepared = await prepareTarget(source, consistent.chunks, target);
    const initialTarget = await target.sourceStore.get(target.collection.name, targetSourceKey);
    assertOrigin(initialTarget.source, source);
    const targetRepresentationCurrent =
      initialTarget.source !== null &&
      initialTarget.source.contentHash === source.contentHash &&
      initialTarget.source.representationHash === prepared.representationHash &&
      initialTarget.source.embeddingFingerprint === target.embedderConfig.fingerprint &&
      initialTarget.source.embeddingDim === target.embedderConfig.dim;
    const metadataOnly =
      targetRepresentationCurrent && initialTarget.source!.metadataHash !== source.metadataHash;
    const receiptOnly =
      targetRepresentationCurrent && initialTarget.source!.metadataHash === source.metadataHash;

    let embeddings: readonly (readonly number[])[] | undefined;
    let reusedVectors = false;
    let reembedded = false;
    if (!metadataOnly && !receiptOnly) {
      const cacheKey = `${target.embedderConfig.fingerprint}:${prepared.representationHash}`;
      if (
        prepared.carried &&
        source.embeddingFingerprint === target.embedderConfig.fingerprint &&
        source.embeddingDim === target.embedderConfig.dim
      ) {
        embeddings = consistent.chunks.map(({ embedding }) => embedding);
        embeddingCache.set(cacheKey, embeddings);
        reusedVectors = true;
      } else {
        embeddings = embeddingCache.get(cacheKey);
        if (embeddings === undefined) {
          embeddings = await embedChunks(
            target.embedder,
            source.sourceKey,
            prepared.chunks,
            target.embedderConfig.dim,
          );
          embeddingCache.set(cacheKey, embeddings);
          reembedded = true;
        } else {
          reusedVectors = true;
        }
      }
    }

    const persisted = await target.transactional.withTransaction(async (tx) => {
      await acquireSourceLock(
        tx,
        target.lockNamespace,
        target.collection.name,
        targetSourceKey,
      );
      const currentTarget = await target.sourceStore.get(
        target.collection.name,
        targetSourceKey,
        tx,
      );
      if (!sameSnapshot(initialTarget, currentTarget)) {
        throw new ConcurrentModificationError(target.collection.name, targetSourceKey);
      }
      assertOrigin(currentTarget.source, source);

      let targetSource = currentTarget.source;
      if (metadataOnly) {
        targetSource = await target.sourceStore.updateMetadata(
          tx,
          targetSource!.id,
          targetSource!.rowVersion,
          source.metadata,
          source.metadataHash,
        );
        await target.vectorStore.updateChunkMetadata(
          tx,
          targetSource.id,
          targetSource.embeddingDim,
          source.metadata,
        );
      } else if (!receiptOnly) {
        if (targetSource === null) {
          targetSource = await target.sourceStore.insert(tx, {
            collection: target.collection.name,
            sourceKey: targetSourceKey,
            content: source.content,
            contentHash: source.contentHash,
            representationHash: prepared.representationHash,
            metadataHash: source.metadataHash,
            embeddingFingerprint: target.embedderConfig.fingerprint,
            embeddingDim: target.embedderConfig.dim,
            chunkingMode: prepared.mode,
            chunkSize: prepared.chunkSize,
            metadata: source.metadata,
            origin: { collection: source.collection, sourceKey: source.sourceKey },
          });
        } else {
          await target.vectorStore.deleteChunksBySource(
            tx,
            targetSource.id,
            targetSource.embeddingDim,
          );
          targetSource = await target.sourceStore.updateRepresentation(
            tx,
            targetSource.id,
            targetSource.rowVersion,
            {
              content: source.content,
              contentHash: source.contentHash,
              representationHash: prepared.representationHash,
              metadataHash: source.metadataHash,
              embeddingFingerprint: target.embedderConfig.fingerprint,
              embeddingDim: target.embedderConfig.dim,
              chunkingMode: prepared.mode,
              chunkSize: prepared.chunkSize,
              metadata: source.metadata,
            },
          );
        }
        for (const [index, content] of prepared.chunks.entries()) {
          await target.vectorStore.insertChunk(
            tx,
            target.collection.name,
            targetSource.id,
            content,
            embeddings![index]!,
            index,
            prepared.chunks.length,
            source.metadata,
          );
        }
      }
      await target.stateStore.replaceReceipt(
        tx,
        operation,
        source.collection,
        source.sourceKey,
        target.collection.name,
        targetSourceKey,
        ref,
      );
      return targetSource;
    });

    return {
      operation,
      sourceCollection: source.collection,
      sourceKey: source.sourceKey,
      targetCollection: target.collection.name,
      targetSourceKey,
      skipped: false,
      changed: !receiptOnly,
      reembedded,
      reusedVectors,
      ...(persisted === null ? {} : { targetSourceId: persisted.id }),
    };
  }
}

export class MirrorFanout implements MirrorDispatcher {
  readonly #source: TransferEndpoint;
  readonly #targets: ReadonlyMap<string, TransferEndpoint>;
  readonly #transfer: TransferService;

  constructor(
    source: TransferEndpoint,
    targets: ReadonlyMap<string, TransferEndpoint>,
    transfer = new TransferService(),
  ) {
    this.#source = source;
    this.#targets = targets;
    this.#transfer = transfer;
  }

  async onIngest(event: MirrorIngestEvent): Promise<readonly string[]> {
    const warnings: string[] = [];
    const embeddingCache = new Map<string, readonly (readonly number[])[]>();
    for (const mirror of this.#source.collection.mirrors) {
      const target = this.#targets.get(mirror.target);
      if (target === undefined) {
        warnings.push(`Mirror ${mirror.target} failed: target runtime is unavailable`);
        continue;
      }
      try {
        await this.#transfer.mirror(this.#source, target, event, embeddingCache);
      } catch (error) {
        warnings.push(
          `Mirror ${mirror.target} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return warnings;
  }
}
