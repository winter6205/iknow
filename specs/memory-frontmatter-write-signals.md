# Spec: memory frontmatter write-side signals (#1137)

## Objective

Close the two accepted residuals of ADR-0123 that leave memory store degradations invisible to the operator (issue #1137): (1) a non-scalar unknown extra field is silently dropped by the pure serializer, so a `memory_save` / GC / ingest write-back can replace a file that keeps every canonical field but loses an extra; (2) a file the reader cannot parse is quarantined into `skipped` — its bytes stay intact, but no caller surfaces the fact, so the only way to discover the omission is to inspect the disk. The change is a signal upgrade, not a format change: on-disk shapes for healthy files stay byte-identical.

## Assumptions (confirmed by operator in session)

1. **Posture A (reject, not preserve).** `serializeMemoryEntry` throws a typed error on a non-scalar unknown extra instead of silently omitting it; the write path warns and refuses to replace the file. The alternative (teach the serializer to emit non-scalar YAML) was rejected as an ADR-scale contract change. The pure-serializer contract (no IO, no clock) is kept; pure does not preclude throwing.
2. **One PR, two commits.** Part A (serialize rejects + write-path warn) and Part B (structured `skipped` + caller warnings) land in one PR, one commit each. Commit grain follows the module convention, not one commit per bullet.
3. **No new ADR.** Part A is authorized by issue #1137's acceptance criterion ("surface a clear validation result before replacing the file"). Both ADR-0123 accepted-residual bullets are annotated as resolved by #1137 in the PR; no new ADR file.
4. **Warn channel.** A module-level `console.warn` seam, same as the existing `[memory/frontmatter]` (src/harness/memory/frontmatter.ts) and `[memory/prefetch]` (src/harness/memory/prefetch.ts) precedents. The host `onError` observer is NOT extended in this change.
5. **Warning content.** Warnings name the slug / key / error category only — never memory content (title, body, or extra values). Same posture as the existing warn seams.
6. **Known behavioral shift (accepted).** A flow-sequence extra such as `tags: [a, b]` currently round-trips through parse as a JS array and is then silently dropped on the next write-back. After this change that write-back refuses and warns instead of succeeding with loss. This converts a silent-corruption path into a loud refusal; it is reachable in the real corpus only if a future file introduces a non-scalar extra, and scalar extras (the only shape in the measured 19-file corpus) are unaffected. Verification correction (2026-09-26, real MCP-interaction transcript S3): under the landed coerce boundary an array read from disk never survives parsing (`YAMLSeq` values arrive comma-joined), and the `memory_save` surface rejects unknown keys at schema + `ALLOWED_KEYS` before the writer — so the refusal is reachable only from in-process callers of `writeMemoryEntryAtomic`; it is defense-in-depth, not an operator-visible production signal today.
7. **No old/new compat for the changed shapes.** The operator's direction: converge on the new design, do not carry legacy-shape compatibility. Concretely: `MemoryStoreScan.skipped` / `MemoryGcResult.skipped` switch to the structured record outright — no dual-shape export, no string-form backfill, no deprecation window. Consumers inside the module are updated in the same commit. (This applies to the shape change in this spec; it is NOT a mandate to break on-disk file formats — the 19-file corpus byte contract in SC-Corpus stays.)
8. **Test style.** Real temporary directories per the session/trace evidence rule; existing round-trip and GC quarantine tests keep their assertion strength and are extended, not weakened.

## Boundaries

**Does**

- Part A: `serializeMemoryEntry` fails closed (typed throw) on a non-scalar unknown extra; `writeMemoryEntryAtomic` warns (`[memory/save]`) and refuses to write when serialization is refused; GC soft-disable and ingest write-backs inherit the refusal through the shared writer.
- Part B: `MemoryStoreScan.skipped` becomes a structured record (`slug` + machine-usable `reason`); `store.ts` classifies the skip reason (unreadable frontmatter vs other read/parse failure) without carrying file content; every scan consumer (gc, assembly, dream, ingest, prefetch) warns when it drops skipped entries, via the same console seam.
- Annotate both accepted-residual bullets in ADR-0123 as resolved by #1137.
- Tests for both parts against real temp files, asserting stored bytes and observable warnings.

**Confirms with human**

- none beyond the assumptions above.

**Out of this spec**

- Serializing non-scalar extras (YAML block/list emission) — ADR-scale contract change, rejected.
- Migrating the two blank-`id` files (+2 bytes on next save) — documented migration behavior, outside #1137.
- Backfilling a `turn outcome` for legacy sessions (ADR-0126 territory), migrating pre-ADR-0099 legacy memory directories (no migration code exists today; real orphaned data noted in the survey), adding a version field to `usage.json`, and surfacing skill/user-catalog degradation warnings in the TUI — all recorded in the #1137 gap register (see below) as separate concerns.
- Any change to the shared parser (`src/harness/frontmatter/`), the coerce boundary, `computeSignature`, or the skill / user-catalog consumers.

## Success Criteria

- **SC-A1** `serializeMemoryEntry` on an entry whose unknown extras are all scalar produces output byte-identical to today (existing round-trip assertions in tests/harness/memory/frontmatter.test.ts keep passing unmodified); on an entry carrying a non-scalar extra it throws a typed `MemorySchemaInvalid` naming the key (not the value). `npx vitest run tests/harness/memory/frontmatter.test.ts` exit 0.
- **SC-A2** In a real temporary directory, calling `writeMemoryEntryAtomic` with a non-scalar-extra entry does not create the target file (or leaves a pre-existing file byte-identical), emits one `[memory/save]` warning naming slug and key, and surfaces the refusal to its caller. `npx vitest run tests/harness/memory/tools-save.test.ts` exit 0.
- **SC-B1** In a real temporary directory containing one YAML-invalid `<slug>.md` and one healthy file, `listStoreEntries` returns the structured skipped record with a machine-usable reason and no file content; the malformed file's bytes are identical before and after the scan. `npm test` exit 0.
- **SC-B2** `runMemoryGc` over a store containing a malformed entry leaves that file byte-identical, reports it in the structured `skipped`, and emits one warning naming the slug; existing GC tests (`tests/harness/memory/gc.test.ts`) are updated to the structured shape without weakening their byte-preservation assertions. `npx vitest run tests/harness/memory/gc.test.ts` exit 0.
- **SC-B3** Each scan consumer (assembly, dream, ingest, prefetch) emits a warning when `scan.skipped` is non-empty; warnings carry slug/reason, never content. Covered by `npm test` exit 0.
- **SC-Corpus (regression evidence)** The 19-file corpus re-measurement (read → parse → serialize → byte-compare, per docs/evidence/frontmatter-serialize-migration.md §9) still reports 17/19 byte-identical and 2/19 `+2 B` at byte offset 8 — identical to the recorded pre-change measurement. Recorded as a note in the PR body.

## Open Questions

- none.

## Gap register (discovered during the #1137 survey; NOT this spec's scope)

Recorded so the residuals do not get lost; each item needs its own ticket before work:

1. **Legacy memory store orphaned.** Pre-ADR-0099 layout `<workspaceRoot>/.iknow/memory/<slug>` is never read by the project store; real orphaned data exists (e.g. this repo's own checkout). `resolveUserMemoryDir` (src/harness/memory/paths.ts) is exported but has no production caller. Needs a migrate-or-read-both decision.
2. **`usage.json` sidecar is v0 with no version field** (src/harness/memory/promote.ts) — any future shape change has no compat hook.
3. **Skill / user-catalog degradation warnings are stderr-only.** The strict shared parser rejects or degrades blocks with warnings that never reach the TUI (build-engine.ts and the subagent spawners pass no `warn`; defaults go to console/stderr). Memory quarantine warnings (this spec) land in the same channel, so the operator sees them only in terminal scrollback.
4. **`SKILL_LOAD_PREFIX` is string-duplicated** across src/harness/skill/body.ts and web/src/hooks/use-slash-commands.ts with convention-only sync.
5. **`[memory/frontmatter]` warn quotes source content.** The shared-parser quarantine warn passes the raw YAML error through, which embeds the offending line (verified live: `... column 17: id: <slug> ^`). The two #1137 seams carry slug/category only; any TUI surfacing of gap 3 must re-shape this warn first.

## Inherits / Changes

**Inherits (quoted from this workspace):**

- "frontmatter coercion boundary: At the shared parser's output, string/number/boolean/null values become strings, scalar arrays are joined with commas, and mappings are skipped with a warning. A nested key must never silently overwrite a top-level key. Consumers (skill index, subagent catalog, and memory reader) receive only scalar values. ADR-0123." — docs/CONTEXT.md
- "frontmatter fence strip contract: The shared module removes a leading `---` fence independently of its contents, never throws, and returns a byte-identical body slice... ADR-0123." — docs/CONTEXT.md
- ADR-0123 Amendment: the memory writer emits `yaml.stringify` with `lineWidth: -1`; pinned shape = `KNOWN_FRONT_KEYS` first, sorted extras afterward, `body` outside frontmatter, comma-flat `supersedes`; measured cost 17/19 byte-identical, 2/19 +2 B (blank `id` → `id: ""`), zero field loss, `computeSignature` stable 19/19.
- ADR-0123 accepted residual (this spec resolves it): "The pure `serializeMemoryEntry` writer silently drops a non-scalar unknown extra field through its `isScalar` filter... In the 19-file real corpus, every unknown extra is scalar."
- ADR-0123 accepted residual (this spec resolves it): "The store has no warning outlet for this case... discovering such a file currently requires inspecting it on disk."
- Spec `specs/frontmatter-shared-parser.md` SC1/SC4: the pure-serialize + round-trip byte contract and the quarantine-throw contract are inherited verbatim; this spec adds the write-side refusal and the skip-diagnostic layer on top of them.
- "source: auto: ...落在 frontmatter（sanitizeMemoryFile / serializeMemoryEntry 已 round-trip 未知字段，无需 schema 升版）" — docs/CONTEXT.md: unknown extras are forward-compat metadata and must survive a write-back; this spec makes that survival loud instead of silent.

**Changes (what this contract adds):**

- `serializeMemoryEntry`: silent omission of non-scalar extras → typed throw naming the key.
- `writeMemoryEntryAtomic`: warn + refuse on serialization refusal (no file replaced).
- `MemoryStoreScan.skipped`: `ReadonlyArray<string>` → `ReadonlyArray<{ slug: string; reason: string }>`; `MemoryGcResult.skipped` follows. Direct cutover, no legacy-shape compat (operator direction, assumption 7). Exported types stay module-internal (verified: no consumer outside src/harness/memory).
- Scan consumers gain one warn call each when skipped is non-empty.
- ADR-0123: both accepted-residual bullets annotated resolved by #1137.
- New gap register (this file) for the four out-of-scope survey findings.

**待写入**: none — no new domain terms (existing terms reused: quarantine, skipped, frontmatter coercion boundary) and no one-way-door ADR.

## ACR verdict

architecture-change-reviewer: yes — one bounded context (harness/memory), blast radius verified module-internal; exported store types have zero consumers outside src/harness/memory.
input-contract-tests: yes — new failure inputs covered by SC-A1/SC-A2/SC-B1 (non-scalar extra, unreadable file, pre-existing file preservation).
error-handling-enforcer: yes — silent drop replaced by typed throw + warn; no empty catch; no content in error/warning text; reason strings are categories, not values.
complexity-anti-drift: yes — no function grows past thresholds; warn additions are single calls at existing seams.
minimal-change-verifier: yes — no new dependency, no shared-parser change, no skill/user-catalog touch; scope matches #1137 acceptance criteria exactly.
