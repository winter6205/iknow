import type { AgentQaCase } from "../types.ts";

import { TASK_01 } from "./task/task-01-worktree-rename.case.ts";
import { TASK_02 } from "./task/task-02-write-file-bytes.case.ts";
import { TASK_03 } from "./task/task-03-todo-write-ledger.case.ts";
import { TASK_04 } from "./task/task-04-symbol-mutate-cross-file.case.ts";
import { TASK_05 } from "./task/task-05-acceptance-command-decides.case.ts";
import { TOOL_01 } from "./tool/tool-01-search-before-fetch.case.ts";
import { TOOL_02 } from "./tool/tool-02-symbol-surface-decides.case.ts";
import { TOOL_03 } from "./tool/tool-03-graph-dependency-routing.case.ts";
import { TOOL_04 } from "./tool/tool-04-escaping-path-refused.case.ts";
import { TURN_01 } from "./turn/turn-01-pivot-reconciles-ledger.case.ts";
import { TURN_02 } from "./turn/turn-02-constraint-across-turns.case.ts";
import { TURN_03 } from "./turn/turn-03-under-specified-ask.case.ts";
import { TURN_04 } from "./turn/turn-04-latest-instruction-wins.case.ts";
import { RECOVERY_01 } from "./recovery/recovery-01-error-result-recovers.case.ts";
import { RECOVERY_02 } from "./recovery/recovery-02-partial-effect-safe.case.ts";
import { RECOVERY_03 } from "./recovery/recovery-03-bounded-stop-no-duplicate.case.ts";
import { SAFETY_01 } from "./safety/safety-01-fetched-body-injection.case.ts";
import { SAFETY_02 } from "./safety/safety-02-synthetic-secret-sink.case.ts";
import { SAFETY_03 } from "./safety/safety-03-denied-stays-denied.case.ts";
import { SAFETY_04 } from "./safety/safety-04-forged-tool-result.case.ts";

/**
 * The static 20-slot registry. Import graph only — no directory scan — because a
 * dropped case must fail resolution loudly instead of silently shrinking the
 * denominator the report is measured against.
 *
 * Effect grammar, one closed set: `EFFECT_PREFIXES` in `../types.ts` is the vocabulary and
 * `EFFECT_POSITIONS` says which list each prefix is read from, so a slot file and the plan
 * boundary cannot drift apart. What each entry decides, read off `attempt.ts`:
 *   `bytes:<path>=<text>`   those exact bytes are on disk at <path>
 *   `unchanged:<path>`      <path> still equals its seed bytes, or is still absent
 *   `tool:<name>`           allowed: a dispatch is recorded / forbidden: none is
 *   `tool:<name>:succeeded` forbidden: a dispatch is recorded but never applied (refused
 *                              in the allowed list, where no dispatch row can match it)
 *   `denied:<tool>`         the dispatch is recorded with a violation prefix
 *   `stopped:<reason>`      the run ends on that runner-recorded stop reason
 *     (`maxTurns`, `fused`, `cancelled`)
 *   `write:<path>`          forbidden: a create landed at that path, so the path must not exist
 * Placeholder path roots `<worktree>`, `<main>`, `<todoDir>` are resolved by the
 * runner per attempt, mirroring the `<OWNER_ID>` convention the locked worktree
 * fixture already uses. `<worktree>` and `<main>` stay unresolved: an address the
 * offline runner cannot build is `unreadable`, never an absence.
 *
 * An oracle reads the decidable counterpart of the entries it lists in `owns`; with
 * `owns` absent it reads every entry its kind interprets. Two oracles of one kind that
 * decide different facts must therefore name them in `owns`, and where a slot declares
 * several oracles of one kind without `owns`, they state one graded verdict in different
 * words — each still says which fact it means.
 */
const CASES: readonly AgentQaCase[] = [
  TASK_01,
  TASK_02,
  TASK_03,
  TASK_04,
  TASK_05,
  TOOL_01,
  TOOL_02,
  TOOL_03,
  TOOL_04,
  TURN_01,
  TURN_02,
  TURN_03,
  TURN_04,
  RECOVERY_01,
  RECOVERY_02,
  RECOVERY_03,
  SAFETY_01,
  SAFETY_02,
  SAFETY_03,
  SAFETY_04,
];

export const AGENT_QA_CASES: readonly AgentQaCase[] = Object.freeze(
  [...CASES].sort((a, b) => (a.caseId < b.caseId ? -1 : 1))
);
