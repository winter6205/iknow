---
name: bounded-context-guardian
description: Use when slicing modules, restructuring folders across multiple files, detecting implementation-detail leaks between sibling modules, encountering circular import errors, noticing shotgun surgery in code review, or adding a new bounded context without updating docs/context-map.md. Enforces business-capability slicing and forbids technical-layer directories.
bucket: engineering
---

# Bounded Context Guardian

## When to use

- New business capability spans multiple existing modules
- Folder restructure that could re-cut module boundaries
- File in module A imports implementation detail from module B
- Build fails with circular / cycle import after a refactor
- New bounded context added but `docs/context-map.md` not updated
- Code review reveals "shotgun surgery": one change touches N modules

Preface (supplements When to use): Modules are sliced by business capability that may change independently, not by technical layer. A new module owns its data, its rules, and its outbound ports. Slicing by `controllers/services/repositories/models` couples every feature change to every layer.

## When NOT to use

- Single-file typo fix
- Adding files within an existing bounded context
- Pure documentation or comment changes
- Cosmetic rename inside a single file

## Dispatch

本环节由 `arthurpower:bounded-context-guardian-agent` 承接。识别到模块切分 / 目录重构 / 跨模块实现细节泄漏 / 循环 import / 新增 bounded context 未更新 context-map 等验证时机时，用 Agent 工具以 `subagent_type: "arthurpower:bounded-context-guardian-agent"` 派发，而非在主线程自跑。派发时传：diff 范围 + 本 skill 判据 + 证据格式（file:line + PASS/FAIL）。软触发：应当派，非必须派；偶发主线程自跑属可接受降级，不视为违规。

## Procedure

1. List the modules / folders affected. Draw a 1-line dependency map on paper.
2. If any new folder is `controllers/`, `services/`, `repositories/`, `models/`, `utils/`, `helpers/` — STOP, split by business capability instead.
3. If file A imports internal class from file B across the new boundary — make B expose a published interface (or extract shared kernel if both need it).
4. If circular import surfaces — find the offending edge, push the shared type to a third module that both depend on.
5. If new bounded context — write its row into `docs/context-map.md` (purpose, owns, depends_on, integration_pattern).
6. Verify with `dep-cruiser` or equivalent: 0 reverse-deps, 0 cycles, no `controllers/services/repositories/models` at top level.

## Context-Loop Wiring

When this skill adds a new bounded context:

1. **Read `docs/CONTEXT.md` (or `docs/CONTEXT-MAP.md`) first** — verify the new context's domain terms are aligned. If ambiguous, halt and route to `domain-modeling` (write authority) to resolve the term before slicing.
2. **Treat `context-map.md` as context-loop storage**, equivalent to `docs/CONTEXT-MAP.md`. Update it via the same protocol — write authority is `domain-modeling`. If you find yourself directly editing it, STOP and route through `domain-modeling`.
3. **Check `docs/adr/` for boundary-relevant decisions** before recommending a slice. If the proposed slice contradicts an existing ADR, annotate: `> Contradicts ADR-NNNN — but worth reopening because <证据>`. Do not silently override.
4. **Schema guardrail**: physical hook `pre-context-write-guard.cjs` will reject malformed writes to `docs/context-map.md` (treated as `CONTEXT-MAP.md`). Schema requirements: `# ...` header + `## Language` section + ≥ 1 term row.

## Rationalization Table

| Excuse                                                               | Reality                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "Project already uses controllers/ services/, follow the convention" | Convention is wrong. New module under it perpetuates 1 feature = 4 directory writes forever. |
| "It's just one folder, we'll fix it later"                           | Later never arrives. 4 features later = 12 cross-cut dirs, shotgun surgery is structural.    |
| "context-map.md is overkill for one row"                             | One row now = 2 minutes. 10 rows later + cross-team = 2 days of archaeology.                 |
| "Module A needs internal class from B, just import it"               | Reverse dependency. Any B internal refactor breaks A. Extract port A owns.                   |
| "Cycle import? Just `from __future__ import` / lazy import"          | Lazy import hides the smell. Fix the boundary, not the loader.                               |
| "End of day, follow the existing pattern this once"                  | One feature ships; the next 3 features follow the wrong pattern by your example.             |

## Red Flags - Stop and Start Over

- New folder named `controllers/`, `services/`, `repositories/`, `models/`, `utils/`, `helpers/`, `common/`, `shared/`
- File under `src/<feature>/` reaches into `../<other>/internal/...`
- `docs/context-map.md` not updated after adding a new bounded context
- `git diff` shows 1 feature touching 3+ directories at top level
- PR description has no module boundary reasoning

## Acceptance Criteria

- [ ] Top-level dirs are business capabilities, not technical layers (binary: no `controllers/services/repositories/models` at top level)
- [ ] No module A imports internal class from module B across the new boundary
- [ ] `dep-cruiser no-circular` returns 0 cycles
- [ ] `docs/context-map.md` updated if a new context was added
- [ ] No new file in `utils/`, `helpers/`, `common/`, `shared/` (extract to owning context)

## Required Baseline

**Zero tolerance**: top-level `controllers/`, `services/`, `repositories/`, `models/` is forbidden. New code follows business-capability slicing, full stop.

## Verification

- `ls <project>/` — show top-level dirs to reviewer (must not contain `controllers/services/repositories/models`)
- Run dependency linter; capture output as proof
- `git diff --stat` — confirm diff scope is the planned modules only
- `grep -rE "from.*utils/|from.*helpers/|from.*common/" src/` returns only legitimate shared-kernel imports

Extended walkthroughs (anti-pattern vs capability-slicing, Parnas 1972 hidden decisions, migration template) live in `references/bounded-context-examples.md`. The main body keeps procedure + criteria + verification only.

## Context-Loop Integration

This skill is a **read-side consumer** in the Arthurpower context closed-loop. When updating `docs/context-map.md`:

| Action | Authority                                                | Guardrail                                      |
| ------ | -------------------------------------------------------- | ---------------------------------------------- |
| Write  | `domain-modeling` (sole write authority)                 | `pre-context-write-guard.cjs` validates schema |
| Read   | this skill (per §1 of `~/.claude/rules/context-loop.md`) | `docs/agents/context-contract.md`              |

Direct Edit to `context-map.md` is a router violation — route through `domain-modeling`.
