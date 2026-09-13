# Dimension Semantics: Pre-impl vs Post-impl

ACR runs BEFORE implementation — it judges the plan's declared structure, not measurable values. The 5 Core Skill agents run AFTER, on real diffs, and measure.

| Dimension                    | ACR (pre-impl) asks                                                                                             | Core Skill agent (post-impl) measures                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| complexity-anti-drift        | one abstraction level per function/module? god-function / god-file intent? planned deep nesting or duplication? | CC ≤ 10 / nesting ≤ 4 / clone ≤ 3% (hard FAIL); function ≤ 60 lines / file ≤ 1000 / params ≤ 4 (soft REVIEW) |
| defensive-contract-validator | plan allocates tests for the 5 boundary classes (empty / negative / overflow / concurrent / exception)?         | the 5 classes actually covered; line coverage ≥ 80% / branch ≥ 70%                                           |
| minimal-change-verifier      | one task? diff scope will match task intent?                                                                    | diff scope == task scope, lockfile with dependency changes, pre-commit tests exit 0                          |
| bounded-context-guardian     | new code lands in a capability-sliced context? cross-context deps declared via interfaces?                      | no technical-layer dirs, no reverse deps, no circular imports, context-map.md present                        |
| error-handling-enforcer      | failure paths named in the plan? typed errors, EXIT comments planned?                                           | no empty catch, no null/-1/"" returns, typed exceptions, // EXIT: comments on fallbacks                      |

Smell thresholds are judgment aids at ACR time, never verdict criteria. Estimated line counts never gate; measured values gate post-impl through the Core Skill agents.
