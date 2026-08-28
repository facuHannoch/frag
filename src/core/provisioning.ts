import { randomUUID } from "node:crypto";

import { ConfigurationError } from "./errors.js";
import type {
  FragControlPlane,
  SystemCreateInput,
  SystemRecord,
} from "./global-registry.js";
import { LMStudioService, type LMStudioModel, type LMStudioReadyModel } from "./lmstudio.js";
import {
  PostgresProvisioner,
  type ManagedPostgresReady,
} from "./postgres-provisioning.js";

export type SystemDatabaseChoice =
  | { readonly kind: "managed-postgres" }
  | {
      readonly kind: "existing-postgres";
      readonly id: string;
      readonly urlEnv: string;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    };

export interface ProvisionSystemInput {
  readonly name: string;
  readonly description: string;
  readonly lmStudioModelKey: string;
  readonly database: SystemDatabaseChoice;
  readonly mirrors?: readonly string[];
  readonly setDefault?: boolean;
}

export type ProvisioningStep =
  | "embedding-model"
  | "vector-database"
  | "registry-commit"
  | "complete";

export interface SystemProvisionerOptions {
  readonly lmStudio?: LMStudioProvisioning;
  readonly postgres?: PostgresProvisioning;
  readonly onProgress?: (step: ProvisioningStep, message: string) => void;
}

export interface PreparedSystem {
  readonly input: SystemCreateInput;
  finish(): void;
  release(): Promise<void>;
}

export interface LMStudioProvisioning {
  discoverEmbeddingModels(): Promise<LMStudioModel[]>;
  ensureReady(modelKey: string): Promise<LMStudioReadyModel>;
  release(ready: LMStudioReadyModel): Promise<void>;
}

export interface PostgresProvisioning {
  availableRuntimes(): ReturnType<PostgresProvisioner["availableRuntimes"]>;
  ensureManaged(
    dimension: number,
    existing?: Parameters<PostgresProvisioner["ensureManaged"]>[1],
  ): Promise<ManagedPostgresReady>;
  verifyExisting(
    input: Parameters<PostgresProvisioner["verifyExisting"]>[0],
  ): ReturnType<PostgresProvisioner["verifyExisting"]>;
  releaseManaged(ready: ManagedPostgresReady): Promise<void>;
}

export interface ProvisioningRecoveryResult {
  readonly journalEntries: number;
  readonly clearedEntries: number;
  readonly recoveredManagedPostgres: boolean;
  readonly recoveredRuntimes: readonly string[];
}

export async function recoverInterruptedProvisioning(
  controlPlane: FragControlPlane,
  postgres: Pick<PostgresProvisioner, "recoverManagedOrphans"> = new PostgresProvisioner(),
): Promise<ProvisioningRecoveryResult> {
  const entries = controlPlane.provisioning.list();
  if (entries.length === 0) {
    return {
      journalEntries: 0,
      clearedEntries: 0,
      recoveredManagedPostgres: false,
      recoveredRuntimes: [],
    };
  }
  let recovery = { recovered: false, runtimes: [] as readonly string[] };
  if (controlPlane.databases.get("managed:local") === null) {
    recovery = await postgres.recoverManagedOrphans();
  }
  for (const entry of entries) controlPlane.provisioning.remove(entry.id);
  return {
    journalEntries: entries.length,
    clearedEntries: entries.length,
    recoveredManagedPostgres: recovery.recovered,
    recoveredRuntimes: recovery.runtimes,
  };
}

export class SystemProvisioner {
  readonly #controlPlane: FragControlPlane;
  readonly #lmStudio: LMStudioProvisioning;
  readonly #postgres: PostgresProvisioning;
  readonly #onProgress: (step: ProvisioningStep, message: string) => void;

  constructor(controlPlane: FragControlPlane, options: SystemProvisionerOptions = {}) {
    this.#controlPlane = controlPlane;
    this.#lmStudio = options.lmStudio ?? new LMStudioService();
    this.#postgres = options.postgres ?? new PostgresProvisioner();
    this.#onProgress = options.onProgress ?? (() => undefined);
  }

  discoverEmbeddingModels(): Promise<LMStudioModel[]> {
    return this.#lmStudio.discoverEmbeddingModels();
  }

  availableDatabaseRuntimes() {
    return this.#postgres.availableRuntimes();
  }

  async create(input: ProvisionSystemInput): Promise<SystemRecord> {
    const prepared = await this.prepare(input);
    try {
      this.#onProgress("registry-commit", `Registering system ${input.name}`);
      const system = this.#controlPlane.systems.create(prepared.input);
      prepared.finish();
      this.#onProgress("complete", `System ${input.name} is ready`);
      return system;
    } catch (error) {
      await prepared.release().catch((cleanupError) => {
        throw new ConfigurationError(
          `System ${input.name} was not registered and some provisioned resources need recovery`,
          { cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
          { cause: error },
        );
      });
      throw error;
    }
  }

  async prepare(input: ProvisionSystemInput): Promise<PreparedSystem> {
    this.#validateBeforeProvisioning(input);
    const attemptId = randomUUID();
    this.#controlPlane.provisioning.record(attemptId, JSON.stringify({
      system: input.name,
      modelKey: input.lmStudioModelKey,
      databaseKind: input.database.kind,
      mirrors: input.mirrors ?? [],
    }));
    let embedderReady: LMStudioReadyModel | undefined;
    let postgresReady: ManagedPostgresReady | undefined;
    try {
      this.#onProgress("embedding-model", `Preparing ${input.lmStudioModelKey}`);
      embedderReady = await this.#lmStudio.ensureReady(input.lmStudioModelKey);
      this.#onProgress("vector-database", "Preparing PostgreSQL and pgvector");
      const database = input.database.kind === "managed-postgres"
        ? (postgresReady = await this.#postgres.ensureManaged(
            embedderReady.dimension,
            this.#controlPlane.databases.get("managed:local") ?? undefined,
          )).registration
        : await this.#postgres.verifyExisting({
            id: input.database.id,
            urlEnv: input.database.urlEnv,
            dimension: embedderReady.dimension,
            ...(input.database.environment === undefined ? {} : { environment: input.database.environment }),
          });
      const registrationInput: SystemCreateInput = {
        name: input.name,
        description: input.description,
        embedder: embedderReady.registration,
        database,
        mirrors: input.mirrors ?? [],
        ...(input.setDefault === undefined ? {} : { setDefault: input.setDefault }),
      };
      let finished = false;
      return {
        input: registrationInput,
        finish: () => {
          if (finished) return;
          this.#controlPlane.provisioning.remove(attemptId);
          finished = true;
        },
        release: async () => {
          if (finished) return;
          const cleanupErrors: unknown[] = [];
          if (postgresReady !== undefined) {
            await this.#postgres.releaseManaged(postgresReady).catch((error) => cleanupErrors.push(error));
          }
          if (embedderReady !== undefined) {
            await this.#lmStudio.release(embedderReady).catch((error) => cleanupErrors.push(error));
          }
          if (cleanupErrors.length === 0) {
            this.#controlPlane.provisioning.remove(attemptId);
            finished = true;
            return;
          }
          throw new ConfigurationError("Provisioned resources need recovery", {
            attemptId,
            cleanupErrors: cleanupErrors.map((item) => item instanceof Error ? item.message : String(item)),
          });
        },
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (postgresReady !== undefined) {
        await this.#postgres.releaseManaged(postgresReady).catch((cleanupError) => cleanupErrors.push(cleanupError));
      }
      if (embedderReady !== undefined) {
        await this.#lmStudio.release(embedderReady).catch((cleanupError) => cleanupErrors.push(cleanupError));
      }
      if (cleanupErrors.length === 0) this.#controlPlane.provisioning.remove(attemptId);
      if (cleanupErrors.length > 0) {
        throw new ConfigurationError(
          `System ${input.name} was not registered and some provisioned resources need recovery`,
          { attemptId, cleanupErrors: cleanupErrors.map((item) => item instanceof Error ? item.message : String(item)) },
          { cause: error },
        );
      }
      throw error;
    }
  }

  #validateBeforeProvisioning(input: ProvisionSystemInput): void {
    if (input.name.trim().length === 0) throw new ConfigurationError("System name must be non-empty");
    if (input.description.trim().length === 0) throw new ConfigurationError("System description must be non-empty");
    if (input.lmStudioModelKey.trim().length === 0) throw new ConfigurationError("Embedding model must be selected");
    if (this.#controlPlane.systems.get(input.name) !== null) {
      throw new ConfigurationError(`System ${input.name} already exists`);
    }
    const mirrors = input.mirrors ?? [];
    if (new Set(mirrors).size !== mirrors.length) throw new ConfigurationError("Mirror targets must be unique");
    for (const target of mirrors) {
      if (target === input.name) throw new ConfigurationError("A system cannot mirror to itself");
      if (this.#controlPlane.systems.get(target) === null) {
        throw new ConfigurationError(`Unknown mirror target ${target}`);
      }
    }
  }
}
