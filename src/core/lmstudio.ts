import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { ConfigurationError } from "./errors.js";
import type { EmbedderRegistration } from "./global-registry.js";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunOptions {
  readonly environment?: Readonly<Record<string, string>>;
}

export interface CommandRunner {
  run(
    executable: string,
    arguments_: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

export interface LMStudioModel {
  readonly key: string;
  readonly displayName: string;
  readonly sizeBytes?: number;
}

export interface LMStudioReadyModel {
  readonly model: LMStudioModel;
  readonly identifier: string;
  readonly baseUrl: string;
  readonly dimension: number;
  readonly maxTokens: number;
  readonly limitsInferred: boolean;
  readonly startedServer: boolean;
  readonly loadedByFrag: boolean;
  readonly registration: EmbedderRegistration;
}

interface ApiModel {
  readonly type: "embedding" | "llm";
  readonly key: string;
  readonly displayName: string;
  readonly sizeBytes?: number;
  readonly maxContextLength?: number;
  readonly loadedInstanceIds: readonly string[];
}

export interface LMStudioOptions {
  readonly runner?: CommandRunner;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly executable?: string;
  readonly host?: string;
  readonly port?: number;
}

export class ProcessCommandRunner implements CommandRunner {
  async run(
    executable: string,
    arguments_: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, arguments_, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.environment === undefined
          ? process.env
          : { ...process.env, ...options.environment },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseJson(text: string, owner: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigurationError(`${owner} returned invalid JSON`, {}, { cause: error });
  }
}

export function parseLMStudioModelList(text: string): LMStudioModel[] {
  const parsed = parseJson(text, "lms model discovery");
  const root = objectValue(parsed);
  const candidates = Array.isArray(parsed)
    ? parsed
    : root !== null && Array.isArray(root.models)
      ? root.models
      : root !== null && Array.isArray(root.entries)
        ? root.entries
        : root !== null && Array.isArray(root.embeddingModels)
          ? root.embeddingModels
          : root !== null && Array.isArray(root.embedding_models)
            ? root.embedding_models
        : null;
  if (candidates === null) throw new ConfigurationError("lms model discovery returned an unsupported shape");
  const discovered = new Map<string, LMStudioModel>();
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      if (candidate.length > 0) discovered.set(candidate, { key: candidate, displayName: candidate });
      continue;
    }
    const raw = objectValue(candidate);
    if (raw === null) continue;
    if (raw.type === "llm") continue;
    const keyValue = raw.key ?? raw.modelKey ?? raw.model_key ?? raw.path;
    if (typeof keyValue !== "string" || keyValue.length === 0) continue;
    const nameValue = raw.display_name ?? raw.displayName ?? raw.name;
    const sizeBytes = optionalPositiveNumber(raw.size_bytes ?? raw.sizeBytes ?? raw.size);
    discovered.set(keyValue, {
      key: keyValue,
      displayName: typeof nameValue === "string" && nameValue.length > 0 ? nameValue : keyValue,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  }
  return [...discovered.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function parseApiModels(value: unknown): ApiModel[] {
  const root = objectValue(value);
  if (root === null || !Array.isArray(root.models)) {
    throw new ConfigurationError("LM Studio model API returned an unsupported shape");
  }
  const models: ApiModel[] = [];
  for (const candidate of root.models) {
    const raw = objectValue(candidate);
    if (raw === null || (raw.type !== "embedding" && raw.type !== "llm") || typeof raw.key !== "string") continue;
    const instances = Array.isArray(raw.loaded_instances)
      ? raw.loaded_instances.flatMap((instance) => {
          const item = objectValue(instance);
          return item !== null && typeof item.id === "string" ? [item.id] : [];
        })
      : [];
    const displayName = typeof raw.display_name === "string" ? raw.display_name : raw.key;
    const sizeBytes = optionalPositiveNumber(raw.size_bytes);
    const maxContextLength = optionalPositiveNumber(raw.max_context_length);
    models.push({
      type: raw.type,
      key: raw.key,
      displayName,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(maxContextLength === undefined ? {} : { maxContextLength }),
      loadedInstanceIds: instances,
    });
  }
  return models;
}

function stableIdentifier(modelKey: string): string {
  return `frag-${createHash("sha256").update(modelKey).digest("hex").slice(0, 16)}`;
}

function commandFailure(command: string, result: CommandResult): ConfigurationError {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return new ConfigurationError(`${command} failed: ${detail}`, { exitCode: result.exitCode });
}

export class LMStudioService {
  readonly #runner: CommandRunner;
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly #executable: string;
  readonly #host: string;
  readonly #port: number;

  constructor(options: LMStudioOptions = {}) {
    this.#runner = options.runner ?? new ProcessCommandRunner();
    this.#fetch = options.fetch ?? fetch;
    this.#executable = options.executable ?? "lms";
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 1234;
  }

  async discoverEmbeddingModels(): Promise<LMStudioModel[]> {
    let result: CommandResult;
    try {
      result = await this.#runner.run(this.#executable, ["ls", "--embedding", "--json", "--detailed"]);
    } catch (error) {
      const code = objectValue(error)?.code;
      if (code === "ENOENT") {
        throw new ConfigurationError(
          "LM Studio CLI (lms) was not found. Install LM Studio or llmster, then run frag add again.",
          {},
          { cause: error },
        );
      }
      throw new ConfigurationError("Could not run LM Studio CLI", {}, { cause: error });
    }
    if (result.exitCode !== 0) throw commandFailure("lms ls", result);
    return parseLMStudioModelList(result.stdout);
  }

  async ensureReady(modelKey: string): Promise<LMStudioReadyModel> {
    const discovered = await this.discoverEmbeddingModels();
    const selected = discovered.find((model) => model.key === modelKey);
    if (selected === undefined) {
      throw new ConfigurationError(`Downloaded LM Studio embedding model not found: ${modelKey}`);
    }
    let startedServer = false;
    let loadedByFrag = false;
    const identifier = stableIdentifier(modelKey);
    let port = this.#port;
    try {
      const status = await this.#runner.run(this.#executable, ["server", "status", "--json", "--quiet"]);
      if (status.exitCode === 0) {
        const raw = objectValue(parseJson(status.stdout, "lms server status"));
        if (raw?.running === true) port = optionalPositiveNumber(raw.port) ?? port;
        else startedServer = await this.#startServer();
      } else {
        startedServer = await this.#startServer();
      }

      const apiBase = `http://${this.#host}:${port}`;
      let apiModels = await this.#fetchApiModels(apiBase);
      const selectedApi = apiModels.find((model) => model.type === "embedding" && model.key === modelKey);
      const loadedIdentifier = selectedApi?.loadedInstanceIds[0];
      const effectiveIdentifier = loadedIdentifier ?? identifier;
      if (loadedIdentifier === undefined) {
        const load = await this.#runner.run(this.#executable, [
          "load", modelKey, "--identifier", identifier,
        ]);
        if (load.exitCode !== 0) throw commandFailure("lms load", load);
        loadedByFrag = true;
        apiModels = await this.#fetchApiModels(apiBase);
      }
      const apiModel = apiModels.find((model) => model.type === "embedding" && model.key === modelKey);
      const maxTokens = apiModel?.maxContextLength ?? 8192;
      const limitsInferred = apiModel?.maxContextLength === undefined;
      const dimension = await this.#probeEmbedding(apiBase, effectiveIdentifier);
      const baseUrl = `${apiBase}/v1`;
      return {
        model: selected,
        identifier: effectiveIdentifier,
        baseUrl,
        dimension,
        maxTokens,
        limitsInferred,
        startedServer,
        loadedByFrag,
        registration: {
          id: `lmstudio:${modelKey}`,
          providerKind: "lmstudio",
          apiStyle: "openai",
          baseUrl,
          model: modelKey,
          requestModel: effectiveIdentifier,
          revision: "1",
          dim: dimension,
          maxTokens,
          recommendedChunkSize: Math.min(500, maxTokens),
          tokenCounter: "estimate",
          tokenSafetyMargin: 0.8,
          apiKeyEnv: null,
          managed: true,
          limitsInferred,
          lastHealthCheck: new Date().toISOString(),
        },
      };
    } catch (error) {
      const cleanupFailures = await this.#cleanup(identifier, loadedByFrag, startedServer);
      if (cleanupFailures.length > 0) {
        throw new ConfigurationError(
          `LM Studio setup failed and cleanup was incomplete for ${cleanupFailures.join(", ")}`,
          { cleanupFailures },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async release(ready: LMStudioReadyModel): Promise<void> {
    const failures = await this.#cleanup(ready.identifier, ready.loadedByFrag, ready.startedServer);
    if (failures.length > 0) {
      throw new ConfigurationError(`Could not clean up LM Studio resources: ${failures.join(", ")}`, {
        failures,
      });
    }
  }

  async #startServer(): Promise<boolean> {
    const start = await this.#runner.run(this.#executable, [
      "server", "start", "--bind", this.#host, "--port", String(this.#port),
    ]);
    if (start.exitCode !== 0) throw commandFailure("lms server start", start);
    return true;
  }

  async #fetchApiModels(apiBase: string): Promise<ApiModel[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await this.#fetch(`${apiBase}/api/v1/models`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseApiModels(await response.json());
      } catch (error) {
        lastError = error;
        if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new ConfigurationError("LM Studio server did not become ready", {}, { cause: lastError });
  }

  async #probeEmbedding(apiBase: string, identifier: string): Promise<number> {
    const response = await this.#fetch(`${apiBase}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: identifier, input: ["Frag embedding readiness probe"] }),
    });
    const value = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new ConfigurationError(`LM Studio embedding probe failed with HTTP ${response.status}`);
    const root = objectValue(value);
    const data = root !== null && Array.isArray(root.data) ? root.data : [];
    const first = objectValue(data[0]);
    const embedding = first?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some((component) => typeof component !== "number" || !Number.isFinite(component))
    ) {
      throw new ConfigurationError("LM Studio embedding probe returned an invalid vector");
    }
    return embedding.length;
  }

  async #cleanup(identifier: string, loadedByFrag: boolean, startedServer: boolean): Promise<string[]> {
    const failures: string[] = [];
    const attempt = async (resource: string, arguments_: readonly string[]): Promise<void> => {
      try {
        const result = await this.#runner.run(this.#executable, arguments_);
        if (result.exitCode !== 0) failures.push(resource);
      } catch {
        failures.push(resource);
      }
    };
    if (loadedByFrag) {
      await attempt(`model ${identifier}`, ["unload", identifier]);
    }
    if (startedServer) {
      await attempt("LM Studio server", ["server", "stop"]);
    }
    return failures;
  }
}
