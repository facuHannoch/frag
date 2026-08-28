import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  MirrorConfigurationCycleError,
  exportFragYaml,
  importFragYaml,
  openFrag,
  type DatabaseRegistration,
  type EmbedderRegistration,
  type LMStudioProvisioning,
  type LMStudioReadyModel,
  type ManagedPostgresReady,
  type PostgresProvisioning,
} from "../../src/core/index.js";

const directories: string[] = [];
after(async () => Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))));

async function pathFor(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `frag-${name}-`));
  directories.push(directory);
  return join(directory, "registry.sqlite3");
}

const embedder: EmbedderRegistration = {
  id: "lmstudio:nomic",
  providerKind: "lmstudio",
  apiStyle: "openai",
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "nomic",
  requestModel: "runtime-instance",
  revision: "1",
  dim: 3,
  maxTokens: 2048,
  recommendedChunkSize: 500,
  tokenCounter: "estimate",
  tokenSafetyMargin: 0.8,
  apiKeyEnv: null,
  managed: true,
  limitsInferred: false,
  lastHealthCheck: "2026-08-28T00:00:00.000Z",
};

const database: DatabaseRegistration = {
  id: "managed:local",
  kind: "managed-postgres",
  connectionUrl: "postgresql://frag:top-secret@127.0.0.1:40000/frag",
  runtime: "podman",
  containerName: "frag-postgres-v1",
  volumeName: "frag-postgres-data-v1",
  lastHealthCheck: "2026-08-28T00:00:00.000Z",
};

class ImportLMStudio implements LMStudioProvisioning {
  released = 0;

  async discoverEmbeddingModels() {
    return [{ key: "nomic", displayName: "Nomic" }];
  }

  async ensureReady(modelKey: string): Promise<LMStudioReadyModel> {
    return {
      model: { key: modelKey, displayName: "Nomic" },
      identifier: "imported-instance",
      baseUrl: embedder.baseUrl!,
      dimension: embedder.dim,
      maxTokens: embedder.maxTokens,
      limitsInferred: false,
      startedServer: true,
      loadedByFrag: true,
      registration: { ...embedder, model: modelKey, requestModel: "imported-instance" },
    };
  }

  async release(): Promise<void> {
    this.released += 1;
  }
}

class ImportPostgres implements PostgresProvisioning {
  released = 0;

  async availableRuntimes() {
    return ["podman" as const];
  }

  async ensureManaged(): Promise<ManagedPostgresReady> {
    return {
      registration: database,
      runtime: "podman",
      createdContainer: true,
      createdVolume: true,
      startedExistingContainer: false,
    };
  }

  async verifyExisting() {
    return { id: "existing:test", kind: "existing-postgres" as const, urlEnv: "DATABASE_URL" };
  }

  async releaseManaged(): Promise<void> {
    this.released += 1;
  }
}

test("exports secret-free v10 YAML and imports all systems in one registry commit", async () => {
  const source = await openFrag({ registryPath: await pathFor("export") });
  source.systems.create({ name: "public", description: "Public", embedder, database });
  source.systems.create({
    name: "notes",
    description: "Working notes",
    embedder,
    database,
    mirrors: ["public"],
    setDefault: true,
  });
  const yaml = exportFragYaml(source);
  assert.match(yaml, /^version: 10$/mu);
  assert.equal(yaml.includes("top-secret"), false);
  assert.equal(yaml.includes("connection_url"), false);
  assert.equal(yaml.includes("runtime-instance"), false);
  assert.equal(yaml.includes("last_health_check"), false);
  source.close();

  const target = await openFrag({ registryPath: await pathFor("import") });
  const lmStudio = new ImportLMStudio();
  const postgres = new ImportPostgres();
  const imported = await importFragYaml(target, yaml, { lmStudio, postgres });
  assert.deepEqual(imported.map(({ name }) => name), ["notes", "public"]);
  assert.deepEqual(target.systems.get("notes")?.mirrors, ["public"]);
  assert.equal(target.settings.getDefaultSystem(), "notes");
  assert.equal(target.provisioning.list().length, 0);
  assert.equal(lmStudio.released, 0);
  assert.equal(postgres.released, 0);
  target.close();
});

test("rolls back every imported system and releases resources when batch validation fails", async () => {
  const target = await openFrag({ registryPath: await pathFor("rollback") });
  const lmStudio = new ImportLMStudio();
  const postgres = new ImportPostgres();
  const invalid = `
version: 10
embedders:
  - id: lmstudio:nomic
    provider_kind: lmstudio
    model: nomic
databases:
  - id: managed:local
    kind: managed-postgres
systems:
  - name: one
    description: One
    embedder: lmstudio:nomic
    database: managed:local
    mirrors: [two]
  - name: two
    description: Two
    embedder: lmstudio:nomic
    database: managed:local
    mirrors: [one]
settings:
  default_system: one
`;
  await assert.rejects(
    () => importFragYaml(target, invalid, { lmStudio, postgres }),
    MirrorConfigurationCycleError,
  );
  assert.deepEqual(target.systems.list(), []);
  assert.equal(target.provisioning.list().length, 0);
  assert.equal(lmStudio.released, 1);
  assert.equal(postgres.released, 1);
  target.close();
});
