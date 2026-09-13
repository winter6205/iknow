# Handoff with architecture-change-reviewer

Both skills fire on "3+ files". They produce different artifacts, in this order:

1. `architecture-change-reviewer` emits the 5-line verdict: bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier, each `yes` / `no` / `unclear` with one clause.
2. A plan is ready to write when every line is `yes` or `N/A with reason`. A `no` or `unclear` line is unfinished architecture — resolve it before slicing tracer bullets.
3. `writing-plans` consumes that block and writes the ordered tracer bullets into the same `plans/<feature>.md`.

Conflict split: ACR wins on module / context structure. writing-plans wins on commit slicing. They do not merge into one verdict.
