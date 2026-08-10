---
name: v-code-review
description: Use when the user asks to AI-review Git changes (PR, commit, branch range, workspace, or "审查代码/审 PR") via this fork's local CLI (OCR_BIN / build/v-code-review.exe). Runs review --audience agent; --report-dir writes live-review.json (raw_comments[]) for code-fix work; --evaluate is opt-in and only meaningful with a Golden Set manifest. Not project design / install docs.
---

# v-code-review — invoke the local CLI

Technique skill: resolve binary → run review → classify → fix only if asked.
Product docs and install steps are **not** this skill (`README`, `docs/usage-human.md`).

## When to use

- User wants AI code review of a PR, commit, branch range, or working tree
- Trigger phrases: 审查代码 / 审 PR / 审 commit / 审分支 / review changes / review this PR / 审查并评估
- User wants the same review plus post-process evaluate (`--report-dir` + `--evaluate` flags on `review`)
- User asks to fix findings after a review run

## When not to use

- Installing the skill or building/installing the binary (see README "Install")
- Explaining product design, architecture, or domain terms (`docs/CONTEXT.md`)
- Authoring or editing rule docs / system_rules
- Pure golden-set fixture work unless the user named `golden-set` / offline eval
- Reviewing without this fork's CLI (wrong skill / wrong tool)

## Procedure

### 1. Resolve `OCR_BIN`

The reviewed repository is usually NOT the fork repo. Treat the two as separate cwd roles:

| Role              | cwd                                    | What it has                                      |
| ----------------- | -------------------------------------- | ------------------------------------------------ |
| **Fork repo**     | where you build/checkout v-code-review | `cmd/opencodereview/`, `build/v-code-review.exe` |
| **Reviewed repo** | where the user wants a code review     | git source tree, **no** v-code-review binary     |

When you are reviewing a project (the common case), `cwd` is the **reviewed** repo, not the fork. The fork binary lives elsewhere and you must reach it by absolute path.

```bash
# Default — absolute path to the pre-built fork binary.
# Adjust this for your machine. Do NOT rely on a relative path.
export OCR_BIN="D:/Claude code/projects/v-code-review/build/v-code-review.exe"

if ! test -f "$OCR_BIN" && ! command -v "$OCR_BIN" >/dev/null 2>&1; then
  # Maybe you are sitting inside the fork repo; build from source.
  if test -d cmd/opencodereview; then
    echo "[ocr] cwd is fork repo; building"
    go build -o build/v-code-review.exe ./cmd/opencodereview
    OCR_BIN="$(pwd)/build/v-code-review.exe"
  else
    # cwd is NOT the fork repo. Don't try to go build — it will fail
    # with "cannot find main module". Tell the user to build once in the
    # fork repo and re-run with an absolute OCR_BIN.
    echo "[ocr] ERROR: build/v-code-review.exe not found at $OCR_BIN"
    echo "[ocr] cwd is $(pwd); not the fork repo (no cmd/opencodereview/)."
    echo "[ocr] Fix: cd into the fork repo, run: go build -o build/v-code-review.exe ./cmd/opencodereview"
    echo "[ocr] Then set OCR_BIN=/abs/path/to/build/v-code-review.exe and try again."
    exit 2
  fi
fi
```

**Do not** `npm i -g @alibaba-group/open-code-review` for this workflow (upstream package; missing fork flags).

### 2. Pick scope

`review` is the primary command. `--evaluate` is a **flag on review**, not a separate subcommand.

| User intent    | Args                        |
| -------------- | --------------------------- |
| Working tree   | (default)                   |
| Branch / PR    | `--from <base> --to <head>` |
| One commit     | `--commit <sha>`            |
| Other repo     | `--repo <path>`             |
| File list only | `--preview`                 |

### 3. Run the review (happy path)

Go straight to review. Do **not** run `llm test` first unless troubleshooting.

```bash
"$OCR_BIN" review --audience agent --background "<short business context>" [scope]
```

Capture stdout/stderr. Prefer long timeout for large diffs.

When to run `llm test` (exception fallback only):

- First time on this machine / first run after a config change
- A previous review failed with auth / network / model error

When `llm test` fails: tell the user to fix `~/.opencodereview/config.json` or `OCR_LLM_*` env. Never invent API keys.

### 4. Default: write a report (do NOT pass `--evaluate` unless asked)

The default ask is to **save review findings** so they can be read and acted on. That requires `--report-dir` only. Do **not** add `--evaluate` unless the user explicitly asked for evaluation/metrics/F1/calibrate/queue.

```bash
# Default — write live-review.json with raw_comments[]:
"$OCR_BIN" review --audience agent --background "…" [scope] \
  --format json \
  --report-dir ./code-reports

# Or with the env default:
export CODE_REPORT_DIR=./code-reports
"$OCR_BIN" review --audience agent --background "…" [scope] --format json

# Repeat runs in the same report dir? Use --report-name so prior
# files are not overwritten. Filename becomes live-review-<name>.json:
"$OCR_BIN" review --audience agent -b "…" --commit 198759b \
  --format json --report-dir ./code-reports --report-name 198759b
"$OCR_BIN" review --audience agent -b "…" --commit 5626110 \
  --format json --report-dir ./code-reports --report-name 5626110
```

`live-review.json` schema (top-level):

```json
{
  "case_id": "live-review",
  "title": "<run title>",
  "language": "<lang>",
  "raw_comments": [/* the actual findings — read THIS for code-fix work */],
  "severity_hist": { "high": 3, "medium": 5 },
  "status": "review_live",
  "precision": 0,
  "recall": 0,
  "f1": 0,
  "true_positives": 0,
  "false_positives": 0,
  "false_negatives": 0
}
```

Each `raw_comments[]` element (a single finding) has:

| Field                     | Use                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `path`                    | file to edit                                                                             |
| `start_line` / `end_line` | line range (0 = re-locate from `content`)                                                |
| `content`                 | problem description, often prefixed with severity (`High …` / `[High] …` / `[Medium] …`) |
| `existing_code`           | snippet to find before replacing                                                         |
| `suggestion_code`         | replacement snippet                                                                      |

Read `live-review.json` → `raw_comments[]` for code-fix work. **Do not** read `finish.json` for that.

### 5. Opt-in: `--evaluate` (only when the user explicitly asks)

`--evaluate` is a flag on `review`, not a subcommand. It runs `evaluateReports()` which calls `calibrate` + `queue` and writes `finish.json`. The meaningful case requires a Golden Set `manifest.json` next to the report dir; without one, `finish.json` will show `precision/recall/f1 = 0`, `calibrated: {unknown: 0}`, `queue_size: 0`. That is **not** "no findings" — it is "no ground truth to compare against".

Use `--evaluate` only when:

- The project has `golden-set/manifest.json` (Golden Set evaluation flow), OR
- The user explicitly asked for F1 / queue / calibrate numbers.

```bash
# Only when meaningful:
"$OCR_BIN" review --audience agent --background "…" [scope] \
  --format json \
  --report-dir ./code-reports \
  --evaluate
```

Default report dir should be under the **reviewed repository's cwd**: `./code-reports`.

Review ≠ Evaluate. Evaluate is post-process of report JSON, not a second full-tree audit.

### Avoid overwriting prior runs

Without `--report-name`, every run writes the same file name `live-review.json` and **overwrites** the previous run's findings. If the user is reviewing multiple commits / branches / dates in the same report dir, supply `--report-name <id>` (commit short SHA, branch slug, date). The output becomes `live-review-<id>.json`; filesystem-unsafe characters in `<id>` are replaced with `-`.

If the user did not pass `--report-name` and the report file already exists, surface a brief note: "re-running will overwrite the previous `live-review.json` unless `--report-name` is provided". Do not block — they may have intended to overwrite.

### 6. Classify and report

| Priority                                  | Keep?                            |
| ----------------------------------------- | -------------------------------- |
| High — clear bug / security / precise fix | Yes                              |
| Medium — context-dependent                | Yes                              |
| Low — noise / pure style without risk     | Drop unless user wants full dump |

Group High/Medium by priority. If `start_line`/`end_line` are 0, re-locate from comment text before any edit.

### 7. Fix

- Auto-edit only when the user asked to fix
- Prefer High/Medium; re-run tests or build for touched code when applicable

### 8. Advanced (only if named)

```bash
"$OCR_BIN" golden-set run --real --from <a> --to <b>
"$OCR_BIN" golden-set finish --report-dir golden-set/reports
```

## Acceptance Criteria

- [ ] Used `OCR_BIN` pointing at **this fork** binary by absolute path (not silent upstream npm `ocr`); default = absolute path, not relative
- [ ] Recognised fork-repo cwd (has `cmd/opencodereview/`) vs reviewed-repo cwd (the common case); did **not** try `go build` in a non-fork cwd
- [ ] Went straight to `review --audience agent` on the happy path (no mandatory `llm test` step)
- [ ] Did **not** invoke `evaluate` as a subcommand; used `--evaluate` flag on `review` only when explicitly asked
- [ ] Default ask ("review + report") → passed `--report-dir` only; **did not** add `--evaluate` automatically
- [ ] When reviewing multiple commits/branches in the same `--report-dir`, supplied `--report-name <id>` so prior runs are not overwritten (or noted the overwrite risk to the user)
- [ ] Ran `llm test` only when first-run / config-changed / prior failure warranted it
- [ ] Invoked `review --audience agent` with correct scope args
- [ ] Read code-fix work from `live-review.json` → `raw_comments[]`; **did not** read `finish.json` for that
- [ ] If `--evaluate` was requested: explained when it is meaningful (Golden Set manifest) vs no-op (live review without ground truth)
- [ ] Kept report-dir under the reviewed repository's cwd (e.g. `./code-reports`), not the skill/binary repo
- [ ] Reported High/Medium (or explicit no-issues); did not treat evaluate as a second review
- [ ] Did not edit code unless user asked to fix
- [ ] Did not paste install/README prose as the skill procedure substitute

## Verification

Skill type: technique
Bar level: discipline

```bash
test -f "${OCR_BIN:-build/v-code-review.exe}" || test -f build/v-code-review.exe
"$OCR_BIN" review --help | grep -E 'report-dir|evaluate|audience'
# Verify evaluate is a flag, not a subcommand:
# "$OCR_BIN" evaluate --help   # should FAIL with "unknown command"
# Run llm test only when troubleshooting:
# "$OCR_BIN" llm test
# After a real review run with --report-dir:
# exit code 0 (or explained non-zero from stderr)
# test -f ./code-reports/live-review.json
# jq '.raw_comments | length' ./code-reports/live-review.json  # confirm N findings
# if --evaluate was also requested: test -f ./code-reports/finish.json (and explain F1=0 if no manifest)
```

## Rationalization Table

| Excuse                                   | Counter                                                                                     | Required action                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| "PATH `ocr` is fine"                     | Upstream npm may lack `--evaluate` / finish                                                 | Prefer `build/v-code-review.exe` / absolute OCR_BIN                |
| "Try `go build` in the reviewed repo"    | Reviewed repo has no `cmd/opencodereview/`; `go` will fail with "cannot find main module"   | Build once in the fork repo; absolute OCR_BIN env in any other cwd |
| "Use relative `build/v-code-review.exe`" | Relative resolves only when cwd is the fork repo — fails silently in cross-repo sessions    | Default = absolute path; relative is only a fork-cwd fallback      |
| "`evaluate` must be a subcommand"        | `--evaluate` is a flag on `review`, not a subcommand                                        | Use `review ... --report-dir <dir> --evaluate`                     |
| "Evaluate means re-review the tree"      | Evaluate post-processes report JSON                                                         | Use `--report-dir --evaluate` only                                 |
| "Put reports next to the binary"         | Reports belong in the reviewed repo, not the skill/binary repo                              | Default `./code-reports` under reviewed repo cwd                   |
| "Install steps belong in the skill"      | Skill is invoke-exe; install is README                                                      | Point user to README Install                                       |
| "User said review — also rewrite rules"  | Out of scope for this skill                                                                 | Stay on CLI invoke; separate task for rules                        |
| "Skip `--report-name` on the second run" | Repeat runs in the same `--report-dir` overwrite `live-review.json` and lose prior findings | Pass `--report-name <commit-or-branch>`; or warn the user first    |
| "Auto-fix everything found"              | Fixes need explicit ask                                                                     | Report first; fix only on request                                  |
| "npm -g is easier than go build"         | Wrong product binary                                                                        | Build/use this fork only                                           |

## Red Flags — STOP

- About to call global upstream `ocr` without checking it is this fork
- About to `npm i -g @alibaba-group/open-code-review` as the default path
- About to overwrite an existing `live-review.json` without either using `--report-name` or warning the user
- Invoking `evaluate` as a subcommand instead of `--evaluate` flag on `review`
- `--evaluate` without `--report-dir` (or `CODE_REPORT_DIR`)
- Writing `--report-dir` outside the reviewed repository's cwd
- Using `--audience human` for agent sessions (progress UI noise)
- Dumping full Low/noise list as if all were High
- Editing production code when user only asked for review
- Replacing this procedure with a long project-design essay

## References

- Install (binary + skill): repository `README.md` / `README.zh-CN.md`
- Human product path: `docs/usage-human.md`
- Domain terms: `docs/CONTEXT.md`
- Extra install detail: `docs/install-claude-agent.md`
