export interface OutputContext {
  readonly json: boolean;
  readonly plain: boolean;
  readonly isTTY: boolean;
}

export type HumanRenderer<T> = (value: T) => string;

export function usesHumanOutput(context: OutputContext): boolean {
  if (context.json) return false;
  return context.plain || context.isTTY;
}

export function renderOutput<T>(
  value: T,
  context: OutputContext,
  humanRenderer?: HumanRenderer<T>,
): string {
  if (humanRenderer !== undefined && usesHumanOutput(context)) {
    const rendered = humanRenderer(value);
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }
  return `${JSON.stringify(value, jsonReplacer, 2)}\n`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function indentContent(content: string): string {
  return content.split("\n").map((line) => `    ${line}`).join("\n");
}

export function renderSystemList(systems: readonly SystemRecord[], defaultSystem: string | null): string {
  if (systems.length === 0) return "No systems configured. Run frag add to create one.";
  return [
    `Systems (${systems.length})`,
    "",
    ...systems.flatMap((system) => {
      const defaultLabel = system.name === defaultSystem ? "  default" : "";
      return [
        `${system.name}${defaultLabel}`,
        `  ${system.description}`,
        `  Embedder: ${system.embedderId}`,
        `  Database: ${system.databaseId}`,
        ...(system.mirrors.length === 0 ? [] : [`  Mirrors → ${system.mirrors.join(", ")}`]),
        "",
      ];
    }),
  ].join("\n").trimEnd();
}

export function renderSearchResults(response: SearchResponse, collection: string): string {
  if (response.results.length === 0) return `No results in ${collection}.`;
  const heading = `${response.results.length} result${response.results.length === 1 ? "" : "s"} from ${collection}`;
  const sections = response.results.map((result, index) => {
    const metadata = Object.keys(result.metadata).length === 0
      ? []
      : [`    Metadata: ${JSON.stringify(result.metadata)}`];
    return [
      `[${index + 1}] Score ${result.score.toFixed(6)} · source: ${result.sourceKey} · chunk ${result.chunkIndex + 1}/${result.chunkCount}`,
      "",
      indentContent(result.content),
      ...metadata,
    ].join("\n");
  });
  return [
    heading,
    ...(response.stale_embeddings === true
      ? [`WARNING: ${collection} has stale embeddings; run frag reindex ${collection}.`]
      : []),
    "",
    sections.join("\n\n"),
  ].join("\n");
}
import type { SearchResponse, SystemRecord } from "../core/index.js";
