# Rationalization Table and Red Flags

## Rationalization Table (pressure scenarios)

| Rationalization                        | Reality                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| "It's obviously X, just fix it"        | Obvious is the rationalization that ships the wrong fix. Instrument first.                |
| "I'll just try this and see"           | Trying without hypothesis is shotgun-debugging. State the hypothesis, then test.          |
| "Authority says it's a simple bug"     | Authoritative claim does not eliminate root cause. 1 phase of repro = wasted fix.         |
| "It's flaky, can't reproduce"          | Flaky = not yet understood. Add deterministic reproduction (seed / fixture / mock) first. |
| "Fix one thing, break another, normal" | Fix-then-break = wrong fix. Bisect. Re-run full suite. New failure = revert.              |
| "I already fixed it"                   | Without the failing test going green, you have not fixed it. Verification is mandatory.   |
| "This is the 4th try, ship any fix"    | 4th try = 3+ failures = STOP, reload this skill, restart from Phase 1 (debug-stop rule).  |

## Red Flags — STOP and reload

If you catch yourself thinking or doing any of these, STOP and return to Phase 1:

- Patching code without the failing test in hand
- Patching code without identifying root cause (only saw symptom location)
- "I'll add a try/except" without understanding WHY it fails (S3 error-handling-enforcer violation)
- 3+ fix attempts in one session without re-loading this skill
- Reporting "fix" without the failing test going green
- Logging the symptom location but not the cause (instrumentation without hypothesis)
- "Works in dev, fails in prod" without reproducing prod environment first
- Adding `// FIXME` or `# TODO` instead of fixing (deferral = failure)
- Inventing a "pattern" from a single occurrence (1 occurrence is not a pattern; N>=3 required)
