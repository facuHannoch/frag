import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function defaultStatePath(): string {
  return join(homedir(), ".config", "frag", "local.json");
}

export async function readDefaultCollection(path = defaultStatePath()): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { defaultCollection?: unknown };
    return typeof value.defaultCollection === "string" ? value.defaultCollection : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDefaultCollection(
  collection: string,
  path = defaultStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ defaultCollection: collection }, null, 2)}\n`, "utf8");
}
