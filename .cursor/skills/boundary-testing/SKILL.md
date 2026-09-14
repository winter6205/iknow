---
name: boundary-testing
description: Use when a change can drift hook, detector, or skill trigger behavior — exit-code contract, state-key mismatch, mtime precision, smoke false-pass, secret-config whole-file rewrite. Triggers on "触发语义", "force smoke", "detector drift". For public-entry input classes use input-contract-tests. Not ordinary multi-file features.
bucket: engineering
type: technique
---

# Boundary Testing

Thin orchestration for **trigger-semantics** adoption smoke (detector/hook/skill). Axis 1 proposes evals; Axis 2 verifies on real FS/JSON/cwd. **Sequential, not parallel** — Axis 2 needs Axis 1's eval set.

## When to use

- Change can drift hook / detector / skill trigger behavior or cross-platform FS semantics
- Operator says 触发语义 / force smoke / detector drift
- Subagent claimed success but real FS/JSON/cwd was probably not exercised

## When not to use

- Ordinary multi-file feature with no detector/hook trigger surface
- Public API input classes → `input-contract-tests`
- Single-line typo / "只改这一处"

## Procedure

1. **Pin the candidate.** base + HEAD (or explicit file set) and what trigger surface is under test. Completion: unambiguous ref.
2. **Pin protocol.** [`references/protocol.md`](references/protocol.md) by pointer only. Completion: path cited.
3. **Axis 1 (proponent) first.** Dispatch `arthurpower:boundary-testing-axis1-agent` with the pinned ref + protocol path. It drafts 10–30 evals, runs subagent smoke (necessary not sufficient), prepares A/B baseline. Completion: eval set + `OVERALL` line returned.
4. **Axis 2 (skeptic) second.** Only after Axis 1 returns, dispatch `arthurpower:boundary-testing-axis2-agent` with the same pin **and** Axis 1's eval set / driver paths. It runs real FS/JSON/cwd smoke, exit-code contract, Step 5 accept/reject. Completion: table + `OVERALL` + gate call.
5. **Aggregate.** Side-by-side; no cross-axis rerank. Completion: both `OVERALL` lines visible.
6. **Drift gate.** From protocol Step 5: required-behavior regression OR FP not down OR TP not up → `GATE: REJECT: <reason>` (do not adopt). Else `GATE: ACCEPT`. Completion: verdict line emitted.

## Acceptance Criteria

- [ ] Candidate ref pinned
- [ ] Protocol cited by pointer only
- [ ] Axis 1 completed before Axis 2 started
- [ ] Axis 2 received Axis 1 eval/driver output
- [ ] Both returned `OVERALL` lines; gate ACCEPT or REJECT emitted

## Verification

```
Skill type: technique
Bar level:  minimum
```

## See Also

- [`references/protocol.md`](references/protocol.md) — 6-step + exit-code contract
- [`references/cases.md`](references/cases.md) — case templates
- `input-contract-tests` — public-entry input classes (not this skill)
