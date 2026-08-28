import { DimensionMismatchError } from "./errors.js";
import type { SourceStore } from "./store.js";
import type { EmbedderConfig } from "./types.js";

export async function assertCollectionDimension(
  collection: string,
  embedder: EmbedderConfig,
  sources: SourceStore,
): Promise<void> {
  const dimensions = await sources.listDimensions(collection);
  if (dimensions.some((dimension) => dimension !== embedder.dim)) {
    throw new DimensionMismatchError(collection, embedder.dim, dimensions);
  }
}

export async function collectionHasStaleEmbeddings(
  collection: string,
  embedder: EmbedderConfig,
  sources: SourceStore,
): Promise<boolean> {
  return (await sources.listStale(collection, embedder.fingerprint, embedder.dim)).length > 0;
}
