# Frag

Frag is a standalone retrieval-augmented storage and search package. Its core
API is independently importable, while the `frag` executable supplies CLI,
human TUI, HTTP, and MCP callers over the same behavior.

The design contract is [SPEC-v9.md](./SPEC-v9.md).

## Development

```sh
npm install
npm run check
npm test
npm run build
```

Node 22 or newer, PostgreSQL with pgvector, and an OpenAI-compatible embedding
endpoint are required for standalone operation.

## Configuration

Copy `frag.example.yaml` and set the database environment variable named by
`url_env`. Configuration stores environment variable names, never secrets.

```sh
cp frag.example.yaml frag.yaml
export LOCAL_DATABASE_URL=postgres://localhost/frag
```

Schema bootstrap runs on every application startup. `frag add` edits the shared
registry; with no flags it opens a human-only prompt.

## CLI

```sh
frag put local-notes "a short note" --source-key note-1
frag search local-notes "what did I write?"
frag sources local-notes
frag reindex local-notes --dry-run
frag promote --from local-notes --to cloud-main --source note-1
frag serve --collections local-notes
frag mcp --collections local-notes
```

Only CLI `put` and `search` use the locally configured default collection.
Library, HTTP, and MCP calls always require an explicit collection.

The HTTP surface is:

- `POST /ingest`
- `POST /search`
- `GET /collections` (also `GET /list_collections`)

The MCP surface exposes exactly `ingest`, `search`, and `list_collections`.

## Library

```js
import { loadFragApplication } from "frag/core";

const app = await loadFragApplication("frag.yaml", {
  allowedCollections: ["public-docs"],
});

const collections = app.registry.listCollections();
const response = await app.registry.search("public-docs", "installation steps");
await app.close();
```

The allow-list describes what that registry instance exposes. It is coarse
process gating, not a permissions system.
