import { ChunkTooLongError, InvalidIngestionModeError } from "./errors.js";
import { asMetadata, contentHash, metadataHash, representationHash } from "./hash.js";
import type {
  EmbedderConfig,
  IngestInput,
  PreparedRepresentation,
  TokenCounter,
} from "./types.js";

export class EstimateTokenCounter implements TokenCounter {
  async count(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
  }

  isExact(): boolean {
    return false;
  }
}

async function largestPrefixAtMost(
  text: string,
  limit: number,
  counter: TokenCounter,
): Promise<number> {
  let low = 1;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((await counter.count(text.slice(0, middle))) <= limit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

async function smallestSuffixWithin(
  text: string,
  limit: number,
  counter: TokenCounter,
): Promise<number> {
  if (limit <= 0) return text.length;
  let low = 0;
  let high = text.length;
  let best = text.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((await counter.count(text.slice(middle))) <= limit) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best;
}

export async function splitAutomatically(
  content: string,
  chunkSize: number,
  counter: TokenCounter,
  overlap = 50,
): Promise<string[]> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new InvalidIngestionModeError("Automatic chunk size must be a positive integer");
  }
  if (content.length === 0) return [""];
  const effectiveOverlap = Math.max(0, Math.min(overlap, chunkSize - 1));
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const remaining = content.slice(cursor);
    if ((await counter.count(remaining)) <= chunkSize) {
      chunks.push(remaining);
      break;
    }
    const length = await largestPrefixAtMost(remaining, chunkSize, counter);
    if (length <= 0) {
      throw new InvalidIngestionModeError(
        "Token counter could not fit even one character into the automatic chunk size",
      );
    }
    const chunk = remaining.slice(0, length);
    chunks.push(chunk);
    const overlapStart = await smallestSuffixWithin(chunk, effectiveOverlap, counter);
    const advance = Math.max(1, length - (chunk.length - overlapStart));
    cursor += advance;
  }
  return chunks;
}

export async function prepareRepresentation(
  input: IngestInput,
  embedder: EmbedderConfig,
  counter: TokenCounter,
): Promise<PreparedRepresentation> {
  if (input.chunks !== undefined && input.autoChunk !== undefined) {
    throw new InvalidIngestionModeError("chunks and autoChunk are mutually exclusive");
  }
  const metadata = asMetadata(input.metadata ?? {});
  let mode: PreparedRepresentation["mode"];
  let chunkSize: number | null;
  let chunks: readonly string[];
  if (input.chunks !== undefined) {
    if (input.chunks.length === 0) {
      throw new InvalidIngestionModeError("Explicit chunks must contain at least one chunk");
    }
    mode = "explicit";
    chunkSize = null;
    chunks = [...input.chunks];
  } else if (input.autoChunk !== undefined && input.autoChunk !== false) {
    const requested = typeof input.autoChunk === "number" ? input.autoChunk : embedder.recommendedChunkSize;
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new InvalidIngestionModeError("Automatic chunk size must be a positive integer");
    }
    if (requested > embedder.maxTokens) {
      throw new InvalidIngestionModeError("Automatic chunk size cannot exceed the embedder hard limit", {
        requested,
        maxTokens: embedder.maxTokens,
      });
    }
    mode = "auto";
    chunkSize = requested;
    chunks = await splitAutomatically(input.content, requested, counter);
  } else {
    mode = "manual";
    chunkSize = null;
    chunks = [input.content];
  }
  return {
    mode,
    chunkSize,
    chunks,
    contentHash: contentHash(input.content),
    representationHash: representationHash({ mode, chunkSize, chunks }),
    metadata,
    metadataHash: metadataHash(metadata),
  };
}

export async function validateChunkLimits(
  sourceKey: string,
  chunks: readonly string[],
  embedder: EmbedderConfig,
  counter: TokenCounter,
): Promise<readonly number[]> {
  const limit =
    embedder.tokenCounter === "estimate"
      ? Math.floor(embedder.maxTokens * (embedder.tokenSafetyMargin ?? 1))
      : embedder.maxTokens;
  const counts: number[] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const count = await counter.count(chunk);
    counts.push(count);
    if (count > limit) {
      throw new ChunkTooLongError({
        sourceKey,
        chunkIndex,
        count,
        limit,
        exact: counter.isExact(),
      });
    }
  }
  return counts;
}
