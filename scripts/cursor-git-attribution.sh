#!/usr/bin/env bash
# Pin git author + neutralize Cloud/platform commit attribution.
#
# Always apply (overwrite). Do not LLM-probe. Install once into the snapshot;
# start.sh runs this on every Cloud session boot so a platform rewrite of
# user.* or *.cursor.co-author is replaced again.
#
# Usage:
#   bash scripts/cursor-git-attribution.sh          # apply
#   bash scripts/cursor-git-attribution.sh --check  # assert desired state, no writes
set -euo pipefail

GIT_IDENTITY_NAME="winter6205"
GIT_IDENTITY_EMAIL="136674824+winter6205@users.noreply.github.com"

MODE="apply"
if [ "${1:-}" = "--check" ]; then
  MODE="check"
elif [ -n "${1:-}" ]; then
  echo "cursor-git-attribution: unknown arg: $1 (want --check or none)" >&2
  exit 2
fi

log() { printf 'cursor-git-attribution: %s\n' "$*"; }

check_fail=0
assert_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" != "$want" ]; then
    echo "cursor-git-attribution --check FAIL $label: got $(printf '%q' "$got") want $(printf '%q' "$want")" >&2
    check_fail=1
  fi
}

# --- identity + gpgsign (unconditional overwrite on apply) -------------
pin_config() {
  git config --global user.name "$GIT_IDENTITY_NAME"
  git config --global user.email "$GIT_IDENTITY_EMAIL"
  git config --global commit.gpgsign false
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git config --local user.name "$GIT_IDENTITY_NAME"
    git config --local user.email "$GIT_IDENTITY_EMAIL"
    git config --local commit.gpgsign false
  fi
}

check_config() {
  assert_eq "user.name" "$(git config --global --get user.name || true)" "$GIT_IDENTITY_NAME"
  assert_eq "user.email" "$(git config --global --get user.email || true)" "$GIT_IDENTITY_EMAIL"
  assert_eq "commit.gpgsign" "$(git config --global --get commit.gpgsign || echo false)" "false"
}

# --- hook dirs: git-dir, core.hooksPath, husky user hooks --------------
hook_dirs() {
  local d hp
  if git rev-parse --git-dir >/dev/null 2>&1; then
    d="$(git rev-parse --git-path hooks 2>/dev/null || true)"
    [ -n "$d" ] && printf '%s\n' "$d"
  fi
  hp="$(git config --get core.hooksPath 2>/dev/null || true)"
  if [ -n "$hp" ]; then
    case "$hp" in
    /*) printf '%s\n' "$hp" ;;
    *)
      if git rev-parse --show-toplevel >/dev/null 2>&1; then
        printf '%s\n' "$(git rev-parse --show-toplevel)/$hp"
      fi
      ;;
    esac
  fi
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    printf '%s\n' "$(git rev-parse --show-toplevel)/.husky"
  fi
}

noop_hook() {
  cat <<'EOF'
#!/bin/sh
# cursor-git-attribution: platform co-author injector disabled
exit 0
EOF
}

strip_hook() {
  cat <<'EOF'
#!/bin/sh
# cursor-git-attribution: drop platform lines from COMMIT_EDITMSG
msg=$1
[ -n "$msg" ] && [ -f "$msg" ] || exit 0
# GNU sed (Cloud Ubuntu). I = case-insensitive.
sed -i \
  -e '/cursoragent@/Id' \
  -e '/Made-with:[[:space:]]*Cursor/Id' \
  -e '/Co-authored-by:.*Cursor/Id' \
  "$msg"
exit 0
EOF
}

write_file() {
  local path="$1" mode="$2"
  local dir
  dir="$(dirname "$path")"
  mkdir -p "$dir"
  if [ "$mode" = "noop" ]; then
    noop_hook >"$path"
    chmod a-x "$path" 2>/dev/null || true
  else
    strip_hook >"$path"
    chmod a+x "$path"
  fi
}

is_co_author_hook() {
  local base
  base="$(basename "$1")"
  case "$base" in
  *cursor*co-author* | *co-author*cursor*) return 0 ;;
  esac
  return 1
}

apply_hooks() {
  local dir f base
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    mkdir -p "$dir"
    find "$dir" -maxdepth 1 -type f 2>/dev/null | while IFS= read -r f; do
      if is_co_author_hook "$f"; then
        write_file "$f" noop
      fi
    done
    base="$(basename "$dir")"
    # hook_dirs emits the worktree husky dir as `.husky`; `husky` covers a
    # core.hooksPath that points at an unprefixed one. Do not drop *.cursor.*
    # into either (gitignore only covers .husky/commit-msg and prepare-commit-msg).
    if [ "$base" = ".husky" ] || [ "$base" = "husky" ]; then
      write_file "$dir/prepare-commit-msg" strip
      write_file "$dir/commit-msg" strip
    else
      write_file "$dir/commit-msg.cursor.co-author" noop
      write_file "$dir/prepare-commit-msg.cursor.strip-attribution" strip
      write_file "$dir/commit-msg.cursor.zz-strip-attribution" strip
    fi
  done < <(hook_dirs | sort -u)
}

check_hooks() {
  local dir f
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || continue
    while IFS= read -r f; do
      if is_co_author_hook "$f" && [ -x "$f" ]; then
        if ! grep -qF 'platform co-author injector disabled' "$f" 2>/dev/null; then
          echo "cursor-git-attribution --check FAIL executable co-author hook: $f" >&2
          check_fail=1
        fi
      fi
    done < <(find "$dir" -maxdepth 1 -type f 2>/dev/null)
  done < <(hook_dirs | sort -u)
}

if [ "$MODE" = "apply" ]; then
  pin_config
  apply_hooks
  log "applied $GIT_IDENTITY_NAME <$GIT_IDENTITY_EMAIL> gpgsign=false hooks overwritten"
  exit 0
fi

check_config
check_hooks
if [ "$check_fail" -ne 0 ]; then
  exit 1
fi
log "check ok $GIT_IDENTITY_NAME <$GIT_IDENTITY_EMAIL>"
exit 0
