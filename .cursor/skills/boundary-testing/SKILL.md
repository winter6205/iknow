---
name: boundary-testing
description: Run the boundary-testing protocol when a change crosses multiple files, hooks, states, or platforms — exit-code drift, state-key misalignment, cross-platform mtime precision, subagent smoke false-pass, whole-file rewrite of secret-bearing config. Use when "边界测试", "boundary test", "跨文件改动", "跨 hook 状态", "实施前验证", "force smoke". For the 5 input-class boundary coverage (empty/negative/overflow/concurrent/exception), use `defensive-contract-validator` instead.
bucket: engineering
type: technique
---

# Boundary Testing

Thin orchestration skill: delegate the 6-step protocol to two parallel
sub-agents (axis1 proponent + axis2 skeptic), then apply the Step 5 drift
gate. Do NOT run boundary checks inline.

## When to use

- A code change whose blast radius spans multiple files / hooks / states / platforms.
- "边界测试", "boundary test", "实施前验证", "force smoke".
- A subagent reported success but the change hits a real API boundary (FS, JSON, cwd) you suspect was not exercised.

## When not to use

- Single-line fix / user explicitly says "只改这一处".
- The 5 input-class boundary coverage (empty/negative/overflow/concurrent/exception) — use `defensive-contract-validator` (S2 输入类).

## Procedure

1. **Pinned target** — Fix the candidate change (commit/branch/file set) + 5-category coverage scope.
   完成判据: candidate change pinned to an unambiguous ref (base + HEAD); coverage scope stated.
2. **Eval source resolved** — Locate evals.json (axis1 produced) or draft on-the-fly from `references/cases.md`.
   完成判据: eval source identified, or draft plan recorded in the ticket.
3. **Protocol source pinned** — `references/protocol.md` (promoted from archive). No inline duplication of 6-step / detector exit-code contract / 5 categories.
   完成判据: protocol source = `arthurpower/skills/boundary-testing/references/protocol.md`; cited by pointer only.
4. **Spawn two agents in parallel** — Dispatch in a single message via the Agent tool:
   - `arthurpower:boundary-testing-axis1-agent` — drafts the 10-30 evals, runs subagent smoke (necessary but not sufficient), prepares the A/B baseline.
   - `arthurpower:boundary-testing-axis2-agent` — runs driver-level smoke on real FS / real JSON / real cwd, enforces the detector exit-code contract, calls Step 5 accept/reject.
     Inject the pinned target (step 1) and protocol source (step 3) into each call; do not paraphrase the 6-step flow or exit-code contract.
     完成判据: both agents return their tables with the exact `OVERALL` line.
5. **Aggregate side-by-side** — Merge the two reports (no cross-agent reranking, no combining verdicts). Preserve file:line evidence and the per-agent `OVERALL` lines. Count unresolved findings.
   完成判据: side-by-side aggregation produced, per-agent counts recorded.
6. **Drift gate** — Apply the Step 5 gate from `references/protocol.md`:
   - Required-behavior regression OR FP not down OR TP not up → **REJECT: stop the change**; emit remediation pointer.
   - Otherwise → ACCEPT.
     Final verdict line: `GATE: ACCEPT` or `GATE: REJECT: <reason>`.
     完成判据: gate verdict emitted; the change is adopted only iff ACCEPT.

## Review-stage placement

- Before change: `architecture-change-reviewer` gates the plan (5-verdict) when the change is multi-file.
- After change, before commit: this skill (6-step boundary protocol via two parallel sub-agents).
- Not to be confused with the 5 input-class coverage of `defensive-contract-validator` (S2 输入类).

## Acceptance Criteria

- [ ] The pinned target (base + HEAD) is explicit and reproducible.
- [ ] Eval source resolved (evals.json or on-the-fly draft plan).
- [ ] Protocol source references `references/protocol.md` by pointer only (no duplicated 6-step / exit-code contract / 5-category table).
- [ ] Both `boundary-testing-axis1-agent` and `boundary-testing-axis2-agent` were dispatched in parallel and returned tables with `OVERALL` lines.
- [ ] Reports from both axes are presented side-by-side without cross-agent reranking.
- [ ] Every finding includes category, file:line, evidence, and remediation where applicable.
- [ ] Step 5 drift gate verdict is emitted (ACCEPT or REJECT: reason) and adoption is gated on it.

## Verification

Skill type: technique
Bar level: minimum

- Confirm the frontmatter omits `disable-model-invocation`, keeping the skill model-invoked.
- Confirm `bucket: engineering` is preserved (so `link-skills.sh` chains it).
- Confirm the description front-loads `smoke` (the leading word) and carries the OD-04 redirect to `defensive-contract-validator`.
- Confirm no inline Python / detector command / exit-code contract / 6-step table / 5-category list appears in the body — all in `references/protocol.md`.
- Confirm `references/protocol.md` + `references/cases.md` promoted from `~/.claude/archive/rules/boundary-testing-*.md` (sole SSOT).
