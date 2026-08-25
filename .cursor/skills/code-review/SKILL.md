---
name: code-review
description: Review Git changes when a ticket produces a code diff, after implementation and before commit. Use when the user asks to "审代码", "审 PR", "review", or "代码审查" against Standards and Spec axes. Orchestrates two parallel sub-agents and applies a severity gate.
bucket: engineering
type: technique
---

# Code Review

Thin orchestration skill: delegate Standards and Spec review to two parallel sub-agents, then apply a severity gate. Do not review code inline.

## When to use

- When a ticket produces a code diff and the main agent is about to commit.
- When the user asks to "审代码", "审 PR", "review", or "代码审查" against the per-ticket loop.
- When a review verdict (Standards + Spec) with severity gating is required before commit.

## When not to use

- Docs-only or config-only changes (no code diff to review).
- Pre-implementation plan review; use `architecture-change-reviewer` for that gate.
- Final pre-merge maintainability stage; use `maintainability-reviewer`.
- Standalone manual invocation of the legacy CLI wrapper; use the user-level slash command for upstream CLI review.

## Procedure

1. **Pinned ref** — Resolve the fixed diff point: pinned commit SHA, merge-base, branch, or tag (e.g. `git diff <base>..HEAD`). The ref must be unambiguous; capture base and HEAD explicitly.
   完成判据: pinned ref (base + HEAD) recorded and reproducible.

2. **Spec source resolved** — Resolve the spec source via the 4-level priority defined in `spec-reviewer-agent` (commit message issue ref → user-supplied path → repo `docs/` or `specs/` match → ask the caller). At level 4, halt the orchestrator and report the missing source instead of inventing requirements.
   完成判据: spec source identified, or level-4 blocker reported back to main agent.

3. **Standards source pinned** — Standards axis is sourced from `code-review-protocol` (§2.2 Fowler 12 smells, §4 severity levels) plus any repository coding standards. Do not duplicate the protocol in this skill; reference it.
   完成判据: standards source = `arthurpower/skills/code-review/references/protocol.md`; Fowler 12 + severity scale cited by pointer only.

4. **Spawn two agents in parallel** — Dispatch in a single message via the Agent tool:
   - `arthurpower:standards-reviewer-agent` — receives the pinned ref and standards source path; returns Standards-axis findings table with `OVERALL` line.
   - `arthurpower:spec-reviewer-agent` — receives the pinned ref and resolved spec source; returns Spec-axis findings table with `OVERALL` line.
     Inject the pinned ref (step 1), spec source (step 2), standards source (step 3) into each call; do not paraphrase severity definitions or the Fowler list.
     完成判据: both agents return findings tables (including no-finding results) with the exact `OVERALL` line.

5. **Aggregate side-by-side** — Merge the two findings tables into a single side-by-side report (no cross-axis reranking, no combining severities). Preserve file:line evidence and the per-axis `OVERALL` lines. Count unresolved findings per axis.
   完成判据: side-by-side aggregation table produced, per-axis counts recorded.

6. **Severity gate** — Apply the severity gate from `code-review-protocol` §4:
   - Unresolved High (either axis) → **BLOCKED: stop the commit**; emit remediation pointer for each High finding.
   - Medium (without a named follow-up ticket) → advisory; include in the commit report.
   - Low → informational only.
     Final verdict line: `GATE: PASS` or `GATE: BLOCKED: <N> High unresolved`.
     完成判据: gate verdict emitted (PASS or BLOCKED: N High); commit blocked iff High unresolved.

## Review-stage placement

Three-body time points:

- Before change: `architecture-change-reviewer` gates the plan (5-verdict).
- After change, before commit: this skill (Standards + Spec via two parallel sub-agents).
- Before merge: `maintainability-reviewer` performs the third-stage S1-S6 maintainability decision.

This skill is conditional: trigger only when the ticket produced a code diff; do not run on docs/config-only changes.

## Acceptance Criteria

- [ ] The pinned diff ref (base + HEAD) is explicit and reproducible.
- [ ] Spec source resolved via the 4-level priority, or level-4 blocker reported back.
- [ ] Standards source references `code-review-protocol` §2.2 and §4 by pointer only (no duplicated Fowler list).
- [ ] Both `standards-reviewer-agent` and `spec-reviewer-agent` were dispatched in parallel and returned findings tables with `OVERALL` lines.
- [ ] Findings from both axes are presented side-by-side without cross-axis reranking.
- [ ] Every finding includes severity, file:line, axis, problem, and remediation.
- [ ] Severity gate verdict is emitted (PASS or BLOCKED: N High) and commits are gated on it.

## Verification

Skill type: technique
Bar level: minimum

- Confirm the frontmatter omits `disable-model-invocation`, keeping the skill model-invoked.
- Confirm `bucket: engineering` is preserved.
- Confirm the description states a conditional trigger ("when a ticket produces a code diff") and no longer references the upstream CLI wrapper.
- Confirm no inline CLI command, executable build, or binary path appears in the body.
- Confirm the Fowler 12 smell list is referenced by pointer (protocol §2.2), not duplicated in body.
- Confirm `references/protocol.md` is unchanged (git diff scope limited to `SKILL.md`).
