import { EmbedderLengthError } from "./errors.js";
import type { Embedder } from "./types.js";

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

function validateEmbeddings(
  embeddings: readonly (readonly number[])[],
  expectedCount: number,
  expectedDim: number,
): readonly (readonly number[])[] {
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

export async function embedChunks(
  embedder: Embedder,
  sourceKey: string,
  chunks: readonly string[],
  expectedDim: number,
): Promise<readonly (readonly number[])[]> {
  try {
    return validateEmbeddings(await embedder.embed(chunks), chunks.length, expectedDim);
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
        isolated.push(...validateEmbeddings(result, 1, expectedDim));
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
