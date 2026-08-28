# Frag — Spec v10 (consolidated)

Status: proposal, not authoritative. Supersedes v0–v9. v10 retains v9's
retrieval, storage, concurrency, staleness, mirror, and promote invariants while
replacing its YAML-first control plane and non-provisioning `add` flow. Flag
disagreements before building rather than silently deviating.

## Changes from v9

- **Normal operation no longer requires YAML.** Frag owns one global local
  registry and callers mutate it through the library. YAML is an explicit
  import/export format only.
- **`frag add` provisions a working system.** It does not merely append a
  collection record. Embedder discovery, model readiness, PostgreSQL/pgvector,
  schema bootstrap, and health checks must all pass before the system appears.
- **LM Studio is the default local embedding provider.** Frag discovers
  downloaded embedding models, starts/checks the server, loads the selected
  model when necessary, and derives the real vector dimension with a probe.
- **Managed local pgvector is the default database.** Frag uses Docker or
  Podman to own a persistent local PostgreSQL+pgvector service. Connecting an
  existing PostgreSQL server remains available as an advanced choice.
- **Resource selection is discovery-driven.** The TUI presents searchable
  installed models, database choices, and mirror targets. It never asks a user
  for an "existing embedder name" or another internal identifier.
- **Creation is atomic from the user's perspective.** Failed provisioning does
  not leave a registered half-system. Safely removable transient resources are
  cleaned up; persistent resources are reported precisely if cleanup is unsafe.

## Changes from v8

Each change closes an ambiguity or contradiction in v8:

- **Dimension changes are not reindexable in place in v10.** The dimension is
  stored explicitly on every source. A fingerprint mismatch at the same
  dimension is stale and repairable by `reindex`; a configured dimension that
  differs from stored sources is a configuration error. Create a new collection
  and promote or mirror into it.
- **The stored embedding fingerprint describes the vectors, not the latest
  write.** It is updated only in the same transaction that replaces or
  regenerates vectors. A metadata-only write must preserve it, or it could
  falsely mark stale vectors current.
- **Metadata-only changes are persisted without embedding.** Change detection
  distinguishes any persisted change from vector regeneration and reports both
  `changed` and `reembedded`.
- **Metadata participates in promote and mirror identity.** Operation refs
  include a canonical `metadata_hash`, so metadata changes propagate without
  requiring new embeddings.
- **Concurrency uses a row version.** Revalidation after the advisory lock
  compares the source's monotonic `row_version`, covering metadata-only changes
  and avoiding ambiguous snapshot comparisons.
- **Stored chunk reads include embeddings.** This is required to repair a
  missing same-fingerprint mirror after the primary ingest no-ops, while still
  making zero embedding calls.
- **Mirror vector reuse compares against the stored source fingerprint.** The
  configured source fingerprint is insufficient when the source is stale.
- **Promote and mirror target identity is explicit.** Target source-key
  collisions with a different origin fail cleanly rather than silently
  overwriting curated content.
- **Advisory locks use a 64-bit derived key.** Hash collisions remain safe but
  are materially less likely to serialize unrelated sources.
- **Collection staleness and invalidity are defined separately.** Mixed
  same-dimension fingerprints are stale and searchable; mixed or changed
  dimensions make a collection unavailable until its configuration is fixed.

## What this is

A standalone package providing retrieval-augmented storage and search: content
goes in, gets chunked and embedded and stored; queries go in, get matched
against stored content and returned as text.

Four callers share one core. None is privileged except that the TUI is
explicitly human-only:

1. **CLI** — non-interactive commands, scriptable and agent-drivable.
2. **TUI** — interactive wizard layered on the CLI's flags, humans only.
3. **Server** — MCP + HTTP, via `frag serve` / `frag mcp`.
4. **Library** — exported `core/` API, importable in-process by an orchestration
   hub.

```text
frag/
  src/
    core/       # sources, chunking, retrieval, stores, mirror, promote
    cli/        # non-interactive commands; wraps core
    tui/        # interactive wizard; wraps CLI flags; human-only
    server/     # MCP + HTTP; wraps core
  package.json  # bin (CLI+TUI), main/exports (library)
```

`core/` is the product. It is agnostic to all four callers.

## Terminology

- **Source**: a unit of original content as supplied by the user — a file, a
  note, or a pasted block. It retains its unchunked original text.
- **Chunk**: an embedded unit belonging to exactly one source. Usually a slice
  of that source, but it may be a caller-supplied rewrite.
- **Representation**: the ordered set of chunks a source is currently embedded
  as, together with how they were produced.
- **Collection**: the core/storage term for one configured embedder plus one
  vector store. It is the atomic RAG unit.
- **System**: the user-facing name for a registered collection. A v10 system
  maps one-to-one to a collection; the TUI and general CLI say "system" while
  storage and compatibility APIs may still say "collection".
- **Registry**: the global control plane managing named systems, their
  resources, and relationships including mirror and promote.
- **Origin**: the source collection and source key from which a target source
  was promoted or mirrored. A directly ingested source has no external origin.
- **Hub** (external): an orchestration process that may hold a registry client
  in-process and gate what each agent sees.

## Non-goals

- No non-Postgres vector engines. Interfaces accommodate one later; only
  Postgres is implemented.
- No automatic sync or reconciliation beyond mirror-on-write. Promote is
  manual and explicit.
- No permissions system. Gating is coarse: a startup allow-list plus whatever
  a hub layers on top.
- No hybrid or keyword search and no reranking in v10. The public API is shaped
  so these can be added without caller changes.
- No two-phase commit across Postgres instances.
- No automatic reindexing on embedder change, by any code path.
- No in-place migration of an existing collection between embedding
  dimensions. Create a new collection instead.

## Global control plane

Normal users do not create or maintain a configuration file. Frag opens one
machine-global control-plane registry from the platform application-data
directory:

```text
Linux:   $XDG_DATA_HOME/frag/registry.sqlite3
         or ~/.local/share/frag/registry.sqlite3
macOS:   ~/Library/Application Support/Frag/registry.sqlite3
Windows: %LOCALAPPDATA%\Frag\registry.sqlite3
```

The directory and registry are created automatically on first use with
owner-only permissions where the platform supports them. `FRAG_HOME` may
override the directory for tests, portable installations, and deliberate
multi-profile use. The override is a process concern, not a per-command config
argument.

The registry is an implementation detail owned by `core/`. CLI, TUI, server,
and library all mutate it through the same API:

```typescript
const frag = await openFrag()

await frag.systems.create(input)
await frag.systems.update(name, patch)
await frag.systems.remove(name)
await frag.systems.list()
```

Callers do not edit SQLite and do not coordinate a configuration file with
operational state. Registry migrations are versioned, automatic, transactional,
and backward compatible within a major release.

The registry stores:

- **systems**: name, description, embedder reference, database reference,
  timestamps, and lifecycle status;
- **system mirrors**: zero or more validated target-system relationships;
- **embedders**: provider kind, endpoint, model identifier, observed dimension,
  hard/recommended token settings, revision, and last successful health check;
- **databases**: managed/existing kind, connection information or environment
  reference, ownership metadata, and last successful health check; and
- **settings**: CLI default system and managed-service preferences.

Local managed credentials are generated by Frag and may be stored in this
owner-only registry because unattended restart must work. Existing remote
database/provider secrets default to environment-variable references. Frag does
not silently copy arbitrary remote credentials into its registry.

`description` remains metadata an agent reads to judge relevance, not a primary
flag or permission rule.

`revision` remains a manually changeable provider-generation handle, but normal
LM Studio setup initializes it automatically and users do not see it in the
wizard.

### YAML import and export

YAML is an advanced interchange format only:

```text
frag config export > frag.yaml
frag config import frag.yaml [--replace]
```

Export omits secrets and managed database passwords. Import validates the whole
document, resolves secret references, provisions/verifies dependencies, and
commits registry changes transactionally. Merely placing `frag.yaml` in the
current directory has no effect. Normal commands never fail because it is
absent.

## Dead-simple local defaults

The recommended path is intentionally opinionated:

- embedding provider: LM Studio on `127.0.0.1:1234`;
- embedding model: one downloaded model selected from discovered embedding-only
  models;
- vector database: one Frag-managed local PostgreSQL+pgvector service shared by
  local systems; and
- state backend: the selected target database, as elsewhere in this spec.

`max_tokens` is a correctness ceiling. `recommended_chunk_size` is a much
smaller retrieval-quality target. Frag derives dimension from a real embedding
probe. It obtains model limits from trustworthy provider metadata when present
and otherwise uses a provider-specific tested default marked as inferred in the
registry.

### LM Studio lifecycle

Frag detects the `lms` executable and uses machine-readable discovery:

```text
lms ls --embedding --json
lms server status
lms server start --bind 127.0.0.1 --port 1234
lms load <model-key> --identifier <stable-id>
```

The wizard lists only downloaded embedding models. If none exist, it offers a
download action rather than an empty free-text prompt. Frag may use LM Studio's
current REST model-management API when available, but the observable behavior
is the same.

After selection Frag ensures the local server is reachable, loads or relies on
LM Studio auto-loading the model, sends a small embedding request, verifies
finite output, and records the observed dimension. A model is never registered
from its filename alone.

If LM Studio or `lms` is absent, the wizard explains how to install it and also
offers an advanced OpenAI-compatible provider path. Frag does not pretend it can
install LM Studio itself.

### Managed local PostgreSQL

The default database choice is `Managed local PostgreSQL`. Frag:

1. detects Docker or Podman;
2. creates/reuses a Frag-owned persistent volume;
3. starts a loopback-only PostgreSQL image containing pgvector;
4. generates and stores a local password;
5. waits for readiness;
6. creates/enables the vector extension and Frag schema; and
7. performs a real insert, similarity query, and rollback-safe cleanup probe.

The initial defaults are one service, one database, and collection-level
separation inside it. Users do not choose ports, database names, extensions, or
connection strings in the normal wizard.

The alternative `Existing PostgreSQL…` path asks for a connection or environment
reference, verifies database creation/extension permissions as applicable, and
runs the same schema/vector probe. It never registers an unverified connection.

If no supported container runtime exists, the managed option is shown as
unavailable with the reason and the existing-PostgreSQL option remains usable.

### Atomic provisioning lifecycle

`systems.create` and `frag add` use one provisioning workflow. Discovery is
read-only. After the user confirms, Frag:

1. builds a provisional plan without adding a visible system;
2. starts or reuses the selected provider and database dependencies;
3. health-checks the embedder and derives its actual dimension;
4. enables/bootstrap-checks pgvector and performs a real vector probe;
5. validates the system name, mirror targets, and absence of mirror cycles;
6. commits the resource records, system record, mirror relationships, and
   default-system setting in one local registry transaction; and
7. reports the ready system and the resources it owns or reuses.

If any step fails, no system becomes visible. Frag stops and removes only
resources created by that attempt when doing so is known to be safe. It never
deletes a reused service, existing database, persistent volume, or downloaded
model. Any persistent resource that could not safely be cleaned up is named in
the error with a recovery command. A small provisioning journal in the registry
supports cleanup after process interruption; journal entries are not systems
and are never returned by `systems.list`.

## Hashes, fingerprint, and dimension

```text
content_hash          = sha256(original content bytes)
representation_hash   = sha256(chunking mode + effective size + ordered chunks)
metadata_hash         = sha256(canonical JSON metadata)
embedding_fingerprint = sha256(api_style + model + revision + dim)
embedding_dim         = configured integer vector width
```

Hash framing must be unambiguous: implementations use length-prefixed UTF-8
fields rather than raw delimiter concatenation. Hash output is lowercase hex.

Metadata is canonicalized according to RFC 8785 JSON Canonicalization Scheme
before hashing. Object key order is therefore irrelevant; array order remains
significant. Input must be valid JSON data: objects, arrays, strings, booleans,
null, and finite JSON numbers.

`representation_hash` inputs are precisely:

- chunking mode: `manual`, `explicit`, or `auto`;
- effective chunk size for `auto`, and null for the other modes; and
- ordered chunk content bytes.

Order matters because reordering changes what each `chunk_index` identifies.

### What each value means

| Change | Detected by | Automatic ingest behavior | Explicit repair |
|---|---|---|---|
| Original content | `content_hash` | Re-chunk/re-embed | None needed |
| Chunk representation | `representation_hash` | Re-embed/replace | None needed |
| Metadata only | `metadata_hash` | Update metadata, no embedding | None needed |
| Model/revision, same dimension | fingerprint | Warn; never re-embed | `frag reindex` |
| Embedding dimension | `embedding_dim` | Refuse collection use | New collection |

Vectors are comparable only when produced by the same embedding fingerprint.
The fingerprint stored on a source identifies the model that produced its
currently stored vectors. It is not a record of the latest configured model.

The stored fingerprint and dimension are updated only in the same transaction
that inserts, replaces, or regenerates all vectors for that source. A
metadata-only write preserves both values.

The fingerprint is never an input to ordinary ingest change detection. This is
the most important invariant in this document.

### Stale versus invalid collections

A collection is **stale** when at least one source has the configured dimension
but a stored fingerprint different from the configured fingerprint. Startup
warns prominently. Search proceeds, warns, and returns
`stale_embeddings: true`. Results may be poor and should not be trusted until
reindex completes.

A collection is **dimension-invalid** when any stored source has an
`embedding_dim` different from the collection's configured dimension. Startup
reports an error naming both dimensions. Search, ingest, promote/mirror writes
into that collection, and reindex are refused. The operator must revert the
configuration or create a new collection and promote/mirror content into it.

An empty collection may use any configured dimension. A single physical
database may contain collections of different dimensions because chunks are
stored in dimension-specific tables.

A collection can temporarily contain multiple same-dimension fingerprints,
for example after a partial per-source reindex or after changed content is
ingested under a new configuration. It remains stale until no source differs
from the configured fingerprint.

## Change detection and result semantics

Ordinary ingest compares three content-state hashes, never the fingerprint:

1. If `content_hash` or `representation_hash` differs, replace chunks and
   regenerate vectors.
2. Else if only `metadata_hash` differs, update source and chunk metadata
   without embedding and preserve the stored fingerprint and dimension.
3. Else the primary operation is a complete no-op.

The result separates persistence from embedding work:

```typescript
interface WriteResult {
  source_id: number
  chunks_inserted: number
  changed: boolean
  reembedded: boolean
  warnings?: string[]
}
```

- `changed` means any persisted primary source, chunk, or metadata state changed.
- `reembedded` means the primary source's chunk embeddings were regenerated.
- Mirror writes do not change either primary flag; mirror failures and recovery
  are reported separately in `warnings` and optional per-target diagnostics.
- `chunks_inserted` is zero for a primary no-op or metadata-only update.

Examples:

| Operation | `changed` | `reembedded` |
|---|---:|---:|
| Identical ingest | false | false |
| Metadata only | true | false |
| Content or chunks changed | true | true |
| Revision bumped, ordinary identical ingest | false | false |

`reindex` has its own result type because it is not ordinary ingest.

After a revision bump, re-ingesting identical content remains a no-op even
though the source is stale. It makes zero embedding calls. Only explicit
reindex repairs the vectors.

## Sources and chunks are not redundant

Both `sources.content` and each chunk's `content` are stored in full,
unconditionally. Do not optimize either away.

Auto-generated chunks are normally slices of the source, but explicit chunks
may be condensed, rephrased, overlapped, or reorganized for retrieval. The
source is what the user supplied; the chunks are what was embedded. Neither can
be reconstructed reliably from the other.

Metadata supplied by the v10 public ingest API is source-level metadata. It is
stored authoritatively on the source and copied onto every chunk as a retrieval
snapshot. A metadata-only update changes the source and all of its chunk
snapshots transactionally without regenerating embeddings. Per-chunk metadata
input is not part of the v10 public API.

## Token counting

A character-per-token estimate cannot enforce a hard limit. Code, dense
punctuation, and CJK text tokenize differently from English prose.

Each embedder declares one of three tiers:

1. **`tiktoken`** — local tokenizer for the model encoding. Exact and no
   network call; appropriate for OpenAI-family models.
2. **`endpoint`** — tokenize endpoint exposed by the serving process. Exact but
   costs a round trip.
3. **`estimate`** — approximately four characters per token, constrained by
   `token_safety_margin`, so validation trips at (for example) 80% of
   `max_tokens`.

In every tier the embedder's own length error is authoritative. The client must
classify and surface that error as a length failure naming the source and exact
zero-based chunk index. No partial database write occurs. `TokenCounter.isExact`
allows messages to distinguish exact preflight rejection from approximate
validation.

## Ingestion modes

There are three explicit modes and no silent truncation.

### 1. Manual (default)

```text
frag put notes "a short note"
```

The source becomes one chunk. Content above `max_tokens` errors and suggests
`--auto-chunk` or `--chunks`. Content above `recommended_chunk_size` but within
the hard limit warns and proceeds.

### 2. Explicit chunks

```text
frag put docs "large text" --chunks "chunk1" "chunk2" "chunk3"
frag put docs --file design.md --chunks "chunk1" "chunk2"
```

One source receives caller-chosen chunks. Every chunk is validated separately.
Chunks need not concatenate to the original and may overlap or be rewrites.
The source content remains authoritative.

### 3. Automatic

```text
frag put docs --file design.md --auto-chunk[=<size>]
```

Frag uses fixed token-size splitting with approximately 50 tokens of overlap.
The default size is the embedder's `recommended_chunk_size`.

The CLI confirms:

```text
This will split into ~N chunks of ~<size> tokens each. Continue? [y/N]
```

`--yes` skips confirmation. MCP and HTTP always behave as though `--yes` was
passed; prompting is a CLI-only affordance and never exists in `core/`.

`--file` without explicit or automatic chunking follows manual mode and errors
if oversized. `source_key` defaults to the filename; `--source-key` overrides.

## Source keys and generated identity

Within a collection, `source_key` is the stable caller-visible identity.

For bare notes without `--source-key`, v10 generates a key from the content hash:

```text
note-<first 16 hex characters of content_hash>
```

This is stable and intentionally content-addressed. A caller that wants later
edits to update the same logical note must provide a stable source key.

Promote and mirror retain an origin tuple separately from target identity:

```text
(origin_collection, origin_source_key)
```

The default target source key is the source key. Core promote accepts an
optional `targetSourceKey`, and the CLI exposes `--target-source-key`.

If the requested target key exists:

- it may be updated when it has the same origin tuple;
- a directly ingested target source counts as a different origin; and
- a different or absent origin causes a clean conflict error.

Frag never silently overwrites target content belonging to another origin.
Operators resolve a conflict by choosing an explicit target source key or
removing the target deliberately.

## Schema

There is one `chunks_<dim>` table per required embedding dimension because a
pgvector column and HNSW index have a fixed vector width.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sources (
    id BIGSERIAL PRIMARY KEY,
    collection TEXT NOT NULL,
    source_key TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    representation_hash TEXT NOT NULL,
    metadata_hash TEXT NOT NULL,
    embedding_fingerprint TEXT NOT NULL,
    embedding_dim INTEGER NOT NULL CHECK (embedding_dim > 0),
    chunking_mode TEXT NOT NULL
      CHECK (chunking_mode IN ('manual', 'explicit', 'auto')),
    chunk_size INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    origin_collection TEXT,
    origin_source_key TEXT,
    row_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (collection, source_key),
    CHECK (
      (origin_collection IS NULL AND origin_source_key IS NULL) OR
      (origin_collection IS NOT NULL AND origin_source_key IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS sources_collection_fingerprint_idx
  ON sources (collection, embedding_fingerprint);
CREATE INDEX IF NOT EXISTS sources_collection_dim_idx
  ON sources (collection, embedding_dim);
CREATE INDEX IF NOT EXISTS sources_origin_idx
  ON sources (collection, origin_collection, origin_source_key);

CREATE TABLE IF NOT EXISTS chunks_768 (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    collection TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(768) NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, chunk_index),
    CHECK (chunk_index < chunk_count)
);

CREATE INDEX IF NOT EXISTS chunks_768_collection_idx
  ON chunks_768 (collection);
CREATE INDEX IF NOT EXISTS chunks_768_source_idx
  ON chunks_768 (source_id);
CREATE INDEX IF NOT EXISTS chunks_768_content_hash_idx
  ON chunks_768 (content_hash);
CREATE INDEX IF NOT EXISTS chunks_768_embedding_hnsw_idx
  ON chunks_768 USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS _frag_state (
    id BIGSERIAL PRIMARY KEY,
    source_collection TEXT NOT NULL,
    source_key TEXT NOT NULL,
    target_collection TEXT NOT NULL,
    target_source_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('promote', 'mirror')),
    ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (target_collection, target_source_key)
);
```

Equivalent chunk tables are bootstrapped for every configured dimension.

Chunk identity is positional: `UNIQUE (source_id, chunk_index)`. Identical
paragraphs may occur in two sources or twice in one source.

`_frag_state.ref` is a framed hash of:

```text
source_key
+ content_hash
+ representation_hash
+ metadata_hash
+ target_source_key
+ target_embedding_fingerprint
```

Source and target collection are already explicit indexed columns in the state
row. Including `target_source_key` prevents state for one mapping from
suppressing another.

The ref identifies operation inputs, not the target's resulting representation.
When a different embedder forces target-side re-chunking, the target's own
`representation_hash` legitimately differs from the source value in the ref.

`_frag_state` is a **current target receipt**, not an immutable event log. A
successful target write replaces any prior receipt for that target collection
and target key in the same transaction. Deleting a target source removes its
receipt in the same transaction. Consequently an old receipt can never cause a
deleted or subsequently replaced target to be skipped. Historical operation
auditing is out of scope.

### Bootstrap

Schema bootstrap is idempotent and connection/startup-time, not `add`-time.
`core/` issues `CREATE ... IF NOT EXISTS` for sources, state, and every required
dimension table and index on every startup or initialized connection. A machine
that clones config and runs `frag serve` without running `add` must work.

Bootstrap is not a general schema migration mechanism. Released migrations are
versioned separately.

## Core interfaces

```typescript
interface StoredChunk {
  id: string | number
  sourceId: number
  collection: string
  content: string
  embedding: number[]
  contentHash: string
  chunkIndex: number
  chunkCount: number
  metadata: object
}

interface SourceSnapshot {
  source: Source | null
  rowVersion: bigint | null
}

interface VectorStore {
  insertChunk(
    tx: Tx,
    collection: string,
    sourceId: number,
    content: string,
    embedding: number[],
    chunkIndex: number,
    chunkCount: number,
    metadata: object
  ): Promise<{ id: string | number }>

  similaritySearch(
    collection: string,
    embedding: number[],
    limit: number
  ): Promise<VectorSearchResult[]>

  listChunksBySource(sourceId: number, embeddingDim: number): Promise<StoredChunk[]>
  deleteChunksBySource(tx: Tx, sourceId: number, embeddingDim: number): Promise<void>
  updateChunkEmbeddings(tx: Tx, sourceId: number, embeddingDim: number,
                        embeddings: number[][]): Promise<void>
  updateChunkMetadata(tx: Tx, sourceId: number, embeddingDim: number,
                      metadata: object): Promise<void>
}

interface SourceStore {
  get(collection: string, sourceKey: string): Promise<SourceSnapshot>
  list(collection: string): Promise<Source[]>
  listStale(collection: string, currentFingerprint: string,
            embeddingDim: number): Promise<Source[]>
  listDimensions(collection: string): Promise<number[]>

  insert(tx: Tx, input: NewSource): Promise<Source>
  updateRepresentation(tx: Tx, sourceId: number, expectedRowVersion: bigint,
                       input: RepresentationUpdate): Promise<Source>
  updateMetadata(tx: Tx, sourceId: number, expectedRowVersion: bigint,
                 metadata: object, metadataHash: string): Promise<Source>
  updateEmbeddingIdentity(tx: Tx, sourceId: number,
                          expectedRowVersion: bigint,
                          fingerprint: string, dim: number): Promise<Source>
  delete(tx: Tx, collection: string, sourceKey: string): Promise<void>
}

interface StateStore {
  replaceReceipt(tx: Tx, operation: 'promote' | 'mirror', source: string,
                 sourceKey: string, target: string, targetSourceKey: string,
                 ref: string): Promise<void>
  hasOperation(operation: 'promote' | 'mirror', source: string,
               target: string, ref: string): Promise<boolean>
  deleteTargetReceipt(tx: Tx, target: string,
                      targetSourceKey: string): Promise<void>
}

interface TokenCounter {
  count(text: string): Promise<number>
  isExact(): boolean
}

interface Transactional {
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}
```

Mutating store operations require a transaction. Reads used for preparation
occur outside it. This makes accidental non-transactional writes harder than
the v8 `Tx | null` form.

The service layer, not `SourceStore`, owns change detection and orchestration.
Splitting `upsert` into explicit insert/update methods prevents a store-level
boolean from hiding whether metadata or representation changed.

Every source mutation increments `row_version` and updates `updated_at`.
Methods with `expectedRowVersion` must affect exactly one row or report a
concurrent modification.

`frag rm` acquires the source advisory lock and deletes the source and its
current target receipt, if any, in one transaction. Chunk deletion follows from
the source foreign key. Removing a source that acts as an origin cannot
transactionally clean receipts stored in other databases; those receipts are
replaced or removed when their target is next written or deleted and do not
claim that the origin still exists.

## Write sequence

No transaction is held across token counting or embedding calls, and no
embedding occurs before the primary no-op decision.

### Representation-changing ingest

```text
1. Validate that the collection is not dimension-invalid.
2. Read SourceSnapshot for (collection, source_key), including row_version.
3. Prepare chunks and compute content_hash, representation_hash, metadata_hash.
4. If content and representation match, use the metadata/no-op path below.
5. Validate all token limits and generate all embeddings outside a transaction.
6. BEGIN.
7. Acquire a transaction-level advisory lock for collection + source_key.
8. Re-read the source after the lock:
   - if step 2 observed absence, it must still be absent;
   - otherwise id and row_version must equal the step 2 snapshot.
   If not, ROLLBACK and return a clean concurrent-modification error.
9. Insert/update the source, delete old chunks from its stored dimension table,
   insert all new chunks into the configured dimension table, and update the
   stored fingerprint/dimension to those that produced the new vectors.
10. COMMIT.
11. Check mirrors, even if the primary path ultimately no-opped.
```

For a dimension-valid collection, old and configured dimensions match. Step 9
does not perform cross-dimension migration.

### Metadata-only ingest

```text
1–4. Same preparation and comparison as above.
5. If only metadata_hash differs, make no embedding call.
6. BEGIN and acquire the same advisory lock.
7. Revalidate id and row_version exactly as above.
8. Update source metadata/hash and every chunk metadata snapshot; increment
   row_version. Preserve embedding_fingerprint and embedding_dim.
9. COMMIT.
10. Check mirrors using the new metadata_hash.
```

### Complete primary no-op

When all three hashes match, Frag performs no primary transaction, embedding,
or write and returns `changed: false, reembedded: false`. It still checks every
mirror. If mirror preparation needs a consistent primary snapshot, it reads the
source and chunks and verifies their relationship; a concurrent primary change
causes that mirror attempt to retry from the new source snapshot rather than
copying mixed state.

### Advisory lock key

The lock is a signed 64-bit value derived from a domain-separated SHA-256 hash
of length-framed `(database namespace, collection, source_key)`, using the first
64 bits with a documented byte order, and passed to `pg_advisory_xact_lock`.
Hash collisions are safe because the database remains authoritative; they only
serialize unrelated operations.

Target-side promote and mirror writes acquire the same lock for the target
collection and target source key. This covers both existing rows and concurrent
creation. Row locks alone are insufficient when no row exists.

Concurrent writers may perform duplicate embedding work, but only a writer
whose snapshot remains current may commit. The loser receives a domain-level
concurrent-modification result, never a leaked unique-constraint error.

## Retrieval API

The public operation is search for information, not vector similarity:

```typescript
search(
  collection: string,
  query: string,
  options?: SearchOptions
): Promise<SearchResponse>

interface SearchResponse {
  results: SearchResult[]
  stale_embeddings?: boolean
}
```

Callers provide a query string. They never choose an embedder, supply a vector,
or depend on pgvector operators. The internal storage primitive is named
`similaritySearch` deliberately.

`SearchResult` is chunk-level and includes `source_key`, chunk content, score,
chunk position, and source metadata. Source roll-up is deferred until a concrete
consumer requires it. A formal `Retriever` interface is also deferred until a
second retrieval strategy exists.

Before search, Frag validates dimension compatibility. It embeds the query with
the configured embedder and searches the configured dimension table. If any
source in the collection has a different same-dimension fingerprint, the
response sets `stale_embeddings: true` and logs a warning.

## Operational state location

System definitions live in the global local registry. Promote/mirror completion
state is shared operational data and lives in the target collection's
`state_backend`; keeping it only in the local registry would make two machines
writing the same target disagree about completed work.

Only `same-as-db` is implemented in v10. The target source, target chunks, and
state row are committed in one target-side transaction. This makes retries
idempotent. It does not make cross-instance operations atomic end-to-end, and
the spec makes no such claim.

## Shared transfer preparation

Mirror and promote use the same target preparation algorithm.

Given a consistent source row and its ordered stored chunks:

1. Check every chunk against the target token limit.
2. If every chunk fits, carry all chunks over and preserve the source's
   `chunking_mode` and `chunk_size`.
3. If any chunk does not fit, discard carry-over entirely and auto-chunk the
   original `sources.content` at the target's `recommended_chunk_size`. Record
   mode `auto` and that effective size.
4. Never mix carried and freshly split chunks for one target source.
5. Copy original source content and source metadata in full.

Before generating embeddings, Frag also reads the requested target key under
the same optimistic-snapshot pattern used by ingest and determines the target
mutation:

- If the target already has the same origin, original content, and prepared
  target representation, and its stored fingerprint/dimension match the target
  configuration, a metadata-only difference updates metadata and the current
  receipt without embedding.
- If all target hashes and its current receipt match, the transfer is a no-op.
- Otherwise the transfer replaces the target representation and vectors.

This target-side check matters when source and target embedders differ: a source
metadata edit must not regenerate already-valid target vectors merely because
those vectors cannot be reused from the source.

Vector reuse is allowed only if the target configured fingerprint equals the
**stored fingerprint on the source row**, and carry-over was used unchanged.
Comparing with the source collection's current configured fingerprint is wrong
when its vectors are stale. When reuse is allowed, read embeddings through
`listChunksBySource`; make no embedder call.

If target-side re-chunking occurs, or fingerprints differ, generate target
embeddings outside the target transaction. Embedding work can be grouped and
reused across multiple targets only when both the exact ordered chunk contents
and target fingerprints match.

## Mirror

Mirrors are automatic fan-out checked on every ingest, including primary
metadata-only updates and complete primary no-ops.

For each target:

```text
target_key = configured mapping or source_key
ref = hash(source_key, content_hash, representation_hash, metadata_hash,
           target_key, target configured fingerprint)

if target StateStore.hasOperation('mirror', source, target, ref):
  skip
else:
  prepare target representation and vectors
  transaction:
    advisory-lock target collection + target_key
    validate target origin compatibility
    replace or metadata-update target source and chunks as required
    replace the current target receipt
```

Target fingerprint is part of the ref, so changing the target model makes the
operation eligible again. Metadata hash is part of the ref, so metadata-only
source changes propagate.

Mirror carry-over is all-or-nothing per source. Same-fingerprint transfer reuses
stored vectors only under the shared preparation rules above.

Primary success or failure is independent of mirror fan-out. `put`/`ingest`
returns primary success with warnings naming failed targets. Each target write
and state row share one transaction, so failure leaves neither partial target
data nor a false completion receipt.

Re-running identical ingest repairs a failed mirror: the primary remains a
no-op, the missing state check fails, and the mirror retries.

Mirror loops are invalid configuration. Registry validation rejects direct and
transitive mirror cycles before serving or ingesting.

## Promote

Promote is manual and explicit — the only path by which content crosses from a
private/working collection into a curated/public collection.

```text
frag promote --from local-notes --to cloud-main --source design.md
frag promote --from local-notes --to cloud-main --source design.md \
  --target-source-key local-design.md
```

Promote copies original content, source metadata, and the chunk representation,
subject to the shared all-or-nothing carry-over algorithm.

Before embedding, it checks state using source key, all three hashes, target
key, and target fingerprint. Re-running skips only when content,
representation, metadata, target mapping, and target model are unchanged.

The target transaction acquires its advisory lock, validates origin
compatibility, writes the complete source/chunk state, and replaces the current
target receipt. A target failure rolls all of that back. Cross-instance source reading
and target writing are not atomic, but retry is idempotent.

## Reindex

```text
frag reindex <collection> [--dry-run]
```

Reindex repairs sources whose stored fingerprint differs from the configured
fingerprint at the same dimension. It is the only path that acts merely because
of a fingerprint difference.

For each stale source:

```text
1. Read source snapshot and chunks, including exact content and chunk_index.
2. Generate replacement embeddings outside a transaction.
3. BEGIN and advisory-lock collection + source_key.
4. Re-read and verify id + row_version and the same stored fingerprint/dim.
5. Update vectors positionally and update the source fingerprint in the same
   transaction; increment row_version. Do not alter content, chunks, indices,
   chunking fields, metadata, origin, or dimension.
6. COMMIT.
```

Each source commits independently. A failure leaves that source unchanged and
the collection stale; completed sources remain safely reindexed. Retrying acts
only on those still stale.

Before doing any work, reindex refuses if any stored source dimension differs
from configuration and explains that v10 requires a new system.

`--dry-run` reports stale source count, chunk count, configured fingerprint,
stored fingerprint groups, and estimated embedding calls. It writes nothing.

## Gating

Two independent mechanisms exist; neither is a permissions system.

### Startup allow-list

```text
frag mcp --collections public-docs,product-faq
frag serve --collections cloud-main
```

`list_collections` returns only allowed collections. Search and ingest against
another collection error without confirming whether it exists.

### Hub-embedded library mode

A hub holds one registry client in-process and exposes selected methods through
its own agent tooling. It may give an agent search on one collection without
ingest or knowledge of private collections. `core/` implements no permissions.

Consequently, `list_collections` reports only what the current process or hub
permits, not necessarily the full registry. This must be documented at every
public surface.

## CLI surface

```text
frag add
frag add --name <name> --description <text> --lmstudio-model <model-key>
         [--database managed-postgres | --database-url-env <env>]
         [--mirror <system> ...] [--yes]
frag list
frag config set-default <system>
frag config export
frag config import <path> [--replace]

frag put <system> "<text>" [--source-key <key>] [--metadata <json>]
                                [--chunks "c1" "c2" ... | --auto-chunk[=<size>]]
                                [--yes]
frag put <system> --file <path> [--source-key <key>] [--metadata <json>]
                                [--chunks "c1" "c2" ... | --auto-chunk[=<size>]]
                                [--yes]
frag search <system> "<query>" [--k <n>]        # alias: get
frag sources <system> [--source-key <key>]
frag rm <system> --source-key <key>
frag reindex <system> [--dry-run]
frag promote --from <n> --to <n> --source <key>
             [--target-source-key <key>]
frag serve [--collections a,b,c]
frag mcp [--collections a,b,c]
```

`frag add` without provisioning flags launches this three-step TUI:

```text
Step 1 of 3 — Embedding model
Select embedding model:
  > text-embedding-nomic-embed-text-v1.5
    ...downloaded embedding models

Step 2 of 3 — Vector database
Database:
  > Managed local PostgreSQL
    Existing PostgreSQL…

Step 3 of 3 — System configuration
Name:
Description:
Mirroring:
  > No mirroring
    ...existing systems

Create system? [Y/n]
```

Lists support arrow-key navigation and search-as-you-type filtering. Disabled
choices remain visible with a short reason. The summary before confirmation
states what Frag will start, create, and reuse. Provisioning progress is shown
as named steps, and success ends with one copyable `frag put` example.

Flags provide the same workflow non-interactively for scripts. They describe
provider/database choices, not internal registry identifiers. An incomplete
non-interactive invocation errors with the missing flags and never falls back
to a prompt.

`<system>` is optional on CLI `put` and `search`, falling back to the default in
the global registry. Server and hub/library calls always require an explicit
collection/system and never consult the CLI default.

## MCP and HTTP surface

```typescript
ingest(
  collection: string,
  content: string,
  sourceKey?: string,
  metadata?: object,
  chunks?: string[],
  autoChunk?: boolean | number
): Promise<WriteResult>

search(
  collection: string,
  query: string,
  k?: number
): Promise<{
  results: SearchResult[]
  stale_embeddings?: boolean
}>

list_collections(): Promise<Array<{
  name: string
  description: string
}>>
```

`chunks` and `autoChunk` are mutually exclusive. Server ingest never prompts.

Promote, reindex, removal, and configuration are intentionally absent from the
v10 MCP/HTTP surface. They remain CLI/library administrative operations unless a
future use case justifies exposing them.

## Failure and error contract

Core exposes typed/domain errors that callers translate without leaking SQL or
provider internals:

- `UnknownCollection`
- `CollectionNotAllowed`
- `DimensionMismatch` with configured and stored dimensions
- `ConcurrentModification` with collection and source key
- `SourceKeyConflict` with target key and origin summary
- `ChunkTooLong` with source key, zero-based chunk index, measured/estimated
  count, limit, and whether counting was exact
- `EmbedderLengthError` with source key and zero-based chunk index
- `InvalidIngestionMode`
- `InvalidMetadata`
- `MirrorConfigurationCycle`

Provider batch calls must preserve an index mapping. If a provider identifies
the rejected input, Frag reports the exact chunk. If it rejects a whole batch
without identifying the input, Frag may retry safely outside a transaction in
smaller batches to isolate the chunk; it must not guess.

## Open questions

1. **Azure OpenAI deployment specifics** — confirm deployed model name, output
   dimension, hard token ceiling, and tokenizer mapping against a real
   deployment.
2. **LM Studio tokenize endpoint** — determine whether its current server API
   exposes exact tokenization. If not, the primary local path uses `estimate`.
3. **Source-level search results** — v10 is chunk-level. Add roll-up only after a
   concrete CLI or API requirement defines scoring and pagination semantics.
4. **Mirror target key mapping** — v10 permits a configured mapping but
   only defines identity semantics, not a templating language. Until one is
   specified, mirrors use the unchanged source key.

## Definition of done

### Change detection, metadata, and staleness

- Re-ingesting identical content and metadata after a `revision` bump returns
  `changed: false`, `reembedded: false`, and performs zero embedding calls.
- A revision bump causes startup warning and search
  `stale_embeddings: true`.
- A metadata-only ingest returns `changed: true`, `reembedded: false`, performs
  zero embedding calls, updates source and chunk metadata, and preserves the
  old stored fingerprint if vectors are stale.
- Metadata-only changes cause mirror and a subsequent promote to run again;
  neither regenerates vectors when reuse conditions hold.
- Reindex preserves chunk content, indices, counts, chunking fields, and
  metadata byte-for-byte at the logical JSON level; only vectors, fingerprint,
  row version, and update time change.
- Unchanged ingest with healthy mirrors is a full no-op: no primary transaction,
  embedding call, or mirror write.
- Improved explicit chunks on an unchanged original produce `changed: true`,
  `reembedded: true`, are stored, and make promote eligible again.

### Dimension safety

- Changing a populated 768-dimensional collection config to 1536 produces a
  startup error and typed failures from search, ingest, reindex, and inbound
  mirror/promote. No query reaches the wrong chunk table.
- Reverting the dimension restores availability without data mutation.
- Creating a new 1536-dimensional collection and promoting from the 768 source
  succeeds through target re-embedding.

### Concurrency

- Concurrent update of an existing source: one snapshot wins; the loser aborts
  cleanly after lock revalidation.
- A metadata-only update races correctly with a representation update; neither
  silently overwrites the other.
- Concurrent creation of an absent source: one wins and the other receives a
  domain concurrent-modification error, not a unique-constraint error.
- Concurrent promote/mirror writes to one target key obey the same behavior.
- Instrumentation proves no database transaction is held during token counting
  or embedding, including multi-chunk ingest and reindex with a slow embedder.

### Storage correctness

- Two sources sharing an identical paragraph both ingest.
- A source containing the same paragraph twice ingests.
- Editing original content removes old chunks; only current chunks are
  retrievable.
- A failure between chunk deletion and insertion rolls back to the complete
  prior source and chunks.
- One oversized explicit chunk fails with its exact zero-based index.
- An embedder length rejection mid-batch is isolated and reported with the
  chunk index, with no partial database write.
- Bare note identity is stable for identical content; callers can use an
  explicit key for editable logical notes.

### Mirror and promote

- A failed mirror returns a warning. Re-ingesting identical input primary-no-ops
  while the missing mirror retries and succeeds.
- A healthy same-fingerprint mirror uses stored vectors and makes no additional
  embedding call, including repair after a primary no-op.
- If a source is stale relative to its own configuration, vector reuse is based
  on its stored fingerprint; incompatible stale vectors are never copied into a
  target claiming the current fingerprint.
- A different-fingerprint mirror re-embeds.
- One target-oversized chunk causes the entire target source to be re-chunked in
  auto mode; carried and new boundaries never mix.
- A target failure leaves neither target source/chunks nor state row partial;
  retry succeeds.
- Deleting a promoted or mirrored target deletes its current receipt; repeating
  the operation recreates the target rather than skipping on historical state.
- Two origins with the same default target key conflict cleanly. Supplying a
  distinct target key succeeds and records correct origin.
- Direct and transitive mirror cycles fail registry validation.

### Packaging and integration

- Package installs standalone; every CLI command works against local Postgres
  plus LM Studio.
- `core/` imports from a throwaway script without CLI, TUI, or server modules.
- On a machine with LM Studio, one downloaded embedding model, and Docker or
  Podman, `frag add` requires no file, URL, port, database name, or extension
  knowledge and ends with a working put/search round trip.
- The model picker contains only actual downloaded embedding models and is
  searchable; the database picker defaults to managed PostgreSQL; the mirror
  picker lists existing systems and defaults to no mirroring.
- A failed embedder probe, database startup, pgvector bootstrap, or final
  registry transaction leaves no visible half-system and reports any resource
  that cannot safely be cleaned up.
- Closing and reopening the process preserves systems and the default through
  the platform registry. Running from another current directory behaves the
  same and never searches for `frag.yaml`.
- A library-only test creates, lists, updates, and removes a system through
  `openFrag().systems` and observes the same registry as the CLI.
- YAML export/import round-trips system definitions without secrets; merely
  placing YAML in the working directory changes nothing.
- A fresh machine with a populated global registry but an empty target database
  bootstraps schema at connection time and can immediately put/search.
- `frag mcp --collections a,b` lists and serves exactly those collections and
  does not disclose any other collection through errors.
- A stub hub imports the real library, holds one client, and demonstrates
  different per-agent method and collection exposure.
