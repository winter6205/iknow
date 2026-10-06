/**
 * ADR-0130 **eval state** — the headless, named, non-default entry for the
 * unsandboxed benchmark posture (docs/adr/0130; ADR-0119 Amendment
 * 2026-09-29; docs/CONTEXT.md 评测态).
 *
 * Benchmark evaluation runs inside a disposable task container, and the fence's
 * constant `--unshare-net` (ADR-0097 invariant #1) makes install-dependent tasks
 * unsolvable for reasons unrelated to the model. The operator ruled that
 * evaluation has no use for the fence, so this module opens exactly one named
 * face for it.
 *
 * Eval state is **not a second fence shape**. Its fence posture is what entering
 * yolo does, reached without a TUI: `fsMode: workspace` → **全局档** (holders
 * only, user-layer settings never rewritten), the bwrap fence retired wholesale
 * — so every route this entry mounts (foreground bash) runs bare — and the egress
 * seam retired with it (ADR-0119 §ruling 3). The fence carrier is therefore the
 * very same `YoloContext` holder the fence factory's single branch reads, applied
 * by the very same enter action, and the four routes run bare through it because
 * the fence is gone: **the parity is structural in the fence carrier and the
 * fence shape — the shape that could drift — not in a copy.**
 *
 * The permission axis is not part of that parity claim. Permission → `full_auto`
 * is **eval's own write**, on its own line below, and it is set because an
 * operator cannot answer per-call questions mid-benchmark (ADR-0139 §3): the two
 * axes never write each other, so an eval posture equal to yolo's would be a
 * coincidence rather than a guarantee. What the shared holder still prevents is
 * the drift that actually mattered — eval's fence shape diverging from yolo's.
 *
 * Route scope: retiring the fence retires all four routes wherever they are
 * mounted (ADR-0130 §2, true for yolo). The single eval entry is `surface:
 * "ask"`, which mounts only the foreground bash route — the background manager
 * and subagent manager are gated `surface !== "ask"` (`build-engine.ts`), and
 * the verify sandbox-run is only constructed by `chat-session` / `hub`. Those
 * three are structurally absent here, not retired-and-measured; see
 * `EVAL_STATE_NOTICE`.
 *
 * What does **not** retire here (ADR-0130 §2): the **hard-wall** (a matched deny
 * still intercepts before `full_auto` grants anything) and the **which-tree**
 * axis (writes still resolve against the live `taskRoot`). The worktree gate is
 * fence-independent and untouched.
 *
 * Two faces, deliberately not one (ADR-0130 §1 / ADR-0119 §ruling 7): `--yolo`
 * keeps refusing at parse time on the five non-TUI commands. Widening that
 * enumeration is what this ADR declines to do; eval state is a separate named
 * opt-in whose guard is its naming plus the ADR-0130 §5 reporting invariant, not
 * a relaxed flag list.
 *
 * Boundary: never persisted, per-invocation only — not a settings value, not a
 * default, not an env var that flips silently.
 */

import type {
  PermissionMode,
  PermissionModeContext,
} from "../permission/modes.js";
import type { FsModeContext } from "./fs-mode.js";
import { createYoloContext, createYoloController } from "./yolo.js";
import type { YoloContext } from "./yolo.js";

/** The named opt-in flag, available to the headless one-shot entries. */
export const EVAL_STATE_FLAG = "--eval-state";

/**
 * Where the permission axis lands for an eval-state invocation — eval's **own**
 * write, established here rather than inherited from the shared fence entry
 * (ADR-0139 §3). It reuses the existing `full_auto` semantics (the hard wall
 * still intercepts first) and adds no fourth `PermissionMode`.
 *
 * It cannot be inherited: ADR-0130 §2's central survival claim is that the hard
 * wall intercepts "before `full_auto` grants anything", which presupposes
 * `full_auto` is in force, and an operator cannot answer per-call questions
 * mid-benchmark — a benchmark that deadlocked on its own prompts would measure
 * the harness, not the model.
 */
const EVAL_STATE_PERMISSION_TARGET: PermissionMode = "full_auto";

/**
 * The state label a published number must carry (ADR-0130 §5). One string, so
 * the reporting invariant has a single greppable token to check against.
 */
export const EVAL_STATE_RUN_LABEL = "eval_state" as const;

export type EvalStateRunLabel = typeof EVAL_STATE_RUN_LABEL;

/**
 * The headless entries that take the flag: the one-shot JSON faces a benchmark
 * harness needs (one command, parseable output). Named narrowly on purpose —
 * `chat` (interactive REPL), `serve` (long-lived pool), `trace` (reader-only
 * panel) and `tui` (which has its own yolo posture) are not eval-state entries,
 * and carrying the flag there is a typed refusal rather than a silent ignore.
 */
export const EVAL_STATE_ACCEPTING_COMMANDS = ["ask", "oneshot"] as const;

/**
 * A resumed session contradicts eval state: the posture is per-invocation and
 * persists nothing, so a transcript cannot carry two of them. This is the flag
 * literal the conflict refusal names (`--resume` → `resumeId` in the parser).
 */
export const EVAL_STATE_RESUME_FLAG = "--resume";

/**
 * Entry notice (stderr, headless — there is no mode row to carry it). It states
 * both halves of the posture so a reader cannot mistake eval state for "no
 * guardrails": what retires with the fence, and what does not (ADR-0130 §2/§3).
 *
 * It is scoped to the routes the entry actually mounts. The ADR's "all four
 * routes run bare" is the STRUCTURAL consequence of the fence retiring, and it
 * holds where all four exist (yolo). The one eval entry is `surface: "ask"`,
 * which never mounts the background manager (`build-engine.ts`, `surface !==
 * "ask"`), never registers `spawn_subagent` (same gate), and never constructs
 * the verify sandbox-run (only `chat-session` / `hub` build one). Repeating the
 * four-route claim here would let a benchmark artifact read as a measurement of
 * background and subagent execution that never happened — the misattribution
 * ADR-0130 §5 exists to prevent. Naming what is absent is the honest half.
 */
export const EVAL_STATE_NOTICE =
  "eval_state: ADR-0130 eval state — bwrap fence retired on the foreground bash " +
  "route, egress seam off, permission full_auto, fs mode global. Not " +
  "guardrail-free: the hard-wall still intercepts before full_auto, and writes " +
  "still resolve against the live taskRoot. Scoped to what this entry mounts: " +
  "the ask entry has no background manager, no subagent worker and no verify " +
  "sandbox-run, so this run measures none of those three. Nothing is " +
  "persisted for this invocation; any number this run publishes must name " +
  "this state.";

/** Membership guard for the accepted-entry set (SSOT above). */
export function isEvalStateEntry(command: string): boolean {
  return (EVAL_STATE_ACCEPTING_COMMANDS as readonly string[]).includes(command);
}

/**
 * Typed refusal for an entry that does not take the flag — same discriminated-
 * union face as the yolo non-TUI refusal (specs/yolo-mode.md typed-error catch
 * contract: render `${kind}: ...`, never `String(err)`).
 *
 * The copy points at the named benchmark face and deliberately never mentions
 * `--yolo`: the two exceptions must stay distinguishable in a log.
 */
export interface EvalStateUnsupportedEntryError {
  readonly kind: "eval_state_unsupported_entry";
  readonly command: string;
  readonly message: string;
}

export function rejectEvalStateEntry(
  command: string
): EvalStateUnsupportedEntryError {
  return {
    kind: "eval_state_unsupported_entry",
    command,
    message:
      `eval_state_unsupported_entry: ${EVAL_STATE_FLAG} is available only on the ` +
      `headless one-shot entries (iknow ask / iknow "<query>"); '${command}' does ` +
      `not take it. Run 'iknow ask ${EVAL_STATE_FLAG} "<task>"' for an ADR-0130 ` +
      `eval-state invocation.`,
  };
}

/**
 * Typed refusal for a request that contradicts the posture itself: eval state is
 * per-invocation and persists nothing, so it cannot carry a resumed session (the
 * transcript would mix two postures). Fail-loud, per the repo's discipline of
 * refusing instead of silently dropping a flag.
 */
export interface EvalStateFlagConflictError {
  readonly kind: "eval_state_flag_conflict";
  readonly command: string;
  readonly flag: string;
  readonly message: string;
}

export function rejectEvalStateConflict(
  command: string,
  flag: string
): EvalStateFlagConflictError {
  return {
    kind: "eval_state_flag_conflict",
    command,
    flag,
    message:
      `eval_state_flag_conflict: ${EVAL_STATE_FLAG} cannot combine with '${flag}' ` +
      `on '${command}' — an eval-state run is per-invocation and persists nothing ` +
      `(ADR-0130), so it cannot carry a resumed session. Drop '${flag}'.`,
  };
}

/** The three holder axes an eval-state invocation runs with. */
export interface EvalStateHolders {
  readonly yolo: YoloContext;
  readonly permission: PermissionModeContext;
  readonly fsMode: FsModeContext;
}

/**
 * Enter eval state: apply the fence state-combination to the supplied holders,
 * set the permission posture through this entry's own write, and return the
 * fence-retire holder alongside them.
 *
 * It delegates the **fence** half to `createYoloController(...).enterAtLaunch()`
 * — the same action `iknow tui --yolo` runs, and the same holder the fence
 * factory's single branch reads. Reusing it is what keeps the fence shape
 * identical by construction rather than by copy.
 *
 * The **permission** half is written here, on its own line, and that asymmetry
 * is the decision rather than an accident (ADR-0139 §3). The two axes never
 * write each other, so eval's `full_auto` is no longer evidence of parity with
 * yolo — it is eval's own posture, set because an operator cannot answer
 * per-call questions mid-benchmark (see `EVAL_STATE_PERMISSION_TARGET`).
 *
 * No bwrap probe on either side: the launch branch skips entry probing (a host
 * without bwrap must not block a posture that needs no fence), and there is no
 * exit to probe — an eval-state invocation ends with the process, so the
 * symmetric-probe rule that protects a TUI session from restoring into a broken
 * fence has nothing to restore into.
 */
export function enterEvalState(initial: {
  readonly permission: PermissionModeContext;
  readonly fsMode: FsModeContext;
}): EvalStateHolders {
  const yolo = createYoloContext(false);
  const action = createYoloController({
    yolo,
    permission: initial.permission,
    fsMode: initial.fsMode,
  }).enterAtLaunch();
  if (!action.ok) {
    // Unreachable by construction (that branch only fires on the probed, in-session
    // entry). Fail closed anyway: silently assembling a run that kept the fence
    // would publish a number under a false label.
    throw new Error(`eval_state_entry_refused: ${action.text}`);
  }
  // The fence combination above touched the fsMode holder only; the permission
  // posture is this entry's own (ADR-0139 §3).
  initial.permission.set(EVAL_STATE_PERMISSION_TARGET);
  return { yolo, permission: initial.permission, fsMode: initial.fsMode };
}
