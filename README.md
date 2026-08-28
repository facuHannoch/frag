# Frag

Frag is a standalone retrieval-augmented storage and search package. Its core
API is independently importable, while the `frag` executable supplies CLI,
human TUI, HTTP, and MCP callers over the same behavior.

The design contract is [SPEC-v10.md](./SPEC-v10.md).

## Development

```sh
npm install
npm run check
npm test
npm run build
```

Node 22.5 or newer is required. The simplest local path uses LM Studio plus
Docker or Podman; Frag provisions PostgreSQL with pgvector itself.

## First system

There is no required YAML file and Frag does not inspect the working directory
for one. Run:

```sh
frag add
```

The three-step wizard lets you search downloaded LM Studio embedding models,
choose managed local PostgreSQL (the default) or an existing server, and name
and describe the system with optional mirroring. It verifies the model,
database, pgvector, and schema before the system becomes visible.

Systems live in Frag's platform application-data directory. `FRAG_HOME` can
override that location for a deliberate separate profile. YAML is reserved for
explicit, secret-free import/export rather than normal startup:

```sh
frag config export > frag.yaml
frag config import frag.yaml
frag config recover       # clean up a journaled interrupted setup
```

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

Only CLI `put` and `search` use the globally configured default system.
Library, HTTP, and MCP calls always require an explicit collection.

The HTTP surface is:

- `POST /ingest`
- `POST /search`
- `GET /collections` (also `GET /list_collections`)

The MCP surface exposes exactly `ingest`, `search`, and `list_collections`.

## Library

```js
import {
  SystemProvisioner,
  createFragApplicationFromControlPlane,
  openFrag,
} from "frag/core";

const frag = await openFrag();
await new SystemProvisioner(frag).create({
  name: "public-docs",
  description: "Curated public documentation",
  lmStudioModelKey: "text-embedding-nomic-embed-text-v1.5",
  database: { kind: "managed-postgres" },
});

const app = await createFragApplicationFromControlPlane(frag, {
  allowedCollections: ["public-docs"],
});
const collections = app.registry.listCollections();
const response = await app.registry.search("public-docs", "installation steps");
await app.close();
frag.close();
```

The allow-list describes what that registry instance exposes. It is coarse
process gating, not a permissions system.
