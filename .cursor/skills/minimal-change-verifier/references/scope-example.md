# Scope example (S6)

## Anti-pattern: two tasks in one diff

Users endpoint plus an unrelated billing rewrite. Each could land or revert alone. FAIL — two tasks.

## Anti-pattern: drive-by

Task files plus an eslint sweep of a second package. FAIL — unstage the sweep.

## In scope

Feat (or fix) plus the tests that prove it, plus docs required to operate that change, plus a paving extract the feat cannot stand without. PASS — still one task.
