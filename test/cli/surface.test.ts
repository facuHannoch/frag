import assert from "node:assert/strict";
import test from "node:test";

import { createCli } from "../../src/cli/main.js";

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
