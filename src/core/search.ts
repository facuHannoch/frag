import { validateChunkLimits } from "./chunking.js";
import { assertCollectionDimension, collectionHasStaleEmbeddings } from "./collection-status.js";
import type { SourceStore, VectorStore } from "./store.js";
import type {
  CollectionConfig,
  Embedder,
  EmbedderConfig,
  SearchOptions,
  SearchResponse,
  TokenCounter,
} from "./types.js";

export interface SearchLogger {
  warn(message: string): void;
}

export interface SearchServiceDependencies {
  readonly collection: CollectionConfig;
  readonly embedderConfig: EmbedderConfig;
  readonly embedder: Embedder;
  readonly tokenCounter: TokenCounter;
  readonly sourceStore: SourceStore;
  readonly vectorStore: VectorStore;
  readonly logger?: SearchLogger;
}

export interface CollectionStatus {
  readonly collection: string;
  readonly state: "current" | "stale" | "dimension-invalid";
  readonly configuredDimension: number;
  readonly storedDimensions: readonly number[];
}

export class SearchService {
  readonly #dependencies: SearchServiceDependencies;

  constructor(dependencies: SearchServiceDependencies) {
    if (dependencies.collection.embedder !== dependencies.embedderConfig.name) {
      throw new TypeError("Collection and embedder configuration do not match");
    }
    if (dependencies.embedder.config.fingerprint !== dependencies.embedderConfig.fingerprint) {
      throw new TypeError("Embedder instance and configuration fingerprints do not match");
    }
    this.#dependencies = dependencies;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const dependencies = this.#dependencies;
    const limit = options.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("Search limit must be a positive integer");
    }
    await assertCollectionDimension(
      dependencies.collection.name,
      dependencies.embedderConfig,
      dependencies.sourceStore,
    );
    await validateChunkLimits(
      "<query>",
      [query],
      dependencies.embedderConfig,
      dependencies.tokenCounter,
    );
    const vectors = await dependencies.embedder.embed([query]);
    const vector = vectors[0];
    if (
      vectors.length !== 1 ||
      vector === undefined ||
      vector.length !== dependencies.embedderConfig.dim ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new RangeError("Embedder returned an invalid query vector");
    }
    const results = await dependencies.vectorStore.similaritySearch(
      dependencies.collection.name,
      vector,
      limit,
    );
    const stale = await collectionHasStaleEmbeddings(
      dependencies.collection.name,
      dependencies.embedderConfig,
      dependencies.sourceStore,
    );
    if (stale) {
      dependencies.logger?.warn(
        `Collection ${dependencies.collection.name} contains stale embeddings; run frag reindex ${dependencies.collection.name}`,
      );
    }
    return { results, ...(stale ? { stale_embeddings: true } : {}) };
  }

  async inspectStatus(): Promise<CollectionStatus> {
    const dependencies = this.#dependencies;
    const storedDimensions = await dependencies.sourceStore.listDimensions(
      dependencies.collection.name,
    );
    if (storedDimensions.some((dimension) => dimension !== dependencies.embedderConfig.dim)) {
      dependencies.logger?.warn(
        `Collection ${dependencies.collection.name} has stored dimensions ${storedDimensions.join(
          ", ",
        )} but is configured for ${dependencies.embedderConfig.dim}; create a new collection for a dimension change`,
      );
      return {
        collection: dependencies.collection.name,
        state: "dimension-invalid",
        configuredDimension: dependencies.embedderConfig.dim,
        storedDimensions,
      };
    }
    const stale = await collectionHasStaleEmbeddings(
      dependencies.collection.name,
      dependencies.embedderConfig,
      dependencies.sourceStore,
    );
    if (stale) {
      dependencies.logger?.warn(
        `Collection ${dependencies.collection.name} contains stale embeddings; run frag reindex ${dependencies.collection.name}`,
      );
    }
    return {
      collection: dependencies.collection.name,
      state: stale ? "stale" : "current",
      configuredDimension: dependencies.embedderConfig.dim,
      storedDimensions,
    };
  }
}
