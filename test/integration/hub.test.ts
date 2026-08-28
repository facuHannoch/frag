import assert from "node:assert/strict";
import test from "node:test";

import {
  CollectionNotAllowedError,
  FragRegistry,
  type CollectionRuntime,
  type IngestService,
  type SearchService,
} from "../../src/core/index.js";

function runtime(name: string): CollectionRuntime {
  return {
    config: {
      name,
      description: `${name} description`,
      embedder: "test",
      db: "test",
      stateBackend: "same-as-db",
      mirrors: [],
    },
    search: {
      async search() {
        return { results: [] };
      },
      async inspectStatus() {
        return { collection: name, state: "current", configuredDimension: 2, storedDimensions: [2] };
      },
    } as SearchService,
    ingest: {
      async ingest() {
        return { source_id: 1, chunks_inserted: 1, changed: true, reembedded: true };
      },
    } as IngestService,
  };
}

test("stub hub exposes different methods and collection knowledge per agent", async () => {
  const all = [runtime("public"), runtime("private")];
  const publicRegistry = new FragRegistry(all, { allowedCollections: ["public"] });
  const internalRegistry = new FragRegistry(all);

  const publicAgent = {
    list_collections: () => publicRegistry.listCollections(),
    search: (collection: string, query: string) => publicRegistry.search(collection, query),
  };
  const internalAgent = {
    list_collections: () => internalRegistry.listCollections(),
    search: (collection: string, query: string) => internalRegistry.search(collection, query),
    ingest: (collection: string, content: string) =>
      internalRegistry.ingest({ collection, content }),
  };

  assert.deepEqual(publicAgent.list_collections().map(({ name }) => name), ["public"]);
  assert.equal("ingest" in publicAgent, false);
  await assert.rejects(publicAgent.search("private", "secret"), CollectionNotAllowedError);
  assert.deepEqual(internalAgent.list_collections().map(({ name }) => name), ["private", "public"]);
  assert.equal((await internalAgent.ingest("private", "note")).changed, true);
});
