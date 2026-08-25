---
name: dispatching-parallel-agents
description: Use when 2+ independent tasks can run without shared mutable state, when context isolation is needed between tasks, when parallel subagent dispatch is requested, when batch review of multiple files is required, or when the user requests fan-out across independent investigations.
bucket: engineering
---

# Dispatching Parallel Agents

This skill is the **fan-out playbook for the current agent**. Independence, one-message dispatch, and a merged report are the contract. Worker subagents do the work (`general-purpose`, `spec-reviewer-agent`, `standards-reviewer-agent`, or other named verifiers).

A task is **independent** when it shares no mutable file / DB / config / lock with its peers and does not need another peer's output. Fake parallelism is sequential work wrapped in extra Agent calls.

## When to use

- **2+ truly independent tasks** (no shared files / DB / config / lock)
- **Context explosion** (e.g. six failing test files → one worker per file)
- **Parallel review of disjoint files** (axes or modules that do not overlap)
- **Independent exploration** of unfamiliar modules (one worker per module)
- **Batch-fix N similar bugs** in N independent files

`code-review` already fans out Standards + Spec; use that skill when the job is the dual-axis gate, not this general playbook.

## When not to use

- Peers depend on each other (B reads A's output → sequence)
- One trivial task (setup cost exceeds the work)
- The user asked for order ("先 X 再 Y")
- Two workers would write the same file

## Procedure

1. **Identify independent tasks.** Confirm no shared mutable state, no overlapping write paths, no peer-output dependency. Count follows shape: one worker per independent module / compile boundary; otherwise cost vs speed vs dependency. Completion: a named list of units, each with a disjoint write (or read) path, or a decision to run sequentially instead.

2. **Write a 7-field prompt per worker.** ROLE / SCOPE / PERMISSION / REFERENCE / CONSTRAINTS / DELIVERABLE / OUTPUT RULES. Skeleton: [`references/prompt-template.md`](references/prompt-template.md). Missing ROLE, SCOPE, or PERMISSION means the worker will drift. Completion: every unit has all seven fields.

3. **Fan out in one message.** The current agent issues multiple Agent/Task calls in a **single** message, each targeting a worker. Sequential messages are sequence, not parallel. Completion: N workers launched together.

4. **Collect structured results.** Each worker returns verifiable output (paths, commands, exit codes, findings) — not "looks good". Completion: N results in hand, including crashed workers reported as FAIL.

5. **Cross-check.** Scope creep, overlapping writes, and peer-output leakage — [`references/verification.md`](references/verification.md). Completion: conflicts named or confirmed absent.

6. **Synthesize.** Merge into one report. Commit is not this step; a later implementing turn owns git. Completion: `dispatched N, passed M, failed K` plus the merged table.

Shape, shared-state table, and one-message vs sequential: [`references/procedure-details.md`](references/procedure-details.md).

## Prompt skeleton

```
ROLE:        <worker identity>
SCOPE:       1 logical task; write paths do not overlap peers
PERMISSION:  <tools + read/write scope>
REFERENCE:   <paths the worker must read first>
CONSTRAINTS: <no scope creep, no drive-by refactors>
DELIVERABLE: <concrete artifact>
OUTPUT RULES: <format; deliverable is the output>
```

Full template: [`references/prompt-template.md`](references/prompt-template.md).

## Acceptance criteria

- [ ] 2+ tasks are independent (or the run correctly fell back to sequence)
- [ ] Each worker has explicit SCOPE (one logical task, disjoint write paths)
- [ ] Workers launched in one message by the **current agent**
- [ ] Each result is structured and verifiable
- [ ] Cross-check ran before the merge
- [ ] Report includes `dispatched N, passed M, failed K`

## References

- Worked example (three disjoint reviews, synthesize, no commit): [`references/example.md`](references/example.md)
- Procedure expansion: [`references/procedure-details.md`](references/procedure-details.md)
- Prompt template: [`references/prompt-template.md`](references/prompt-template.md)
- Cross-check: [`references/verification.md`](references/verification.md)
- Pressure / anti-patterns: [`references/pressure-and-antipatterns.md`](references/pressure-and-antipatterns.md)
