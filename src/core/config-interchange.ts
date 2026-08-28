import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";

import { ConfigurationError } from "./errors.js";
import type {
  DatabaseRecord,
  DatabaseRegistration,
  EmbedderRegistration,
  FragControlPlane,
  SystemCreateInput,
  SystemRecord,
} from "./global-registry.js";
import { LMStudioService, type LMStudioReadyModel } from "./lmstudio.js";
import {
  PostgresProvisioner,
  type ManagedPostgresReady,
} from "./postgres-provisioning.js";
import type { LMStudioProvisioning, PostgresProvisioning } from "./provisioning.js";

interface ExportDocument {
  readonly version: 10;
  readonly systems: readonly {
    readonly name: string;
    readonly description: string;
    readonly embedder: string;
    readonly database: string;
    readonly mirrors: readonly string[];
  }[];
  readonly embedders: readonly {
    readonly id: string;
    readonly provider_kind: string;
    readonly api_style: string;
    readonly base_url_env?: string;
    readonly model: string;
    readonly revision: string;
    readonly max_tokens: number;
    readonly recommended_chunk_size: number;
    readonly token_counter: string;
    readonly token_safety_margin?: number;
    readonly api_key_env: string | null;
  }[];
  readonly databases: readonly {
    readonly id: string;
    readonly kind: string;
    readonly url_env?: string;
  }[];
  readonly settings: { readonly default_system: string | null };
}

interface ImportedEmbedder {
  readonly id: string;
  readonly providerKind: string;
  readonly model: string;
}

interface ImportedDatabase {
  readonly id: string;
  readonly kind: "managed-postgres" | "existing-postgres";
  readonly urlEnv?: string;
}

interface ImportedSystem {
  readonly name: string;
  readonly description: string;
  readonly embedder: string;
  readonly database: string;
  readonly mirrors: readonly string[];
}

export interface ImportFragYamlOptions {
  readonly replace?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly lmStudio?: LMStudioProvisioning;
  readonly postgres?: PostgresProvisioning;
  readonly onProgress?: (message: string) => void;
}

function object(value: unknown, owner: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${owner} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, owner: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigurationError(`${owner} must be an array`);
  return value;
}

function text(value: unknown, owner: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${owner} must be a non-empty string`);
  }
  return value;
}

function unique<T extends { readonly id?: string; readonly name?: string }>(values: readonly T[], owner: string): void {
  const names = values.map((value) => value.id ?? value.name!);
  if (new Set(names).size !== names.length) throw new ConfigurationError(`${owner} names must be unique`);
}

function parseImportDocument(yaml: string): {
  embedders: ImportedEmbedder[];
  databases: ImportedDatabase[];
  systems: ImportedSystem[];
  defaultSystem: string | null;
} {
  let parsed: unknown;
  try {
    parsed = parse(yaml, { uniqueKeys: true });
  } catch (error) {
    throw new ConfigurationError("Import is not valid YAML", {}, { cause: error });
  }
  const root = object(parsed, "import");
  if (root.version !== 10) throw new ConfigurationError("Import version must be 10");
  const embedders = array(root.embedders, "embedders").map((value, index): ImportedEmbedder => {
    const item = object(value, `embedders[${index}]`);
    return {
      id: text(item.id, `embedders[${index}].id`),
      providerKind: text(item.provider_kind, `embedders[${index}].provider_kind`),
      model: text(item.model, `embedders[${index}].model`),
    };
  });
  const databases = array(root.databases, "databases").map((value, index): ImportedDatabase => {
    const item = object(value, `databases[${index}]`);
    const kind = text(item.kind, `databases[${index}].kind`);
    if (kind !== "managed-postgres" && kind !== "existing-postgres") {
      throw new ConfigurationError(`databases[${index}].kind is unsupported`);
    }
    const urlEnv = item.url_env === undefined ? undefined : text(item.url_env, `databases[${index}].url_env`);
    if (kind === "existing-postgres" && urlEnv === undefined) {
      throw new ConfigurationError(`databases[${index}].url_env is required`);
    }
    return { id: text(item.id, `databases[${index}].id`), kind, ...(urlEnv === undefined ? {} : { urlEnv }) };
  });
  const systems = array(root.systems, "systems").map((value, index): ImportedSystem => {
    const item = object(value, `systems[${index}]`);
    return {
      name: text(item.name, `systems[${index}].name`),
      description: text(item.description, `systems[${index}].description`),
      embedder: text(item.embedder, `systems[${index}].embedder`),
      database: text(item.database, `systems[${index}].database`),
      mirrors: item.mirrors === undefined
        ? []
        : array(item.mirrors, `systems[${index}].mirrors`).map((target, targetIndex) =>
            text(target, `systems[${index}].mirrors[${targetIndex}]`)),
    };
  });
  unique(embedders, "Embedder");
  unique(databases, "Database");
  unique(systems, "System");
  const embedderNames = new Set(embedders.map(({ id }) => id));
  const databaseNames = new Set(databases.map(({ id }) => id));
  const systemNames = new Set(systems.map(({ name }) => name));
  for (const system of systems) {
    if (!embedderNames.has(system.embedder)) throw new ConfigurationError(`System ${system.name} references unknown embedder`);
    if (!databaseNames.has(system.database)) throw new ConfigurationError(`System ${system.name} references unknown database`);
    for (const target of system.mirrors) {
      if (!systemNames.has(target)) throw new ConfigurationError(`System ${system.name} references unknown mirror ${target}`);
    }
  }
  const settings = root.settings === undefined ? {} : object(root.settings, "settings");
  const defaultSystem = settings.default_system === null || settings.default_system === undefined
    ? null
    : text(settings.default_system, "settings.default_system");
  if (defaultSystem !== null && !systemNames.has(defaultSystem)) {
    throw new ConfigurationError(`Default system ${defaultSystem} is not imported`);
  }
  return { embedders, databases, systems, defaultSystem };
}

export function exportFragYaml(controlPlane: FragControlPlane): string {
  const document: ExportDocument = {
    version: 10,
    systems: controlPlane.systems.list().map((system) => ({
      name: system.name,
      description: system.description,
      embedder: system.embedderId,
      database: system.databaseId,
      mirrors: system.mirrors,
    })),
    embedders: controlPlane.embedders.list().map((embedder) => ({
      id: embedder.id,
      provider_kind: embedder.providerKind,
      api_style: embedder.apiStyle,
      ...(embedder.baseUrlEnv === undefined ? {} : { base_url_env: embedder.baseUrlEnv }),
      model: embedder.model,
      revision: embedder.revision,
      max_tokens: embedder.maxTokens,
      recommended_chunk_size: embedder.recommendedChunkSize,
      token_counter: embedder.tokenCounter,
      ...(embedder.tokenSafetyMargin === undefined ? {} : { token_safety_margin: embedder.tokenSafetyMargin }),
      api_key_env: embedder.apiKeyEnv,
    })),
    databases: controlPlane.databases.list().map((database) => ({
      id: database.id,
      kind: database.kind,
      ...(database.urlEnv === undefined ? {} : { url_env: database.urlEnv }),
    })),
    settings: { default_system: controlPlane.settings.getDefaultSystem() },
  };
  return stringify(document, { lineWidth: 100 });
}

function temporaryDatabaseRecord(registration: DatabaseRegistration): DatabaseRecord {
  const now = new Date().toISOString();
  return { ...registration, createdAt: now, updatedAt: now };
}

export async function importFragYaml(
  controlPlane: FragControlPlane,
  yaml: string,
  options: ImportFragYamlOptions = {},
): Promise<SystemRecord[]> {
  const document = parseImportDocument(yaml);
  if (options.replace !== true) {
    const conflict = document.systems.find(({ name }) => controlPlane.systems.get(name) !== null);
    if (conflict !== undefined) throw new ConfigurationError(`System ${conflict.name} already exists`);
  }
  const lmStudio = options.lmStudio ?? new LMStudioService();
  const postgres = options.postgres ?? new PostgresProvisioner();
  const progress = options.onProgress ?? (() => undefined);
  const attemptId = randomUUID();
  controlPlane.provisioning.record(attemptId, JSON.stringify({
    operation: "config-import",
    systems: document.systems.map(({ name }) => name),
  }));
  const readyModels: LMStudioReadyModel[] = [];
  const readyDatabases: ManagedPostgresReady[] = [];
  try {
    const embedderRecords = new Map<string, EmbedderRegistration>();
    for (const definition of document.embedders) {
      if (definition.providerKind !== "lmstudio") {
        throw new ConfigurationError(
          `Import provisioning currently supports LM Studio embedders; ${definition.id} uses ${definition.providerKind}`,
        );
      }
      progress(`Verifying embedding model ${definition.model}`);
      const ready = await lmStudio.ensureReady(definition.model);
      readyModels.push(ready);
      embedderRecords.set(definition.id, { ...ready.registration, id: definition.id });
    }

    const databaseRecords = new Map<string, Map<number, DatabaseRegistration>>();
    for (const definition of document.databases) {
      const dimensions = [...new Set(document.systems
        .filter((system) => system.database === definition.id)
        .map((system) => embedderRecords.get(system.embedder)!.dim))];
      const registrations = new Map<number, DatabaseRegistration>();
      let managedExisting = definition.kind === "managed-postgres"
        ? controlPlane.databases.get(definition.id) ?? undefined
        : undefined;
      for (const dimension of dimensions) {
        progress(`Verifying ${definition.id} for ${dimension}-dimensional vectors`);
        if (definition.kind === "managed-postgres") {
          const ready = await postgres.ensureManaged(dimension, managedExisting);
          readyDatabases.push(ready);
          const registration = { ...ready.registration, id: definition.id };
          registrations.set(dimension, registration);
          managedExisting = temporaryDatabaseRecord(registration);
        } else {
          const registration = await postgres.verifyExisting({
            id: definition.id,
            urlEnv: definition.urlEnv!,
            dimension,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
          });
          registrations.set(dimension, registration);
        }
      }
      databaseRecords.set(definition.id, registrations);
    }

    const inputs: SystemCreateInput[] = document.systems.map((system) => {
      const embedder = embedderRecords.get(system.embedder)!;
      const database = databaseRecords.get(system.database)?.get(embedder.dim);
      if (database === undefined) throw new ConfigurationError(`Database ${system.database} was not prepared`);
      return {
        name: system.name,
        description: system.description,
        embedder,
        database,
        mirrors: system.mirrors,
      };
    });
    progress("Committing imported systems");
    const imported = controlPlane.systems.importPrepared(inputs, {
      replace: options.replace === true,
      defaultSystem: document.defaultSystem,
    });
    controlPlane.provisioning.remove(attemptId);
    return imported;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const ready of [...readyDatabases].reverse()) {
      await postgres.releaseManaged(ready).catch((cleanupError) => cleanupErrors.push(cleanupError));
    }
    for (const ready of [...readyModels].reverse()) {
      await lmStudio.release(ready).catch((cleanupError) => cleanupErrors.push(cleanupError));
    }
    if (cleanupErrors.length === 0) controlPlane.provisioning.remove(attemptId);
    if (cleanupErrors.length > 0) {
      throw new ConfigurationError("Config import failed and some resources need recovery", {
        attemptId,
        cleanupErrors: cleanupErrors.map((item) => item instanceof Error ? item.message : String(item)),
      }, { cause: error });
    }
    throw error;
  }
}
