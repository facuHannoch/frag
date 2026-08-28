import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import type { FragRegistry } from "../core/registry.js";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

export function createMcpServer(registry: FragRegistry): McpServer {
  const server = new McpServer({ name: "frag", version: "0.1.0" });
  server.registerTool(
    "ingest",
    {
      description: "Store source content in an explicitly named Frag collection",
      inputSchema: {
        collection: z.string().min(1),
        content: z.string(),
        sourceKey: z.string().min(1).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        chunks: z.array(z.string()).min(1).optional(),
        autoChunk: z.union([z.boolean(), z.number().int().positive()]).optional(),
      },
    },
    async ({ collection, content, sourceKey, metadata, chunks, autoChunk }) =>
      toolResult(
        await registry.ingest({
          collection,
          content,
          ...(sourceKey === undefined ? {} : { sourceKey }),
          ...(metadata === undefined ? {} : { metadata }),
          ...(chunks === undefined ? {} : { chunks }),
          ...(autoChunk === undefined ? {} : { autoChunk }),
        }),
      ),
  );
  server.registerTool(
    "search",
    {
      description: "Search an explicitly named Frag collection for relevant information",
      inputSchema: {
        collection: z.string().min(1),
        query: z.string(),
        k: z.number().int().positive().optional(),
      },
    },
    async ({ collection, query, k }) =>
      toolResult(await registry.search(collection, query, k === undefined ? undefined : { limit: k })),
  );
  server.registerTool(
    "list_collections",
    {
      description: "List only the Frag collections visible to this process",
    },
    async () => toolResult(registry.listCollections()),
  );
  return server;
}

export async function runMcpStdio(registry: FragRegistry): Promise<void> {
  const server = createMcpServer(registry);
  await server.connect(new StdioServerTransport());
}
