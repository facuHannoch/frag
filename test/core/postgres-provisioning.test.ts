import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  PostgresProvisioner,
  type CommandResult,
  type CommandRunOptions,
  type CommandRunner,
  type DatabaseRecord,
  type QueryResult,
  type Tx,
} from "../../src/core/index.js";

interface RunnerCall {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly options?: CommandRunOptions;
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  readonly #respond: (executable: string, arguments_: readonly string[]) => CommandResult;

  constructor(respond: (executable: string, arguments_: readonly string[]) => CommandResult) {
    this.#respond = respond;
  }

  async run(
    executable: string,
    arguments_: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    this.calls.push({ executable, arguments: [...arguments_], ...(options === undefined ? {} : { options }) });
    return this.#respond(executable, arguments_);
  }
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const missing = (kind: "container" | "volume"): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `Error: no such ${kind}`,
});

class FakeDatabase {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  closed = false;
  failReadiness = false;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (this.failReadiness && text === "SELECT 1 AS ready") throw new Error("not ready");
    const result = text.includes("AS similarity")
      ? { rows: [{ similarity: 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
    return result as QueryResult<Row>;
  }

  async withTransaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    return operation(this as unknown as Tx);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function newResourceRunner(): FakeRunner {
  return new FakeRunner((executable, arguments_) => {
    if (arguments_[0] === "info") return executable === "docker" ? ok("26") : { exitCode: 1, stdout: "", stderr: "offline" };
    if (arguments_[0] === "container" && arguments_[1] === "inspect") return missing("container");
    if (arguments_[0] === "volume" && arguments_[1] === "inspect") return missing("volume");
    if (arguments_[0] === "port") return ok("127.0.0.1:49152\n");
    return ok();
  });
}

test("detects only usable Docker or Podman runtimes", async () => {
  const runner = new FakeRunner((executable) => executable === "podman"
    ? ok("5.0")
    : { exitCode: 1, stdout: "", stderr: "daemon unavailable" });
  const provisioner = new PostgresProvisioner({ runner });
  assert.deepEqual(await provisioner.availableRuntimes(), ["podman"]);
  assert.deepEqual(runner.calls[0]?.arguments, ["info", "--format", "{{.ServerVersion}}"]);
  assert.deepEqual(runner.calls[1]?.arguments, ["info", "--format", "{{.Version.Version}}"]);
});

test("creates loopback managed pgvector and validates its real vector operations", async () => {
  const runner = newResourceRunner();
  const database = new FakeDatabase();
  let openedUrl = "";
  const provisioner = new PostgresProvisioner({
    runner,
    databaseFactory: (url) => {
      openedUrl = url;
      return database;
    },
    readinessAttempts: 1,
    readinessDelayMs: 0,
  });
  const ready = await provisioner.ensureManaged(3);
  assert.equal(ready.runtime, "docker");
  assert.equal(ready.createdContainer, true);
  assert.equal(ready.createdVolume, true);
  assert.match(openedUrl, /^postgresql:\/\/frag:[^@]+@127\.0\.0\.1:49152\/frag$/u);
  assert.equal(ready.registration.connectionUrl, openedUrl);
  const run = runner.calls.find(({ arguments: arguments_ }) => arguments_[0] === "run")!;
  assert.ok(run.arguments.includes("127.0.0.1::5432"));
  assert.ok(run.arguments.includes("POSTGRES_PASSWORD"));
  assert.equal(run.arguments.some((argument) => argument.includes(new URL(openedUrl).password)), false);
  assert.equal(typeof run.options?.environment?.POSTGRES_PASSWORD, "string");
  assert.ok(database.queries.some(({ text }) => text.includes("CREATE EXTENSION IF NOT EXISTS vector")));
  assert.ok(database.queries.some(({ text }) => text.includes("VECTOR(3)")));
  assert.ok(database.queries.some(({ text, values }) => text.includes("AS similarity") && values[0] === "[1,0,0]"));
  assert.equal(database.closed, true);

  await provisioner.releaseManaged(ready);
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_.join(" ") === "rm --force frag-postgres-v1"));
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_.join(" ") === "volume rm frag-postgres-data-v1"));
});

test("restarts and reuses only a labelled managed container with its stored credential", async () => {
  const runner = new FakeRunner((executable, arguments_) => {
    if (arguments_[0] === "info") return executable === "docker" ? ok("26") : { exitCode: 1, stdout: "", stderr: "" };
    if (arguments_[0] === "container") return ok("true|false\n");
    if (arguments_[0] === "volume" && arguments_[1] === "inspect") return ok("true\n");
    if (arguments_[0] === "port") return ok("127.0.0.1:40000\n");
    return ok();
  });
  const database = new FakeDatabase();
  const existing: DatabaseRecord = {
    id: "managed:local",
    kind: "managed-postgres",
    connectionUrl: "postgresql://frag:known-password@127.0.0.1:40000/frag",
    runtime: "docker",
    containerName: "frag-postgres-v1",
    volumeName: "frag-postgres-data-v1",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
  const provisioner = new PostgresProvisioner({
    runner,
    databaseFactory: () => database,
    readinessAttempts: 1,
    readinessDelayMs: 0,
  });
  const ready = await provisioner.ensureManaged(2, existing);
  assert.equal(ready.createdContainer, false);
  assert.equal(ready.startedExistingContainer, true);
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_.join(" ") === "start frag-postgres-v1"));
  await provisioner.releaseManaged(ready);
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_.join(" ") === "stop frag-postgres-v1"));
  assert.equal(runner.calls.some(({ arguments: arguments_ }) => arguments_[0] === "rm"), false);
});

test("refuses orphaned or unlabelled resources instead of taking ownership", async () => {
  const orphanRunner = new FakeRunner((executable, arguments_) => {
    if (arguments_[0] === "info") return executable === "docker" ? ok("26") : { exitCode: 1, stdout: "", stderr: "" };
    if (arguments_[0] === "container") return missing("container");
    if (arguments_[0] === "volume") return ok("true");
    return ok();
  });
  await assert.rejects(
    () => new PostgresProvisioner({ runner: orphanRunner }).ensureManaged(2),
    /without their registry record/u,
  );
  assert.equal(orphanRunner.calls.some(({ arguments: arguments_ }) => arguments_[1] === "create"), false);

  const foreignRunner = new FakeRunner((executable, arguments_) => {
    if (arguments_[0] === "info") return executable === "docker" ? ok("26") : { exitCode: 1, stdout: "", stderr: "" };
    if (arguments_[0] === "container") return ok("|true");
    return missing("volume");
  });
  await assert.rejects(
    () => new PostgresProvisioner({ runner: foreignRunner }).ensureManaged(2),
    /not owned by Frag/u,
  );
});

test("verifies existing PostgreSQL while persisting only its environment reference", async () => {
  const database = new FakeDatabase();
  let openedUrl = "";
  const provisioner = new PostgresProvisioner({
    runner: new FakeRunner(() => ok()),
    databaseFactory: (url) => {
      openedUrl = url;
      return database;
    },
    readinessAttempts: 1,
    readinessDelayMs: 0,
  });
  const registration = await provisioner.verifyExisting({
    id: "existing:team",
    urlEnv: "TEAM_DATABASE_URL",
    dimension: 4,
    environment: { TEAM_DATABASE_URL: "postgresql://user:secret@example.test/frag" },
  });
  assert.equal(openedUrl, "postgresql://user:secret@example.test/frag");
  assert.equal(registration.urlEnv, "TEAM_DATABASE_URL");
  assert.equal(registration.connectionUrl, undefined);
  assert.equal(JSON.stringify(registration).includes("secret"), false);
  await assert.rejects(
    () => provisioner.verifyExisting({
      id: "existing:team",
      urlEnv: "MISSING",
      dimension: 4,
      environment: {},
    }),
    ConfigurationError,
  );
});

test("removes newly created resources when database readiness fails", async () => {
  const runner = newResourceRunner();
  const database = new FakeDatabase();
  database.failReadiness = true;
  const provisioner = new PostgresProvisioner({
    runner,
    databaseFactory: () => database,
    readinessAttempts: 1,
    readinessDelayMs: 0,
  });
  await assert.rejects(() => provisioner.ensureManaged(2), /did not become ready/u);
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_[0] === "rm"));
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_.join(" ") === "volume rm frag-postgres-data-v1"));
});

test("names persistent resources when failure cleanup is incomplete", async () => {
  const runner = new FakeRunner((executable, arguments_) => {
    if (arguments_[0] === "info") return executable === "docker" ? ok("26") : { exitCode: 1, stdout: "", stderr: "" };
    if (arguments_[0] === "container" && arguments_[1] === "inspect") return missing("container");
    if (arguments_[0] === "volume" && arguments_[1] === "inspect") return missing("volume");
    if (arguments_[0] === "port") return ok("127.0.0.1:49152\n");
    if (arguments_[0] === "rm" || (arguments_[0] === "volume" && arguments_[1] === "rm")) {
      return { exitCode: 1, stdout: "", stderr: "busy" };
    }
    return ok();
  });
  const database = new FakeDatabase();
  database.failReadiness = true;
  const provisioner = new PostgresProvisioner({
    runner,
    databaseFactory: () => database,
    readinessAttempts: 1,
    readinessDelayMs: 0,
  });
  await assert.rejects(
    () => provisioner.ensureManaged(2),
    (error: unknown) => error instanceof ConfigurationError &&
      /cleanup was incomplete/u.test(error.message) &&
      error.message.includes("frag-postgres-v1") &&
      error.message.includes("frag-postgres-data-v1"),
  );
});

test("recovers only ownership-labelled managed container and volume orphans", async () => {
  const runner = new FakeRunner((executable, arguments_) => {
    if (arguments_[0] === "info") return executable === "podman" ? ok("5") : { exitCode: 1, stdout: "", stderr: "" };
    if (arguments_[0] === "container") return ok("true|true");
    if (arguments_[0] === "volume" && arguments_[1] === "inspect") return ok("true");
    return ok();
  });
  const recovered = await new PostgresProvisioner({ runner }).recoverManagedOrphans();
  assert.deepEqual(recovered, { recovered: true, runtimes: ["podman"] });
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_.join(" ") === "rm --force frag-postgres-v1"));
  assert.ok(runner.calls.some(({ arguments: arguments_ }) => arguments_.join(" ") === "volume rm frag-postgres-data-v1"));
});
