#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";

import {
  ConfigurationError,
  SystemProvisioner,
  createFragApplicationFromControlPlane,
  openFrag,
  type FragApplication,
  type FragControlPlane,
} from "../core/index.js";
import { listenHttp } from "../server/http.js";
import { runMcpStdio } from "../server/mcp.js";
import { runAddWizard } from "../tui/add.js";

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function collectionsOption(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function mirrorsOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resolveSystem(controlPlane: FragControlPlane, value: string | undefined): string {
  if (value !== undefined) return value;
  const fallback = controlPlane.settings.getDefaultSystem();
  if (fallback === null) throw new Error("System is required; pass one or run frag config set-default");
  return fallback;
}

async function openApplication(allowed?: readonly string[]): Promise<{
  readonly controlPlane: FragControlPlane;
  readonly application: FragApplication;
}> {
  const controlPlane = await openFrag();
  try {
    const application = await createFragApplicationFromControlPlane(controlPlane, {
      ...(allowed === undefined ? {} : { allowedCollections: allowed }),
      logger: { warn: (message) => process.stderr.write(`WARNING: ${message}\n`) },
    });
    return { controlPlane, application };
  } catch (error) {
    controlPlane.close();
    throw error;
  }
}

async function withApplication<T>(
  allowed: readonly string[] | undefined,
  fn: (application: FragApplication, controlPlane: FragControlPlane) => Promise<T>,
): Promise<T> {
  const { application, controlPlane } = await openApplication(allowed);
  try {
    return await fn(application, controlPlane);
  } finally {
    await application.close();
    controlPlane.close();
  }
}

async function confirmAutoChunk(content: string, size: number, yes: boolean): Promise<void> {
  if (yes) return;
  const approximateTokens = Math.ceil(content.length / 4);
  const chunks = Math.max(1, Math.ceil(approximateTokens / Math.max(1, size - 50)));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      `This will split into ~${chunks} chunks of ~${size} tokens each. Continue? [y/N] `,
    );
    if (!/^y(es)?$/iu.test(answer.trim())) throw new Error("Cancelled");
  } finally {
    terminal.close();
  }
}

export function createCli(): Command {
  const program = new Command();
  program
    .name("frag")
    .description("Retrieval-augmented storage and search")
    .version("0.1.0");

  program
    .command("put")
    .argument("[system]")
    .argument("[text]")
    .option("--file <path>")
    .option("--source-key <key>")
    .option("--metadata <json>")
    .option("--chunks <chunks...>")
    .addOption(new Option("--auto-chunk [size]").argParser((value) => Number(value)))
    .option("--yes")
    .action(async (first: string | undefined, second: string | undefined, options) => {
      await withApplication(undefined, async (application, controlPlane) => {
        const usingDefault = second === undefined && options.file === undefined;
        const collection = resolveSystem(controlPlane, usingDefault ? undefined : first);
        const content = options.file === undefined
          ? (usingDefault ? first : second)
          : await readFile(options.file as string, "utf8");
        if (content === undefined) throw new Error("Text or --file is required");
        const autoChunk = options.autoChunk as boolean | number | undefined;
        if (autoChunk !== undefined && autoChunk !== false) {
          const system = controlPlane.systems.get(collection);
          const embedder = system === null ? null : controlPlane.embedders.get(system.embedderId);
          const size = typeof autoChunk === "number"
            ? autoChunk
            : embedder?.recommendedChunkSize ?? 500;
          await confirmAutoChunk(content, size, options.yes === true);
        }
        output(await application.registry.ingest({
          collection,
          content,
          ...(options.sourceKey === undefined ? {} : { sourceKey: options.sourceKey as string }),
          ...(options.metadata === undefined ? {} : { metadata: JSON.parse(options.metadata as string) }),
          ...(options.chunks === undefined ? {} : { chunks: options.chunks as string[] }),
          ...(autoChunk === undefined ? {} : { autoChunk }),
        }));
      });
    });

  program
    .command("search")
    .alias("get")
    .argument("[system]")
    .argument("[query]")
    .option("--k <number>", "result count", (value) => Number(value), 5)
    .action(async (first: string | undefined, second: string | undefined, options) => {
      await withApplication(undefined, async (application, controlPlane) => {
        const collection = resolveSystem(controlPlane, second === undefined ? undefined : first);
        const query = second ?? first;
        if (query === undefined) throw new Error("Query is required");
        output(await application.registry.search(collection, query, { limit: options.k as number }));
      });
    });

  program
    .command("sources")
    .argument("<system>")
    .option("--source-key <key>")
    .action(async (collection: string, options) => {
      await withApplication(undefined, async (application) => {
        const sources = await application.listSources(collection);
        output(options.sourceKey === undefined
          ? sources
          : sources.filter(({ sourceKey }) => sourceKey === options.sourceKey));
      });
    });

  program
    .command("rm")
    .argument("<system>")
    .requiredOption("--source-key <key>")
    .action(async (collection: string, options) => {
      await withApplication(undefined, async (application) => {
        await application.remove(collection, options.sourceKey as string);
        output({ removed: true });
      });
    });

  program
    .command("reindex")
    .argument("<system>")
    .option("--dry-run")
    .action(async (collection: string, options) => {
      await withApplication(undefined, async (application) => {
        output(await application.reindex(collection, options.dryRun === true));
      });
    });

  program.command("list").action(async () => {
    const controlPlane = await openFrag();
    try {
      output(controlPlane.systems.list());
    } finally {
      controlPlane.close();
    }
  });

  program
    .command("promote")
    .requiredOption("--from <system>")
    .requiredOption("--to <system>")
    .requiredOption("--source <key>")
    .option("--target-source-key <key>")
    .action(async (options) => {
      await withApplication(undefined, async (application) => {
        output(await application.promote(
          options.from as string,
          options.to as string,
          options.source as string,
          options.targetSourceKey as string | undefined,
        ));
      });
    });

  program
    .command("add")
    .option("--name <name>")
    .option("--description <text>")
    .option("--lmstudio-model <model-key>")
    .option("--database <kind>", "managed-postgres or existing-postgres")
    .option("--database-url-env <env>")
    .option("--mirror <system>", "mirror target (repeatable)", mirrorsOption, [])
    .option("--yes")
    .action(async (options) => {
      const controlPlane = await openFrag();
      try {
        const provided = [options.name, options.description, options.lmstudioModel, options.database,
          options.databaseUrlEnv, ...(options.mirror as string[])];
        if (provided.every((value) => value === undefined || (Array.isArray(value) && value.length === 0))) {
          output(await runAddWizard(controlPlane));
          return;
        }
        if (
          typeof options.name !== "string" ||
          typeof options.description !== "string" ||
          typeof options.lmstudioModel !== "string" ||
          (options.database !== "managed-postgres" && options.database !== "existing-postgres")
        ) {
          throw new ConfigurationError(
            "Flag mode requires --name, --description, --lmstudio-model, and --database",
          );
        }
        if (options.yes !== true) throw new ConfigurationError("Flag mode requires --yes and never prompts");
        if (options.database === "existing-postgres" && typeof options.databaseUrlEnv !== "string") {
          throw new ConfigurationError("--database-url-env is required with existing-postgres");
        }
        if (options.database === "managed-postgres" && options.databaseUrlEnv !== undefined) {
          throw new ConfigurationError("--database-url-env is valid only with existing-postgres");
        }
        const provisioner = new SystemProvisioner(controlPlane, {
          onProgress: (_step, message) => process.stderr.write(`${message}\n`),
        });
        output(await provisioner.create({
          name: options.name,
          description: options.description,
          lmStudioModelKey: options.lmstudioModel,
          database: options.database === "managed-postgres"
            ? { kind: "managed-postgres" }
            : {
                kind: "existing-postgres",
                id: `existing:${(options.databaseUrlEnv as string).toLocaleLowerCase()}`,
                urlEnv: options.databaseUrlEnv as string,
              },
          mirrors: options.mirror as string[],
        }));
      } finally {
        controlPlane.close();
      }
    });

  const config = program.command("config");
  config
    .command("set-default")
    .argument("<system>")
    .action(async (system: string) => {
      const controlPlane = await openFrag();
      try {
        controlPlane.settings.setDefaultSystem(system);
        output({ default: system });
      } finally {
        controlPlane.close();
      }
    });

  program
    .command("serve")
    .option("--collections <names>", "comma-separated allow-list", collectionsOption)
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("--port <port>", "listen port", (value) => Number(value), 34391)
    .action(async (options) => {
      const { application, controlPlane } = await openApplication(options.collections as string[] | undefined);
      controlPlane.close();
      const server = await listenHttp(application.registry, {
        host: options.host as string,
        port: options.port as number,
      });
      process.stderr.write(`Frag HTTP listening on ${(server.address() as { port: number }).port}\n`);
      const close = async () => {
        server.close();
        await application.close();
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });

  program
    .command("mcp")
    .option("--collections <names>", "comma-separated allow-list", collectionsOption)
    .action(async (options) => {
      const { application, controlPlane } = await openApplication(options.collections as string[] | undefined);
      controlPlane.close();
      process.once("exit", () => void application.close());
      await runMcpStdio(application.registry);
    });
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
