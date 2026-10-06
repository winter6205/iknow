/**
 * `--yolo` no-sandbox mode — the single point of the session-level "retire the
 * whole fence" switch (ADR-0119, specs/yolo-mode.md).
 *
 * yolo is **not** a `PermissionMode` (authorization axis), **not** a
 * `FsIsolationMode` (fs-tier axis), **not** `worktreeOnMutate` (write gate) — it
 * is an independent boolean axis: whether the `bwrap` fence exists at all.
 *   - `false` (default) — today's shape: all four routes (foreground bash /
 *     background spawn / verify sandbox-run / subagent worker) assemble a fence
 *     through `createBwrapFence`.
 *   - `true`            — the fence retires: no bwrap argv, no netns, the egress
 *     seam is skipped.
 *
 * This module owns three things (mirroring the shape of `FsModeContext` in
 * `sandbox/fs-mode.ts`):
 *   - **value-domain guard**: `parseYoloFlag` — fail-closed parsing of arbitrary
 *     input (only explicit truthy tokens match; everything else is false and it
 *     never throws).
 *   - **mutable holder**: `YoloContext` — flipped in place at runtime, so no
 *     engine rebuild is needed.
 *   - **enter / exit actions**: `createYoloController` — the idempotent fence
 *     state combination (fsMode snapshot + `global`, restore on exit) plus the
 *     symmetric bwrap probe on both sides (a host without bwrap is refused
 *     either way). The **permission axis is not part of it**: yolo writes the
 *     fence axis only, in both directions (ADR-0139).
 *
 * Boundary (ADR-0119 §ruling 8): **never persisted**. The holder is pure memory —
 * not in settings, not in the session file, no config-panel row; each session
 * passes an explicit initial value.
 */

import { ToolExecutionError } from "../errors.js";
import type { PermissionModeContext } from "../permission/modes.js";
import type { FsIsolationMode, FsModeContext } from "./fs-mode.js";
import { FS_ISOLATION_MODE_DEFAULT } from "./fs-mode.js";
import { requireBwrap } from "./runner.js";

/**
 * Typed refusal for a non-TUI entry point carrying `--yolo` — discriminated
 * union form (ADR-0119 §ruling 7 / spec EXIT). It fires on the five public
 * session entries `chat` / `serve` / `ask` / `oneshot` / `trace`, which then exit
 * non-zero without starting.
 *
 * Rendering: the message follows `${kind}: ${detail}`, never
 * `err instanceof Error ? err.message : String(err)`, which would collapse a
 * plain object (code-quality.md typed-error catch contract).
 */
export interface YoloNonTuiEntryError {
  readonly kind: "yolo_non_tui_entry";
  readonly command: string;
  readonly message: string;
}

/** The non-TUI commands that reject `--yolo` (ADR-0119 §ruling 7). */
export const YOLO_TUI_ONLY_REJECTED_COMMANDS = [
  "chat",
  "serve",
  "ask",
  "oneshot",
  "trace",
] as const;

/**
 * Single constructor for the non-TUI typed refusal — all five entries share it,
 * so the message has one source.
 *
 * `command` is echoed verbatim so `iknow chat --yolo` names the offending
 * command; the copy matches the usage text (pointing at `iknow tui --yolo`).
 */
export function rejectYoloForCommand(command: string): YoloNonTuiEntryError {
  return {
    kind: "yolo_non_tui_entry",
    command,
    message:
      `yolo_non_tui_entry: --yolo is available only for the TUI entry (iknow tui); ` +
      `'${command}' does not support it. Drop --yolo, or run 'iknow tui --yolo'.`,
  };
}

/**
 * yolo-axis holder — same shape as `FsModeContext` / `PermissionModeContext` /
 * `GraphModeContext`: flipped in place at runtime, no engine rebuild.
 */
export interface YoloContext {
  /** Current reading. */
  readonly get: () => boolean;
  /** Flip in place (normalized fail-closed through `parseYoloFlag`). */
  readonly set: (on: boolean) => void;
}

/** yolo initial value — defaults to `false` (V1 baseline: fence up, argv byte-identical to today). */
export const YOLO_DEFAULT = false;

/**
 * ADR-0119: env var carrying the yolo posture across the same process
 * boundary (parent session → subagent worker). Sits with the other two
 * parent-set / worker-read wires (`IKNOW_WORKSPACE_ROOT` / `IKNOW_FS_MODE`);
 * the value domain is a single token `"1"` — yolo is a boolean axis, so the
 * wire carries presence, not a posture vocabulary. The parser SSOT is
 * `parseYoloFlag` in this module, which the worker applies fail-closed; a
 * worker that finds the var absent or unparsable keeps the default fenced
 * posture (byte-identical to the pre-wire shape). The key is defined here
 * (not in `config/workspace-root.ts`) because new env keys for the yolo axis
 * live in the yolo module.
 */
export const YOLO_ENV_KEY = "IKNOW_YOLO";

/**
 * Literal parsing for `--yolo` / env values — any input fails closed to `false`
 * and never throws.
 *
 * Unlike `parseFsModeFlag`, an invalid yolo value has no "reject" semantics left
 * (there is nothing to reject a boolean into), so it is treated as false —
 * keeping the fence up is the fail-closed direction (ADR-0119 Contract: "invalid
 * yolo value -> false, fail-closed, no throw").
 *
 * Truthy set: `true` / `"true"` / `"1"` / `"on"` / `"yes"` (trim + lowercase).
 */
export function parseYoloFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== "string") return false;
  const token = raw.trim().toLowerCase();
  return token === "true" || token === "1" || token === "on" || token === "yes";
}

/**
 * Build the yolo holder. `initial` is normalized fail-closed through
 * `parseYoloFlag`, so invalid input lands on false (fence up) and never leaks a
 * bogus state into downstream fence assembly.
 */
export function createYoloContext(
  initial: unknown = YOLO_DEFAULT
): YoloContext {
  let current: boolean = parseYoloFlag(initial);
  return Object.freeze({
    get: () => current,
    set: (on: boolean) => {
      current = parseYoloFlag(on);
    },
  });
}

/**
 * Dependency face for the enter / exit actions — the state holders plus a
 * bwrap availability probe.
 *
 * An absent `permission` / `fsMode` means that axis does not join the enter /
 * exit combination (only the yolo axis flips), which keeps tests and minimal
 * assembly possible.
 *
 * `permission` is carried but **deliberately never read, written, snapshotted
 * or restored** by any action here: the permission axis is fence-independent in
 * both directions (ADR-0139), so the fence axis may not move it. It stays on
 * this face because it is the shape callers already wire — `run.tsx` passes
 * every session axis in one object — and because holding the real holder makes
 * fence-independence testable as a claim about the object handed in rather
 * than about a holder the controller never saw. An entry that wants a posture
 * of its own writes it itself; `eval-state.ts` is the one that does.
 *
 * `probe` is injectable for tests; the production default is `requireBwrap`
 * (`spawnSync("bwrap", ["--version"])` in `runner.ts`, throwing
 * `ToolExecutionError` when unavailable).
 */
export interface YoloActionOptions {
  readonly yolo: YoloContext;
  readonly permission?: PermissionModeContext;
  readonly fsMode?: FsModeContext;
  /** bwrap availability probe — throws when unavailable. Defaults to `requireBwrap`. */
  readonly probe?: () => void;
}

/**
 * Enter / exit result — the TUI notice consumption face (spec EXIT: refused ->
 * zero state change + notice, session continues).
 */
export type YoloActionResult =
  | { readonly ok: true; readonly yolo: boolean; readonly text: string }
  | { readonly ok: false; readonly text: string };

/**
 * Pre-entry snapshot — the fence axis' own values only. What makes repeated
 * entry idempotent: a second entry must not re-snapshot, or the snapshot gets
 * polluted by the previous yolo posture and exit can no longer restore the real
 * pre-entry fs tier.
 */
interface YoloSnapshot {
  readonly fsMode: FsIsolationMode | undefined;
}

/**
 * yolo controller — single point for the enter / exit actions plus the snapshot.
 *
 * Division of labour against the bare `YoloContext`: the context is the read-only
 * "is this yolo right now" face other modules read; the controller owns the
 * snapshot and the state combination, and is used only by the TUI command face and
 * the startup entry.
 */
export interface YoloController {
  readonly context: YoloContext;
  /** Idempotent entry: already yolo -> no second snapshot, no repeat probe. */
  readonly enter: () => YoloActionResult;
  /**
   * Startup entry for `--yolo` (ADR-0119 §launch): apply the same state
   * combination as `enter()`, but without the probe-refusal gate — the holder
   * was already seeded true by `createYoloContext`, so the fence is retired at
   * assembly time on every host, and the spec's requireBwrap sequencing ruling
   * says a bwrap-less host must not block yolo assembly. The exit-side probe
   * stays symmetric (refusal to leave on such a host is the honest
   * fail-closed). Once-guard: a repeat call never re-snapshots (ruling 6).
   */
  readonly enterAtLaunch: () => YoloActionResult;
  /** Idempotent exit: not yolo -> no-op; yolo -> probe, then leave. */
  readonly exit: () => YoloActionResult;
}

/** Successful-entry notice (consumed by the TUI). */
export const YOLO_ENTER_TEXT =
  "yolo mode ON — sandbox fence retired for this session (bash argv is bare; network and filesystem are unrestricted). /yolo again to exit.";

/** Idempotent notice when already in the yolo posture. */
export const YOLO_ALREADY_ON_TEXT = "yolo mode is already ON.";

/** Successful-exit notice. */
export const YOLO_EXIT_TEXT =
  "yolo mode OFF — sandbox fence restored; fs mode rolled back to its pre-yolo value; the permission posture was never touched and is unchanged.";

/** Idempotent notice when exiting from a non-yolo posture. */
export const YOLO_ALREADY_OFF_TEXT = "yolo mode is already OFF.";

/**
 * Spread-guard helper for the S5 discipline — moves the "emit the key only when
 * the holder exists" branch out of every call site. `lint:s5:staged` gates
 * per-function complexity: one more ternary at a call site can push the hosting
 * god function over the threshold, while a named projection leaves the call site
 * branch-free.
 *
 * Semantics are byte-identical to the inline `...(holder !== undefined ? { holder } : {})`.
 */
export function yoloHolderSpread(holder: YoloContext | undefined): {
  readonly yolo?: YoloContext;
} {
  return holder !== undefined ? { yolo: holder } : {};
}

/**
 * Membership guard for the non-TUI refusal domain — the five session commands
 * are decided from `YOLO_TUI_ONLY_REJECTED_COMMANDS` (SSOT above) so the parse
 * gate and the constant cannot drift.
 */
export function isYoloRejectedCommand(command: string): boolean {
  return (YOLO_TUI_ONLY_REJECTED_COMMANDS as readonly string[]).includes(
    command
  );
}

/**
 * Entry refusal on a host without bwrap — carries the install guidance
 * (ADR-0119 §requireBwrap sequencing ruling / spec EXIT).
 */
export function yoloProbeRefusalText(cause: unknown): string {
  return (
    "yolo mode refused: bwrap is not available on this host, and /yolo needs a " +
    "working fence to fall back to. Install bubblewrap (>= 0.11.1) — " +
    "`apt install bubblewrap` or your distro equivalent — then retry. " +
    `(${typedCauseText(cause)})`
  );
}

/**
 * Exit refusal on a host without bwrap — carries the "install bwrap or quit the
 * TUI" guidance (ADR-0119 §requireBwrap sequencing ruling: with no usable non-yolo
 * fence, refusing is the only honest fail-closed).
 */
export function yoloExitRefusalText(cause: unknown): string {
  return (
    "yolo mode refused to exit: bwrap is not available on this host, so leaving " +
    "yolo would turn every bash call into a runtime failure. Install bubblewrap " +
    "(>= 0.11.1) and retry, or quit the TUI. " +
    `(${typedCauseText(cause)})`
  );
}

/**
 * typed-error catch contract (code-quality.md) — recognize the
 * `ToolExecutionError` message first (`requireBwrap`'s install copy); unknown
 * errors keep their name instead of collapsing to `[object Object]`.
 */
function typedCauseText(cause: unknown): string {
  if (cause instanceof ToolExecutionError) return cause.message;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return "unknown cause";
}

/**
 * Build the yolo controller.
 *
 * **Enter** (spec / ADR-0119 §ruling 1, 6, 8, as amended by ADR-0139): return
 * idempotently when already yolo; probe bwrap and refuse with zero state change
 * on a host without it; snapshot the fsMode holder; force a non-default fsMode
 * to `global` through the holder only, never rewriting user settings; then set
 * yolo true. The permission axis is not read, written, snapshotted or restored
 * on any entry path (ADR-0139) — the fence axis writes the fence axis.
 *
 * **Exit** — deliberately asymmetric with entry: leaving is always safe in
 * principle, but **still probes**. On a host without bwrap the exit is refused,
 * because with no usable non-yolo fence every bash call would become a runtime
 * failure, so refusing is the only honest fail-closed (ADR-0119 §requireBwrap
 * sequencing ruling). Otherwise restore the snapshotted fsMode, then set yolo
 * false.
 *
 * **Launch entry** (`enterAtLaunch`): the `--yolo` startup path applies the
 * same combination as enter — the flag only seeds the holder, which by itself
 * leaves the fs tier as it was while the fence is already gone.
 */
export function createYoloController(opts: YoloActionOptions): YoloController {
  const probe = opts.probe ?? requireBwrap;
  let snapshot: YoloSnapshot | undefined;
  let launchEntered = false;

  /** The enter state combination — shared by `enter()` and `enterAtLaunch()`. */
  const applyEnterCombination = (): void => {
    snapshot = { fsMode: opts.fsMode?.get() };
    // A `fsMode: workspace` tier has nothing to carry it without a fence, so it
    // forces back to `global` through the holder only (ADR-0092 "flip in place
    // through the holder at runtime"); exit restores the snapshot.
    if (
      opts.fsMode !== undefined &&
      opts.fsMode.get() !== FS_ISOLATION_MODE_DEFAULT
    ) {
      opts.fsMode.set(FS_ISOLATION_MODE_DEFAULT);
    }
    opts.yolo.set(true);
  };

  const enter = (): YoloActionResult => {
    if (opts.yolo.get()) {
      return { ok: true, yolo: true, text: YOLO_ALREADY_ON_TEXT };
    }
    try {
      probe();
    } catch (cause) {
      // EXIT: no bwrap -> entry refused, zero state change, session continues
      // (spec EXIT / ADR-0119 §requireBwrap sequencing ruling).
      return { ok: false, text: yoloProbeRefusalText(cause) };
    }
    applyEnterCombination();
    return { ok: true, yolo: true, text: YOLO_ENTER_TEXT };
  };

  const enterAtLaunch = (): YoloActionResult => {
    if (launchEntered) {
      return { ok: true, yolo: true, text: YOLO_ALREADY_ON_TEXT };
    }
    launchEntered = true;
    // Snapshot is taken before the flip, so a yolo session that started via
    // `--yolo` rolls back to its startup values on exit (ADR-0119 §ruling 8).
    applyEnterCombination();
    return { ok: true, yolo: true, text: YOLO_ENTER_TEXT };
  };

  const exit = (): YoloActionResult => {
    if (!opts.yolo.get()) {
      return { ok: true, yolo: false, text: YOLO_ALREADY_OFF_TEXT };
    }
    try {
      probe();
    } catch (cause) {
      // EXIT: exit refused — without a usable bwrap fence, leaving yolo would turn
      // every bash call into a runtime failure; refusing is the only honest
      // fail-closed and state stays untouched (ADR-0119 §requireBwrap ruling).
      return { ok: false, text: yoloExitRefusalText(cause) };
    }
    const snap = snapshot;
    snapshot = undefined;
    if (snap?.fsMode !== undefined) opts.fsMode?.set(snap.fsMode);
    opts.yolo.set(false);
    return { ok: true, yolo: false, text: YOLO_EXIT_TEXT };
  };

  return Object.freeze({ context: opts.yolo, enter, enterAtLaunch, exit });
}
