/**
 * `/permissions` command semantics — the single implementation shared by the
 * REPL (src/cli/chat-session.ts) and the TUI (src/tui/app.tsx).
 *
 * Why this module exists: the three-value parse, the status echo and the usage
 * error used to be inline in the REPL's `/permissions` case, so the TUI had no
 * entry for the command at all — the TUI could render "Plan Mode"
 * (`modeLabel`) but never enter it. A second copy is exactly how that gap
 * happened; parse / status / usage therefore live here once, mirroring
 * `graph/mode.ts`'s GraphCommand block and `sandbox/fs-mode.ts`'s ConfigCommand
 * block (same four-part shape: command union, usage constant, parse, apply).
 *
 * Boundary, deliberately drawn:
 *  - **What a mode means** stays in `modes.ts` (`PERMISSION_MODES` is the value
 *    domain; `parsePermissionMode` is the parse; `nextShiftTabMode` keeps `plan`
 *    off the Shift+Tab wheel). This module owns only the *command surface*.
 *  - **"Holder absent" is not shared.** ask / serve install no permission
 *    holder, and each entry carries its own wording for that (the REPL's
 *    `applyHolderSlash` unavailable text; the TUI's fallback context means its
 *    case never takes that branch).
 *  - `ok: false` means nothing changed and `text` is the usage line; carriers
 *    decide stdout vs stderr / notice — the `/graph` + `/config` split.
 *
 * The literals here are the REPL's, byte-for-byte: the acceptance is shared
 * behaviour, not restyled copy.
 */

import {
  parsePermissionMode,
  type PermissionMode,
  type PermissionModeContext,
} from "./modes.js";

/** Usage line for any non-status, non-mode input. Never echoes user input. */
export const PERMISSIONS_USAGE_TEXT =
  "Usage: /permissions [default|plan|full_auto]（或空 / status 查看当前）";

/** `/permissions` states: query the mode, flip it, or report usage. */
export type PermissionsCommand =
  | { readonly kind: "status"; readonly withUsage?: boolean }
  | { readonly kind: "set"; readonly mode: PermissionMode }
  | { readonly kind: "usage" };

/**
 * Parse `/permissions` args (shared by both entries).
 *
 *  - empty / `status` → status; `help` → status plus the usage hint;
 *  - one of the three modes (trim + lowercase, via `parsePermissionMode`) → set;
 *  - anything else → usage.
 *
 * Surplus args follow the REPL's existing contract — the first token decides
 * (`/permissions plan extra` sets `plan`) rather than erroring. `/graph` and
 * `/config` reject surplus args instead; that difference is inherited, not
 * chosen here: changing it would silently restyle a shipped REPL command, and
 * this bullet is about making the mode reachable, not about re-deciding parse
 * strictness.
 */
export function parsePermissionsCommand(
  args: ReadonlyArray<string>
): PermissionsCommand {
  const head = (args[0] ?? "").trim().toLowerCase();
  if (head === "" || head === "status") return { kind: "status" };
  if (head === "help") return { kind: "status", withUsage: true };
  const mode = parsePermissionMode(head);
  if (mode !== undefined) return { kind: "set", mode };
  return { kind: "usage" };
}

/**
 * Status echo. Prints the raw enum, not `modeLabel`: the REPL has always shown
 * the value `/permissions` accepts (`default` / `plan` / `full_auto`), and a
 * status line that cannot be typed back is a worse answer.
 */
export function formatPermissionStatus(
  mode: PermissionMode,
  opts?: { readonly withUsage?: boolean }
): string {
  const hint =
    opts?.withUsage === true
      ? "  · 用法: /permissions [default|plan|full_auto]"
      : "";
  return `权限模式: ${mode}${hint}`;
}

/** Execution result: `ok=false` means nothing changed; `text` is user-visible. */
export interface PermissionsCommandResult {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Execute one `/permissions` command against the holder and return the
 * user-visible text. Both entry points call this; only the carrier differs
 * (REPL routes `ok` to stdout and `!ok` to stderr, the TUI shows it as a notice).
 */
export function applyPermissionsCommand(
  ctx: PermissionModeContext,
  args: ReadonlyArray<string>
): PermissionsCommandResult {
  const cmd = parsePermissionsCommand(args);
  switch (cmd.kind) {
    case "status":
      return {
        ok: true,
        text: formatPermissionStatus(ctx.get(), {
          withUsage: cmd.withUsage === true,
        }),
      };
    case "set":
      ctx.set(cmd.mode);
      return { ok: true, text: `权限模式已切换: ${cmd.mode}` };
    case "usage":
      return { ok: false, text: PERMISSIONS_USAGE_TEXT };
  }
}

/**
 * Free-text args tokenizer (the remainder segment of `/permissions plan`).
 * Both surfaces slice the remainder themselves (`slashRemainder`) and hand it
 * here; serve-style callers pass an already-split array. Mirrors
 * `splitGraphArgs` / `splitConfigArgs`.
 */
export function splitPermissionArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
