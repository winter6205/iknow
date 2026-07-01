# Eval Framework

Regression-test scaffold for project templates. Zero external deps — pure bash + YAML.

## What

- `.evals/tasks/*.yaml` — task definitions (test cases)
- `.evals/run.sh` — bash runner that executes each task's `test_command`
- `.evals/results/<timestamp>.json` — pass/fail report

## Task YAML schema (7 fields)

```yaml
id: <unique-id>                       # required, string
tier: fast|medium|slow                # optional, default medium
description: "<what this tests>"      # required, string
repo: <path>                          # optional, default cwd
files_to_fix:                         # optional, list
  - <relative-path>
test_command: <shell-command>         # required, string, exit 0 = pass
prompt: |                             # optional, agent prompt for this task
  <multi-line>
```

**Pass criteria**: `test_command` exits 0.
**No timeout field**: tasks run to natural completion. Outer harness timeout handles true hangs.

## Tier model

| tier    | use case                                              |
|---------|-------------------------------------------------------|
| fast    | boot, structural grep, smoke checks (always safe)      |
| medium  | pytest collect, lint, mid-cost integration smoke      |
| slow    | coverage gates, full pytest, e2e                      |

Within a tier, tasks run **in parallel**. Across tiers: fast → medium → slow, sequentially.
This means a fast-tier failure stops the run before medium/slow consume time.

Default invocation runs only `tier: fast` (smoke check). Default tier for
yaml missing the `tier:` field is `medium` (backward compat — won't run by
default, must opt in with `--all` or `--tier medium`).

## Usage

```bash
bash .evals/run.sh                       # default: tier=fast only
bash .evals/run.sh --all                 # run all tiers
bash .evals/run.sh --tier slow           # run only slow tier
bash .evals/run.sh --task <id>           # run single task (any tier)
bash .evals/run.sh --results-dir ./out   # custom output dir
```

## Exit codes

- `0` — all **executed** tasks passed (filtered-out tasks are NOT counted)
- `1` — one or more executed tasks failed (see JSON report)
- `2` — runner error (bad YAML, missing dir, unknown arg, etc.)

## Result JSON schema

```json
{
  "run_id": "20260629T140000",
  "started_at": "2026-06-29T14:00:00+00:00",
  "finished_at": "2026-06-29T14:00:01+00:00",
  "tasks": [
    {
      "id": "001-bootstrap-pass",
      "tier": "fast",
      "description": "...",
      "success": true,
      "test_exit_code": 0,
      "test_output_truncated": "...",
      "test_duration_sec": 0.123
    }
  ],
  "summary": {"total": 1, "passed": 1, "failed": 0}
}
```

## Bootstrap integration

`scripts/bootstrap.sh` runs baseline eval after scaffold. If any baseline task fails, bootstrap exits 1 and prints fix instructions.
