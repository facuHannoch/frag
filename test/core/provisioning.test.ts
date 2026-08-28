import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  ConfigurationError,
  SystemProvisioner,
  openFrag,
  recoverInterruptedProvisioning,
  type DatabaseRegistration,
  type EmbedderRegistration,
  type LMStudioProvisioning,
  type LMStudioReadyModel,
  type ManagedPostgresReady,
  type PostgresProvisioning,
} from "../../src/core/index.js";

const directories: string[] = [];
after(async () => Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))));

async function registryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "frag-provision-test-"));
  directories.push(directory);
  return join(directory, "registry.sqlite3");
}

function embedderRegistration(overrides: Partial<EmbedderRegistration> = {}): EmbedderRegistration {
  return {
    id: "lmstudio:nomic",
    providerKind: "lmstudio",
    apiStyle: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "nomic",
    requestModel: "frag-nomic",
    revision: "1",
    dim: 3,
    maxTokens: 2048,
    recommendedChunkSize: 500,
    tokenCounter: "estimate",
    tokenSafetyMargin: 0.8,
    apiKeyEnv: null,
    managed: true,
    limitsInferred: false,
    ...overrides,
  };
}

function readyModel(registration = embedderRegistration()): LMStudioReadyModel {
  return {
    model: { key: "nomic", displayName: "Nomic" },
    identifier: registration.requestModel ?? registration.model,
    baseUrl: registration.baseUrl!,
    dimension: registration.dim,
    maxTokens: registration.maxTokens,
    limitsInferred: registration.limitsInferred,
    startedServer: true,
    loadedByFrag: true,
    registration,
  };
}

function databaseRegistration(): DatabaseRegistration {
  return {
    id: "managed:local",
    kind: "managed-postgres",
    connectionUrl: "postgresql://frag:secret@127.0.0.1:40000/frag",
    runtime: "podman",
    containerName: "frag-postgres-v1",
    volumeName: "frag-postgres-data-v1",
  };
}

class FakeLMStudio implements LMStudioProvisioning {
  released = 0;
  ready = readyModel();

  async discoverEmbeddingModels() {
    return [this.ready.model];
  }

  async ensureReady() {
    return this.ready;
  }

  async release() {
    this.released += 1;
  }
}

class FakePostgres implements PostgresProvisioning {
  released = 0;
  fail = false;
  ready: ManagedPostgresReady = {
    registration: databaseRegistration(),
    runtime: "podman",
    createdContainer: true,
    createdVolume: true,
    startedExistingContainer: false,
  };

  async availableRuntimes() {
    return ["podman" as const];
  }

  async ensureManaged() {
    if (this.fail) throw new ConfigurationError("database failed");
    return this.ready;
  }

  async verifyExisting() {
    return { id: "existing:test", kind: "existing-postgres" as const, urlEnv: "DATABASE_URL" };
  }

  async releaseManaged() {
    this.released += 1;
  }
}

test("provisions dependencies then atomically exposes a ready system", async () => {
  const controlPlane = await openFrag({ registryPath: await registryPath() });
  const lmStudio = new FakeLMStudio();
  const postgres = new FakePostgres();
  const progress: string[] = [];
  const provisioner = new SystemProvisioner(controlPlane, {
    lmStudio,
    postgres,
    onProgress: (step) => progress.push(step),
  });
  const created = await provisioner.create({
    name: "notes",
    description: "Working notes",
    lmStudioModelKey: "nomic",
    database: { kind: "managed-postgres" },
  });
  assert.equal(created.name, "notes");
  assert.equal(controlPlane.systems.get("notes")?.status, "ready");
  assert.equal(controlPlane.provisioning.list().length, 0);
  assert.equal(lmStudio.released, 0);
  assert.equal(postgres.released, 0);
  assert.deepEqual(progress, ["embedding-model", "vector-database", "registry-commit", "complete"]);
  controlPlane.close();
});

test("cleans up dependencies and hides the system when registration fails", async () => {
  const controlPlane = await openFrag({ registryPath: await registryPath() });
  controlPlane.embedders.register(embedderRegistration({ dim: 4 }));
  const lmStudio = new FakeLMStudio();
  const postgres = new FakePostgres();
  const provisioner = new SystemProvisioner(controlPlane, { lmStudio, postgres });
  await assert.rejects(
    () => provisioner.create({
      name: "notes",
      description: "Working notes",
      lmStudioModelKey: "nomic",
      database: { kind: "managed-postgres" },
    }),
    /different settings/u,
  );
  assert.equal(controlPlane.systems.get("notes"), null);
  assert.equal(controlPlane.provisioning.list().length, 0);
  assert.equal(lmStudio.released, 1);
  assert.equal(postgres.released, 1);
  controlPlane.close();
});

test("validates names and mirror targets before starting external dependencies", async () => {
  const controlPlane = await openFrag({ registryPath: await registryPath() });
  const lmStudio = new FakeLMStudio();
  let ensured = 0;
  lmStudio.ensureReady = async () => {
    ensured += 1;
    return lmStudio.ready;
  };
  const provisioner = new SystemProvisioner(controlPlane, { lmStudio, postgres: new FakePostgres() });
  await assert.rejects(
    () => provisioner.create({
      name: "notes",
      description: "Working notes",
      lmStudioModelKey: "nomic",
      database: { kind: "managed-postgres" },
      mirrors: ["missing"],
    }),
    /Unknown mirror target/u,
  );
  assert.equal(ensured, 0);
  assert.equal(controlPlane.provisioning.list().length, 0);
  controlPlane.close();
});

test("recovers labelled managed resources after an interrupted journaled attempt", async () => {
  const controlPlane = await openFrag({ registryPath: await registryPath() });
  controlPlane.provisioning.record("interrupted", JSON.stringify({
    system: "notes",
    databaseKind: "managed-postgres",
  }));
  let calls = 0;
  const result = await recoverInterruptedProvisioning(controlPlane, {
    async recoverManagedOrphans() {
      calls += 1;
      return { recovered: true, runtimes: ["podman"] };
    },
  });
  assert.deepEqual(result, {
    journalEntries: 1,
    clearedEntries: 1,
    recoveredManagedPostgres: true,
    recoveredRuntimes: ["podman"],
  });
  assert.equal(calls, 1);
  assert.equal(controlPlane.provisioning.list().length, 0);
  controlPlane.close();
});
