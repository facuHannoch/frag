import type { SearchResult } from "../core/index.js";
import { TerminalWizardPrompter, type SelectChoice } from "./add.js";

function preview(content: string): string {
  const singleLine = content.replace(/\s+/gu, " ").trim();
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 69)}…`;
}

export function searchResultChoices(results: readonly SearchResult[]): readonly SelectChoice<SearchResult>[] {
  return results.map((result, index) => ({
    label: `[${index + 1}] ${result.sourceKey}`,
    value: result,
    detail: `score ${result.score.toFixed(6)} · ${preview(result.content)}`,
  }));
}

export async function pickSearchResult(results: readonly SearchResult[]): Promise<SearchResult> {
  return new TerminalWizardPrompter().select("Select a result to copy:", searchResultChoices(results));
}
