# Pressure scenarios and anti-patterns

Each pressure maps a locally defensible excuse to the failure mode it tends to produce, and the extract that pre-empts it. Anti-patterns are named for the recurring shape they leave in the diff.

## Rationalizations

| Excuse                                               | Reality                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "Just one more branch, refactor next time"           | "Next time" never arrives. 4 branches become 10 by feature 5.                                                           |
| "This function is hard to split, just add a comment" | Comments don't reduce cyclomatic complexity. Linter still fails.                                                        |
| "Nested ifs are clearer than extracted functions"    | Nested ifs are clearer to write, not to read. Extract.                                                                  |
| "It's only 5 params, who cares about the limit"      | 5 params is past the soft threshold (≤4) — the function is taking a config blob. Split it or introduce a params object. |
| "Duplicate string is just a coincidence"             | Coincidence repeats. Extract the function or the constant.                                                              |
| "Just this once for the demo"                        | "This once" = 60+ lines once = 120 lines next PR.                                                                       |

## Anti-patterns

- **Chained ternary** — `a ? b : c ? d : e : f`. Flatten with named helpers or early returns, not another `?`.
- **Just-this-once comment** — `// just this once` or `// temporary` beside a complex block. The comment does not buy a waiver; extract.
- **Unextracted duplicate** — the same block in 2+ places with no shared extraction. Extract the shared logic into a function, not a duplicated-string collapse.
- **Comment-instead-of-extract** — "I added a comment explaining the nesting" instead of extracting. Helpers extract; comments do not.

## Verification

- Linter exit 0 with no warnings on touched files
- `jscpd --reporters json` shows touched files < 3%
- `git diff --stat` shows extracted helper files are reasonable in size
- `grep -nE "// (just|only|temporary) this once" -- $(git diff --name-only)` returns no matches
