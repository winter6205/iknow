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
 * discriminated union.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Env var name. Exported so env-SSOT loader and CLI share one symbol. */
export const WORKSPACE_ROOT_ENV_KEY = "IKNOW_WORKSPACE_ROOT";

/**
 * ADR-0037 §4: env var carrying the
 * session's `productRoot` across a process boundary (parent session → subagent
 * worker). Lives beside `WORKSPACE_ROOT_ENV_KEY` because both are root env
 * keys; the roles differ — `workspaceRoot` anchors per-root state, while
 * `productRoot` anchors project identity discovery. A worker's cwd may be a
 * gitignored task worktree, so identity must not be resolved from it.
 */
export const PRODUCT_ROOT_ENV_KEY = "IKNOW_PRODUCT_ROOT";

/**
 * ADR-0092 Amendment 2026-09-13 / SC11: env var carrying the session's fs
 * isolation mode across the same process boundary (parent session → subagent
 * worker). Sits with the other two parent-set / worker-read wires; the role
 * differs — this one is a posture token (`"global" | "workspace"`, the value
 * domain of `FsIsolationMode`), not a path. The value domain + parser SSOT is
 * `harness/sandbox/fs-mode.ts` (`parseFsModeFlag`), which the worker applies
 * fail-closed; a worker that finds the var absent or unparsable keeps the
 * default global posture (byte-identical to the pre-wire shape).
 */
export const FS_MODE_ENV_KEY = "IKNOW_FS_MODE";

/**
 * issue 1059: env var carrying the worktree-on-mutate gate's live state
 * across the same parent → worker boundary. Like `FS_MODE_ENV_KEY` it is a
 * posture token (`"1" | "0"`), not a path — the worker turns it into a
 * static holder consumed by its bash fence (UNBOUND_FENCE). Absent key =
 * wire not connected (legacy / test spawn) → the worker never emits the
 * ro-bind segment, byte-identical to the pre-wire shape.
 */
export const WORKTREE_GATE_ON_ENV_KEY = "IKNOW_WORKTREE_GATE_ON";

/** SessionFile / PUT path cap (serve-workspace T1). Overflow → schema_invalid. */
export const MAX_WORKSPACE_ROOT_CHARS = 4096;

/** Typed-error discriminated union (mirror `IknowIdentityError`). The first
 *  4 kinds come from the resolver priority chain; `overflow` comes from the
 *  serve PUT path (T3) which must reject >MAX_WORKSPACE_ROOT_CHARS inputs
 *  before hitting `existsSync` (a 4KB path is a client bug, not an fs query). */
export type WorkspaceRootError =
  | { kind: "empty_explicit"; path: string }
  | { kind: "empty_env"; varName: typeof WORKSPACE_ROOT_ENV_KEY }
  | { kind: "non_absolute"; path: string }
  | { kind: "not_found"; path: string }
  | { kind: "overflow"; path: string };

/**
 * Plain-object discriminated-union guard. The resolver throws
 * `satisfies WorkspaceRootError` objects, NOT Error instances — callers must
 * branch on `kind`, never `err instanceof Error ? err.message : String(err)`
 * (the latter prints `[object Object]`, hiding kind/path). SSOT lives here;
 * `src/cli.ts` re-exports for CLI render.
 *
 * Kind-only guard would collide with `SessionStoreError`'s `{ kind: "not_found" }`
 * (the store uses `conversation_id`, the workspace resolver uses `path` /
 * `varName`). We require the matching payload field so a SessionStoreError
 * not_found does NOT slip into the 400-validation branch (would be 404).
 * serve-workspace T3 hardening; pure resolver unchanged.
 */
export function isWorkspaceRootError(err: unknown): err is WorkspaceRootError {
  if (err === null || typeof err !== "object") return false;
  const maybe = err as Record<string, unknown>;
  if (typeof maybe.kind !== "string") return false;
  if (
    ![
      "empty_explicit",
      "empty_env",
      "non_absolute",
      "not_found",
      "overflow",
    ].includes(maybe.kind)
  ) {
    return false;
  }
  // Discriminate by payload: workspace errors carry `path` (string) or
  // `varName` (string, empty_env only); store errors carry `conversation_id`.
  return (
    typeof maybe["path"] === "string" || typeof maybe["varName"] === "string"
  );
}

/** Per-kind text render (discriminated union, order matches the definition). */
export function renderWorkspaceRootError(err: WorkspaceRootError): string {
  switch (err.kind) {
    case "empty_explicit":
      return `[workspace_root]: empty_explicit`;
    case "empty_env":
      return `[workspace_root]: empty_env ${WORKSPACE_ROOT_ENV_KEY}=<empty>`;
    case "non_absolute":
      return `[workspace_root]: non_absolute path=${err.path}`;
    case "not_found":
      return `[workspace_root]: not_found path=${err.path}`;
    case "overflow":
      return `[workspace_root]: overflow path length exceeds ${MAX_WORKSPACE_ROOT_CHARS}`;
  }
}

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
