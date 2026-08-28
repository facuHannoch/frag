import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  LMStudioService,
  parseLMStudioModelList,
  type CommandResult,
  type CommandRunner,
} from "../../src/core/index.js";

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];
  readonly #respond: (arguments_: readonly string[]) => CommandResult | Promise<CommandResult>;

  constructor(respond: (arguments_: readonly string[]) => CommandResult | Promise<CommandResult>) {
    this.#respond = respond;
  }

  async run(_executable: string, arguments_: readonly string[]): Promise<CommandResult> {
    this.calls.push([...arguments_]);
    return this.#respond(arguments_);
  }
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const modelList = JSON.stringify({
  models: [
    {
      type: "embedding",
      key: "nomic@q4",
      display_name: "Nomic Embed",
      size_bytes: 84_000_000,
    },
  ],
});

function apiModels(loadedIds: readonly string[], maxContextLength: number | null = 2048): Response {
  return Response.json({
    models: [{
      type: "embedding",
      key: "nomic@q4",
      display_name: "Nomic Embed",
      size_bytes: 84_000_000,
      loaded_instances: loadedIds.map((id) => ({ id })),
      ...(maxContextLength === null ? {} : { max_context_length: maxContextLength }),
    }],
  });
}

test("parses known lms JSON shapes, filters LLMs, and sorts display names", () => {
  assert.deepEqual(parseLMStudioModelList(JSON.stringify({ entries: [
    { type: "embedding", modelKey: "z", displayName: "Zulu", size: 3 },
    { type: "llm", modelKey: "chat", displayName: "Chat" },
    { model_key: "a", name: "Alpha", size_bytes: 2 },
  ] })), [
    { key: "a", displayName: "Alpha", sizeBytes: 2 },
    { key: "z", displayName: "Zulu", sizeBytes: 3 },
  ]);
  assert.deepEqual(parseLMStudioModelList(JSON.stringify(["one", "two"])), [
    { key: "one", displayName: "one" },
    { key: "two", displayName: "two" },
  ]);
});

test("reports a missing LM Studio CLI with install guidance", async () => {
  const runner: CommandRunner = {
    run: async () => {
      throw Object.assign(new Error("spawn lms ENOENT"), { code: "ENOENT" });
    },
  };
  await assert.rejects(
    () => new LMStudioService({ runner }).discoverEmbeddingModels(),
    (error: unknown) => error instanceof ConfigurationError && /Install LM Studio or llmster/u.test(error.message),
  );
});

test("reuses a running server and loaded embedding model then probes its real dimension", async () => {
  const runner = new FakeRunner((arguments_) => {
    if (arguments_[0] === "ls") return ok(modelList);
    if (arguments_[1] === "status") return ok(JSON.stringify({ running: true, port: 4321 }));
    throw new Error(`Unexpected command: ${arguments_.join(" ")}`);
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const service = new LMStudioService({
    runner,
    fetch: async (url, init) => {
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/api/v1/models")) return apiModels(["already-loaded"]);
      return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
    },
  });
  const ready = await service.ensureReady("nomic@q4");
  assert.equal(ready.identifier, "already-loaded");
  assert.equal(ready.baseUrl, "http://127.0.0.1:4321/v1");
  assert.equal(ready.dimension, 3);
  assert.equal(ready.maxTokens, 2048);
  assert.equal(ready.registration.dim, 3);
  assert.equal(ready.registration.model, "nomic@q4");
  assert.equal(ready.registration.requestModel, "already-loaded");
  assert.equal(ready.startedServer, false);
  assert.equal(ready.loadedByFrag, false);
  assert.equal(runner.calls.some((call) => call[0] === "load"), false);
  assert.equal(requests.at(-1)?.url, "http://127.0.0.1:4321/v1/embeddings");
});

test("starts the server, loads the model, and releases only resources Frag created", async () => {
  const runner = new FakeRunner((arguments_) => {
    if (arguments_[0] === "ls") return ok(modelList);
    if (arguments_[1] === "status") return ok(JSON.stringify({ running: false }));
    return ok();
  });
  let modelRequests = 0;
  const service = new LMStudioService({
    runner,
    fetch: async (url) => {
      if (url.endsWith("/api/v1/models")) {
        modelRequests += 1;
        return apiModels(modelRequests === 1 ? [] : ["frag-loaded"], null);
      }
      return Response.json({ data: [{ embedding: [1, 2, 3, 4] }] });
    },
  });
  const ready = await service.ensureReady("nomic@q4");
  assert.equal(ready.startedServer, true);
  assert.equal(ready.loadedByFrag, true);
  assert.equal(ready.dimension, 4);
  assert.equal(ready.maxTokens, 8192);
  assert.equal(ready.limitsInferred, true);
  assert.deepEqual(runner.calls[2], ["server", "start", "--bind", "127.0.0.1", "--port", "1234"]);
  assert.equal(runner.calls[3]?.[0], "load");
  await service.release(ready);
  assert.deepEqual(runner.calls.at(-2)?.slice(0, 2), ["unload", ready.identifier]);
  assert.deepEqual(runner.calls.at(-1), ["server", "stop"]);
});

test("cleans up a model and server when the embedding probe is invalid", async () => {
  const runner = new FakeRunner((arguments_) => {
    if (arguments_[0] === "ls") return ok(modelList);
    if (arguments_[1] === "status") return ok(JSON.stringify({ running: false }));
    return ok();
  });
  let modelRequests = 0;
  const service = new LMStudioService({
    runner,
    fetch: async (url) => {
      if (url.endsWith("/api/v1/models")) {
        modelRequests += 1;
        return apiModels(modelRequests === 1 ? [] : ["loaded"]);
      }
      return Response.json({ data: [{ embedding: [1, Number.NaN] }] });
    },
  });
  await assert.rejects(() => service.ensureReady("nomic@q4"), /invalid vector/u);
  assert.equal(runner.calls.at(-2)?.[0], "unload");
  assert.deepEqual(runner.calls.at(-1), ["server", "stop"]);
});
