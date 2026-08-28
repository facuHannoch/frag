import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidMetadataError,
  canonicalizeMetadata,
  contentHash,
  embeddingFingerprint,
  metadataHash,
  representationHash,
  sha256Framed,
} from "../../src/core/index.js";

test("framing distinguishes ambiguous concatenations", () => {
  assert.notEqual(sha256Framed(["ab", "c"]), sha256Framed(["a", "bc"]));
});

test("content hashes exact UTF-8 content", () => {
  assert.equal(
    contentHash("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assert.notEqual(contentHash("hello"), contentHash("hello\n"));
});

test("representation hash includes mode, size, order, and duplicate positions", () => {
  const manual = representationHash({ mode: "manual", chunkSize: null, chunks: ["a", "b"] });
  assert.notEqual(
    manual,
    representationHash({ mode: "explicit", chunkSize: null, chunks: ["a", "b"] }),
  );
  assert.notEqual(
    representationHash({ mode: "auto", chunkSize: 10, chunks: ["a", "b"] }),
    representationHash({ mode: "auto", chunkSize: 20, chunks: ["a", "b"] }),
  );
  assert.notEqual(
    manual,
    representationHash({ mode: "manual", chunkSize: null, chunks: ["b", "a"] }),
  );
  assert.notEqual(
    representationHash({ mode: "explicit", chunkSize: null, chunks: ["a"] }),
    representationHash({ mode: "explicit", chunkSize: null, chunks: ["a", "a"] }),
  );
});

test("embedding fingerprint includes revision and dimension", () => {
  const base = { apiStyle: "openai" as const, model: "model", revision: "1", dim: 768 };
  assert.notEqual(embeddingFingerprint(base), embeddingFingerprint({ ...base, revision: "2" }));
  assert.notEqual(embeddingFingerprint(base), embeddingFingerprint({ ...base, dim: 1536 }));
});

test("metadata canonicalization follows JSON key and number semantics", () => {
  assert.equal(canonicalizeMetadata({ z: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"z":1}');
  assert.equal(metadataHash({ b: 2, a: 1 }), metadataHash({ a: 1, b: 2 }));
  assert.notEqual(metadataHash({ a: [1, 2] }), metadataHash({ a: [2, 1] }));
  assert.equal(canonicalizeMetadata({ minusZero: -0 }), '{"minusZero":0}');
});

test("metadata rejects values outside the JSON data model", () => {
  assert.throws(() => canonicalizeMetadata(null), InvalidMetadataError);
  assert.throws(() => canonicalizeMetadata({ value: Number.NaN }), InvalidMetadataError);
  assert.throws(() => canonicalizeMetadata({ value: undefined }), InvalidMetadataError);
  assert.throws(() => canonicalizeMetadata({ value: new Date() }), InvalidMetadataError);
  assert.throws(() => canonicalizeMetadata({ value: "\ud800" }), InvalidMetadataError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeMetadata(cyclic), InvalidMetadataError);
});
