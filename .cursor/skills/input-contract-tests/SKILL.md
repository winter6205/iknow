---
name: input-contract-tests
description: Use when adding or changing a public API, CLI command, or module export — cover applicable input classes (empty, invalid/negative, overflow, concurrent, exception). Triggers on "入参契约", "input contract", "public API tests". Not for hook/detector trigger-semantics (use boundary-testing). Not a default landing gate.
bucket: engineering
type: technique
---

# Input Contract Tests

Write-time checklist for **public entries**: callers outside the module can send dirty input. Nail the promise (reject / tolerate / typed error) with tests. This is not a default review slot and does not dispatch an auditor agent.

## When to use

- New or changed public API / CLI / RPC / exported function that accepts external input
- A PR clearly missing an input class on a public entry
- Operator asks for 入参契约 / input-contract coverage

Skip: internal helpers with no external callers; prototypes; generated code; formatting. Hook/detector **trigger** drift → `boundary-testing` (sequential axis1 → axis2).

## The five input classes

Apply only classes that fit the entry:

| Class              | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| empty              | missing / null / blank where a value is required            |
| invalid / negative | wrong type, illegal enum, negative where forbidden          |
| overflow           | too long / too large / out of range                         |
| concurrent         | two callers mutate shared state at once (if relevant)       |
| exception          | dependency failure surfaces as a typed error, not a swallow |

## Procedure

1. **Name the public entry.** Completion: function/command path stated.
2. **List applicable classes.** Drop classes that cannot apply; note why. Completion: list written.
3. **For each listed class — RED then GREEN** under `test-driven-development`. Completion: each class has a test that failed before the handling code (or already existed and still passes).
4. **Stop.** Do not open a separate audit agent. Optional human re-check: invoke this skill by name on the diff.

## Acceptance Criteria

- [ ] Public entry named
- [ ] Applicable input classes listed (inapplicable marked N/A)
- [ ] Each applicable class has a focused test
- [ ] No default dispatch of a contract-validator agent

## Verification

```
Skill type: technique
Bar level:  minimum
```

## See Also

- `test-driven-development` — RED/GREEN discipline for every test you add
- `boundary-testing` — detector/hook trigger-semantics smoke (not input classes)
