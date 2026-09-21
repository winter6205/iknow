# 0018. goal is the user's fixed anchor, taskFocus the deterministic task focus; the model has zero write path to either

Date: 2026-08-16
Status: superseded by 0026

Still in force: `session.goal` as the user-pinned anchor (`/goal` / `## GOAL:`, `source = user_pin`) with zero model writes. Retired: the `session.taskFocus` field and the judging-layer fallback `goal.text ?? taskFocus.text ?? query`. For current behavior read ADR-0024 (judge modules) + ADR-0026 (task excerpts).

Context: `session.goal` served two roles at once, conflating "user-pinned anchor" with "model-advanceable live object"; the goal-lifecycle decision series required the split and wholesale trimmed the earlier scheme's propose/confirm side channels.

Decision: split into `session.goal` (written only by `/goal <text>` / `## GOAL: <text>`, `source = user_pin`, not model-writable, cleared only via `/goal clear`) + `session.taskFocus` (deterministic extraction, no LLM in v1, rendered only at compact boundaries). On-disk migration: legacy `goal.source === "user_initial"` becomes `taskFocus`; `model_proposed` is removed from `GoalSource` / `VALID_GOAL_SOURCES` / trace entirely; the single task-value formula = `goal.text ?? taskFocus.text ?? query` (the judging layer reads it, never writes back). Both goal write entry points go through `validateGoalText` (non-empty + ≤ 2000).

Why: a single mixed field let the model drift the user's mission; after the split, the permission boundary (user writes goal / system deterministically writes taskFocus / judging layer consumes read-only) becomes a type-level fact. Adding an optional field to the schema does not bump the version, per session-persistence precedent (`CURRENT_SCHEMA_VERSION` stays 5).

Supersede chain: ADR-0018 §judging formula was superseded by ADR-0024 (after the verify/goal remediation series). ADR-0018 §taskFocus residency + compact focus rendering was superseded by ADR-0026 (after the task-excerpt series). The `session.goal` split and zero model writes still hold. See ADR-0026 for extract-at-compact rendering of up to 3 qualifying user-task sentences (task excerpts replace the `session.taskFocus` field and the 240+history+cap720 focus rendering).

Evidence: the accompanying spec passed ACR 5/5 (later superseded and archived by the task-excerpt remediation); its decision bullets settled the OQ2 switching algorithm / OQ3 no-version-bump. Replacement: ADR-0026 (recent-user-tasks spec).
