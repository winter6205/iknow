/**
 * T1 — workspace-root resolver (pure function, no I/O side effects).
 *
 * Per-root state anchor (identity workspace seed, memory store, settings
 * write-back fallback, serve data) lives at the resolved root; global
 * config (settings merge fallback, host-init) keeps using `homedir()`.
 *
 * ADR-0019 (workspace-root per-root state decoupling) — D1.1 default
 * `process.cwd()`, D1.5 register at env SSOT. Priority chain
 * `[explicit, env, cwd]`. Resolver does NOT read `process.env` directly:
 * callers DI the env Record. `existsSync` is the only fs touch (no
 * `fs.read` of file contents); treated as a meta-query, not a read.
 *
 * Mirror of `IknowIdentityError` (`identity/workspace.ts:37-41`)
 * discriminated union. Full spec: `plans/workspace-root-launch.md` T1.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Env var name. Exported so env-SSOT loader and CLI share one symbol. */
export const WORKSPACE_ROOT_ENV_KEY = "IKNOW_WORKSPACE_ROOT";

/** SessionFile / PUT path cap (serve-workspace T1). Overflow → schema_invalid. */
export const MAX_WORKSPACE_ROOT_CHARS = 4096;

/** Typed-error discriminated union (4 kinds; mirror `IknowIdentityError`). */
export type WorkspaceRootError =
  | { kind: "empty_explicit"; path: string }
  | { kind: "empty_env"; varName: typeof WORKSPACE_ROOT_ENV_KEY }
  | { kind: "non_absolute"; path: string }
  | { kind: "not_found"; path: string };

export interface ResolveWorkspaceRootOpts {
  /**
   * Highest-priority slot — typically the `--workspace-root <dir>` CLI flag.
   * Empty string is a hard error (`empty_explicit`), NOT a fall-through
   * to the env slot (a user typing `--workspace-root ""` is almost
   * certainly a quoting bug, not "unset").
   */
  readonly explicit?: string;
  /**
   * Override `process.cwd()` for priority-slot-3 fallback.
   * Default: `process.cwd()` (only `process.env`-style global read allowed).
   */
  readonly cwd?: string;
  /**
   * Env Record passed by the caller (DI). Resolver reads
   * `env[WORKSPACE_ROOT_ENV_KEY]`. Empty string is a hard error
   * (`empty_env`), NOT a fall-through.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve workspace root via priority chain `[explicit, env, cwd]`.
 *
 *  1. `opts.explicit` — if set, validate and return.
 *  2. `opts.env[IKNOW_WORKSPACE_ROOT]` — if set, validate and return.
 *  3. `opts.cwd ?? process.cwd()` — no validation (cwd is always absolute
 *     and exists; if it doesn't, the OS is already broken).
 *
 * Validation guards (mirror `IknowIdentityError`):
 *  - `empty_explicit` / `empty_env` — empty string is rejected (NOT a
 *    fall-through; explicit empty usually indicates a quoting bug).
 *  - `non_absolute` — relative paths are rejected. Catches `data/foo`,
 *    `not/absolute`, bare `foo`, etc.
 *  - `not_found` — absolute but non-existent paths are rejected. Catches
 *    typos; consumers don't have to `try/catch mkdir` at every join.
 *
 * Cyclomatic scope: 4 branches in this function + 2 in helper
 * `assertAbsoluteExists` (well under the 10-branch hard trigger from
 * `complexity-anti-drift`; spec target ≤ 5).
 */
export function resolveWorkspaceRoot(opts?: ResolveWorkspaceRootOpts): string {
  const explicit = opts?.explicit;
  if (explicit !== undefined) {
    if (explicit === "") {
      throw {
        kind: "empty_explicit",
        path: "",
      } satisfies WorkspaceRootError;
    }
    return assertAbsoluteExists(explicit);
  }
  const fromEnv =
    opts?.env !== undefined ? opts.env[WORKSPACE_ROOT_ENV_KEY] : undefined;
  if (fromEnv !== undefined) {
    if (fromEnv === "") {
      throw {
        kind: "empty_env",
        varName: WORKSPACE_ROOT_ENV_KEY,
      } satisfies WorkspaceRootError;
    }
    return assertAbsoluteExists(fromEnv);
  }
  return opts?.cwd ?? process.cwd();
}

function assertAbsoluteExists(p: string): string {
  if (!path.isAbsolute(p)) {
    throw {
      kind: "non_absolute",
      path: p,
    } satisfies WorkspaceRootError;
  }
  if (!existsSync(p)) {
    throw {
      kind: "not_found",
      path: p,
    } satisfies WorkspaceRootError;
  }
  return p;
}
