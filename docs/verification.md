# Frag v10 verification matrix

This document maps the zero-config onboarding and retrieval contracts to
repeatable evidence. The normal suite is infrastructure-independent; live
checks activate only when their documented services are available.

## Always-run checks

```sh
npm run check
npm test
npm run build
node dist/cli/main.js --help
node dist/cli/main.js add --help
npm_config_cache=/tmp/frag-npm-cache npm pack --dry-run --json
```

The unit/in-memory suites cover:

- platform global-registry paths, permissions, v1-to-v2 migration, persistent
  system/resource/default APIs, secret boundaries, and mirror cycles;
- LM Studio embedding-only discovery, missing-service guidance, server/model
  reuse and startup, metadata reading, real-dimension probe validation, and
  ownership-safe cleanup;
- Docker/Podman selection, labelled managed-resource ownership, generated
  credential handling, readiness/schema/vector probes, existing PostgreSQL,
  stopped-state restoration, and incomplete-cleanup reporting;
- three-step searchable add flow, semantic script flags, atomic final registry
  commit, rollback cleanup, and interrupted-attempt recovery;
- explicit v10 YAML export/import, secret omission, whole-batch registry commit,
  and resource cleanup on batch failure;
- two-hash content/representation change detection independent of fingerprint,
  metadata-only updates, concurrency, duplicate chunks, dimension safety,
  search, gating, reindex, mirror/promote, MCP/HTTP, and hub integration.

## Live managed pgvector

The provisioning adapter can be checked without retaining test infrastructure:

```sh
npm run build
node --input-type=module -e '
  import { PostgresProvisioner } from "./dist/core/index.js";
  const provisioner = new PostgresProvisioner();
  let ready;
  try {
    ready = await provisioner.ensureManaged(3);
    console.log(ready.runtime);
  } finally {
    if (ready) await provisioner.releaseManaged(ready);
  }
'
```

This creates only `frag-postgres-v1` and `frag-postgres-data-v1`, both labelled
`dev.frag.managed=true`, binds PostgreSQL to an automatically assigned
`127.0.0.1` port, bootstraps pgvector, performs a similarity query, and removes
the resources afterward.

## Existing live pgvector suite

Set an isolated PostgreSQL database containing pgvector:

```sh
FRAG_TEST_DATABASE_URL=postgres://frag:frag@127.0.0.1:55432/frag npm test
```

The gated suite verifies idempotent bootstrap, repeated paragraphs,
metadata-only persistence, transactional rollback, concurrent absent-source
creation, similarity search, staleness, dry-run, and same-dimension reindex.

## Full local add round trip

With LM Studio/llmster available, at least one embedding model downloaded, and
Docker or Podman running:

```sh
frag add
frag put "standalone smoke note" --source-key smoke
frag search "smoke note"
frag reindex <system-name> --dry-run
```

The current host used during v10 development had `lms` installed, but its
service remained at `Waking up LM Studio service...` and returned no model JSON.
Frag correctly refused to invent a model registration. A complete real LM
Studio add/put/search check therefore remains environment-dependent.

## Azure

Azure model/deployment name, output dimension, token limit, and endpoint URL
must be confirmed against the deployment. v10 import provisioning currently
supports the primary LM Studio path; advanced provider provisioning remains a
future extension.
