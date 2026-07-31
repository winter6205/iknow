# 023 - Archived: legacy `src/kb-*` 4-tool suite retired (CLI runs on harness)

> Archived 2026-07-31. The 4 enterprise-KB business tools (`kb_retrieve` /
> `kb_verify_citation` / `kb_compile` / `kb_governance`) and their thin
> facade `src/tools/registry.ts` lost all live consumers once the CLI
> product path cutover to `src/harness/` (020, closed) and Session API
> followed (022). They were kept runnable (registry assembled, tests green)
> but unreferenced by `buildHarnessEngine`, which wires `createEchoTool` +
> `createGetTimeTool` only. This archive retires the dead suite.

## What's here

### `src/kb-*` + `src/tools/registry.ts` (archived in full)

- `src/kb-retrieve/` - `kbRetrieve` + dual-index fusion (`rrf.ts` /
  `keyword.ts`) + optional embedding vector arm (`embedding/`: fake /
  openai-compatible client, vector index, math). **Replaced by**: harness
  ACI decor layer `fs_search` (read-only, 50-cap, sandboxed) for live
  file discovery; retrieval over a knowledge store is not on the current
  test-stage path.
- `src/kb-verify/verify.ts` - `kbVerifyCitation` (3-state verdict on a
  source span). **Replaced by**: no direct ACI equivalent; citation
  verification is out of scope for the test-stage harness.
- `src/kb-compile/compile.ts` - `kbCompile` (fact extraction + dedupe via
  `content_hash`). **Replaced by**: harness ACI `fs_edit` (Linter
  poka-yoke, exact-1-match replace) for live file mutation.
- `src/kb-governance/governance.ts` - `kbGovernance` (freshness / conflict
  / snapshot). **Replaced by**: no direct ACI equivalent; governance is
  out of scope for the test-stage harness.
- `src/tools/registry.ts` - `createToolRegistry`, the vanilla facade that
  bound the 4 tools to a store + session. **Replaced by**: harness
  `createRegistry` + ACI `createAciRegistry` / `createAciExecutor` decor.

## Why archived (not deleted)

The 4-tool suite was the **product business layer** (what the agent does:
retrieve / verify / compile / govern an enterprise KB). After 020 + 022
moved both CLI and Session API onto `src/harness/` (the agent runtime
foundation), the harness product path stopped consuming these tools - it
runs the loop with `echo` + `get_time` demo tools, not `kb_*`. The suite
was alive only as exported symbols (`src/index.ts`) and 4 test files, with
zero production callers. Archiving (not deleting) preserves the audit
trail and a resurrection path; the live agent execution surface is now the
harness ACI decor layer (`src/harness/aci/`).

## Cross-cutting context

- **CLI product path**: `src/cli/runtime.ts::buildHarnessEngine` is the
  sole build entry for `ask` / `chat`. It does not reference `kb_*`;
  `prepareRuntime` now returns `{ store, env, session }` (the
  `vectorIndex` field was dropped in this same commit).
- **`src/runtime/create-runtime.ts`**: simplified to `store + env`; the
  embedding / vector-index path was removed with the `kb_retrieve`
  embedding arm.
- **`src/shared/schema.ts`**: the `Kb*Input` / `Kb*Output` / `Chunk` /
  `PriorChunk` / `SourceSpan` / `CompiledFact` / `SnapshotPayload` types
  were removed. **Retained**: `CallerRole` / `SessionContext` /
  `isCallerRole` / `parseCallerRole` / `CALLER_ROLES` (CLI slash command
  + `/status` banner still consume `caller_role`).
- **Orphaned (retained, marked for follow-up)**:
  `SessionContext.simulate_governance_timeout`, the `--governance-timeout`
  CLI flag, and `prepareRuntime`'s `degrade` param have **zero production
  consumers** after this archive (their only readers were `kb_retrieve`
  and `kb_governance`). They are kept for surface compatibility; a
  dedicated cleanup commit should remove them. Tracked in the 023 handoff.
- **`src/fixtures/seed-kb.ts` + `src/knowledge-store/`**: retained - they
  do not import `kb_*`; `createSeededStore` still feeds the runtime.
- **`graphrag-memory/`**: independent backend MCP server with its own
  registry and `EmbeddingClient`; not affected by this archive.

## Out of scope (tracked separately)

- Wiring the harness ACI decor layer (`fs_search` / `fs_view` / `fs_edit`
  / `shell_exec` / `context_manager`) into `buildHarnessEngine` for the
  test stage - see the ACI prototype PR (#95) and task #14.
- Removing the orphaned `simulate_governance_timeout` / `--governance-timeout`
  / `degrade` surface (follow-up cleanup).
- Updating `docs/iknow-spec/` protocol pages (`tool-schema.md`,
  `architecture.md`, ADR-v0.1) - those are protocol truth-of-record and
  are not mutated by a code archive; they are noted in the handoff.

## Pointer for future readers

If you need to resurrect the enterprise-KB 4-tool suite (e.g. to
re-introduce retrieval / verification on top of the harness runtime), the
source is here in `docs/archive/023-retire-kb-tools/src/`. The live agent
execution surface is now `src/harness/aci/` (ACI decor layer over the
frozen 4-type tool protocol in `src/harness/tools/types.ts`).
