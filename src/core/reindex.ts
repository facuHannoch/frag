import { validateChunkLimits } from "./chunking.js";
import { assertCollectionDimension } from "./collection-status.js";
import { embedChunks } from "./embedding.js";
import { ConcurrentModificationError } from "./errors.js";
import { acquireSourceLock } from "./postgres/sql.js";
import type { SourceStore, Transactional, Tx, VectorStore } from "./store.js";
import type {
  CollectionConfig,
  Embedder,
  EmbedderConfig,
  ReindexResult,
  Source,
  TokenCounter,
} from "./types.js";

export interface ReindexDependencies {
  readonly collection: CollectionConfig;
  readonly embedderConfig: EmbedderConfig;
  readonly embedder: Embedder;
  readonly tokenCounter: TokenCounter;
  readonly sourceStore: SourceStore;
  readonly vectorStore: VectorStore;
  readonly transactional: Transactional;
  readonly lockNamespace: string;
}

export class ReindexService {
  readonly #dependencies: ReindexDependencies;

  constructor(dependencies: ReindexDependencies) {
    if (dependencies.collection.embedder !== dependencies.embedderConfig.name) {
      throw new TypeError("Collection and embedder configuration do not match");
    }
    if (dependencies.embedder.config.fingerprint !== dependencies.embedderConfig.fingerprint) {
      throw new TypeError("Embedder instance and configuration fingerprints do not match");
    }
    this.#dependencies = dependencies;
  }

  async reindex(options: { readonly dryRun?: boolean } = {}): Promise<ReindexResult> {
    const dependencies = this.#dependencies;
    await assertCollectionDimension(
      dependencies.collection.name,
      dependencies.embedderConfig,
      dependencies.sourceStore,
    );
    const stale = await dependencies.sourceStore.listStale(
      dependencies.collection.name,
      dependencies.embedderConfig.fingerprint,
      dependencies.embedderConfig.dim,
    );
    const storedFingerprintGroups: Record<string, number> = {};
    let chunkCount = 0;
    const chunksBySource = new Map<number, Awaited<ReturnType<VectorStore["listChunksBySource"]>>>();
    for (const source of stale) {
      storedFingerprintGroups[source.embeddingFingerprint] =
        (storedFingerprintGroups[source.embeddingFingerprint] ?? 0) + 1;
      const chunks = await dependencies.vectorStore.listChunksBySource(
        source.id,
        source.embeddingDim,
      );
      this.#assertChunkPositions(source, chunks);
      chunksBySource.set(source.id, chunks);
      chunkCount += chunks.length;
    }
    const result: ReindexResult = {
      dryRun: options.dryRun ?? false,
      sources: stale.length,
      chunks: chunkCount,
      configuredFingerprint: dependencies.embedderConfig.fingerprint,
      storedFingerprintGroups,
    };
    if (options.dryRun === true) return result;

    for (const source of stale) {
      const chunks = chunksBySource.get(source.id)!;
      const contents = chunks.map(({ content }) => content);
      await validateChunkLimits(
        source.sourceKey,
        contents,
        dependencies.embedderConfig,
        dependencies.tokenCounter,
      );
      const embeddings = await embedChunks(
        dependencies.embedder,
        source.sourceKey,
        contents,
        dependencies.embedderConfig.dim,
      );
      await dependencies.transactional.withTransaction(async (tx) => {
        await acquireSourceLock(
          tx,
          dependencies.lockNamespace,
          dependencies.collection.name,
          source.sourceKey,
        );
        await this.#revalidate(tx, source);
        await dependencies.vectorStore.updateChunkEmbeddings(
          tx,
          source.id,
          source.embeddingDim,
          embeddings,
        );
        await dependencies.sourceStore.updateEmbeddingIdentity(
          tx,
          source.id,
          source.rowVersion,
          dependencies.embedderConfig.fingerprint,
          dependencies.embedderConfig.dim,
        );
      });
    }
    return result;
  }

  #assertChunkPositions(
    source: Source,
    chunks: Awaited<ReturnType<VectorStore["listChunksBySource"]>>,
  ): void {
    for (const [position, chunk] of chunks.entries()) {
      if (chunk.chunkIndex !== position || chunk.chunkCount !== chunks.length) {
        throw new RangeError(`Stored chunks for ${source.collection}/${source.sourceKey} are not contiguous`);
      }
    }
  }

  async #revalidate(tx: Tx, source: Source): Promise<void> {
    const current = await this.#dependencies.sourceStore.get(
      source.collection,
      source.sourceKey,
      tx,
    );
    if (
      current.source === null ||
      current.source.id !== source.id ||
      current.rowVersion !== source.rowVersion ||
      current.source.embeddingFingerprint !== source.embeddingFingerprint ||
      current.source.embeddingDim !== source.embeddingDim
    ) {
      throw new ConcurrentModificationError(source.collection, source.sourceKey);
    }
  }
}
