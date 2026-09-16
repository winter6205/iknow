# Plan: TUI skill slash → harness SkillCatalog

**Goal:** TUI `/skill` resolution matches `SkillCatalog.get` (canonical + unique bare), so plugin skills used in the operator leader prompt load without typing the namespace every time.
**Approach:** One matching path through catalog; keep static vocabulary and Tab tri-state; no agents in slash; no plugin commands in this plan.
**Spec link:** `specs/tui-skill-slash-catalog.md`
**ACR:** Plan3 was blocked only on missing input-contract allocation — matrix now in spec; re-stated yes below
**待写入:** (empty — `skill bare alias` 已入 `docs/CONTEXT.md`)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## ACR

bounded-context-guardian: yes — tui/slash delegates to harness catalog; no second namespace parser.
input-contract-tests: yes — bare/canonical/empty/unknown/static-priority matrix in spec.
error-handling-enforcer: yes — miss stays undefined; static wins; app load still `skillCatalog.get`.
complexity-anti-drift: yes — one get path; remainder uses typed token length.
minimal-change-verifier: yes — TUI skill slash only; CLI and commands/ deferred.

## Tasks (ordered by dependency)

1. **RED: slash tests for bare alias + static priority** — tag: `[implementation]`
   - **Inherits:** spec invariants 1–5; SC1–SC2; input-contract table
   - **Surface:** tests/tui (slash)
   - **Acceptance:** failing tests exist for unique bare load, canonical load, unknown bare, static `/help` winning over skill bare, remainder after bare token
   - Status: [x] done (RED `8003992d`)

2. **GREEN: parseSkillLoad / suggestions / complete use catalog get semantics** — tag: `[implementation]`
   - **Inherits:** T1; spec SC1–SC4
   - **Surface:** tui slash (+ app only if wiring must pass catalog into match helpers)
   - **Acceptance:** T1 tests green; Tab still unique / LCP / null tri-state; help lists canonical skill names; no agent slash candidates; no `split(':')` skill matcher reintroduced
   - Status: [x] done (GREEN `27904577`；review 修复见本轮 commit)
   - [blocks: T1]

## Code review phase

End of round: `code-review` → if `GATE: BLOCKED` then `review-report-repair` → `verification-before-completion`.

## Note for measured workflow

This plan unblocks `/using-agent-skills`, `/code-review`, `/review-report-repair`, `/logicsync`, `/improve-codebase-architecture`, `/codebase-design` bare or canonical loads in TUI after skills exist under `.iknow/skills/` or plugins.
