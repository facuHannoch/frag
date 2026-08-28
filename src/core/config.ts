import { parse } from "yaml";

import { ConfigurationError, MirrorConfigurationCycleError } from "./errors.js";
import { embeddingFingerprint } from "./hash.js";
import type {
  ApiStyle,
  CollectionConfig,
  DatabaseConfig,
  EmbedderConfig,
  FragConfig,
  MirrorConfig,
  TokenCounterKind,
} from "./types.js";

type RawObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): RawObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${path} must be an object`, { path });
  }
  return value as RawObject;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${path} must be an array`, { path });
  }
  return value;
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new ConfigurationError(`${path} must be a non-empty string`, { path });
  }
  return value;
}

function integerAt(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ConfigurationError(`${path} must be a positive integer`, { path });
  }
  return value as number;
}

function uniqueMap<T extends { readonly name: string }>(values: readonly T[], path: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.name)) {
      throw new ConfigurationError(`${path} contains duplicate name ${value.name}`, {
        path,
        name: value.name,
      });
    }
    result.set(value.name, value);
  }
  return result;
}

function parseEmbedder(value: unknown, index: number): EmbedderConfig {
  const path = `embedders[${index}]`;
  const raw = objectAt(value, path);
  const name = stringAt(raw.name, `${path}.name`);
  const apiStyle = stringAt(raw.api_style, `${path}.api_style`) as ApiStyle;
  if (apiStyle !== "openai" && apiStyle !== "azure-openai") {
    throw new ConfigurationError(`${path}.api_style must be openai or azure-openai`);
  }
  const tokenCounter = stringAt(raw.token_counter, `${path}.token_counter`) as TokenCounterKind;
  if (!(["tiktoken", "endpoint", "estimate"] as const).includes(tokenCounter)) {
    throw new ConfigurationError(`${path}.token_counter is unsupported`);
  }
  const dim = integerAt(raw.dim, `${path}.dim`);
  const maxTokens = integerAt(raw.max_tokens, `${path}.max_tokens`);
  const recommendedChunkSize = integerAt(
    raw.recommended_chunk_size,
    `${path}.recommended_chunk_size`,
  );
  if (recommendedChunkSize > maxTokens) {
    throw new ConfigurationError(`${path}.recommended_chunk_size cannot exceed max_tokens`);
  }
  const baseUrl = raw.base_url === undefined ? undefined : stringAt(raw.base_url, `${path}.base_url`);
  const baseUrlEnv =
    raw.base_url_env === undefined ? undefined : stringAt(raw.base_url_env, `${path}.base_url_env`);
  if ((baseUrl === undefined) === (baseUrlEnv === undefined)) {
    throw new ConfigurationError(`${path} must define exactly one of base_url or base_url_env`);
  }
  const apiKeyEnv =
    raw.api_key_env === null || raw.api_key_env === undefined
      ? null
      : stringAt(raw.api_key_env, `${path}.api_key_env`);
  let tokenSafetyMargin: number | undefined;
  if (tokenCounter === "estimate") {
    if (
      typeof raw.token_safety_margin !== "number" ||
      !Number.isFinite(raw.token_safety_margin) ||
      raw.token_safety_margin <= 0 ||
      raw.token_safety_margin > 1
    ) {
      throw new ConfigurationError(
        `${path}.token_safety_margin must be greater than 0 and at most 1 for estimate`,
      );
    }
    tokenSafetyMargin = raw.token_safety_margin;
  } else if (raw.token_safety_margin !== undefined) {
    throw new ConfigurationError(`${path}.token_safety_margin is only valid for estimate`);
  }
  const model = stringAt(raw.model, `${path}.model`);
  const revision = stringAt(raw.revision, `${path}.revision`);
  return {
    name,
    apiStyle,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(baseUrlEnv === undefined ? {} : { baseUrlEnv }),
    model,
    revision,
    dim,
    maxTokens,
    recommendedChunkSize,
    tokenCounter,
    ...(tokenSafetyMargin === undefined ? {} : { tokenSafetyMargin }),
    apiKeyEnv,
    fingerprint: embeddingFingerprint({ apiStyle, model, revision, dim }),
  };
}

function parseDatabase(value: unknown, index: number): DatabaseConfig {
  const path = `dbs[${index}]`;
  const raw = objectAt(value, path);
  return {
    name: stringAt(raw.name, `${path}.name`),
    urlEnv: stringAt(raw.url_env, `${path}.url_env`),
  };
}

function parseCollection(value: unknown, index: number): CollectionConfig {
  const path = `collections[${index}]`;
  const raw = objectAt(value, path);
  const stateBackend = stringAt(raw.state_backend, `${path}.state_backend`);
  if (stateBackend !== "same-as-db") {
    throw new ConfigurationError(`${path}.state_backend must be same-as-db in v9`);
  }
  const mirrors: MirrorConfig[] = (raw.mirrors === undefined
    ? []
    : arrayAt(raw.mirrors, `${path}.mirrors`)
  ).map((mirror, mirrorIndex) => ({
    target: stringAt(
      objectAt(mirror, `${path}.mirrors[${mirrorIndex}]`).target,
      `${path}.mirrors[${mirrorIndex}].target`,
    ),
  }));
  if (new Set(mirrors.map(({ target }) => target)).size !== mirrors.length) {
    throw new ConfigurationError(`${path}.mirrors contains a duplicate target`);
  }
  return {
    name: stringAt(raw.name, `${path}.name`),
    description: stringAt(raw.description, `${path}.description`),
    embedder: stringAt(raw.embedder, `${path}.embedder`),
    db: stringAt(raw.db, `${path}.db`),
    stateBackend: "same-as-db",
    mirrors,
  };
}

function validateReferences(config: FragConfig): void {
  for (const collection of config.collections.values()) {
    if (!config.embedders.has(collection.embedder)) {
      throw new ConfigurationError(
        `Collection ${collection.name} references unknown embedder ${collection.embedder}`,
      );
    }
    if (!config.dbs.has(collection.db)) {
      throw new ConfigurationError(`Collection ${collection.name} references unknown db ${collection.db}`);
    }
    for (const mirror of collection.mirrors) {
      if (!config.collections.has(mirror.target)) {
        throw new ConfigurationError(
          `Collection ${collection.name} mirrors to unknown collection ${mirror.target}`,
        );
      }
    }
  }
}

function validateMirrorCycles(collections: ReadonlyMap<string, CollectionConfig>): void {
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const path: string[] = [];

  const visit = (name: string): void => {
    const cycleStart = active.get(name);
    if (cycleStart !== undefined) {
      throw new MirrorConfigurationCycleError([...path.slice(cycleStart), name]);
    }
    if (visited.has(name)) return;
    active.set(name, path.length);
    path.push(name);
    for (const mirror of collections.get(name)?.mirrors ?? []) visit(mirror.target);
    path.pop();
    active.delete(name);
    visited.add(name);
  };

  for (const name of collections.keys()) visit(name);
}

export function parseFragConfig(text: string): FragConfig {
  let document: unknown;
  try {
    document = parse(text, { uniqueKeys: true });
  } catch (error) {
    throw new ConfigurationError("Configuration is not valid YAML", {}, { cause: error });
  }
  const raw = objectAt(document, "config");
  const embedders = uniqueMap(
    arrayAt(raw.embedders, "embedders").map(parseEmbedder),
    "embedders",
  );
  const dbs = uniqueMap(arrayAt(raw.dbs, "dbs").map(parseDatabase), "dbs");
  const collections = uniqueMap(
    arrayAt(raw.collections, "collections").map(parseCollection),
    "collections",
  );
  const config: FragConfig = { collections, embedders, dbs };
  validateReferences(config);
  validateMirrorCycles(collections);
  return config;
}

export function resolveConfiguredEnvironment(
  config: FragConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): {
  readonly databaseUrls: ReadonlyMap<string, string>;
  readonly embedderBaseUrls: ReadonlyMap<string, string>;
  readonly embedderApiKeys: ReadonlyMap<string, string | null>;
} {
  const required = (name: string, owner: string): string => {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
      throw new ConfigurationError(`Environment variable ${name} required by ${owner} is not set`, {
        environmentVariable: name,
        owner,
      });
    }
    return value;
  };
  const databaseUrls = new Map<string, string>();
  for (const database of config.dbs.values()) {
    if ((database.url === undefined) === (database.urlEnv === undefined)) {
      throw new ConfigurationError(`database ${database.name} must define exactly one URL source`);
    }
    databaseUrls.set(
      database.name,
      database.url ?? required(database.urlEnv!, `database ${database.name}`),
    );
  }
  const embedderBaseUrls = new Map<string, string>();
  const embedderApiKeys = new Map<string, string | null>();
  for (const embedder of config.embedders.values()) {
    embedderBaseUrls.set(
      embedder.name,
      embedder.baseUrl ?? required(embedder.baseUrlEnv!, `embedder ${embedder.name}`),
    );
    embedderApiKeys.set(
      embedder.name,
      embedder.apiKeyEnv === null
        ? null
        : required(embedder.apiKeyEnv, `embedder ${embedder.name}`),
    );
  }
  return { databaseUrls, embedderBaseUrls, embedderApiKeys };
}
