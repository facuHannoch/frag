import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  MirrorConfigurationCycleError,
  parseFragConfig,
  resolveConfiguredEnvironment,
} from "../../src/core/index.js";

const baseConfig = `
collections:
  - name: source
    description: Working notes
    embedder: local
    db: postgres
    state_backend: same-as-db
    mirrors:
      - target: cache
  - name: cache
    description: Offline cache
    embedder: local
    db: postgres
    state_backend: same-as-db
embedders:
  - name: local
    api_style: openai
    base_url: http://localhost:1234/v1
    model: nomic
    revision: "1"
    dim: 768
    max_tokens: 8192
    recommended_chunk_size: 500
    token_counter: estimate
    token_safety_margin: 0.8
    api_key_env: null
dbs:
  - name: postgres
    url_env: DATABASE_URL
`;

test("parses and links a valid registry", () => {
  const config = parseFragConfig(baseConfig);
  assert.equal(config.collections.get("source")?.mirrors[0]?.target, "cache");
  assert.equal(config.embedders.get("local")?.dim, 768);
  assert.match(config.embedders.get("local")?.fingerprint ?? "", /^[a-f0-9]{64}$/);
});

test("resolves secrets at runtime without retaining them in config", () => {
  const config = parseFragConfig(baseConfig);
  const resolved = resolveConfiguredEnvironment(config, { DATABASE_URL: "postgres://example" });
  assert.equal(resolved.databaseUrls.get("postgres"), "postgres://example");
  assert.equal(resolved.embedderBaseUrls.get("local"), "http://localhost:1234/v1");
  assert.equal(resolved.embedderApiKeys.get("local"), null);
  assert.equal(JSON.stringify(config).includes("postgres://example"), false);
});

test("rejects unknown references and duplicate names", () => {
  assert.throws(
    () => parseFragConfig(baseConfig.replace("embedder: local", "embedder: absent")),
    ConfigurationError,
  );
  assert.throws(
    () => parseFragConfig(baseConfig.replace("  - name: cache", "  - name: source")),
    ConfigurationError,
  );
});

test("rejects direct and transitive mirror cycles", () => {
  const cycle = baseConfig.replace(
    "    state_backend: same-as-db\nembedders:",
    "    state_backend: same-as-db\n    mirrors:\n      - target: source\nembedders:",
  );
  assert.throws(() => parseFragConfig(cycle), MirrorConfigurationCycleError);
});

test("validates dimensions, token limits, and estimate safety margin", () => {
  assert.throws(() => parseFragConfig(baseConfig.replace("dim: 768", "dim: 0")), ConfigurationError);
  assert.throws(
    () => parseFragConfig(baseConfig.replace("recommended_chunk_size: 500", "recommended_chunk_size: 9000")),
    ConfigurationError,
  );
  assert.throws(
    () => parseFragConfig(baseConfig.replace("token_safety_margin: 0.8", "token_safety_margin: 2")),
    ConfigurationError,
  );
});

test("requires referenced environment variables only during resolution", () => {
  const config = parseFragConfig(baseConfig);
  assert.throws(() => resolveConfiguredEnvironment(config, {}), ConfigurationError);
});
