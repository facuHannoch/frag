import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createCli, isMainModule } from "../../src/cli/main.js";

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
