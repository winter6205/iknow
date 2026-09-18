# Spec: TUI skill slash → harness SkillCatalog

**Status:** ready for plan  
**Surface:** `src/tui/slash.ts`, `tests/tui/slash.test.ts`, `src/tui/app.tsx` load path (already `skillCatalog.get`)

## Goal

Typing `/<skill>` in TUI resolves the same way harness catalog does: canonical name or unique bare alias. Host static commands stay first-class TUI vocabulary. Agents never appear as slash entries.

## Settled invariants

1. Skill match for suggestions / complete / `parseSkillLoad` must resolve through **`SkillCatalog.get`** (or the same index semantics: canonical Map then bareIndex). **Do not** reimplement `split(':')` matching in `slash.ts`.
2. Listing / help / Tab display prefer **canonical** names (`plugin:skill`).
3. Bare exact match resolves only when the bare alias is unique (catalog already drops colliding bare aliases).
4. Static vocabulary (`/continue`, `/help`, …) **wins** over skill names on exact collision.
5. Remainder after the skill token uses **typed token length**, not `skill.name.length` alone when bare matched.
6. Agents are **not** slash-loadable. Plugin `commands/` is **out of this spec**.
7. CLI slash 与 TUI/Web **同一入口** 的收口见 `specs/skill-index-increment.md`（本文件仍锁 catalog.get / remainder / 静态优先 / agents 不进 slash）。

## Out of scope

- Plugin `commands/` discovery + `$ARGUMENTS`
- Changing static Tab tri-state semantics beyond including catalog-backed skill candidates
- 会话中途模型索引增量、可加载面无 description、CLI/Web 统一入口（`specs/skill-index-increment.md`）

## Input-contract classes

| Surface           | empty                                | invalid/negative                                                                | overflow      | concurrent | exception |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------- | ------------- | ---------- | --------- |
| `parseSkillLoad`  | `/` or empty → undefined / not skill | unknown bare → undefined; unknown becomes message/unknown command path          | N/A           | N/A        | N/A       |
| bare vs canonical | N/A                                  | bare of unique plugin skill → loads; colliding bare already absent from catalog | N/A           | N/A        | N/A       |
| static priority   | N/A                                  | skill whose bare equals `help` etc. → static command wins                       | N/A           | N/A        | N/A       |
| `slashComplete`   | no match → null                      | unique skill → completed with trailing space                                    | ≥2 → LCP only | N/A        | N/A       |

## Success criteria

- SC1: `/using-agent-skills` loads the same entry as `/arthurpower:using-agent-skills` when bare alias exists.
- SC2: `/help` still opens host help, not a skill.
- SC3: Tab suggestions show canonical skill names; bare typing still filters.
- SC4: Existing static command tests remain green.
