import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  ConfigurationError,
  MirrorConfigurationCycleError,
  openFrag,
  resolveFragHome,
  type DatabaseRegistration,
  type EmbedderRegistration,
} from "../../src/core/index.js";

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "frag-registry-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

const embedder: EmbedderRegistration = {
  id: "lmstudio:nomic",
  providerKind: "lmstudio",
  apiStyle: "openai",
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "text-embedding-nomic-embed-text-v1.5",
  revision: "1",
  dim: 768,
  maxTokens: 8192,
  recommendedChunkSize: 500,
  tokenCounter: "estimate",
  tokenSafetyMargin: 0.8,
  apiKeyEnv: null,
  managed: true,
  limitsInferred: true,
  lastHealthCheck: "2026-08-28T00:00:00.000Z",
};

const database: DatabaseRegistration = {
  id: "managed:local",
  kind: "managed-postgres",
  connectionUrl: "postgres://frag:secret@127.0.0.1:54329/frag",
  runtime: "docker",
  containerName: "frag-postgres",
  volumeName: "frag-postgres-data",
  lastHealthCheck: "2026-08-28T00:00:00.000Z",
};

test("resolves platform application-data paths and FRAG_HOME", () => {
  assert.equal(
    resolveFragHome({ platform: "linux", homeDirectory: "/users/me", environment: {} }),
    "/users/me/.local/share/frag",
  );
  assert.equal(
    resolveFragHome({
      platform: "linux",
      homeDirectory: "/users/me",
      environment: { XDG_DATA_HOME: "/data" },
    }),
    "/data/frag",
  );
  assert.equal(
    resolveFragHome({ platform: "darwin", homeDirectory: "/Users/me", environment: {} }),
    "/Users/me/Library/Application Support/Frag",
  );
  assert.equal(
    resolveFragHome({
      platform: "win32",
      homeDirectory: "C:\\Users\\me",
      environment: { LOCALAPPDATA: "D:\\Local" },
    }),
    join("D:\\Local", "Frag"),
  );
  assert.equal(
    resolveFragHome({ environment: { FRAG_HOME: "/portable/frag" } }),
    "/portable/frag",
  );
});

test("opens an owner-only registry and persists systems across processes", async () => {
  const directory = await temporaryDirectory();
  await chmod(directory, 0o755);
  const registryPath = join(directory, "nested", "registry.sqlite3");
  const frag = await openFrag({ registryPath });
  frag.systems.create({
    name: "public",
    description: "Curated information",
    embedder,
    database,
  });
  frag.systems.create({
    name: "notes",
    description: "Working notes",
    embedder,
    database,
    mirrors: ["public"],
  });
  assert.deepEqual(frag.systems.list().map(({ name }) => name), ["notes", "public"]);
  assert.deepEqual(frag.systems.get("notes")?.mirrors, ["public"]);
  assert.equal(frag.settings.getDefaultSystem(), "public");
  frag.settings.setDefaultSystem("notes");
  frag.close();

  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);

  const reopened = await openFrag({ registryPath });
  assert.equal(reopened.systems.get("notes")?.description, "Working notes");
  assert.equal(reopened.settings.getDefaultSystem(), "notes");
  reopened.close();
});

test("creates resources, system, mirrors, and default in one transaction", async () => {
  const directory = await temporaryDirectory();
  const frag = await openFrag({ registryPath: join(directory, "registry.sqlite3") });
  frag.systems.create({ name: "target", description: "Target", embedder, database });

  const secondEmbedder = { ...embedder, id: "lmstudio:other", model: "other" };
  const secondDatabase: DatabaseRegistration = {
    id: "existing:cloud",
    kind: "existing-postgres",
    urlEnv: "CLOUD_DATABASE_URL",
  };
  assert.throws(
    () => frag.systems.create({
      name: "broken",
      description: "Broken",
      embedder: secondEmbedder,
      database: secondDatabase,
      mirrors: ["missing"],
    }),
    ConfigurationError,
  );
  assert.equal(frag.systems.get("broken"), null);
  assert.equal(frag.embedders.get(secondEmbedder.id), null);
  assert.equal(frag.databases.get(secondDatabase.id), null);

  const created = frag.systems.create({
    name: "source",
    description: "Source",
    embedder: secondEmbedder,
    database: secondDatabase,
    mirrors: ["target"],
    setDefault: true,
  });
  assert.deepEqual(created.mirrors, ["target"]);
  assert.equal(frag.settings.getDefaultSystem(), "source");
  assert.equal(frag.databases.get(secondDatabase.id)?.connectionUrl, undefined);
  frag.close();
});

test("updates systems while rejecting mirror cycles and unsafe removal", async () => {
  const directory = await temporaryDirectory();
  const frag = await openFrag({ registryPath: join(directory, "registry.sqlite3") });
  frag.systems.create({ name: "one", description: "One", embedder, database });
  frag.systems.create({ name: "two", description: "Two", embedder, database, mirrors: ["one"] });

  assert.throws(() => frag.systems.update("one", { mirrors: ["two"] }), MirrorConfigurationCycleError);
  assert.deepEqual(frag.systems.get("one")?.mirrors, []);
  assert.throws(() => frag.systems.remove("one"), /mirrored by two/u);
  frag.systems.update("two", { description: "Updated", mirrors: [] });
  assert.equal(frag.systems.get("two")?.description, "Updated");
  frag.systems.remove("one");
  assert.equal(frag.systems.get("one"), null);
  frag.close();
});

test("validates resource secret boundaries and keeps journals out of systems", async () => {
  const directory = await temporaryDirectory();
  const frag = await openFrag({ registryPath: join(directory, "registry.sqlite3") });
  assert.throws(
    () => frag.databases.register({
      id: "bad-existing",
      kind: "existing-postgres",
      connectionUrl: "postgres://secret",
    }),
    ConfigurationError,
  );
  frag.provisioning.record("attempt-1", JSON.stringify({ container: "temporary" }));
  assert.equal(frag.systems.list().length, 0);
  assert.equal(frag.provisioning.list().length, 1);
  frag.provisioning.remove("attempt-1");
  assert.equal(frag.provisioning.list().length, 0);
  frag.close();
});
