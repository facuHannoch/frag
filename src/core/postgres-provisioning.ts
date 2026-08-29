import { randomBytes } from "node:crypto";

import { ConfigurationError } from "./errors.js";
import type {
  ContainerRuntime,
  DatabaseRecord,
  DatabaseRegistration,
} from "./global-registry.js";
import { ProcessCommandRunner, type CommandResult, type CommandRunner } from "./lmstudio.js";
import { PostgresDatabase } from "./postgres/database.js";
import { assertEmbeddingDimension, bootstrapSchema, vectorLiteral } from "./postgres/sql.js";
import type { Queryable, Transactional } from "./store.js";

const MANAGED_DATABASE_ID = "managed:local";
const MANAGED_CONTAINER = "frag-postgres-v1";
const MANAGED_VOLUME = "frag-postgres-data-v1";
const MANAGED_IMAGE = "pgvector/pgvector:pg16";
const MANAGED_LABEL = "dev.frag.managed";

interface ProvisioningDatabase extends Queryable, Transactional {
  close(): Promise<void>;
}

export interface ManagedPostgresReady {
  readonly registration: DatabaseRegistration;
  readonly runtime: ContainerRuntime;
  readonly createdContainer: boolean;
  readonly createdVolume: boolean;
  readonly startedExistingContainer: boolean;
}

export interface ManagedPostgresRecovery {
  readonly recovered: boolean;
  readonly runtimes: readonly ContainerRuntime[];
}

export interface ExistingPostgresInput {
  readonly id: string;
  readonly urlEnv: string;
  readonly dimension: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface PostgresProvisionerOptions {
  readonly runner?: CommandRunner;
  readonly databaseFactory?: (connectionUrl: string) => ProvisioningDatabase;
  readonly readinessAttempts?: number;
  readonly readinessDelayMs?: number;
}

interface ContainerStatus {
  readonly exists: boolean;
  readonly running: boolean;
}

function failure(command: string, result: CommandResult): ConfigurationError {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return new ConfigurationError(`${command} failed: ${detail}`, { exitCode: result.exitCode });
}

function isMissing(result: CommandResult): boolean {
  return /no such (container|object|volume)|not found/iu.test(`${result.stderr}\n${result.stdout}`);
}

function managedConnectionUrl(port: number, password: string): string {
  return `postgresql://frag:${encodeURIComponent(password)}@127.0.0.1:${port}/frag`;
}

function passwordFromManagedRecord(record: DatabaseRecord): string {
  if (record.kind !== "managed-postgres" || record.connectionUrl === undefined) {
    throw new ConfigurationError("The existing managed database registration is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(record.connectionUrl);
  } catch (error) {
    throw new ConfigurationError("The managed database connection URL is invalid", {}, { cause: error });
  }
  if (parsed.hostname !== "127.0.0.1" || parsed.username !== "frag" || parsed.password.length === 0) {
    throw new ConfigurationError("The managed database registration is not a Frag loopback database");
  }
  return decodeURIComponent(parsed.password);
}

export class PostgresProvisioner {
  readonly #runner: CommandRunner;
  readonly #databaseFactory: (connectionUrl: string) => ProvisioningDatabase;
  readonly #readinessAttempts: number;
  readonly #readinessDelayMs: number;

  constructor(options: PostgresProvisionerOptions = {}) {
    this.#runner = options.runner ?? new ProcessCommandRunner();
    this.#databaseFactory = options.databaseFactory ?? ((url) => new PostgresDatabase(url));
    this.#readinessAttempts = options.readinessAttempts ?? 30;
    this.#readinessDelayMs = options.readinessDelayMs ?? 500;
  }

  async availableRuntimes(): Promise<ContainerRuntime[]> {
    const available: ContainerRuntime[] = [];
    for (const runtime of ["docker", "podman"] as const) {
      try {
        const format = runtime === "docker" ? "{{.ServerVersion}}" : "{{.Version.Version}}";
        const result = await this.#runner.run(runtime, ["info", "--format", format]);
        if (result.exitCode === 0) available.push(runtime);
      } catch {
        // Absence and an unavailable daemon both make this runtime unavailable.
      }
    }
    return available;
  }

  async ensureManaged(
    dimension: number,
    existing?: DatabaseRecord,
  ): Promise<ManagedPostgresReady> {
    assertEmbeddingDimension(dimension);
    const available = await this.availableRuntimes();
    const requestedRuntime = existing?.runtime;
    const runtime = requestedRuntime === undefined ? available[0] : available.find((item) => item === requestedRuntime);
    if (runtime === undefined) {
      throw new ConfigurationError(
        requestedRuntime === undefined
          ? "Managed local PostgreSQL needs a running Docker or Podman service. Start one, or choose Existing PostgreSQL."
          : `Managed local PostgreSQL was created with ${requestedRuntime}, but that runtime is not available.`,
      );
    }
    const container = await this.#containerStatus(runtime);
    const volumeExists = await this.#volumeExists(runtime);
    if ((container.exists || volumeExists) && existing === undefined) {
      throw new ConfigurationError(
        `Found Frag-managed PostgreSQL resources without their registry record. Recover or remove ${MANAGED_CONTAINER} and ${MANAGED_VOLUME} before retrying.`,
        { container: MANAGED_CONTAINER, volume: MANAGED_VOLUME },
      );
    }

    let createdVolume = false;
    let createdContainer = false;
    let startedExistingContainer = false;
    const password = existing === undefined
      ? randomBytes(24).toString("base64url")
      : passwordFromManagedRecord(existing);
    try {
      if (!volumeExists) {
        const createVolume = await this.#runner.run(runtime, [
          "volume", "create", "--label", `${MANAGED_LABEL}=true`, MANAGED_VOLUME,
        ]);
        if (createVolume.exitCode !== 0) throw failure(`${runtime} volume create`, createVolume);
        createdVolume = true;
      }
      if (!container.exists) {
        const create = await this.#runner.run(runtime, [
          "run", "--detach",
          "--name", MANAGED_CONTAINER,
          "--label", `${MANAGED_LABEL}=true`,
          "--publish", "127.0.0.1::5432",
          "--mount", `type=volume,source=${MANAGED_VOLUME},target=/var/lib/postgresql/data`,
          "--env", "POSTGRES_USER=frag",
          "--env", "POSTGRES_PASSWORD",
          "--env", "POSTGRES_DB=frag",
          MANAGED_IMAGE,
        ], { environment: { POSTGRES_PASSWORD: password } });
        if (create.exitCode !== 0) throw failure(`${runtime} run`, create);
        createdContainer = true;
      } else if (!container.running) {
        const start = await this.#runner.run(runtime, ["start", MANAGED_CONTAINER]);
        if (start.exitCode !== 0) throw failure(`${runtime} start`, start);
        startedExistingContainer = true;
      }
      const port = await this.#mappedPort(runtime);
      const connectionUrl = managedConnectionUrl(port, password);
      await this.#verify(connectionUrl, dimension, this.#readinessAttempts);
      return {
        registration: {
          id: MANAGED_DATABASE_ID,
          kind: "managed-postgres",
          connectionUrl,
          runtime,
          containerName: MANAGED_CONTAINER,
          volumeName: MANAGED_VOLUME,
          lastHealthCheck: new Date().toISOString(),
        },
        runtime,
        createdContainer,
        createdVolume,
        startedExistingContainer,
      };
    } catch (error) {
      const cleanupFailures = await this.#cleanup(runtime, {
        createdContainer,
        createdVolume,
        startedExistingContainer,
      });
      if (cleanupFailures.length > 0) {
        throw new ConfigurationError(
          `PostgreSQL provisioning failed and cleanup was incomplete for ${cleanupFailures.join(", ")}`,
          { cleanupFailures, container: MANAGED_CONTAINER, volume: MANAGED_VOLUME },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async verifyExisting(input: ExistingPostgresInput): Promise<DatabaseRegistration> {
    assertEmbeddingDimension(input.dimension);
    if (input.id.trim().length === 0 || input.urlEnv.trim().length === 0) {
      throw new ConfigurationError("Existing PostgreSQL id and environment variable must be non-empty");
    }
    const environment = input.environment ?? process.env;
    const connectionUrl = environment[input.urlEnv];
    if (connectionUrl === undefined || connectionUrl.length === 0) {
      throw new ConfigurationError(`Environment variable ${input.urlEnv} is not set`);
    }
    await this.#verify(connectionUrl, input.dimension, 1);
    return {
      id: input.id,
      kind: "existing-postgres",
      urlEnv: input.urlEnv,
      lastHealthCheck: new Date().toISOString(),
    };
  }

  async releaseManaged(ready: ManagedPostgresReady): Promise<void> {
    const failures = await this.#cleanup(ready.runtime, ready);
    if (failures.length > 0) {
      throw new ConfigurationError(
        `Could not clean up managed PostgreSQL resources: ${failures.join(", ")}`,
        { failures, container: MANAGED_CONTAINER, volume: MANAGED_VOLUME },
      );
    }
  }

  async recoverManagedOrphans(): Promise<ManagedPostgresRecovery> {
    const recovered: ContainerRuntime[] = [];
    for (const runtime of await this.availableRuntimes()) {
      const container = await this.#containerStatus(runtime);
      const volume = await this.#volumeExists(runtime);
      if (!container.exists && !volume) continue;
      const failures = await this.#cleanup(runtime, {
        createdContainer: container.exists,
        createdVolume: volume,
        startedExistingContainer: false,
      });
      if (failures.length > 0) {
        throw new ConfigurationError(`Could not recover managed PostgreSQL resources: ${failures.join(", ")}`, {
          failures,
        });
      }
      recovered.push(runtime);
    }
    return { recovered: recovered.length > 0, runtimes: recovered };
  }

  async #containerStatus(runtime: ContainerRuntime): Promise<ContainerStatus> {
    const result = await this.#runner.run(runtime, [
      "container", "inspect", MANAGED_CONTAINER,
      "--format", `{{index .Config.Labels \"${MANAGED_LABEL}\"}}|{{.State.Running}}`,
    ]);
    if (result.exitCode !== 0) {
      if (isMissing(result)) return { exists: false, running: false };
      throw failure(`${runtime} container inspect`, result);
    }
    const [managed, running] = result.stdout.trim().split("|");
    if (managed !== "true") {
      throw new ConfigurationError(`Container ${MANAGED_CONTAINER} exists but is not owned by Frag`);
    }
    return { exists: true, running: running === "true" };
  }

  async #volumeExists(runtime: ContainerRuntime): Promise<boolean> {
    const result = await this.#runner.run(runtime, [
      "volume", "inspect", MANAGED_VOLUME,
      "--format", `{{index .Labels \"${MANAGED_LABEL}\"}}`,
    ]);
    if (result.exitCode !== 0) {
      if (isMissing(result)) return false;
      throw failure(`${runtime} volume inspect`, result);
    }
    if (result.stdout.trim() !== "true") {
      throw new ConfigurationError(`Volume ${MANAGED_VOLUME} exists but is not owned by Frag`);
    }
    return true;
  }

  async #mappedPort(runtime: ContainerRuntime): Promise<number> {
    const result = await this.#runner.run(runtime, ["port", MANAGED_CONTAINER, "5432/tcp"]);
    if (result.exitCode !== 0) throw failure(`${runtime} port`, result);
    const line = result.stdout.trim().split(/\r?\n/u).find((value) => value.startsWith("127.0.0.1:"));
    const match = line === undefined ? null : /^127\.0\.0\.1:(\d+)$/u.exec(line);
    const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
      throw new ConfigurationError("Managed PostgreSQL is not bound to a valid loopback port");
    }
    return port;
  }

  async #verify(connectionUrl: string, dimension: number, attempts: number): Promise<void> {
    const database = this.#databaseFactory(connectionUrl);
    try {
      let ready = false;
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await database.query("SELECT 1 AS ready");
          ready = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attempts && this.#readinessDelayMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, this.#readinessDelayMs));
          }
        }
      }
      if (!ready) throw new ConfigurationError("PostgreSQL did not become ready", {}, { cause: lastError });
      await bootstrapSchema(database, [dimension]);
      const probe = Array.from({ length: dimension }, (_, index) => index === 0 ? 1 : 0);
      const literal = vectorLiteral(probe, dimension);
      await database.withTransaction(async (tx) => {
        await tx.query(`CREATE TEMP TABLE _frag_vector_probe (embedding VECTOR(${dimension}) NOT NULL) ON COMMIT DROP`);
        await tx.query("INSERT INTO _frag_vector_probe (embedding) VALUES ($1::vector)", [literal]);
        const result = await tx.query<{ similarity: number | string }>(
          "SELECT 1 - (embedding <=> $1::vector) AS similarity FROM _frag_vector_probe",
          [literal],
        );
        const similarity = Number(result.rows[0]?.similarity);
        if (!Number.isFinite(similarity) || Math.abs(similarity - 1) > 1e-9) {
          throw new ConfigurationError("pgvector similarity probe returned an invalid result");
        }
      });
    } finally {
      await database.close();
    }
  }

  async #cleanup(
    runtime: ContainerRuntime,
    ownership: {
      readonly createdContainer: boolean;
      readonly createdVolume: boolean;
      readonly startedExistingContainer: boolean;
    },
  ): Promise<string[]> {
    const failures: string[] = [];
    const attempt = async (resource: string, arguments_: readonly string[]): Promise<void> => {
      try {
        const result = await this.#runner.run(runtime, arguments_);
        if (result.exitCode !== 0) failures.push(resource);
      } catch {
        failures.push(resource);
      }
    };
    if (ownership.createdContainer) {
      await attempt(`container ${MANAGED_CONTAINER}`, ["rm", "--force", MANAGED_CONTAINER]);
    } else if (ownership.startedExistingContainer) {
      await attempt(`container ${MANAGED_CONTAINER} (restore stopped state)`, ["stop", MANAGED_CONTAINER]);
    }
    if (ownership.createdVolume) {
      await attempt(`volume ${MANAGED_VOLUME}`, ["volume", "rm", MANAGED_VOLUME]);
    }
    return failures;
  }
}
