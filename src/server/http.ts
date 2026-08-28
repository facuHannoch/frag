import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { FragError } from "../core/errors.js";
import type { FragRegistry } from "../core/registry.js";

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 25 * 1024 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof FragError) {
    return { status: 400, body: { error: error.code, message: error.message, details: error.details } };
  }
  if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
    return { status: 400, body: { error: "BAD_REQUEST", message: error.message } };
  }
  const candidate = error as { status?: unknown; message?: unknown };
  if (candidate?.status === 413) return { status: 413, body: { error: "BODY_TOO_LARGE" } };
  return { status: 500, body: { error: "INTERNAL_ERROR" } };
}

export async function dispatchHttp(
  registry: FragRegistry,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    if (method === "GET" && (pathname === "/collections" || pathname === "/list_collections")) {
      return { status: 200, body: registry.listCollections() };
    }
    if (method === "POST" && pathname === "/ingest") {
      const input = body as Record<string, unknown>;
      const collection = input?.collection;
      const content = input?.content;
      if (typeof collection !== "string" || typeof content !== "string") {
        throw new TypeError("ingest requires string collection and content");
      }
      if (
        input.chunks !== undefined &&
        (!Array.isArray(input.chunks) || !input.chunks.every((item) => typeof item === "string"))
      ) {
        throw new TypeError("chunks must be an array of strings");
      }
      if (
        input.autoChunk !== undefined &&
        typeof input.autoChunk !== "boolean" &&
        typeof input.autoChunk !== "number"
      ) {
        throw new TypeError("autoChunk must be a boolean or number");
      }
      return {
        status: 200,
        body: await registry.ingest({
          collection,
          content,
          ...(typeof input.sourceKey === "string" ? { sourceKey: input.sourceKey } : {}),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          ...(input.chunks === undefined ? {} : { chunks: input.chunks as string[] }),
          ...(typeof input.autoChunk === "boolean" || typeof input.autoChunk === "number"
            ? { autoChunk: input.autoChunk }
            : {}),
        }),
      };
    }
    if (method === "POST" && pathname === "/search") {
      const input = body as Record<string, unknown>;
      if (typeof input?.collection !== "string" || typeof input?.query !== "string") {
        throw new TypeError("search requires string collection and query");
      }
      return {
        status: 200,
        body: await registry.search(
          input.collection,
          input.query,
          typeof input.k === "number" ? { limit: input.k } : undefined,
        ),
      };
    }
    return { status: 404, body: { error: "NOT_FOUND" } };
  } catch (error) {
    return errorResponse(error);
  }
}

export function createHttpServer(registry: FragRegistry): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://frag.local");
      const body = request.method === "POST" ? await jsonBody(request) : undefined;
      const result = await dispatchHttp(registry, request.method ?? "GET", url.pathname, body);
      send(response, result.status, result.body);
    } catch (error) {
      const failure = errorResponse(error);
      send(response, failure.status, failure.body);
    }
  });
}

export async function listenHttp(
  registry: FragRegistry,
  options: { readonly host?: string; readonly port?: number } = {},
): Promise<Server> {
  const server = createHttpServer(registry);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 34391, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
