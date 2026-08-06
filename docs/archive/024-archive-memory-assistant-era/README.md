# 024 — Archive: memory-assistant era (kb tools + iknow-spec protocol)

> **Status: ARCHIVED.** This tree documents the retired _enterprise knowledge-base
> assistant_ (记忆助手) era. Nothing under this directory is imported, linked,
> loaded, or read by the current runtime — it is kept as git-tracked historical
> reference only.

## Why

iknow started as a standalone enterprise KB Q&A agent built around a 4-tool
protocol (`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`)
with its own protocol/design-truth docs (`docs/iknow-spec/`). After the CLI /
serve paths moved onto the harness foundation (020), the harness replaced the
kb-tool suite with an ACI tool set (023 retired the runtime pieces of
`kb_*`). The remaining knowledge-assistant **runtime** files and the whole
`docs/iknow-spec/` protocol asset tree are consolidated here so the live repo
no longer exposes any "memory assistant" surface.

Prior archive that this one builds on / complements:

- `docs/archive/023-retire-kb-tools/` — retired `kb_*` tool implementations
- `docs/archive/022-retire-agent-loop/`, `docs/archive/022-retire-interaction/`
- `docs/archive/021-retire-legacy-loop-and-eval/`

## What moved here

| Moved from (old live path)            | New path under this dir | Role                                                                                       |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `src/knowledge-store/memory-store.ts` | `src/knowledge-store/`  | `InMemoryKnowledgeStore` (in-process KB)                                                   |
| `src/knowledge-store/types.ts`        | `src/knowledge-store/`  | `DocumentRecord` / `ChunkRecord` / `FactRecord`                                            |
| `src/fixtures/seed-kb.ts`             | `src/fixtures/`         | Seed enterprise KB corpus (`seedEnterpriseKb` / `createSeededStore` / `seedDemoKnowledge`) |
| `src/runtime/create-runtime.ts`       | `src/runtime/`          | `createIknowRuntime` — wired seeded store + env                                            |
| `docs/iknow-spec/` (whole tree)       | `iknow-spec/`           | 4-tool protocol + eval + handoff design truth                                              |

## Current state of the live repo

- `src/index.ts` no longer exports any KB store / seed / runtime symbols.
- `src/cli/runtime.ts` `RuntimeBundle` has no `store` field — it carries
  `{ env, session }` only.
- Tool surface is the harness ACI 8-tool set (`bash` / `read_file` / `grep` /
  `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`), assembled in
  `src/harness/build-engine.ts` (SSOT).

## Restoring

To bring a knowledge store back (not currently planned), the pieces live in
`src/knowledge-store/` + `src/fixtures/` + `src/runtime/` here; the protocol
contracts live under `iknow-spec/docs/protocol/`. Re-wiring them into the
harness tool set is a new feature, not an unarchive.
