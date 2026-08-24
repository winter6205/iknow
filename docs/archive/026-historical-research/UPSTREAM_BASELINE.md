# Upstream Baseline

Immutable **reference only** for source ideas from [garrytan/gbrain](https://github.com/garrytan/gbrain).  
iknow is a **rewrite-level** product at the **iknow repository root** (package / product name: **iknow**), not a nested hardfork workspace named `gbrain/`.

## Local layout

| Path                | Role                                                                               | Policy                                          |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `_upstream_gbrain/` | Read-only upstream snapshot                                                        | gitignored; **never modify**; never push        |
| **iknow repo root** | Product rewrite host (`package.json` name → `iknow`, source under root/`src` etc.) | **All implementation edits go here**            |
| `specs/`            | Foundation spec + plans                                                            | tracked                                         |
| `gbrain/`           | Obsolete nested clone (if present)                                                 | gitignored; do not edit; delete when convenient |

**Git policy (project `CLAUDE.md`):**

- **No push** unless the user explicitly authorizes it.
- No force push / tag / release / deploy without explicit authorization.
- Small commits: 1 commit = 1 logical intent; do not skip pre-commit.

---

## 1. Project Information

| Item                         | Value                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Upstream repository          | `https://github.com/garrytan/gbrain`                                                                                  |
| License                      | MIT (Copyright (c) 2026 Garry Tan)                                                                                    |
| Baseline branch              | `master`                                                                                                              |
| Baseline commit              | `058f448b9a4ba3d522e2c2a7a4615bccdd00ae76`                                                                            |
| Baseline version (`VERSION`) | `0.42.57.0`                                                                                                           |
| Baseline date                | `2026-07-06` (author date, -0700)                                                                                     |
| Baseline tip message         | `v0.42.57.0 fix(pglite): incident — never steal a live data-dir lock + corrupted-store recovery hint (#2348) (#2400)` |
| Local reference clone        | `_upstream_gbrain/` (gitignored, shallow `--depth 1`)                                                                 |
| Implementation host          | **iknow repository root** (rewrite; product name **iknow**)                                                           |
| Clone size                   | 2622 files (excluding `.git`)                                                                                         |
| Upstream stack (reference)   | Bun + TypeScript; entry `src/cli.ts` / `src/core/index.ts`                                                            |
| Design mapping pin           | capability mapping written against **v0.42.26.0** — re-validate symbols on **0.42.57.0** before coding                |
| Relationship to upstream     | **Rewrite / capability port**, not “edit gbrain in place”                                                             |

---

## 2. Consistency Verification

| Check                                | Command                                      | Expected                                   |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| Pin SHA                              | `git -C _upstream_gbrain rev-parse HEAD`     | `058f448b9a4ba3d522e2c2a7a4615bccdd00ae76` |
| VERSION                              | `cat _upstream_gbrain/VERSION`               | `0.42.57.0`                                |
| Key paths exist                      | §6 path checks                               | all present                                |
| Baseline unmodified                  | no edits under `_upstream_gbrain/`           | always                                     |
| Implementation not under gbrain name | product package / dirs are **iknow** at root | yes                                        |

---

## 3. Rewrite model (not nested hardfork)

**iknow** reimplements an agent-harness runtime using gbrain as a **capability and algorithm reference** (loop engine, tool use, sandboxed execution, etc.).

Design truth chain (do not invert):

```text
specs/                                    # Foundation per-module specs
  → src/harness/                         # implementation
  → docs/architecture.md                 # capability modules
```

Open gates before silent product decisions: approval flow, auth model, async interaction → **ADR draft first**.

---

## 4. Upstream change acceptance (for reading new tips)

When refreshing `_upstream_gbrain` only to **study** new upstream commits:

| Upstream path                                             | Decision           | Reason                        |
| --------------------------------------------------------- | ------------------ | ----------------------------- |
| `src/core/search/`, `operations.ts`, `vector-index.ts`    | Review for ideas   | capability patterns           |
| `src/core/facts/`, `eval-contradictions/`, `schema-pack/` | Review for ideas   | capability patterns           |
| `src/mcp/`, `src/commands/`                               | Review selectively | agent surface patterns        |
| `admin/`                                                  | Ignore for MVP     | out of scope unless requested |
| Upstream `docs/`                                          | Reference only     | never merge into product docs |

iknow does **not** auto-merge upstream trees into the product root.

---

## 5. Refresh reference clone only

```bash
cd _upstream_gbrain
git fetch --tags origin
git pull --ff-only origin master
git rev-parse HEAD   # update §1 if pin changes
cat VERSION
```

Do **not** copy refreshed trees over iknow product code. Port ideas deliberately via design + tests.

---

## 6. Appendix: verification commands

```bash
git -C _upstream_gbrain rev-parse HEAD
cat _upstream_gbrain/VERSION

# mapping anchors (read-only reference)
test -f _upstream_gbrain/src/core/operations.ts
test -f _upstream_gbrain/src/core/search/hybrid.ts
test -f _upstream_gbrain/src/core/vector-index.ts
test -f _upstream_gbrain/src/core/eval-contradictions/judge.ts
test -f _upstream_gbrain/src/core/facts/backstop.ts
test -f _upstream_gbrain/src/core/schema-pack/detect.ts

git check-ignore -v _upstream_gbrain
```

### Upstream `src/` anchors (0.42.57.0)

```
_upstream_gbrain/src/
  cli.ts  commands/  core/  mcp/  eval/  schema.sql
  core/operations.ts
  core/search/hybrid.ts
  core/vector-index.ts
  core/facts/backstop.ts
  core/eval-contradictions/judge.ts
  core/schema-pack/detect.ts
```

---

## 7. Hard rules

1. **Never modify** `_upstream_gbrain/`.
2. **All product code** is written at **iknow root** under the **iknow** name (rewrite).
3. **Never push** without explicit user authorization (`CLAUDE.md` NEVER #1).
4. Design truth stays under `specs/` + `docs/architecture.md`; do not edit the reference clone.
5. Follow global Grok rules (`~/.grok/AGENTS.md` / `~/.grok/rules/`) - no secret leaks, no gate bypass, evidence before "done".
