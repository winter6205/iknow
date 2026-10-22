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
import type { PresetId, PresetOverlay } from "./no-sandbox-marker.js";

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

/**
 * ADR-0141 guardrail: the preset entry refusals. Root is refused for BOTH
 * presets — retiring the fence as uid 0 removes the last boundary between the
 * session and the host, and the refusal is raised BEFORE the overlay is seeded
 * so nothing is declared on the way out.
 */
export type PresetEntryRefusalKind =
  | "yolo_non_tui_entry"
  | "preset_root_entry";

/** The typed refusal for a preset entry that must not proceed. */
export interface PresetEntryRefusal {
  readonly kind: PresetEntryRefusalKind;
  readonly command: string;
  readonly message: string;
}

/**
 * Root refusal for a preset entry. Same discriminated-union shape as
 * `YoloNonTuiEntryError` so one renderer covers both.
 */
export function rejectPresetAsRoot(command: string): PresetEntryRefusal {
  return {
    kind: "preset_root_entry",
    command,
    message:
      `preset_root_entry: --yolo / --no-sandbox retire the sandbox fence, ` +
      `which is refused while the process runs as root; '${command}' does not ` +
      `start. Run as an unprivileged user.`,
  };
}

/**
 * True when the process runs as root. `getuid` is absent on Windows, where the
 * question does not arise — the guard reads false there rather than refusing a
 * platform it cannot reason about.
 */
export function isRunningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
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
 * command. ADR-0141: the flag named in the message is the one actually typed,
 * because both preset flags share this refusal and telling an operator who typed
 * `--no-sandbox` to "drop --yolo" would send them looking for the wrong token.
 */
export function rejectYoloForCommand(
  command: string,
  flag: "yolo" | "no-sandbox" = "yolo"
): YoloNonTuiEntryError {
  const literal = flag === "yolo" ? "--yolo" : "--no-sandbox";
  return {
    kind: "yolo_non_tui_entry",
    command,
    message:
      `yolo_non_tui_entry: ${literal} is available only for the TUI entry ` +
      `(iknow tui); '${command}' does not support it. Drop ${literal}, or run ` +
      `'iknow tui ${literal}'.`,
  };
}

/**
 * Typed invariant violation (spec invariant 7: `fsMode: workspace` and a retired
 * fence are never simultaneously effective) — same discriminated union form as
 * `YoloNonTuiEntryError`, message rendered `${kind}: ${detail}`.
 */
export interface FenceRetirementInvariantError {
  readonly kind: "fence_retirement_invariant";
  readonly fsMode: FsIsolationMode;
  readonly message: string;
}

/** What the derivation consumes: the declared fence posture plus the effective fs tier. */
export interface FenceRetirementDeclaration {
  readonly fenceRetired: boolean;
  readonly fsMode: FsIsolationMode;
}

/**
 * The one site that derives `fenceRetired` (ADR-0141 §6 "derived at exactly one
 * site", spec invariant 2). `true` declared at `workspace` throws the typed
 * invariant error — never a silent correction (spec invariant 7).
 */
export function deriveFenceRetired(decl: FenceRetirementDeclaration): boolean {
  if (decl.fenceRetired === true && decl.fsMode === "workspace") {
    const err: FenceRetirementInvariantError = {
      kind: "fence_retirement_invariant",
      fsMode: decl.fsMode,
      message:
        `fence_retirement_invariant: fenceRetired=true is declared with ` +
        `fsMode="${decl.fsMode}" — a retired fence and a workspace tier are ` +
        "never simultaneously effective (spec invariant 7).",
    };
    throw err;
  }
  return decl.fenceRetired;
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

/**
 * ADR-0141: the face every consumer below the controller reads. It is
 * **get-only by construction** — a consumer cannot flip the axis, and it cannot
 * read the raw holder, so "the fence layer reads exactly one derived boolean"
 * is a type fact rather than a convention.
 *
 * The controller hands out the overlay-backed reader when a session overlay is
 * wired and falls back to the holder when it is not (the minimal assembly
 * shape), so `get()` is derived in every case.
 */
export interface FenceRetirementReader {
  /** The derived fence posture: true means the fence is retired for this call. */
  readonly get: () => boolean;
}

/** yolo initial value — defaults to `false` (V1 baseline: fence up, argv byte-identical to today). */
export const YOLO_DEFAULT = false;

/**
 * ADR-0141: env var carrying the derived fence posture across the same process
 * boundary (parent session → subagent worker). Sits with the other two
 * parent-set / worker-read wires (`IKNOW_WORKSPACE_ROOT` / `IKNOW_FS_MODE`);
 * the value domain is a single token `"1"` — the fence is a boolean axis, so the
 * wire carries presence, not a posture vocabulary. The parser SSOT is
 * `parseYoloFlag` in this module, which the worker applies fail-closed; a
 * worker that finds the var absent or unparsable keeps the default fenced
 * posture. The key renames with its carrier (ADR-0141): `IKNOW_YOLO` named the
 * preset, this names the axis.
 */
export const FENCE_RETIRED_ENV_KEY = "IKNOW_FENCE_RETIRED";

/**
 * The pre-ADR-0141 spelling, scrubbed alongside the current one so an ambient
 * value of either name can never seed a child. There is no compatibility shim
 * for the VALUE — only the scrub outlives the rename.
 */
export const LEGACY_YOLO_ENV_KEY = "IKNOW_YOLO";

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
  /**
   * ADR-0141: the session overlay the preset declares into. Absent keeps the
   * pre-overlay shape (a bare boolean holder with no declared axes).
   */
  readonly overlay?: PresetOverlay;
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
 * Pre-entry snapshot — the fence axis' own values only. Retained only for the
 * no-overlay assembly shape; with an overlay the declared axes replace it and
 * exit clears the overlay instead of restoring (ADR-0141, ruling 6 replaced).
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
   * Startup entry for `--yolo` / `--no-sandbox`: apply the same declaration as
   * the in-session entry, but without the probe-refusal gate — the holder was
   * already seeded true by `createYoloContext`, so the fence is retired at
   * assembly time on every host, and the requireBwrap sequencing ruling says a
   * bwrap-less host must not block preset assembly. The exit-side probe stays
   * symmetric (refusal to leave on such a host is the honest fail-closed).
   * Once-guard: a repeat call never re-seeds (ADR-0141).
   */
  readonly enterAtLaunch: () => YoloActionResult;
  /** Idempotent exit: not yolo -> no-op; yolo -> probe, then leave. */
  readonly exit: () => YoloActionResult;
  /**
   * ADR-0141: enter the `--no-sandbox` preset — fence retired + `fsMode: global`
   * declared, permission left alone. It declares two axes, so a later permission
   * change does not clear it.
   *
   * The already-on guard reads the **declared** preset when an overlay is wired,
   * not the yolo holder. The holder is seeded true at assembly for BOTH presets
   * (the fence must be retired from the first fenced call on any host), so a
   * holder-only guard would short-circuit the launch seed and leave the overlay
   * undeclared — a session with the fence up and no posture, which is the silent
   * drop this guard exists to distinguish from a real repeat entry.
   */
  readonly enterNoSandbox: () => YoloActionResult;
}

/** Successful-entry notice (consumed by the TUI). */
export const YOLO_ENTER_TEXT =
  "yolo mode ON — sandbox fence retired for this session (bash argv is bare; network and filesystem are unrestricted). /yolo again to exit.";

/** Idempotent notice when already in the yolo posture. */
export const YOLO_ALREADY_ON_TEXT = "yolo mode is already ON.";

/**
 * ADR-0141: the `--no-sandbox` entry notice. It names the two axes the preset
 * declared and states that permission is untouched, because that is what
 * separates this preset from the yolo one.
 */
export const NO_SANDBOX_ENTER_TEXT =
  "no-sandbox mode ON — sandbox fence retired for this session (bash argv is bare; network and filesystem are unrestricted); filesystem tier set to global; permission mode unchanged.";

/** Successful-exit notice. */
export const YOLO_EXIT_TEXT =
  "yolo mode OFF — sandbox fence restored; filesystem tier and permission mode are back to the values your settings hold (the preset is not persisted, so the next launch starts there too).";

/** Idempotent notice when exiting from a non-yolo posture. */
export const YOLO_ALREADY_OFF_TEXT = "yolo mode is already OFF.";

/**
 * Spread-guard helper for the S5 discipline — moves the "emit the key only when
 * the reader exists" branch out of every call site. `lint:s5:staged` gates
 * per-function complexity: one more ternary at a call site can push the hosting
 * god function over the threshold, while a named projection leaves the call site
 * branch-free.
 *
 * Semantics are byte-identical to the inline `...(reader !== undefined ? { reader } : {})`.
 */
export function fenceRetiredSpread(reader: FenceRetirementReader | undefined): {
  readonly fenceRetired?: FenceRetirementReader;
} {
  return reader !== undefined ? { fenceRetired: reader } : {};
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
 * Drop the overlay's declared axes and hand the holders back the tier that was
 * seeded in (the one the operator owned). Clearing the overlay alone is not
 * enough: the enter side wrote the declared axes into the holders, so without
 * this the session would keep running fenced-off-but-`full_auto` with an
 * overlay that says nothing is in force (ADR-0141 — no snapshot channel).
 */
function releaseOverlayTier(opts: YoloActionOptions, overlay: PresetOverlay): void {
  const tier = overlay.declaredTier();
  overlay.clear();
  if (tier.fsMode !== undefined) opts.fsMode?.set(tier.fsMode);
  if (tier.permission !== undefined) opts.permission?.set(tier.permission);
}

/**
 * Build the yolo controller.
 *
 * **Enter** (ADR-0141): the preset declares its axes into the overlay AND into
 * the holders, because a declaration no consumer reads is not one — the
 * permission policy reads `PermissionModeContext` and the fence reads the
 * fsMode holder, while `effectivePermission()` has no caller. `--yolo`
 * declares all three (fence, `fsMode: global`, `full_auto`); `--no-sandbox`
 * declares two and writes nothing to the permission holder, which is exactly
 * why it survives a later permission change. Entry is idempotent on the
 * **declared** state, and probes bwrap with zero state change on a host
 * without it.
 *
 * **Exit** — deliberately asymmetric with entry: leaving is always safe in
 * principle, but **still probes**. On a host without bwrap the exit is refused,
 * because with no usable non-yolo fence every bash call would become a runtime
 * failure, so refusing is the only honest fail-closed (ADR-0119 §requireBwrap
 * sequencing ruling). Otherwise clear the overlay whole and return both
 * holders to the tier that was seeded in — the value the operator owned, not
 * a snapshot taken at enter time (ADR-0141 deleted the snapshot channel).
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

  /**
   * ADR-0141: declare the preset's axes into the overlay instead of snapshotting.
   * The settings tier stays where the user put it — the overlay shadows it while
   * a preset is in force and exit drops the overlay rather than restoring.
   */
  const applyOverlayCombination = (preset: PresetId): void => {
    if (opts.overlay === undefined) {
      applyEnterCombination();
      return;
    }
    // Seed FIRST: this captures the tier the user owns, which is what `exit`
    // restores after the whole clear.
    opts.overlay.seedSettingsTier({
      fsMode: opts.fsMode?.get() ?? FS_ISOLATION_MODE_DEFAULT,
      permission: opts.permission?.get() ?? "default",
    });
    opts.overlay.declare(preset);
    // The declared axes must reach the HOLDERS, not only the overlay: the
    // permission policy reads `PermissionModeContext`, and nothing else reads
    // `effectivePermission()`. Without this write the yolo preset declares
    // `full_auto` into a field no consumer reads and ships as `--no-sandbox`
    // under another name. `--no-sandbox` declares no permission axis, so it
    // writes nothing here — which is exactly what makes it survive a later
    // permission change.
    if (preset === "yolo") opts.permission?.set("full_auto");
    opts.fsMode?.set("global");
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
    applyOverlayCombination("yolo");
    return { ok: true, yolo: true, text: YOLO_ENTER_TEXT };
  };

  const enterNoSandbox = (): YoloActionResult => {
    // Declared-state guard, not holder-state: at launch the holder is seeded
    // true for both presets while the overlay is still undeclared (see the
    // interface note). Reading the overlay makes "already on" mean "already
    // DECLARED", which is the only reading that distinguishes a repeat entry
    // from the first one.
    if (opts.overlay !== undefined) {
      if (opts.overlay.preset() !== undefined) {
        return { ok: true, yolo: true, text: YOLO_ALREADY_ON_TEXT };
      }
    } else if (opts.yolo.get()) {
      return { ok: true, yolo: true, text: YOLO_ALREADY_ON_TEXT };
    }
    try {
      probe();
    } catch (cause) {
      return { ok: false, text: yoloProbeRefusalText(cause) };
    }
    applyOverlayCombination("no-sandbox");
    return { ok: true, yolo: true, text: NO_SANDBOX_ENTER_TEXT };
  };

  const enterAtLaunch = (): YoloActionResult => {
    if (launchEntered) {
      return { ok: true, yolo: true, text: YOLO_ALREADY_ON_TEXT };
    }
    launchEntered = true;
    // The launch path applies the same declaration as `enter()`; `seedSettingsTier`
    // captures the startup tier first, so exit returns to it (ADR-0141).
    applyOverlayCombination("yolo");
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
    if (opts.overlay !== undefined) {
      releaseOverlayTier(opts, opts.overlay);
    } else if (snap?.fsMode !== undefined) {
      opts.fsMode?.set(snap.fsMode);
    }
    opts.yolo.set(false);
    return { ok: true, yolo: false, text: YOLO_EXIT_TEXT };
  };

  return Object.freeze({
    context: opts.yolo,
    enter,
    enterAtLaunch,
    exit,
    enterNoSandbox,
  });
}
