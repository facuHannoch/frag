import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parse, stringify } from "yaml";

interface AddAnswers {
  readonly name: string;
  readonly description: string;
  readonly embedder: string;
  readonly db: string;
}

async function addCollection(configPath: string, answers: AddAnswers): Promise<void> {
  const document = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const collections = Array.isArray(document.collections) ? document.collections : [];
  if (collections.some((value) => (value as { name?: unknown }).name === answers.name)) {
    throw new Error(`Collection ${answers.name} already exists`);
  }
  collections.push({
    name: answers.name,
    description: answers.description,
    embedder: answers.embedder,
    db: answers.db,
    state_backend: "same-as-db",
  });
  document.collections = collections;
  await writeFile(configPath, stringify(document), "utf8");
}

export async function runAddWizard(configPath: string): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = (await terminal.question("Collection name: ")).trim();
    const description = (await terminal.question("Description for agents: ")).trim();
    const embedder = (await terminal.question("Existing embedder name: ")).trim();
    const db = (await terminal.question("Existing database name: ")).trim();
    if ([name, description, embedder, db].some((value) => value.length === 0)) {
      throw new Error("All fields are required");
    }
    await addCollection(configPath, { name, description, embedder, db });
  } finally {
    terminal.close();
  }
}

export async function addCollectionFromFlags(configPath: string, answers: AddAnswers): Promise<void> {
  await addCollection(configPath, answers);
}
