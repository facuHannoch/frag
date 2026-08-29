Note: for the experiment we used the following two libraries:
- frag (this library)
- agents (agents orchestration library): used to spawn and instruct the ephemeral agents (`e-xxxx`), which also have access to frag via mcp

# Run: fleet-based ingest/retrieval smoke test

Date: 2026-08-29
Collection: `fleet-smoketest` (LM Studio `text-embedding-nomic-embed-text-v1.5`,
managed local PostgreSQL/pgvector, dim 768)

## Purpose

Frag's unit/integration suite (`docs/verification.md`) exercises the write
sequence, change detection, and storage invariants in isolation. It does not
exercise the scenario the spec calls out as the actual product target: an
external hub-style setup where independent agent processes share one global
registry, one process writes, and a different process reads back only through
`search`. This run tests exactly that, end to end, using two independent
agents from the local agent fleet (`.agents/agents.yaml`) talking to their own
`frag mcp` subprocess.

The knowledge base is entirely fictional (an invented town, "Windhollow," with
invented people, companies, and numbers) so that a correct answer can only
come from retrieval, never from the model's own pretrained knowledge.

## Setup

```sh
frag add --name fleet-smoketest \
  --description "smoke test collection for fleet ingest/retrieval verification" \
  --lmstudio-model text-embedding-nomic-embed-text-v1.5 \
  --database managed-postgres --yes
```

Reused the existing LM Studio embedder and managed Postgres instance already
registered on this machine; provisioning succeeded without any new
infrastructure.

## Procedure

1. **Ingest agent** (`task-0001`, ephemeral agent `e-0001`): given 20 short,
   fully fictional facts about Windhollow (town founding, population, mayor,
   a local company, a landmark, a festival, a school, a lake, a bridge, a
   mineral, a flood), each with an explicit `sourceKey`. Instructed to call
   `mcp__frag__ingest` once per fact, verbatim, against `fleet-smoketest`, and
   report which writes were `changed`/`reembedded`.
2. **Retrieval agent** (`task-0002`, ephemeral agent `e-0002`): given only 14
   quiz questions, no facts, and explicitly forbidden from using
   `mcp__frag__ingest` or general knowledge. Instructed to answer each
   question using only `mcp__frag__search` (k=3) against `fleet-smoketest`,
   record the `sourceKey`/score it relied on, and answer `NOT_FOUND` rather
   than guess when no chunk supported an answer. Two of the fourteen
   questions were deliberate traps with no supporting fact in the collection
   (a soccer team, a board president), to check for hallucination under
   retrieval failure.
3. Report written to `.agents/.artifacts/common/fleet-smoketest-answers.json`
   and graded against ground truth kept outside the fleet (not visible to
   either agent).

## Results

- **Ingestion: 20/20 facts landed.** Verified independently via
  `frag sources fleet-smoketest` (20 distinct `sourceKey`s, all `embeddingDim:
  768`, fingerprint matching the collection's configured embedder).
- **Retrieval: 12/14 questions answered correctly**, each citing the exact
  right `sourceKey`.
- **0/2 hallucinations on trap questions.** Both deliberately unanswerable
  questions were correctly reported as `NOT_FOUND` instead of a confabulated
  answer.
- **1 genuine miss**: "What is the mascot of Windhollow's high school?" The
  correct fact (`greywood-mascot`: "Greywood Academy's mascot is the Ember
  Fox.") is present, correctly embedded, and dimension/fingerprint-valid, but
  ranked **6th of 20** results (score 0.68) for that query — behind four
  generic Windhollow town-identity facts (population, mayor, founding,
  clocktower; scores 0.71–0.78) that share only the town name, not the topic.
  At `k=3` the correct fact never surfaced. Reproduced directly:

  ```sh
  frag search fleet-smoketest "What is the mascot of Windhollow's high school?" --k 20 --json
  ```

  This is not a data or ingestion defect — it is a retrieval-ranking property
  of small-corpus embedding similarity with single-sentence sources and no
  reranking (v10 explicitly has no hybrid/keyword search or reranking; see
  SPEC-v10.md "Non-goals"). It means default/small `k` can silently miss a
  correct, present fact when several unrelated sources in the same corpus
  share surface vocabulary with the query.

## Defects found and fixed during this run

- **`frag sources <collection>` crashed unconditionally on any non-empty
  collection** with `JSON.stringify cannot serialize BigInt`. Root cause:
  `Source.rowVersion` (`src/core/types.ts`) is a plain `bigint`, and
  `renderOutput` (`src/cli/output.ts`) called `JSON.stringify` with no BigInt
  handling. Every real collection has at least one source with a
  `rowVersion`, so this command never worked. Fixed with a BigInt-to-string
  JSON replacer in `renderOutput`. Verified against `test1` and
  `fleet-smoketest`; `bun test test/cli` still 7/7 passing.

## Architectural note (not a code change)

`frag serve` / `frag mcp` snapshot the control-plane registry once at process
startup: `createFragApplicationFromControlPlane` reads
`controlPlane.systems.list()` a single time and builds a fixed `endpoints`
map (`src/core/application.ts`). A system created afterward by a *different*
process (e.g. `frag add` run in another terminal) is invisible to an
already-running server or MCP connection until that process restarts. This
was observed directly: the frag MCP connection already open in the orchestrating
session at the start of this run could not see `fleet-smoketest` and returned
`Unknown collection`, even though `frag list` (a fresh process) saw it
immediately. Each fleet agent's own `frag mcp` subprocess is spawned fresh per
task, so this did not affect the ingest/retrieval agents themselves — but it
is worth deciding whether a long-lived hub process should pick up newly
created systems without a restart.

## Takeaway

The core ingest → embed → store → search round trip works correctly across
independent agent processes sharing one global registry, which is the
scenario the spec's "hub" concept targets. Storage, dimension, and identity
handling all held up. The one real gap is retrieval ranking quality — not
correctness — on narrow-topic questions inside a small, thematically uniform
corpus, consistent with v10's documented absence of reranking.


So: yes, usable as a RAG system today, with two caveats to keep in mind rather than blockers:

1. Ranking quality, not correctness, is the soft spot — the one miss (mascot question) was retrievable but got outranked by generically-similar text at low k. Practically this means: use a higher k than 3 for small/thematically-narrow collections, or expect to add reranking later since v10 doesn't have it.
2. Operational quirk: a long-running frag serve/mcp process won't see collections created by frag add from another process without a restart. Doesn't affect correctness, just something to know when running it as a persistent service.
