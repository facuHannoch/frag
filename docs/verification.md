# Frag v9 verification matrix

This document maps the v9 Definition of Done to repeatable evidence. The normal
suite is infrastructure-independent; live checks activate only when their
documented services are available.

## Always-run checks

```sh
npm run check
npm test
npm run build
node dist/cli/main.js --help
npm_config_cache=/tmp/frag-npm-cache npm pack --dry-run --json
```

The unit/in-memory suites cover:

- two-hash content/representation change detection independent of fingerprint;
- metadata-only updates with zero embedding and preserved vector identity;
- existing and absent-source concurrency races after advisory locking;
- positional duplicate chunks and transactional store contracts;
- dimension invalidity, same-dimension staleness, query-string retrieval, and
  allow-list behavior;
- dry-run and exact-chunk reindex;
- same/different/stale fingerprint transfer, grouped embeddings,
  all-or-nothing carry-over, mirror recovery, rollback, and origin conflicts;
- exact MCP tool exposure through the official SDK and the HTTP dispatcher;
- a stub hub with per-agent method and collection gating; and
- compiled package/bin layout.

## Live pgvector

Set an isolated PostgreSQL database containing the pgvector extension:

```sh
FRAG_TEST_DATABASE_URL=postgres://frag:frag@127.0.0.1:55432/frag npm test
```

The gated live suite verifies idempotent bootstrap, repeated paragraphs within
and across sources, metadata-only persistence, rollback after chunk deletion,
concurrent absent-source creation, similarity search, staleness, dry-run, and
same-dimension reindex against real SQL.

The suite creates uniquely named collections and deletes only those rows on
completion. It does not drop shared tables or the vector extension.

## Local LM Studio

With PostgreSQL configured and LM Studio serving the embedder from
`frag.example.yaml`:

```sh
export LOCAL_DATABASE_URL=postgres://localhost/frag
npm run build
node dist/cli/main.js put local-notes "standalone smoke note" --source-key smoke
node dist/cli/main.js search local-notes "smoke note"
node dist/cli/main.js reindex local-notes --dry-run
```

LM Studio tokenize-endpoint availability remains a v9 open question. The
example intentionally uses the conservative `estimate` tier.

## Azure

Azure model/deployment name, output dimension, token limit, and endpoint URL
must be confirmed against the actual deployment before enabling a collection.
This repository does not claim those environment-specific placeholders are
verified.
