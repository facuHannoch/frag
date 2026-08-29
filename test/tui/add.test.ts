import assert from "node:assert/strict";
import test from "node:test";

import {
  runAddWizard,
  type SelectChoice,
  type WizardPrompter,
} from "../../src/tui/index.js";
import type {
  ProvisionSystemInput,
  ProvisioningStep,
  SystemRecord,
} from "../../src/core/index.js";

class ScriptedPrompter implements WizardPrompter {
  readonly notes: string[] = [];
  readonly activities: string[] = [];
  readonly selections: unknown[];
  readonly inputs: string[];

  constructor(selections: unknown[], inputs: string[]) {
    this.selections = [...selections];
    this.inputs = [...inputs];
  }

  async select<T>(_message: string, choices: readonly SelectChoice<T>[]): Promise<T> {
    const value = this.selections.shift() as T;
    assert.ok(choices.some((choice) => Object.is(choice.value, value) && choice.disabled !== true));
    return value;
  }

  async input(): Promise<string> {
    return this.inputs.shift() ?? "";
  }

  async confirm(): Promise<boolean> {
    return true;
  }

  async activity<T>(message: string, operation: () => Promise<T>): Promise<T> {
    this.activities.push(message);
    return operation();
  }

  progress(_step: ProvisioningStep, message: string): void {
    this.notes.push(message);
  }

  note(message: string): void {
    this.notes.push(message);
  }
}

test("runs the requested three-step discovery-driven add flow", async () => {
  const prompter = new ScriptedPrompter(["nomic", "managed-postgres", null], ["notes", "Working notes"]);
  let received: ProvisionSystemInput | undefined;
  const system: SystemRecord = {
    name: "notes",
    description: "Working notes",
    embedderId: "lmstudio:nomic",
    databaseId: "managed:local",
    mirrors: [],
    status: "ready",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
  const provisioner = {
    async discoverEmbeddingModels() {
      return [{ key: "nomic", displayName: "Nomic Embed" }];
    },
    async availableDatabaseRuntimes() {
      return ["podman" as const];
    },
    async create(input: ProvisionSystemInput) {
      received = input;
      return system;
    },
  };
  const controlPlane = {
    systems: { list: () => [] },
  } as never;
  assert.equal(await runAddWizard(controlPlane, { prompter, provisioner }), system);
  assert.deepEqual(received, {
    name: "notes",
    description: "Working notes",
    lmStudioModelKey: "nomic",
    database: { kind: "managed-postgres" },
    mirrors: [],
  });
  assert.ok(prompter.notes.some((note) => note.includes("Step 1 of 3 — Embedding model")));
  assert.deepEqual(prompter.activities, [
    "Asking LM Studio for downloaded embedding models…",
    "Checking whether Docker or Podman is available…",
  ]);
  assert.ok(prompter.notes.some((note) => note.includes("Found 1 downloaded embedding model")));
  assert.ok(prompter.notes.some((note) => note.includes("Step 2 of 3 — Vector database")));
  assert.ok(prompter.notes.some((note) => note.includes("Step 3 of 3 — System configuration")));
  assert.ok(prompter.notes.some((note) => note.includes("frag put")));
});
