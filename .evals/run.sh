#!/usr/bin/env bash
# .evals/run.sh — tier-grouped eval runner (fast default, parallel within tier)
# Usage:
#   bash .evals/run.sh                 # default: tier=fast only (smoke check, ~3s)
#   bash .evals/run.sh --all           # run all tiers (full sweep)
#   bash .evals/run.sh --tier slow     # run only slow tier (e.g. coverage)
#   bash .evals/run.sh --task <id>     # run single task (any tier)
#
# No per-task timeout: tasks run to natural completion. Outer API timeout
# (e.g. Claude API_TIMEOUT_MS=50min) handles true hangs. Magic kill = bad:
# kills workers with stale lock files, truncates buffered output, masks
# real exit codes.
set -euo pipefail

TASKS_DIR="${TASKS_DIR:-.evals/tasks}"
RESULTS_DIR="${RESULTS_DIR:-.evals/results}"
FILTER_TASK=""
FILTER_TIER=""
RUN_ALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --task)        FILTER_TASK="$2"; shift 2 ;;
    --tier)        FILTER_TIER="$2"; shift 2 ;;
    --all)         RUN_ALL=1; shift ;;
    --results-dir) RESULTS_DIR="$2"; shift 2 ;;
    --tasks-dir)   TASKS_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0 ;;
    *) echo "[run.sh] unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default: fast tier only (smoke). Use --all for full sweep.
if [ "$RUN_ALL" -eq 0 ] && [ -z "$FILTER_TASK" ] && [ -z "$FILTER_TIER" ]; then
  FILTER_TIER="fast"
fi

[ -d "$TASKS_DIR" ] || { echo "[run.sh] ERROR: tasks dir not found: $TASKS_DIR" >&2; exit 2; }
mkdir -p "$RESULTS_DIR"

# Read a top-level scalar field (returns "" if missing).
yaml_field() {
  local field="$1" yaml="$2"
  awk -v f="$field" '
    $0 ~ "^"f":" {
      val = $0
      sub("^"f":[[:space:]]*", "", val)
      sub("^[\"'"'"']", "", val); sub("[\"'"'"']$", "", val)
      print val
      exit
    }
  ' "$yaml"
}

# Extract multi-line test_command (block scalar aware).
extract_test_cmd() {
  awk '
    /^test_command:/ {
      sub(/^test_command:[[:space:]]*/, "")
      if ($0 == "|" || $0 == ">" || $0 == "|-" || $0 == ">-") { in_block = 1; next }
      in_block = 0; printf "%s", $0; next
    }
    in_block && /^[[:space:]]/ { sub(/^[[:space:]]+/, ""); printf "%s\n", $0; next }
    in_block && /^[^[:space:]]/ { in_block = 0 }
  ' "$1" | sed -E 's/[[:space:]]+$//'
}

# Pre-parse all yamls into bash associative arrays (4 grep/awk per yaml, once).
declare -A T_YAML T_DESC T_TIER T_CMD
for yaml in "$TASKS_DIR"/*.yaml; do
  [ -f "$yaml" ] || continue
  ID=$(yaml_field id "$yaml")
  [ -n "$ID" ] || { echo "[run.sh] WARN: $yaml missing id, skipping" >&2; continue; }
  T_YAML[$ID]="$yaml"
  T_DESC[$ID]=$(yaml_field description "$yaml")
  TIER=$(yaml_field tier "$yaml")
  T_TIER[$ID]="${TIER:-medium}"
  T_CMD[$ID]=$(extract_test_cmd "$yaml")
done
[ ${#T_YAML[@]} -eq 0 ] && { echo "[run.sh] no tasks in $TASKS_DIR" >&2; exit 2; }

PARALLEL_DIR=$(mktemp -d)
SKIP_DIR="$PARALLEL_DIR/_skipped"
mkdir -p "$SKIP_DIR"
RESULTS_TMP=$(mktemp)

# Run one task. Writes JSON to PARALLEL_DIR/$ID.json, or marker file in SKIP_DIR
# (file-based skip — no magic sentinel strings that could collide with output).
run_task() {
  local id="$1"
  local result="$PARALLEL_DIR/$id.json"
  [ -n "$FILTER_TASK" ] && [ "$id" != "$FILTER_TASK" ] && { touch "$SKIP_DIR/$id"; return; }
  [ -n "$FILTER_TIER" ] && [ "${T_TIER[$id]}" != "$FILTER_TIER" ] && { touch "$SKIP_DIR/$id"; return; }
  [ -z "${T_CMD[$id]}" ] && { echo "[run.sh] WARN: no test_command in ${T_YAML[$id]}" >&2; touch "$SKIP_DIR/$id"; return; }

  T0=$(date +%s.%N)
  set +e
  OUT=$(bash -c "${T_CMD[$id]}" 2>&1)
  EXIT=$?
  set -e
  T1=$(date +%s.%N)
  DUR=$(awk "BEGIN{printf \"%.3f\", $T1-$T0}")
  local STATUS="false"
  [ "$EXIT" -eq 0 ] && STATUS="true"
  local SANITIZED
  SANITIZED=$(printf '%s' "$OUT" | head -c 200 | tr '"' "'")

  printf '{"id":"%s","tier":"%s","description":"%s","success":%s,"test_exit_code":%d,"test_output_truncated":"%s","test_duration_sec":%s}\n' \
    "$id" "${T_TIER[$id]}" "${T_DESC[$id]}" "$STATUS" "$EXIT" "$SANITIZED" "$DUR" > "$result"
  echo "[run.sh] $id (tier=${T_TIER[$id]}): $STATUS (exit=$EXIT, ${DUR}s)"
}

# Tier-grouped: fast → medium → slow. Parallel within tier.
for TIER in fast medium slow; do
  TIER_IDS=()
  for id in "${!T_YAML[@]}"; do
    [ "${T_TIER[$id]}" = "$TIER" ] && TIER_IDS+=("$id")
  done
  [ ${#TIER_IDS[@]} -eq 0 ] && continue

  for id in "${TIER_IDS[@]}"; do
    run_task "$id" &
  done
  wait || true  # set -e safe; per-task success recorded in RESULT files
done

# Aggregate
TOTAL=0; PASSED=0; FAILED=0
for id in "${!T_YAML[@]}"; do
  result="$PARALLEL_DIR/$id.json"
  [ -f "$result" ] || continue  # SKIP_DIR marker files are silently ignored
  TOTAL=$((TOTAL + 1))
  if grep -q '"success":true' "$result"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
  cat "$result" >> "$RESULTS_TMP"
done

RUN_ID=$(date -u +"%Y%m%dT%H%M%S")
STARTED=$(date -u +"%Y-%m-%dT%H:%M:%S+00:00")
FINISHED=$(date -u +"%Y-%m-%dT%H:%M:%S+00:00")
REPORT="$RESULTS_DIR/${RUN_ID}.json"
{
  echo "{\"run_id\":\"$RUN_ID\",\"started_at\":\"$STARTED\",\"finished_at\":\"$FINISHED\",\"tasks\":["
  paste -sd ',' "$RESULTS_TMP"
  echo "],\"summary\":{\"total\":$TOTAL,\"passed\":$PASSED,\"failed\":$FAILED}}"
} > "$REPORT"
rm -rf "$PARALLEL_DIR" "$RESULTS_TMP"

echo "[run.sh] wrote $REPORT"
echo "[run.sh] summary: $PASSED/$TOTAL passed"
[ "$FAILED" -eq 0 ] && exit 0 || exit 1
