import { getEncoding } from "js-tiktoken";

import type { Embedder, EmbedderConfig, TokenCounter } from "./types.js";

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

export class TiktokenCounter implements TokenCounter {
  readonly #encoding = getEncoding("cl100k_base");

  async count(text: string): Promise<number> {
    return this.#encoding.encode(text).length;
  }

  isExact(): boolean {
    return true;
  }
}

export class EndpointTokenCounter implements TokenCounter {
  readonly #url: string;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(baseUrl: string, apiKey: string | null) {
    this.#url = `${withoutTrailingSlash(baseUrl)}/tokenize`;
    this.#headers = apiKey === null ? {} : { authorization: `Bearer ${apiKey}` };
  }

  async count(text: string): Promise<number> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#headers },
      body: JSON.stringify({ content: text }),
    });
    const body = (await response.json()) as { count?: unknown; tokens?: unknown };
    if (!response.ok) throw new Error(`Tokenize endpoint returned ${response.status}`);
    if (Number.isSafeInteger(body.count) && (body.count as number) >= 0) return body.count as number;
    if (Array.isArray(body.tokens)) return body.tokens.length;
    throw new TypeError("Tokenize endpoint response contains neither count nor tokens");
  }

  isExact(): boolean {
    return true;
  }
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly config: EmbedderConfig;
  readonly #url: string;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(config: EmbedderConfig, baseUrl: string, apiKey: string | null) {
    this.config = config;
    const base = withoutTrailingSlash(baseUrl);
    if (config.apiStyle === "azure-openai") {
      this.#url = `${base}/openai/deployments/${encodeURIComponent(
        config.model,
      )}/embeddings?api-version=2024-02-01`;
      this.#headers = apiKey === null ? {} : { "api-key": apiKey };
    } else {
      this.#url = `${base}/embeddings`;
      this.#headers = apiKey === null ? {} : { authorization: `Bearer ${apiKey}` };
    }
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#headers },
      body: JSON.stringify({ input: texts, model: this.config.requestModel ?? this.config.model }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
      error?: { code?: string; message?: string; param?: string };
    };
    if (!response.ok) {
      const error = Object.assign(
        new Error(body.error?.message ?? `Embedding endpoint returned ${response.status}`),
        { status: response.status, code: body.error?.code },
      );
      const match = /input\[(\d+)\]/u.exec(body.error?.param ?? body.error?.message ?? "");
      if (match?.[1] !== undefined) Object.assign(error, { chunkIndex: Number(match[1]) });
      throw error;
    }
    if (!Array.isArray(body.data)) throw new TypeError("Embedding response has no data array");
    return [...body.data]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map(({ embedding }) => {
        if (!Array.isArray(embedding)) throw new TypeError("Embedding response item has no vector");
        return embedding;
      });
  }
}
