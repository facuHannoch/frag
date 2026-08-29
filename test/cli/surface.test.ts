import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createCli, isMainModule } from "../../src/cli/main.js";
import {
  renderOutput,
  renderSearchResults,
  renderSystemList,
  usesHumanOutput,
} from "../../src/cli/output.js";
import type { SystemRecord } from "../../src/core/index.js";

test("normal CLI has no config path and add exposes semantic provisioning flags", () => {
  const cli = createCli();
  assert.equal(cli.options.some((option) => option.long === "--config"), false);
  const add = cli.commands.find((command) => command.name() === "add");
  assert.ok(add !== undefined);
  const flags = add.options.map((option) => option.long);
  assert.ok(flags.includes("--lmstudio-model"));
  assert.ok(flags.includes("--database"));
  assert.ok(flags.includes("--database-url-env"));
  assert.ok(flags.includes("--mirror"));
  assert.equal(flags.includes("--embedder"), false);
  assert.equal(flags.includes("--db"), false);
  assert.ok(cli.options.some((option) => option.long === "--json"));
  assert.ok(cli.options.some((option) => option.long === "--plain"));
});

test("uses readable output only for terminals or an explicit plain request", () => {
  assert.equal(usesHumanOutput({ json: false, plain: false, isTTY: true }), true);
  assert.equal(usesHumanOutput({ json: false, plain: false, isTTY: false }), false);
  assert.equal(usesHumanOutput({ json: false, plain: true, isTTY: false }), true);
  assert.equal(usesHumanOutput({ json: true, plain: true, isTTY: true }), false);
  assert.equal(
    renderOutput({ value: 1 }, { json: false, plain: true, isTTY: false }, () => "Readable"),
    "Readable\n",
  );
  assert.equal(
    renderOutput({ value: 1 }, { json: true, plain: false, isTTY: true }, () => "Readable"),
    '{\n  "value": 1\n}\n',
  );
});

test("renders systems with default and mirror context", () => {
  const base = {
    embedderId: "lmstudio:nomic",
    databaseId: "managed:local",
    status: "ready" as const,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  const systems: SystemRecord[] = [
    { ...base, name: "notes", description: "Working notes", mirrors: ["public"] },
    { ...base, name: "public", description: "Curated content", mirrors: [] },
  ];
  const rendered = renderSystemList(systems, "public");
  assert.match(rendered, /public  default/u);
  assert.match(rendered, /notes/u);
  assert.match(rendered, /Mirrors → public/u);
});

test("renders ranked search chunks without changing their content", () => {
  const rendered = renderSearchResults({
    results: [{
      sourceKey: "cars.md",
      content: "first line\nsecond line",
      score: 0.4897123,
      chunkIndex: 1,
      chunkCount: 3,
      metadata: { topic: "cars" },
    }],
    stale_embeddings: true,
  }, "test1");
  assert.match(rendered, /1 result from test1/u);
  assert.match(rendered, /\[1\] Score 0\.489712 · source: cars\.md · chunk 2\/3/u);
  assert.match(rendered, /    first line\n    second line/u);
  assert.match(rendered, /Metadata: \{"topic":"cars"\}/u);
  assert.match(rendered, /stale embeddings/u);
});

test("recognizes an installed symlink as the CLI main module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frag-bin-test-"));
  try {
    const modulePath = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
    const link = join(directory, "frag");
    await symlink(modulePath, link);
    assert.equal(isMainModule(link, pathToFileURL(modulePath).href), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
