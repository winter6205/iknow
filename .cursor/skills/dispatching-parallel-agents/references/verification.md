# Cross-check (before synthesize)

This skill is done when the SKILL.md acceptance boxes are green. The commands below are **when workers wrote files**; a read-only review with empty `git diff` still passes.

| Check              | How                                 | Expect                                                             |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------ |
| Scope creep        | `git diff --stat` vs each SCOPE     | Only scoped paths                                                  |
| Overlapping writes | Compare each worker's claimed paths | Empty intersection                                                 |
| Peer leakage       | Prompts and results                 | No worker consumed another's in-flight output                      |
| Evidence           | Deliverable body                    | Command + exit code, or findings with file:line — not "looks good" |

Do not treat `git log` Conventional Commit as dispatch completion. Commit is a later implementing turn.

Summary line: `dispatched N, passed M, failed K`.
