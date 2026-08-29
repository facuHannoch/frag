import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ConfigurationError, MirrorConfigurationCycleError } from "./errors.js";
import type { ApiStyle, TokenCounterKind } from "./types.js";

const SCHEMA_VERSION = 2;

export type EmbedderProviderKind = "lmstudio" | "openai-compatible" | "azure-openai";
export type DatabaseKind = "managed-postgres" | "existing-postgres";
export type ContainerRuntime = "docker" | "podman";

export interface EmbedderRegistration {
  readonly id: string;
  readonly providerKind: EmbedderProviderKind;
  readonly apiStyle: ApiStyle;
  readonly baseUrl?: string;
  readonly baseUrlEnv?: string;
  readonly model: string;
  readonly requestModel?: string;
  readonly revision: string;
  readonly dim: number;
  readonly maxTokens: number;
  readonly recommendedChunkSize: number;
  readonly tokenCounter: TokenCounterKind;
  readonly tokenSafetyMargin?: number;
  readonly apiKeyEnv: string | null;
  readonly managed: boolean;
  readonly limitsInferred: boolean;
  readonly lastHealthCheck?: string;
}

export interface EmbedderRecord extends EmbedderRegistration {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DatabaseRegistration {
  readonly id: string;
  readonly kind: DatabaseKind;
  /** Stored only for a Frag-managed loopback database. */
  readonly connectionUrl?: string;
  /** Required for an existing database; the secret stays in the environment. */
  readonly urlEnv?: string;
  readonly runtime?: ContainerRuntime;
  readonly containerName?: string;
  readonly volumeName?: string;
  readonly lastHealthCheck?: string;
}

export interface DatabaseRecord extends DatabaseRegistration {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SystemRecord {
  readonly name: string;
  readonly description: string;
  readonly embedderId: string;
  readonly databaseId: string;
  readonly mirrors: readonly string[];
  readonly status: "ready";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SystemCreateInput {
  readonly name: string;
  readonly description: string;
  readonly embedder: EmbedderRegistration;
  readonly database: DatabaseRegistration;
  readonly mirrors?: readonly string[];
  readonly setDefault?: boolean;
}

export interface SystemUpdatePatch {
  readonly description?: string;
  readonly embedderId?: string;
  readonly databaseId?: string;
  readonly mirrors?: readonly string[];
}

export interface SystemBatchOptions {
  readonly replace?: boolean;
  readonly defaultSystem?: string | null;
}

export interface ProvisioningJournalEntry {
  readonly id: string;
  readonly payload: string;
  readonly createdAt: string;
}

export interface FragPathsOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export interface OpenFragOptions extends FragPathsOptions {
  readonly registryPath?: string;
}

function nonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) throw new ConfigurationError(`${field} must be non-empty`, { field });
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${field} must be a positive integer`, { field });
  }
  return value;
}

function optionalExclusive(left: string | undefined, right: string | undefined, owner: string): void {
  if ((left === undefined) === (right === undefined)) {
    throw new ConfigurationError(`${owner} must define exactly one of baseUrl or baseUrlEnv`);
  }
}

function validateEmbedder(value: EmbedderRegistration): void {
  nonEmpty(value.id, "embedder.id");
  nonEmpty(value.model, "embedder.model");
  nonEmpty(value.revision, "embedder.revision");
  optionalExclusive(value.baseUrl, value.baseUrlEnv, `embedder ${value.id}`);
  positiveInteger(value.dim, "embedder.dim");
  positiveInteger(value.maxTokens, "embedder.maxTokens");
  positiveInteger(value.recommendedChunkSize, "embedder.recommendedChunkSize");
  if (value.recommendedChunkSize > value.maxTokens) {
    throw new ConfigurationError("embedder.recommendedChunkSize cannot exceed maxTokens");
  }
  if (value.tokenCounter === "estimate") {
    if (
      value.tokenSafetyMargin === undefined ||
      !Number.isFinite(value.tokenSafetyMargin) ||
      value.tokenSafetyMargin <= 0 ||
      value.tokenSafetyMargin > 1
    ) {
      throw new ConfigurationError("estimate embedders require tokenSafetyMargin in (0, 1]");
    }
  } else if (value.tokenSafetyMargin !== undefined) {
    throw new ConfigurationError("tokenSafetyMargin is valid only for estimate token counting");
  }
}

function validateDatabase(value: DatabaseRegistration): void {
  nonEmpty(value.id, "database.id");
  if (value.kind === "managed-postgres") {
    if (value.connectionUrl === undefined || value.urlEnv !== undefined) {
      throw new ConfigurationError("managed PostgreSQL requires connectionUrl and cannot use urlEnv");
    }
    if (value.runtime === undefined || value.containerName === undefined || value.volumeName === undefined) {
      throw new ConfigurationError("managed PostgreSQL requires runtime, containerName, and volumeName");
    }
  } else if (value.urlEnv === undefined || value.connectionUrl !== undefined) {
    throw new ConfigurationError("existing PostgreSQL requires urlEnv and cannot persist a connection URL");
  }
}

export function resolveFragHome(options: FragPathsOptions = {}): string {
  const environment = options.environment ?? process.env;
  const override = environment.FRAG_HOME;
  if (override !== undefined) return resolve(nonEmpty(override, "FRAG_HOME"));
  const platform = options.platform ?? process.platform;
  const userHome = options.homeDirectory ?? homedir();
  if (platform === "win32") {
    const local = environment.LOCALAPPDATA;
    return local === undefined ? join(userHome, "AppData", "Local", "Frag") : join(local, "Frag");
  }
  if (platform === "darwin") return join(userHome, "Library", "Application Support", "Frag");
  const xdg = environment.XDG_DATA_HOME;
  return xdg === undefined ? join(userHome, ".local", "share", "frag") : join(xdg, "frag");
}

export function resolveRegistryPath(options: OpenFragOptions = {}): string {
  return options.registryPath === undefined
    ? join(resolveFragHome(options), "registry.sqlite3")
    : resolve(options.registryPath);
}

type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;
type SqlValue = string | number | bigint | null | Uint8Array;

interface SqlRunResult {
  readonly changes: number;
}

interface SqlStatement {
  all(...values: SqlValue[]): unknown[];
  get(...values: SqlValue[]): unknown;
  run(...values: SqlValue[]): SqlRunResult;
}

interface SqlDatabase {
  close(): void;
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

interface SqlDatabaseConstructor {
  new(path: string): SqlDatabase;
}

async function sqliteConstructor(): Promise<SqlDatabaseConstructor> {
  const runtimeModule = (globalThis as { Bun?: unknown }).Bun === undefined
    ? "better-sqlite3"
    : "bun:sqlite";
  const loaded = await import(runtimeModule) as {
    readonly default?: SqlDatabaseConstructor;
    readonly Database?: SqlDatabaseConstructor;
  };
  const constructor = loaded.default ?? loaded.Database;
  if (constructor === undefined) throw new Error(`SQLite driver ${runtimeModule} did not export a database constructor`);
  return constructor;
}

const RuntimeSqlDatabase = await sqliteConstructor();

function stringColumn(row: SqlRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Invalid registry column ${name}`);
  return value;
}

function nullableStringColumn(row: SqlRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid registry column ${name}`);
  return value;
}

function numberColumn(row: SqlRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number") throw new Error(`Invalid registry column ${name}`);
  return value;
}

function rows(statement: SqlStatement, ...values: (string | number | null)[]): SqlRow[] {
  return statement.all(...values) as SqlRow[];
}

function migrate(database: SqlDatabase): void {
  const current = numberColumn(database.prepare("PRAGMA user_version").get() as SqlRow, "user_version");
  if (current > SCHEMA_VERSION) {
    throw new ConfigurationError(
      `Registry schema ${current} is newer than this Frag supports (${SCHEMA_VERSION})`,
    );
  }
  if (current === SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (current < 1) database.exec(`
      CREATE TABLE embedders (
        id TEXT PRIMARY KEY,
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('lmstudio','openai-compatible','azure-openai')),
        api_style TEXT NOT NULL CHECK (api_style IN ('openai','azure-openai')),
        base_url TEXT,
        base_url_env TEXT,
        model TEXT NOT NULL,
        request_model TEXT,
        revision TEXT NOT NULL,
        dim INTEGER NOT NULL CHECK (dim > 0),
        max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
        recommended_chunk_size INTEGER NOT NULL CHECK (recommended_chunk_size > 0),
        token_counter TEXT NOT NULL CHECK (token_counter IN ('tiktoken','endpoint','estimate')),
        token_safety_margin REAL,
        api_key_env TEXT,
        managed INTEGER NOT NULL CHECK (managed IN (0,1)),
        limits_inferred INTEGER NOT NULL CHECK (limits_inferred IN (0,1)),
        last_health_check TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((base_url IS NULL) <> (base_url_env IS NULL))
      );
      CREATE TABLE databases (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('managed-postgres','existing-postgres')),
        connection_url TEXT,
        url_env TEXT,
        runtime TEXT CHECK (runtime IN ('docker','podman')),
        container_name TEXT,
        volume_name TEXT,
        last_health_check TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE systems (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        embedder_id TEXT NOT NULL REFERENCES embedders(id) ON DELETE RESTRICT,
        database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status = 'ready'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE system_mirrors (
        source_system TEXT NOT NULL REFERENCES systems(name) ON DELETE CASCADE,
        target_system TEXT NOT NULL REFERENCES systems(name) ON DELETE RESTRICT,
        PRIMARY KEY (source_system, target_system),
        CHECK (source_system <> target_system)
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE provisioning_journal (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    if (current === 1) database.exec("ALTER TABLE embedders ADD COLUMN request_model TEXT");
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function runTransaction<T>(database: SqlDatabase, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function embedderFromRow(row: SqlRow): EmbedderRecord {
  const margin = row.token_safety_margin;
  return {
    id: stringColumn(row, "id"),
    providerKind: stringColumn(row, "provider_kind") as EmbedderProviderKind,
    apiStyle: stringColumn(row, "api_style") as ApiStyle,
    ...(nullableStringColumn(row, "base_url") === undefined ? {} : { baseUrl: stringColumn(row, "base_url") }),
    ...(nullableStringColumn(row, "base_url_env") === undefined ? {} : { baseUrlEnv: stringColumn(row, "base_url_env") }),
    model: stringColumn(row, "model"),
    ...(nullableStringColumn(row, "request_model") === undefined
      ? {}
      : { requestModel: stringColumn(row, "request_model") }),
    revision: stringColumn(row, "revision"),
    dim: numberColumn(row, "dim"),
    maxTokens: numberColumn(row, "max_tokens"),
    recommendedChunkSize: numberColumn(row, "recommended_chunk_size"),
    tokenCounter: stringColumn(row, "token_counter") as TokenCounterKind,
    ...(margin === null ? {} : { tokenSafetyMargin: numberColumn(row, "token_safety_margin") }),
    apiKeyEnv: nullableStringColumn(row, "api_key_env") ?? null,
    managed: numberColumn(row, "managed") === 1,
    limitsInferred: numberColumn(row, "limits_inferred") === 1,
    ...(nullableStringColumn(row, "last_health_check") === undefined
      ? {}
      : { lastHealthCheck: stringColumn(row, "last_health_check") }),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function databaseFromRow(row: SqlRow): DatabaseRecord {
  return {
    id: stringColumn(row, "id"),
    kind: stringColumn(row, "kind") as DatabaseKind,
    ...(nullableStringColumn(row, "connection_url") === undefined
      ? {}
      : { connectionUrl: stringColumn(row, "connection_url") }),
    ...(nullableStringColumn(row, "url_env") === undefined ? {} : { urlEnv: stringColumn(row, "url_env") }),
    ...(nullableStringColumn(row, "runtime") === undefined
      ? {}
      : { runtime: stringColumn(row, "runtime") as ContainerRuntime }),
    ...(nullableStringColumn(row, "container_name") === undefined
      ? {}
      : { containerName: stringColumn(row, "container_name") }),
    ...(nullableStringColumn(row, "volume_name") === undefined
      ? {}
      : { volumeName: stringColumn(row, "volume_name") }),
    ...(nullableStringColumn(row, "last_health_check") === undefined
      ? {}
      : { lastHealthCheck: stringColumn(row, "last_health_check") }),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

export class FragControlPlane {
  readonly path: string;
  readonly #database: SqlDatabase;

  constructor(path: string) {
    this.path = path;
    this.#database = new RuntimeSqlDatabase(path);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrate(this.#database);
  }

  readonly embedders = {
    list: (): EmbedderRecord[] =>
      rows(this.#database.prepare("SELECT * FROM embedders ORDER BY id")).map(embedderFromRow),
    get: (id: string): EmbedderRecord | null => {
      const row = this.#database.prepare("SELECT * FROM embedders WHERE id = ?").get(id) as SqlRow | null | undefined;
      return row == null ? null : embedderFromRow(row);
    },
    register: (input: EmbedderRegistration): EmbedderRecord => runTransaction(this.#database, () => {
      this.#ensureEmbedder(input);
      return this.embedders.get(input.id)!;
    }),
    updateHealth: (id: string, checkedAt: string): void => {
      const result = this.#database.prepare(
        "UPDATE embedders SET last_health_check = ?, updated_at = ? WHERE id = ?",
      ).run(checkedAt, new Date().toISOString(), id);
      if (result.changes === 0) throw new ConfigurationError(`Unknown embedder ${id}`);
    },
  };

  readonly databases = {
    list: (): DatabaseRecord[] =>
      rows(this.#database.prepare("SELECT * FROM databases ORDER BY id")).map(databaseFromRow),
    get: (id: string): DatabaseRecord | null => {
      const row = this.#database.prepare("SELECT * FROM databases WHERE id = ?").get(id) as SqlRow | null | undefined;
      return row == null ? null : databaseFromRow(row);
    },
    register: (input: DatabaseRegistration): DatabaseRecord => runTransaction(this.#database, () => {
      this.#ensureDatabase(input);
      return this.databases.get(input.id)!;
    }),
    updateHealth: (id: string, checkedAt: string): void => {
      const result = this.#database.prepare(
        "UPDATE databases SET last_health_check = ?, updated_at = ? WHERE id = ?",
      ).run(checkedAt, new Date().toISOString(), id);
      if (result.changes === 0) throw new ConfigurationError(`Unknown database ${id}`);
    },
  };

  readonly systems = {
    list: (): SystemRecord[] => rows(
      this.#database.prepare("SELECT * FROM systems WHERE status = 'ready' ORDER BY name"),
    ).map((row) => this.#systemFromRow(row)),
    get: (name: string): SystemRecord | null => {
      const row = this.#database.prepare(
        "SELECT * FROM systems WHERE name = ? AND status = 'ready'",
      ).get(name) as SqlRow | null | undefined;
      return row == null ? null : this.#systemFromRow(row);
    },
    create: (input: SystemCreateInput): SystemRecord => runTransaction(this.#database, () => {
      const name = nonEmpty(input.name, "system.name");
      const description = nonEmpty(input.description, "system.description");
      if (this.systems.get(name) !== null) throw new ConfigurationError(`System ${name} already exists`);
      this.#ensureEmbedder(input.embedder);
      this.#ensureDatabase(input.database);
      const mirrors = this.#validateMirrors(name, input.mirrors ?? []);
      const now = new Date().toISOString();
      this.#database.prepare(`
        INSERT INTO systems
          (name, description, embedder_id, database_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ready', ?, ?)
      `).run(name, description, input.embedder.id, input.database.id, now, now);
      const insertMirror = this.#database.prepare(
        "INSERT INTO system_mirrors (source_system, target_system) VALUES (?, ?)",
      );
      for (const target of mirrors) insertMirror.run(name, target);
      if (input.setDefault === true || this.settings.get("defaultSystem") === null) {
        this.#setSetting("defaultSystem", name);
      }
      return this.systems.get(name)!;
    }),
    importPrepared: (
      inputs: readonly SystemCreateInput[],
      options: SystemBatchOptions = {},
    ): SystemRecord[] => runTransaction(this.#database, () => {
      const names = inputs.map((input) => nonEmpty(input.name, "system.name"));
      if (new Set(names).size !== names.length) throw new ConfigurationError("Imported system names must be unique");
      if (options.replace === true) {
        this.#database.prepare("DELETE FROM system_mirrors").run();
        this.#database.prepare("DELETE FROM systems").run();
        this.#database.prepare("DELETE FROM settings WHERE key = 'defaultSystem'").run();
      } else {
        const conflict = names.find((name) => this.systems.get(name) !== null);
        if (conflict !== undefined) throw new ConfigurationError(`System ${conflict} already exists`);
      }
      const now = new Date().toISOString();
      const insertSystem = this.#database.prepare(`
        INSERT INTO systems
          (name, description, embedder_id, database_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ready', ?, ?)
      `);
      for (const input of inputs) {
        this.#ensureEmbedder(input.embedder);
        this.#ensureDatabase(input.database);
        insertSystem.run(
          input.name,
          nonEmpty(input.description, "system.description"),
          input.embedder.id,
          input.database.id,
          now,
          now,
        );
      }
      const insertMirror = this.#database.prepare(
        "INSERT INTO system_mirrors (source_system, target_system) VALUES (?, ?)",
      );
      for (const input of inputs) {
        for (const target of this.#validateMirrors(input.name, input.mirrors ?? [])) {
          insertMirror.run(input.name, target);
        }
      }
      if (options.defaultSystem === null) {
        this.#database.prepare("DELETE FROM settings WHERE key = 'defaultSystem'").run();
      } else if (options.defaultSystem !== undefined) {
        if (this.systems.get(options.defaultSystem) === null) {
          throw new ConfigurationError(`Unknown default system ${options.defaultSystem}`);
        }
        this.#setSetting("defaultSystem", options.defaultSystem);
      } else if (this.settings.getDefaultSystem() === null && names[0] !== undefined) {
        this.#setSetting("defaultSystem", names[0]);
      }
      return names.map((name) => this.systems.get(name)!);
    }),
    update: (name: string, patch: SystemUpdatePatch): SystemRecord => runTransaction(this.#database, () => {
      const current = this.systems.get(name);
      if (current === null) throw new ConfigurationError(`Unknown system ${name}`);
      const description = patch.description === undefined
        ? current.description
        : nonEmpty(patch.description, "system.description");
      const embedderId = patch.embedderId ?? current.embedderId;
      const databaseId = patch.databaseId ?? current.databaseId;
      if (this.embedders.get(embedderId) === null) throw new ConfigurationError(`Unknown embedder ${embedderId}`);
      if (this.databases.get(databaseId) === null) throw new ConfigurationError(`Unknown database ${databaseId}`);
      const mirrors = patch.mirrors === undefined ? current.mirrors : this.#validateMirrors(name, patch.mirrors);
      this.#database.prepare(`
        UPDATE systems SET description = ?, embedder_id = ?, database_id = ?, updated_at = ?
        WHERE name = ?
      `).run(description, embedderId, databaseId, new Date().toISOString(), name);
      if (patch.mirrors !== undefined) {
        this.#database.prepare("DELETE FROM system_mirrors WHERE source_system = ?").run(name);
        const insertMirror = this.#database.prepare(
          "INSERT INTO system_mirrors (source_system, target_system) VALUES (?, ?)",
        );
        for (const target of mirrors) insertMirror.run(name, target);
      }
      return this.systems.get(name)!;
    }),
    remove: (name: string): void => runTransaction(this.#database, () => {
      const inbound = this.#database.prepare(
        "SELECT source_system FROM system_mirrors WHERE target_system = ? ORDER BY source_system LIMIT 1",
      ).get(name) as SqlRow | null | undefined;
      if (inbound != null) {
        throw new ConfigurationError(
          `Cannot remove system ${name}; it is mirrored by ${stringColumn(inbound, "source_system")}`,
        );
      }
      const result = this.#database.prepare("DELETE FROM systems WHERE name = ?").run(name);
      if (result.changes === 0) throw new ConfigurationError(`Unknown system ${name}`);
      if (this.settings.get("defaultSystem") === name) {
        this.#database.prepare("DELETE FROM settings WHERE key = 'defaultSystem'").run();
      }
    }),
  };

  readonly settings = {
    get: (key: string): string | null => {
      const row = this.#database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as SqlRow | null | undefined;
      return row == null ? null : stringColumn(row, "value");
    },
    setDefaultSystem: (name: string | null): void => runTransaction(this.#database, () => {
      if (name === null) {
        this.#database.prepare("DELETE FROM settings WHERE key = 'defaultSystem'").run();
        return;
      }
      if (this.systems.get(name) === null) throw new ConfigurationError(`Unknown system ${name}`);
      this.#setSetting("defaultSystem", name);
    }),
    getDefaultSystem: (): string | null => this.settings.get("defaultSystem"),
  };

  readonly provisioning = {
    list: (): ProvisioningJournalEntry[] => rows(
      this.#database.prepare("SELECT * FROM provisioning_journal ORDER BY created_at, id"),
    ).map((row) => ({
      id: stringColumn(row, "id"),
      payload: stringColumn(row, "payload"),
      createdAt: stringColumn(row, "created_at"),
    })),
    record: (id: string, payload: string): void => {
      this.#database.prepare(
        "INSERT INTO provisioning_journal (id, payload, created_at) VALUES (?, ?, ?)",
      ).run(nonEmpty(id, "provisioning.id"), payload, new Date().toISOString());
    },
    remove: (id: string): void => {
      this.#database.prepare("DELETE FROM provisioning_journal WHERE id = ?").run(id);
    },
  };

  close(): void {
    this.#database.close();
  }

  #ensureEmbedder(input: EmbedderRegistration): void {
    validateEmbedder(input);
    const existing = this.embedders.get(input.id);
    if (existing !== null) {
      const comparable = ({
        createdAt: _created,
        updatedAt: _updated,
        lastHealthCheck: _health,
        requestModel: _requestModel,
        baseUrl: _baseUrl,
        ...rest
      }: EmbedderRecord) => rest;
      const {
        lastHealthCheck: _inputHealth,
        requestModel: _inputRequestModel,
        baseUrl: _inputBaseUrl,
        ...registration
      } = input;
      if (!isDeepStrictEqual(comparable(existing), registration)) {
        throw new ConfigurationError(`Embedder ${input.id} already exists with different settings`);
      }
      this.#database.prepare(`
        UPDATE embedders
        SET base_url = ?, request_model = ?, last_health_check = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.baseUrl ?? null,
        input.requestModel ?? null,
        input.lastHealthCheck ?? existing.lastHealthCheck ?? null,
        new Date().toISOString(),
        input.id,
      );
      return;
    }
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO embedders (
        id, provider_kind, api_style, base_url, base_url_env, model, request_model, revision, dim,
        max_tokens, recommended_chunk_size, token_counter, token_safety_margin,
        api_key_env, managed, limits_inferred, last_health_check, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.providerKind, input.apiStyle, input.baseUrl ?? null,
      input.baseUrlEnv ?? null, input.model, input.requestModel ?? null, input.revision, input.dim, input.maxTokens,
      input.recommendedChunkSize, input.tokenCounter, input.tokenSafetyMargin ?? null,
      input.apiKeyEnv, input.managed ? 1 : 0, input.limitsInferred ? 1 : 0,
      input.lastHealthCheck ?? null, now, now,
    );
  }

  #ensureDatabase(input: DatabaseRegistration): void {
    validateDatabase(input);
    const existing = this.databases.get(input.id);
    if (existing !== null) {
      const comparable = ({
        createdAt: _created,
        updatedAt: _updated,
        lastHealthCheck: _health,
        connectionUrl: _connectionUrl,
        ...rest
      }: DatabaseRecord) => rest;
      const {
        lastHealthCheck: _inputHealth,
        connectionUrl: _inputConnectionUrl,
        ...registration
      } = input;
      if (!isDeepStrictEqual(comparable(existing), registration)) {
        throw new ConfigurationError(`Database ${input.id} already exists with different settings`);
      }
      this.#database.prepare(`
        UPDATE databases SET connection_url = ?, last_health_check = ?, updated_at = ? WHERE id = ?
      `).run(
        input.connectionUrl ?? null,
        input.lastHealthCheck ?? existing.lastHealthCheck ?? null,
        new Date().toISOString(),
        input.id,
      );
      return;
    }
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO databases (
        id, kind, connection_url, url_env, runtime, container_name, volume_name,
        last_health_check, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.kind, input.connectionUrl ?? null, input.urlEnv ?? null,
      input.runtime ?? null, input.containerName ?? null, input.volumeName ?? null,
      input.lastHealthCheck ?? null, now, now,
    );
  }

  #systemFromRow(row: SqlRow): SystemRecord {
    return {
      name: stringColumn(row, "name"),
      description: stringColumn(row, "description"),
      embedderId: stringColumn(row, "embedder_id"),
      databaseId: stringColumn(row, "database_id"),
      mirrors: rows(
        this.#database.prepare(
          "SELECT target_system FROM system_mirrors WHERE source_system = ? ORDER BY target_system",
        ),
        stringColumn(row, "name"),
      ).map((mirror) => stringColumn(mirror, "target_system")),
      status: "ready",
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  #validateMirrors(source: string, targets: readonly string[]): string[] {
    const unique = [...new Set(targets.map((target) => nonEmpty(target, "mirror target")))];
    if (unique.length !== targets.length) throw new ConfigurationError("Mirror targets must be unique");
    for (const target of unique) {
      if (target === source) throw new MirrorConfigurationCycleError([source, source]);
      if (this.systems.get(target) === null) throw new ConfigurationError(`Unknown mirror target ${target}`);
    }
    const graph = new Map<string, string[]>();
    for (const system of this.systems.list()) graph.set(system.name, [...system.mirrors]);
    graph.set(source, unique);
    const visited = new Set<string>();
    const active = new Map<string, number>();
    const path: string[] = [];
    const visit = (name: string): void => {
      const cycleStart = active.get(name);
      if (cycleStart !== undefined) throw new MirrorConfigurationCycleError([...path.slice(cycleStart), name]);
      if (visited.has(name)) return;
      active.set(name, path.length);
      path.push(name);
      for (const target of graph.get(name) ?? []) visit(target);
      path.pop();
      active.delete(name);
      visited.add(name);
    };
    for (const name of graph.keys()) visit(name);
    return unique;
  }

  #setSetting(key: string, value: string): void {
    this.#database.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }
}

export async function openFrag(options: OpenFragOptions = {}): Promise<FragControlPlane> {
  const path = resolveRegistryPath(options);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const controlPlane = new FragControlPlane(path);
  try {
    await chmod(path, 0o600);
    return controlPlane;
  } catch (error) {
    controlPlane.close();
    throw error;
  }
}
