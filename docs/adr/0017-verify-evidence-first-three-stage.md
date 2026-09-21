# 0017. verify verdict moves to an evidence-first three-stage flow: evidence check -> supplementary re-run -> evidence-aware judge; never re-run when evidence is sufficient

Date: 2026-08-16
Status: accepted

Partial supersede: only the completion-direction invitation scope is superseded by ADR-0024 (the rest of this decision stands).

Context: verify on master was an A-or-B binary model — "command configured in settings -> re-run in sandbox / command missing -> judge inspects blind", with `verify.command` as the only key that activates verification; the judge actually received the full tool surface and only the task field.

Decision: Refactored into a three-stage verdict flow (sewn into `verify-loop.ts` produceObservation): (1) `checkEvidence` tri-state verdict first — `EVIDENCE_SUFFICIENT` passes directly at zero LLM cost, **never re-running even when a command is configured**; (2) `INSUFFICIENT` -> at most one supplementary re-run envelope (command = `verify.command` preferred, otherwise D2 probing); (3) still insufficient -> evidence-aware read-only judge as fallback (formula not re-bound + evidenceContext), four-state output, `unverified`/`abort` -> stop on `unstable`, no envelope injected, result returned to the user as-is. `verify.command` is downgraded to an optional supplementary-re-run / forced-rerun override; the field is neither deleted nor renamed.

Why: a completed run with solid evidence passes at zero cost; fail-closed — never PASS when unsure ("a verifier that bluffs is worse than none"). Existing mechanisms on the command path (sandbox fence / confirmation ladder / trend arbiter / escalate) are frozen and unchanged; evidence-first is only inserted upstream of them. The checker's tri-state is mapped back to the closed-loop Verdict before entering trend evaluation (SUFFICIENT->pass / CONTRADICTED->true-failure / unverified·abort->unstable).

Evidence: both companion specs of this decision passed ACR 5/5; the parent-map G1-G5 resolutions have been merged into this section.
