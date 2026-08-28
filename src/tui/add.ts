import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

import {
  ConfigurationError,
  SystemProvisioner,
  type FragControlPlane,
  type ProvisionSystemInput,
  type ProvisioningStep,
  type SystemRecord,
} from "../core/index.js";

export interface SelectChoice<T> {
  readonly label: string;
  readonly value: T;
  readonly detail?: string;
  readonly disabled?: boolean;
}

export interface WizardPrompter {
  select<T>(message: string, choices: readonly SelectChoice<T>[]): Promise<T>;
  input(message: string, options?: { readonly defaultValue?: string }): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  progress(step: ProvisioningStep, message: string): void;
  note(message: string): void;
}

interface Keypress {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly sequence?: string;
}

export class TerminalWizardPrompter implements WizardPrompter {
  async select<T>(message: string, choices: readonly SelectChoice<T>[]): Promise<T> {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
      throw new ConfigurationError("frag add needs an interactive terminal; use provisioning flags in scripts");
    }
    if (choices.length === 0) throw new ConfigurationError(`${message} has no available choices`);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write("\x1b[?25l");
    let query = "";
    let selected = 0;
    let renderedLines = 0;

    const filtered = (): readonly SelectChoice<T>[] => {
      const normalized = query.toLocaleLowerCase();
      return choices.filter((choice) =>
        normalized.length === 0 || `${choice.label} ${choice.detail ?? ""}`.toLocaleLowerCase().includes(normalized)
      );
    };
    const render = (): void => {
      const visible = filtered();
      selected = Math.min(selected, Math.max(0, visible.length - 1));
      if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}F`);
      const lines = [
        `\x1b[2K${message}`,
        `\x1b[2KSearch: ${query}`,
        ...(visible.length === 0
          ? ["\x1b[2K  No matches"]
          : visible.slice(0, 10).map((choice, index) => {
              const marker = index === selected ? ">" : " ";
              const disabled = choice.disabled === true ? " (unavailable)" : "";
              return `\x1b[2K  ${marker} ${choice.label}${disabled}${choice.detail === undefined ? "" : ` — ${choice.detail}`}`;
            })),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };

    return new Promise<T>((resolve, reject) => {
      const finish = (error: Error | null, value?: T): void => {
        process.stdin.off("keypress", onKeypress);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\x1b[?25h");
        if (error !== null) reject(error);
        else resolve(value!);
      };
      const onKeypress = (character: string, key: Keypress): void => {
        const visible = filtered();
        if (key.ctrl === true && key.name === "c") return finish(new Error("Cancelled"));
        if (key.name === "up") selected = Math.max(0, selected - 1);
        else if (key.name === "down") selected = Math.min(Math.max(0, visible.length - 1), selected + 1);
        else if (key.name === "backspace") {
          query = [...query].slice(0, -1).join("");
          selected = 0;
        } else if (key.name === "escape") {
          query = "";
          selected = 0;
        } else if (key.name === "return") {
          const choice = visible[selected];
          if (choice !== undefined && choice.disabled !== true) return finish(null, choice.value);
        } else if (character.length > 0 && key.ctrl !== true && key.sequence === character && !/[\x00-\x1f\x7f]/u.test(character)) {
          query += character;
          selected = 0;
        }
        render();
      };
      process.stdin.on("keypress", onKeypress);
      render();
    });
  }

  async input(message: string, options: { readonly defaultValue?: string } = {}): Promise<string> {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const suffix = options.defaultValue === undefined ? "" : ` (${options.defaultValue})`;
      const answer = (await terminal.question(`${message}${suffix}: `)).trim();
      return answer.length === 0 ? options.defaultValue ?? "" : answer;
    } finally {
      terminal.close();
    }
  }

  async confirm(message: string, defaultValue = true): Promise<boolean> {
    const answer = (await this.input(`${message} ${defaultValue ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
    if (answer.length === 0) return defaultValue;
    return answer === "y" || answer === "yes";
  }

  progress(_step: ProvisioningStep, message: string): void {
    process.stdout.write(`  • ${message}\n`);
  }

  note(message: string): void {
    process.stdout.write(`${message}\n`);
  }
}

export interface AddWizardOptions {
  readonly prompter?: WizardPrompter;
  readonly provisioner?: Pick<SystemProvisioner, "discoverEmbeddingModels" | "availableDatabaseRuntimes" | "create">;
}

export async function runAddWizard(
  controlPlane: FragControlPlane,
  options: AddWizardOptions = {},
): Promise<SystemRecord> {
  const prompter = options.prompter ?? new TerminalWizardPrompter();
  let progressTarget = prompter;
  const provisioner = options.provisioner ?? new SystemProvisioner(controlPlane, {
    onProgress: (step, message) => progressTarget.progress(step, message),
  });

  prompter.note("Step 1 of 3 — Embedding model");
  const models = await provisioner.discoverEmbeddingModels();
  if (models.length === 0) {
    throw new ConfigurationError(
      "No downloaded LM Studio embedding models were found. Download one in LM Studio (or with lms get), then retry.",
    );
  }
  const modelKey = await prompter.select(
    "Select embedding model:",
    models.map((model) => ({
      label: model.displayName,
      value: model.key,
      detail: model.key,
    })),
  );

  prompter.note("\nStep 2 of 3 — Vector database");
  const runtimes = await provisioner.availableDatabaseRuntimes();
  const databaseKind = await prompter.select<"managed-postgres" | "existing-postgres">("Database:", [
    {
      label: "Managed local PostgreSQL",
      value: "managed-postgres",
      detail: runtimes.length === 0 ? "Docker or Podman is not running" : `uses ${runtimes[0]}`,
      disabled: runtimes.length === 0,
    },
    {
      label: "Existing PostgreSQL…",
      value: "existing-postgres",
      detail: "advanced",
    },
  ]);
  let database: ProvisionSystemInput["database"] = { kind: "managed-postgres" };
  if (databaseKind === "existing-postgres") {
    const urlEnv = await prompter.input("Connection URL environment variable", {
      defaultValue: "DATABASE_URL",
    });
    database = {
      kind: "existing-postgres",
      id: `existing:${urlEnv.toLocaleLowerCase()}`,
      urlEnv,
    };
  }

  prompter.note("\nStep 3 of 3 — System configuration");
  const name = await prompter.input("Name");
  const description = await prompter.input("Description");
  const mirror = await prompter.select<string | null>("Mirroring:", [
    { label: "No mirroring", value: null },
    ...controlPlane.systems.list().map((system) => ({
      label: system.name,
      value: system.name,
      detail: system.description,
    })),
  ]);
  prompter.note(
    `\nCreate ${name} with ${models.find((model) => model.key === modelKey)?.displayName ?? modelKey}, ` +
    `${databaseKind === "managed-postgres" ? "managed local PostgreSQL" : "existing PostgreSQL"}, ` +
    `${mirror === null ? "and no mirroring" : `mirroring to ${mirror}`}?`,
  );
  if (!await prompter.confirm("Create system?", true)) throw new Error("Cancelled");
  progressTarget = prompter;
  const system = await provisioner.create({
    name,
    description,
    lmStudioModelKey: modelKey,
    database,
    mirrors: mirror === null ? [] : [mirror],
  });
  prompter.note(`\nReady. Try: frag put ${JSON.stringify(system.name)} ${JSON.stringify("a short note")}`);
  return system;
}
