/**
 * Workspace-tier fs-isolation overlay — the single point for the
 * session-level filesystem tier switch (ADR-0092).
 *
 * fs isolation is **not** `PermissionMode` (the authorization axis) and not
 * `worktreeOnMutate` (the write gate) — which paths the bash fence can touch
 * is its own independent axis. Closed value set, two tiers:
 *   - `"global"`   — default: host real paths readable and writable; write
 *                    blocking relies on the permission layers + hard-wall;
 *                    home is not hidden (ADR-0092 main clause).
 *   - `"workspace"`— home visible but read-only; writes = live `taskRoot` ∪
 *                    **session tmp**; the rest of home is unwritable by default.
 *
 * This module carries four things (mirroring `graph/mode.ts` GraphModeContext
 * — the three entries / TUI / REPL / serve share one point):
 *   - **Value guard**: `parseFsModeFlag` — the tier-literal guard for the
 *     **command surface** (`/config` args parsing plus the holder `set`
 *     backstop): trim + lowercase; invalid values fail closed to undefined.
 *     The settings section does not share it: `isolation.fsMode` is validated
 *     separately in `src/config/settings.ts` against case-sensitive literals
 *     (same boolean-only discipline as `worktreeOnMutate`), so `"Workspace"`
 *     in settings.json is dropped → falls back to global, while the same
 *     literal via `/config` hits after trim + lowercase. The two surfaces
 *     diverge on purpose — do not read them as one literal set.
 *   - **Mutable holder**: `FsModeContext` — mirrors `PermissionModeContext` /
 *     `GraphModeContext`: flipped in place at runtime, engine not rebuilt.
 *   - **Assembly-time initial value**: `resolveFsIsolationMode(settings)` in
 *     `src/config/settings.ts` (same fail-closed read point as
 *     `resolveWorktreeOnMutate` / `resolveWorktreeExclusive`).
 *   - **Command semantics**: `parseConfigCommand` / `applyFsModeCommand` /
 *     `formatFsModeStatus` in this same file (shared by the three entries).
 *
 * Boundary: the bash factory opt shape = holder rather than static string
 * (`fsMode?: FsModeContext`) — the handler reads `fsMode?.get() ?? "global"`
 * once per call, same batch-snapshot discipline as `liveTaskRoot`; the
 * foreground fence and background spawn share one frozen value.
 */

/** fs isolation tier value set (closed; exactly two legal strings). */
export type FsIsolationMode = "global" | "workspace";

/**
 * fs isolation tier holder — the `bash` factory opt takes this value; the
 * handler reads `get()` per call (same batch-snapshot discipline as
 * `liveTaskRoot`). `/config` and Shift+Tab flip the same holder in place for
 * the session's lifetime (via `applyFsModeCommand`).
 */
export interface FsModeContext {
  /** Current snapshot (frozen; changing snapshots does not touch the holder). */
  readonly get: () => FsIsolationMode;
  readonly set: (mode: FsIsolationMode) => void;
}

/** Holder initial value — defaults to `global` (default FS posture). */
export const FS_ISOLATION_MODE_DEFAULT: FsIsolationMode = "global";

/**
 * Build the fs isolation tier holder. Default `initial` = `global` —
 * byte-identical to today's baseline: when all callers pass undefined, the
 * bwrap argv matches the existing global form.
 *
 * `set` runs input through `parseFsModeFlag` as a backstop — anything inside
 * the closed set passes through, anything outside is silently ignored (the
 * getter still returns `global` or `workspace`). Even a caller forcing an
 * invalid literal via `as any` cannot leak a bad state downstream to bwrap
 * (avoiding a mount-layer crash on bwrap argv parsing).
 */
export function createFsModeContext(
  initial: FsIsolationMode = FS_ISOLATION_MODE_DEFAULT
): FsModeContext {
  let current: FsIsolationMode =
    parseFsModeFlag(initial) ?? FS_ISOLATION_MODE_DEFAULT;
  return Object.freeze({
    get: () => current,
    set: (mode: FsIsolationMode) => {
      const next = parseFsModeFlag(mode);
      if (next !== undefined) current = next;
      // Invalid literal → silently ignored, holder keeps current state. This
      // is fail-closed: never pass a bad mode to bwrap (which would silently
      // fall back to global); gating it here is more observable.
    },
  });
}

/**
 * `parseFsModeFlag` — value-domain guard for the **command surface**: `/config`
 * args parsing (the `parseConfigCommand` / `splitConfigArgs` side) and the
 * holder `set` backstop (`createFsModeContext`). `trim + case-insensitive`;
 * legal values are only `"global" / "workspace"`; non-strings / invalid
 * literals → undefined (fail-closed).
 *
 * Deliberately not shared with the settings section: `isolation.fsMode` is
 * validated separately in `src/config/settings.ts` by `isFsIsolationMode`
 * against case-sensitive literals (on purpose, consistent with the
 * `worktreeOnMutate` boolean-only discipline). So `"Workspace"` is invalid in
 * settings.json (dropped → falls back to global), while `/config fs
 * Workspace` is legal (trim + lowercase → workspace). Loosening the settings
 * side requires an ADR decision — do not casually align the two.
 *
 * No aliases (`on` / `off` etc.) — the closed set has two tiers; aliases
 * would let the command surface drift.
 */
export function parseFsModeFlag(raw: unknown): FsIsolationMode | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "global") return "global";
  if (v === "workspace") return "workspace";
  return undefined;
}

// ── `/config` command (non-TTY equivalent) ─────────────────────────────────

/**
 * The three-state `/config` command (shared by the three entries).
 *  - `status`: query the current tier;
 *  - `set`: flip the holder to the given tier;
 *  - `usage`: bad args (including surplus args) — never silently ignored.
 */
export type ConfigCommand =
  | { readonly kind: "status" }
  | { readonly kind: "set"; readonly mode: FsIsolationMode }
  | { readonly kind: "usage" };

export const FS_MODE_USAGE_TEXT =
  "Usage: /config [status|fs global|fs workspace]";

/**
 * `/config` args parsing (shared by the three entries).
 *
 * Rules (mirroring `parseGraphCommand`'s shape — surplus args are not
 * silently ignored):
 *  - empty / `["status"]` → `status`;
 *  - `["fs", "global"|"workspace"]` → `set` (mode through `parseFsModeFlag`,
 *    trim + lowercase; `"  FS  "` / `"  Workspace  "` also hit);
 *  - anything else (`["fs"]` without mode / invalid mode / surplus args /
 *    unknown leading token) → `usage`.
 */
export function parseConfigCommand(args: ReadonlyArray<string>): ConfigCommand {
  if (args.length === 0) return { kind: "status" };
  const head = (args[0] ?? "").trim().toLowerCase();
  if (head === "status" && args.length === 1) return { kind: "status" };
  if (head === "fs" && args.length === 2) {
    const mode = parseFsModeFlag(args[1]);
    if (mode !== undefined) return { kind: "set", mode };
  }
  return { kind: "usage" };
}

/** One-line per-tier difference (one shared line across entries; the two tiers must be obvious at a glance). */
function fsModeDetail(mode: FsIsolationMode): string {
  return mode === "global"
    ? "宿主真路径可读写，拦写靠权限 + hard-wall"
    : "home 可见只读；写 = taskRoot + 会话 tmp";
}

/** Status echo line (identical across the three entries). */
export function formatFsModeStatus(state: FsIsolationMode): string {
  return `文件系统隔离档: ${state}（${fsModeDetail(state)}）`;
}

/** Execution result: `ok=false` means no state changed; `text` is the user-visible line. */
export interface FsModeCommandResult {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Execute one `/config` command against the holder and return the
 * user-visible text.
 *
 * All three entries call this function: chat routes through stdout/stderr,
 * TUI through notice, serve puts `text` into the response body for web
 * rendering — different carriers, same semantics and same literal source.
 *
 * The usage path's `text` is always `FS_MODE_USAGE_TEXT` (do not echo user
 * input — echoing invalid input invites injection and drifts from the graph
 * precedent).
 */
export function applyFsModeCommand(
  ctx: FsModeContext,
  args: ReadonlyArray<string>
): FsModeCommandResult {
  const cmd = parseConfigCommand(args);
  switch (cmd.kind) {
    case "status":
      return { ok: true, text: formatFsModeStatus(ctx.get()) };
    case "set":
      ctx.set(cmd.mode);
      return {
        ok: true,
        text: `已切换: ${cmd.mode}（${fsModeDetail(cmd.mode)}；下一次 bash 调用生效）`,
      };
    case "usage":
      return { ok: false, text: FS_MODE_USAGE_TEXT };
  }
}

/**
 * Free-text args tokenizer (the "fs workspace" segment of `/config fs
 * workspace`). Serve's wire sends a pre-split array; TUI / web use this to
 * take the remainder from a raw line (mirrors `splitGraphArgs`).
 */
export function splitConfigArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
