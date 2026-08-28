import { createHash } from "node:crypto";

import { InvalidMetadataError } from "./errors.js";
import type { ApiStyle, ChunkingMode, JsonValue, Metadata } from "./types.js";

const textEncoder = new TextEncoder();

function frame(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + value.byteLength);
  new DataView(result.buffer).setBigUint64(0, BigInt(value.byteLength), false);
  result.set(value, 8);
  return result;
}

export function sha256Framed(fields: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = typeof field === "string" ? textEncoder.encode(field) : field;
    hash.update(frame(bytes));
  }
  return hash.digest("hex");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(textEncoder.encode(content)).digest("hex");
}

export function representationHash(input: {
  mode: ChunkingMode;
  chunkSize: number | null;
  chunks: readonly string[];
}): string {
  if (input.mode === "auto" && (!Number.isSafeInteger(input.chunkSize) || input.chunkSize! <= 0)) {
    throw new RangeError("Automatic chunking requires a positive effective chunk size");
  }
  if (input.mode !== "auto" && input.chunkSize !== null) {
    throw new RangeError("Only automatic chunking has an effective chunk size");
  }
  return sha256Framed([
    "frag:representation:v1",
    input.mode,
    input.chunkSize === null ? "null" : String(input.chunkSize),
    String(input.chunks.length),
    ...input.chunks,
  ]);
}

export function embeddingFingerprint(input: {
  apiStyle: ApiStyle;
  model: string;
  revision: string;
  dim: number;
}): string {
  return sha256Framed([
    "frag:embedding-fingerprint:v1",
    input.apiStyle,
    input.model,
    input.revision,
    String(input.dim),
  ]);
}

function assertScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new InvalidMetadataError(`Metadata contains an unpaired surrogate at ${path}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new InvalidMetadataError(`Metadata contains an unpaired surrogate at ${path}`);
    }
  }
}

function canonicalizeValue(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidMetadataError(`Metadata contains a non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new InvalidMetadataError(`Metadata contains unsupported ${typeof value} at ${path}`);
  }
  if (seen.has(value)) {
    throw new InvalidMetadataError(`Metadata contains a cycle at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => canonicalizeValue(item, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidMetadataError(`Metadata contains a non-JSON object at ${path}`);
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => {
        assertScalarString(key, `${path}.<key>`);
        return `${JSON.stringify(key)}:${canonicalizeValue(object[key], `${path}.${key}`, seen)}`;
      })
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeMetadata(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidMetadataError("Metadata must be a JSON object");
  }
  return canonicalizeValue(value, "$", new Set());
}

export function metadataHash(metadata: Metadata | unknown): string {
  return createHash("sha256")
    .update(textEncoder.encode(canonicalizeMetadata(metadata)))
    .digest("hex");
}

export function operationRef(input: {
  sourceKey: string;
  contentHash: string;
  representationHash: string;
  metadataHash: string;
  targetSourceKey: string;
  targetEmbeddingFingerprint: string;
}): string {
  return sha256Framed([
    "frag:operation-ref:v1",
    input.sourceKey,
    input.contentHash,
    input.representationHash,
    input.metadataHash,
    input.targetSourceKey,
    input.targetEmbeddingFingerprint,
  ]);
}

export function asMetadata(value: unknown): Metadata {
  canonicalizeMetadata(value);
  return value as Metadata;
}

export type { JsonValue };
