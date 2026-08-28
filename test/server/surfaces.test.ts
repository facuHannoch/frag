import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { FragRegistry } from "../../src/core/index.js";
import { dispatchHttp } from "../../src/server/http.js";
import { createMcpServer } from "../../src/server/mcp.js";

function fakeRegistry(): FragRegistry {
  return {
    listCollections() {
      return [{ name: "public", description: "Public documents" }];
    },
    async ingest(input: { collection: string }) {
      assert.equal(input.collection, "public");
      return { source_id: 1, chunks_inserted: 1, changed: true, reembedded: true };
    },
    async search(collection: string, query: string) {
      assert.equal(collection, "public");
      assert.equal(query, "question");
      return { results: [] };
    },
  } as unknown as FragRegistry;
}

test("HTTP exposes only explicit ingest, search, and collection discovery", async () => {
  const registry = fakeRegistry();
  assert.deepEqual((await dispatchHttp(registry, "GET", "/collections")).body, [
    { name: "public", description: "Public documents" },
  ]);
  const ingest = await dispatchHttp(registry, "POST", "/ingest", {
    collection: "public",
    content: "text",
  });
  assert.equal((ingest.body as { reembedded: boolean }).reembedded, true);
  const search = await dispatchHttp(registry, "POST", "/search", {
    collection: "public",
    query: "question",
  });
  assert.deepEqual(search.body, { results: [] });
  assert.equal((await dispatchHttp(registry, "POST", "/reindex", {})).status, 404);
});

test("MCP advertises exactly the three v9 tools and requires collection input", async () => {
  const server = createMcpServer(fakeRegistry());
  const client = new Client({ name: "frag-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(({ name }) => name).sort(),
      ["ingest", "list_collections", "search"],
    );
    const listed = await client.callTool({ name: "list_collections", arguments: {} });
    assert.equal(listed.isError, undefined);
    assert.deepEqual((listed.structuredContent as { result: unknown }).result, [
      { name: "public", description: "Public documents" },
    ]);
    const invalid = await client.callTool({ name: "search", arguments: { query: "question" } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
