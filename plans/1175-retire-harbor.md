# Plan: retire the optional Harbor adapter (issue #1175)

## Basis and evidence

Base: `origin/master` = `da2128efc`, in the isolated worktree
`/home/winner/projects/iknow-wt-1175` (branch `chore/1175-retire-harbor`).
The dirty main checkout and its two unpushed #1173 evidence commits
(`c86944b27`, `41775fb12`) are untouched and preserved.

Four read-only explore passes, over disjoint scopes, established the facts this
plan rests on:

1. **Inventory** — `git ls-files scripts/harbor` = 10 tracked files, 6424 lines:
   `README.md` (635), `build-bundle.sh` (62), `pyproject.toml` (21),
   `iknow_harbor/{__init__,agent,ask_output,attribution}.py` (9 / 1238 / 219 / 1024),
   `tests/{test_benchmark_attribution,test_iknow_adapter,test_parse_iknow_ask_output}.py`
   (959 / 2012 / 245). The stale 8-file count in #1174 predates #1171.
2. **Zero inbound coupling** — a repo-wide `git grep -i harbor` outside
   `scripts/harbor/` returns 38 lines in 8 files, and none of them is a code
   import. The only product-code hit is a comment (`src/cli/parse-args.ts:167`),
   the only test-code hit is a comment
   (`tests/cli/parse-args-eval-state.test.ts:494`). `tsconfig.json` includes
   only `src/**`, `tsconfig.test.json` adds `tests/**`, `vitest.config.ts`
   collects only `tests/**`; no toolchain reaches `scripts/`. `package.json` and
   `.github/` have no Harbor, Python, or pytest reference at all.
3. **`attribution.py` has no external consumer** — the issue's required check.
   Searches for `attribution.py`, `read_trial`, `CausalEvidence`,
   `AttributionRequest`, `compare_runs`, `verify_pins`, `read_trace` and a
   shell-out sweep (`python -m`, `uv run`, `harbor run`, `--agent `) outside the
   adapter return only an unrelated `"attribution"` JSON key in
   `.claude/settings.json:57` / `.codex/settings.json:57` and unrelated English
   prose about source attribution. Its only consumer is the adapter's own
   `tests/test_benchmark_attribution.py`. The file mixes a genuinely generic
   causal-classification core with a Harbor-shaped input layer (`read_trial`
   hardcodes `result.json` / `verifier/reward.txt` / `verifier/ctrf.json`).
   With zero consumers, extracting the core would add an unused module against
   the issue's "do not add a replacement framework" constraint, so the whole
   file retires with the adapter.
4. **Doc surface** — the only markdown *links* to the adapter anywhere: none.
   What will dangle are three inline code paths: `docs/STATUS.md:68`,
   `specs/hard-wall-denial-alignment.md:101`, `.gitignore:21-22`.

## Scope

- Delete the 10 tracked files under `scripts/harbor/`.
- `docs/STATUS.md`: reframe the §1.3 evaluation row so the adapter is not
  presented as the live benchmark driver. Keep every number and the report
  pointer — they are evidence, not instructions.
- `specs/hard-wall-denial-alignment.md:101,102,160`: the "reused surfaces" and
  "existing test suites" inventories name the deleted adapter. The file is the
  live acceptance contract cited by ADR-0133/0134/0135 and by four test files,
  so a deleted path in it is a stale claim, not historical evidence. Mark the
  adapter references retired; keep every product surface listed beside them.
- `docs/evidence/adr-0130/terminal-bench-2-1-pilot.md`: add one historical
  marker under the H1. Do not touch any measurement, count, or correction note.
- `.gitignore:21-22`: the rationale comment ("scripts/harbor is the first tracked
  Python in this repo") becomes false. `scripts/gen-banner-art.py` is still
  tracked, so the `__pycache__/` and `*.pyc` rules stay; only the comment changes.
- `CHANGELOG.md`: one new `### Removed` bullet recording the retirement. The
  existing `### Added` Harbor entries stay verbatim as evidence.

### Deliberately out of scope

- `--eval-state`, `runState`, their tests, and ADR-0130 — the issue keeps them
  unchanged, and the explore pass confirmed no native path imports the adapter.
- The two dangling comments at `src/cli/parse-args.ts:167` and
  `tests/cli/parse-args-eval-state.test.ts:494`. They describe a flag *position*
  that is still tested behavior; only the parenthetical attribution is stale.
  Rewording them would pull product source into a retirement diff for zero
  functional gain. Recorded here so a reviewer sees it was decided, not missed.
- The spec's stale `Status: ... implementation not started` line, though #1171
  landed it, and the stale `src/harness/hub.ts` citations in ADR-0130 that #1174
  flagged. Both are pre-existing and unrelated; fixing them would mix a drive-by
  into this PR.

## Architecture review verdict (pre-implementation)

affects: `scripts/harbor/**` (10 deleted files), `docs/STATUS.md`,
`specs/hard-wall-denial-alignment.md`,
`docs/evidence/adr-0130/terminal-bench-2-1-pilot.md`, `.gitignore`, `CHANGELOG.md`,
`plans/1175-retire-harbor.md`

- bounded-context-guardian: **yes** — one bounded context is retired whole. It had
  zero inbound coupling from product code and was never registered in
  `docs/architecture.md`; no new context is introduced and no sibling context
  absorbs its responsibilities.
- input-contract-tests: **N/A** — no public API, CLI flag, or module export
  changes; nothing is added or altered. The acceptance criterion is a negative
  one ("no product runtime, package workflow, or CI path imports or requires the
  retired package"), proven by the reference sweep, plus focused regression runs
  of the native surfaces that must survive unchanged.
- error-handling-enforcer: **N/A** — no error path is added, removed, or changed;
  this is a deletion plus comment-level doc corrections.
- complexity-anti-drift: **yes** — pure deletion shrinks the tree. The one
  candidate split, `attribution.py`'s generic core, has zero consumers, so no new
  abstraction is introduced to carry it.
- minimal-change-verifier: **yes** — one logical task. The doc edits are exactly
  those the same deletion invalidates; the pre-existing staleness listed above is
  deliberately left alone. No new dependency, no test weakened or deleted outside
  the adapter's own suite.

No Core Skill conflict: bounded-context-guardian and minimal-change-verifier
agree, because the context being retired has no consumers to migrate.

## Acceptance

1. `git ls-files scripts/harbor` is empty; `npm run build` and `npm run typecheck`
   pass; no CI, npm, or TypeScript path referenced the adapter before or after.
2. No current doc presents the adapter as active or names a deleted path. The
   pilot report, the #1173 drafts, and the changelog history remain present and
   are labelled historical evidence.
3. Native `--trace-out` and JSONL trace, `--eval-state` / `runState`, and the
   ask/chat/serve/TUI permission paths are unchanged, proven by a real CLI
   interaction plus the focused suites.
4. The diff contains only the deletion and the live-doc corrections named above.
