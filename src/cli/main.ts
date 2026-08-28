#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";

import { loadFragApplication, type FragApplication } from "../core/application.js";
import { parseFragConfig } from "../core/config.js";
import { addCollectionFromFlags, runAddWizard } from "../tui/add.js";
import { listenHttp } from "../server/http.js";
import { runMcpStdio } from "../server/mcp.js";
import { readDefaultCollection, writeDefaultCollection } from "./defaults.js";

interface GlobalOptions {
  config: string;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function collectionsOption(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function resolveCollection(value: string | undefined): Promise<string> {
  if (value !== undefined) return value;
  const fallback = await readDefaultCollection();
  if (fallback === null) throw new Error("Collection is required; pass one or configure a CLI default");
  return fallback;
}

async function withApplication<T>(
  command: Command,
  allowed: string[] | undefined,
  fn: (application: FragApplication) => Promise<T>,
): Promise<T> {
  const globals = command.optsWithGlobals<GlobalOptions>();
  const application = await loadFragApplication(globals.config, {
    ...(allowed === undefined ? {} : { allowedCollections: allowed }),
    logger: { warn: (message) => process.stderr.write(`WARNING: ${message}\n`) },
  });
  try {
    return await fn(application);
  } finally {
    await application.close();
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
    .version("0.1.0")
    .option("--config <path>", "registry configuration", process.env.FRAG_CONFIG ?? "frag.yaml");

  program
    .command("put")
    .argument("[collection]")
    .argument("[text]")
    .option("--file <path>")
    .option("--source-key <key>")
    .option("--metadata <json>")
    .option("--chunks <chunks...>")
    .addOption(new Option("--auto-chunk [size]").argParser((value) => Number(value)))
    .option("--yes")
    .action(async (first: string | undefined, second: string | undefined, options, command) => {
      const usingDefault = second === undefined && options.file === undefined;
      const collection = await resolveCollection(usingDefault ? undefined : first);
      const content = options.file === undefined ? (usingDefault ? first : second) : await readFile(options.file, "utf8");
      if (content === undefined) throw new Error("Text or --file is required");
      const autoChunk = options.autoChunk as boolean | number | undefined;
      if (autoChunk !== undefined && autoChunk !== false) {
        let size = typeof autoChunk === "number" ? autoChunk : 500;
        if (autoChunk === true) {
          const configPath = (command as Command).optsWithGlobals<GlobalOptions>().config;
          const config = parseFragConfig(await readFile(configPath, "utf8"));
          const collectionConfig = config.collections.get(collection);
          if (collectionConfig !== undefined) {
            size = config.embedders.get(collectionConfig.embedder)!.recommendedChunkSize;
          }
        }
        await confirmAutoChunk(content, size, options.yes === true);
      }
      await withApplication(command, undefined, async (application) => {
        output(
          await application.registry.ingest({
            collection,
            content,
            ...(options.sourceKey === undefined ? {} : { sourceKey: options.sourceKey as string }),
            ...(options.metadata === undefined ? {} : { metadata: JSON.parse(options.metadata as string) }),
            ...(options.chunks === undefined ? {} : { chunks: options.chunks as string[] }),
            ...(autoChunk === undefined ? {} : { autoChunk }),
          }),
        );
      });
    });

  program
    .command("search")
    .alias("get")
    .argument("[collection]")
    .argument("[query]")
    .option("--k <number>", "result count", (value) => Number(value), 5)
    .action(async (first: string | undefined, second: string | undefined, options, command) => {
      const collection = await resolveCollection(second === undefined ? undefined : first);
      const query = second ?? first;
      if (query === undefined) throw new Error("Query is required");
      await withApplication(command, undefined, async (application) => {
        output(await application.registry.search(collection, query, { limit: options.k as number }));
      });
    });

  program
    .command("sources")
    .argument("<collection>")
    .option("--source-key <key>")
    .action(async (collection: string, options, command) => {
      await withApplication(command, undefined, async (application) => {
        const sources = await application.listSources(collection);
        output(options.sourceKey === undefined ? sources : sources.filter(({ sourceKey }) => sourceKey === options.sourceKey));
      });
    });

  program
    .command("rm")
    .argument("<collection>")
    .requiredOption("--source-key <key>")
    .action(async (collection: string, options, command) => {
      await withApplication(command, undefined, async (application) => {
        await application.remove(collection, options.sourceKey as string);
        output({ removed: true });
      });
    });

  program
    .command("reindex")
    .argument("<collection>")
    .option("--dry-run")
    .action(async (collection: string, options, command) => {
      await withApplication(command, undefined, async (application) => {
        output(await application.reindex(collection, options.dryRun === true));
      });
    });

  program.command("list").action(async (_options, command) => {
    await withApplication(command, undefined, async (application) => output(application.registry.listCollections()));
  });

  program
    .command("promote")
    .requiredOption("--from <collection>")
    .requiredOption("--to <collection>")
    .requiredOption("--source <key>")
    .option("--target-source-key <key>")
    .action(async (options, command) => {
      await withApplication(command, undefined, async (application) => {
        output(
          await application.promote(
            options.from as string,
            options.to as string,
            options.source as string,
            options.targetSourceKey as string | undefined,
          ),
        );
      });
    });

  program
    .command("add")
    .option("--embedder <name>")
    .option("--db <name>")
    .option("--name <name>")
    .option("--description <text>")
    .action(async (options, command) => {
      const configPath = (command as Command).optsWithGlobals<GlobalOptions>().config;
      const values = [options.embedder, options.db, options.name, options.description];
      if (values.every((value) => value === undefined)) {
        await runAddWizard(configPath);
      } else {
        if (values.some((value) => typeof value !== "string" || value.length === 0)) {
          throw new Error("--embedder, --db, --name, and --description are all required with flags");
        }
        await addCollectionFromFlags(configPath, {
          embedder: options.embedder as string,
          db: options.db as string,
          name: options.name as string,
          description: options.description as string,
        });
      }
      output({ added: true });
    });

  const config = program.command("config");
  config
    .command("set-default")
    .argument("<collection>")
    .action(async (collection: string) => {
      await writeDefaultCollection(collection);
      output({ default: collection });
    });

  program
    .command("serve")
    .option("--collections <names>", "comma-separated allow-list", collectionsOption)
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("--port <port>", "listen port", (value) => Number(value), 34391)
    .action(async (options, command) => {
      const globals = (command as Command).optsWithGlobals<GlobalOptions>();
      const application = await loadFragApplication(globals.config, {
        ...(options.collections === undefined ? {} : { allowedCollections: options.collections as string[] }),
        logger: { warn: (message) => process.stderr.write(`WARNING: ${message}\n`) },
      });
      const server = await listenHttp(application.registry, { host: options.host as string, port: options.port as number });
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
    .action(async (options, command) => {
      const globals = (command as Command).optsWithGlobals<GlobalOptions>();
      const application = await loadFragApplication(globals.config, {
        ...(options.collections === undefined ? {} : { allowedCollections: options.collections as string[] }),
        logger: { warn: (message) => process.stderr.write(`WARNING: ${message}\n`) },
      });
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
