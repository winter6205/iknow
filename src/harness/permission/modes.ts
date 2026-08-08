/**
 * Permission modes (W2).
 *
 * Mirrors upstream openharness `PermissionMode` (`default` | `plan` |
 * `full_auto`), adapted to our three-layer policy. Hard-walls remain
 * un-overrideable in every mode — these modes only affect how the policy
 * resolves the gap between read-only (auto-allow) and mutating (ask by
 * default).
 *
 * Modes:
 *   - "default":   read-only → allow; mutating → ask user.
 *                  (Today's behavior — preserves y/N safety net.)
 *   - "plan":      read-only → allow; mutating → deny (without asking).
 *                  For "只看不改" planning sessions.
 *   - "full_auto": read-only → allow; mutating → allow (no prompt).
 *                  User explicitly opted in; useful for autonomous batches
 *                  and startup scripts. Hard-walls still block sensitive
 *                  paths + dangerous commands.
 *
 * Why this exists alongside session-grants:
 *   - session-grants is per-rule (e.g. "always allow `bash` when its
 *     command passes the allowlist"); modes are global on/off for the
 *     whole mutating surface. Both compose: a session grant still applies
 *     on top of `default`; `full_auto` makes session grants redundant.
 *   - The mode holder is process-level mutable so `/permissions full_auto`
 *     can flip it in a running REPL.
 */
export const PERMISSION_MODES = ["default", "plan", "full_auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Sentinel value used to mean "no mode set yet" in env parsing. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/** Parse a raw string into a mode, returning undefined on invalid input. */
export function parsePermissionMode(raw: unknown): PermissionMode | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if ((PERMISSION_MODES as readonly string[]).includes(v)) {
    return v as PermissionMode;
  }
  return undefined;
}

/**
 * Mutable mode holder — lets a REPL slash command flip the mode at
 * runtime while the harness engine is the same object. The holder is
 * frozen; only `set` mutates internal state.
 */
export interface PermissionModeContext {
  readonly get: () => PermissionMode;
  readonly set: (mode: PermissionMode) => void;
}

export function createPermissionModeContext(
  initial: PermissionMode = DEFAULT_PERMISSION_MODE
): PermissionModeContext {
  let current: PermissionMode = initial;
  return Object.freeze({
    get: () => current,
    set: (mode: PermissionMode) => {
      current = mode;
    },
  });
}

/**
 * Normalize either a static mode or a mutable context into a context. Lets
 * `createPermissionPolicy` accept either shape without callers having to
 * remember which one they have.
 */
export function asModeContext(
  mode: PermissionModeContext | PermissionMode | undefined
): PermissionModeContext {
  if (mode === undefined) {
    return createPermissionModeContext();
  }
  if (typeof mode === "string") {
    return createPermissionModeContext(mode);
  }
  return mode;
}

/**
 * Human-readable label for a permission mode (used by TUI / REPL UI).
 *
 * Mirrors upstream openharness `_MODE_LABELS` in `ui/protocol.py`:
 *   - default   → "Default"
 *   - plan      → "Plan Mode"
 *   - full_auto → "Auto"
 *
 * Display-only — `IKNOW_PERMISSION_MODE` env + `parsePermissionMode` SSOT
 * remain pinned to the canonical enum values. Adding an alias here would
 * silently widen the parser surface.
 */
export function modeLabel(
  mode: PermissionMode
): "Default" | "Plan Mode" | "Auto" {
  switch (mode) {
    case "default":
      return "Default";
    case "plan":
      return "Plan Mode";
    case "full_auto":
      return "Auto";
  }
}

/**
 * Shift+Tab cycle for the permission mode (TUI / REPL quick toggle).
 *
 * Stable cycle:
 *   - default   → full_auto
 *   - full_auto → default
 *   - plan      → full_auto
 *   - full_auto → default
 *
 * `plan` is deliberately NOT a cycle target — pressing Shift+Tab in `plan`
 * jumps straight to `full_auto` (the "go" mode) and never silently re-enters
 * `default`. Plan mode is entered/exited only via `/permissions plan` so the
 * planning session cannot be flushed by an accidental Shift+Tab.
 */
export function nextShiftTabMode(current: PermissionMode): PermissionMode {
  if (current === "full_auto") return "default";
  return "full_auto";
}

/**
 * The shape of a key event consumed by `applyShiftTabModeFlip`. Loose enough
 * to accept both ink's `Key.tab/ctrl/...` boolean and node:readline's
 * `Key.name/shift/...` shape, so TUI and REPL can share the helper.
 */
export interface ShiftTabKeyShape {
  readonly name?: string | undefined;
  readonly shift?: boolean | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
}

/**
 * Apply a Shift+Tab keystroke to the permission mode.
 *
 * Guards: `key.name === "tab" && key.shift && !key.ctrl && !key.meta`.
 * Anything else is a no-op (returns `false`). When the guard passes,
 * `ctx.set(nextShiftTabMode(ctx.get()))` is invoked and `onFlip(next)`
 * fires. `ctx === undefined` (ask/serve paths) short-circuits.
 *
 * Single source of truth for the keystroke → mode-flip mapping; both the
 * TUI `useInput` handler (ink `Key`) and the REPL stdin keypress listener
 * (node:readline `Key`) call into this — change the guard policy here and
 * both surfaces update in lockstep.
 */
export function applyShiftTabModeFlip(opts: {
  readonly key: ShiftTabKeyShape | undefined;
  readonly ctx: PermissionModeContext | undefined;
  readonly onFlip: (next: PermissionMode) => void;
}): boolean {
  const k = opts.key;
  if (!k) return false;
  if (k.name !== "tab" || !k.shift || k.ctrl || k.meta) return false;
  const modeCtx = opts.ctx;
  if (!modeCtx) return false;
  const next = nextShiftTabMode(modeCtx.get());
  modeCtx.set(next);
  opts.onFlip(next);
  return true;
}
