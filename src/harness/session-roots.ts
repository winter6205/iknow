/**
 * Session roots SSOT (ADR-0037): the single root-policy point.
 *
 * One input yields roots by **role**; consumers (memory / skills /
 * permission / background / config / mcp / subagent spawn) only use the
 * returned values and never join `join(cwd, '.iknow', …)` themselves, read
 * `process.cwd()`, or judge task worktrees. The one exception is the
 * assembly layer choosing the per-root state anchor (build-engine decides
 * whether `workspaceRoot` is already a task worktree, ADR-0037) — that is
 * one policy decision, not path joining. The identity root's **value** (the
 * host-pinned one, or `mainCheckoutOf(cwd)` when absent) is likewise chosen
 * by the assembly layer, but its **validation** happens here under the same
 * rule as the other roots.
 *
 *  - `productRoot`: the main checkout at conversation start; pinned at first
 *    assembly, unchanged across rebinds and restarts. Only `mcp.json` asks
 *    it (`mcpConfigRoot`); the per-root state (memory library) anchor is
 *    chosen by the assembly layer: `workspaceRoot` preferred, falling back
 *    to `productRoot` only when it is itself a task worktree (ADR-0037).
 *  - `projectIdentityRoot`: the project the user is actually working on,
 *    pinned once at host startup, unchanged across rebinds. **Only it
 *    answers project identity** — rules / project `AGENTS.md` /
 *    `permissions.toml` / project skill discovery, the identity root
 *    inherited by subagents, the memory-library namespace. It is separate
 *    from `productRoot` because the host derives `productRoot` from
 *    `workspaceRoot` per ADR-0019, and under `--workspace-root <dir>`
 *    redirection `<dir>` is not the project (`dir ≠ cwd`).
 *  - `taskRoot`: this conversation's task worktree (create / enter switch
 *    to it, exit switches back to the main checkout). **Only it answers
 *    writes and tool cwd** — write tools / workspace-mutating bash / git /
 *    LSP dirs / subagent working dir.
 *  - `installRoot`: where the iknow runtime itself is installed (worker
 *    bootstrap resolves tsx and its own deps). ≠ the user project's
 *    `node_modules`, so a worker still starts on a bare task worktree.
 *
 * `resolveSessionRoots` is pure: no git reads, no filesystem, no session
 * state. Missing / blank / relative / un-normalizable roots fail closed with
 * `SessionRootError` (the "inconsistent with the pinned root" check belongs
 * to `resolveMcpRoots({ expectedWorkspaceRoot })`, not a second parallel
 * scheme here), and it **never** falls back to `process.cwd()`. The only
 * exported function with IO is `resolveInstallRoot`, anchored on
 * `import.meta.url` rather than any session root.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SessionRootError } from "./errors.js";
import { mainCheckoutOf } from "./isolation/worktree-gate.js";

/** Re-export so consumers (e.g. session-store resolver) can throw the typed
 *  error without a separate detour into harness/errors. */
export { SessionRootError } from "./errors.js";

/** Cap on root values echoed in diagnostics: long paths must stay bounded. */
export const MAX_ROOT_DETAIL_CHARS = 120;

/**
 * (ADR-0071) Path-hostile segment sanitizer shared by the session folder and
 * the todo ledger. The guarantee that "`..`-style escape is impossible"
 * rests solely on this function: any code joining a `conversationId` into a
 * file path must pass it through sanitize first:
 *   - strict `[A-Za-z0-9_-]` → every other character (including `.` / `/` /
 *     `\0`) becomes `_`.
 *   - conversationId is a UUID in practice, so dropping `.` loses no
 *     semantics.
 *
 * Shared because one sanitization rule serves two consumers —
 *   - the todo ledger (`resolveConversationTodoPath`, todo-write.ts SSOT);
 *   - the session-folder leaf (`resolveConversationDir`, session-store.ts).
 * A shadow copy would make the "`..` cannot escape" invariant the job of two
 * code paths; fixing one would break the contract. This function is the SSOT.
 */
export function sanitizeConversationSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The session roots, all normalized to absolute paths. */
export interface SessionRoots {
  readonly productRoot: string;
  readonly taskRoot: string;
  readonly installRoot: string;
  readonly projectIdentityRoot: string;
}

/**
 * Write-situation tri-state.
 *
 * Single source: the decision lives in
 * `src/harness/isolation/write-situation.ts`, rendering (disclosure face /
 * worker prior) lives in `src/harness/skill/*`, the enum type lives here.
 * The dependency direction is pinned: `skill/body.ts` must not import
 * `isolation/`, so the rendering side consumes only this enum + one
 * non-isolation root string.
 *
 * Semantics:
 *   - `writable_main`: isolation OFF, main checkout root = write root.
 *     **Includes the "isolation OFF + tree-shaped path" combination** — the
 *     negative arm is pinned so shape checks cannot be misused on their own
 *     (the lesson recorded in ADR-0037).
 *   - `writable_tree`: isolation ON and the live root is this conversation's
 *     task worktree (legal tree shape).
 *   - `no_writable_root`: isolation ON and the live root is not tree-shaped
 *     (the main checkout is read-only for file edits); the disclosure face
 *     does **not** name `create-worktree`.
 */
export type WriteSituation =
  "writable_main" | "writable_tree" | "no_writable_root";

export interface ResolveSessionRootsInput {
  /** Main checkout at conversation start; sole source of project identity and per-root state. */
  readonly productRoot: string | undefined;
  /** This conversation's live task worktree (equals `productRoot` before any rebind). */
  readonly taskRoot: string | undefined;
  /** iknow's own install location; production supplies it via `resolveInstallRoot()`. */
  readonly installRoot: string | undefined;
  /**
   * Project identity root. The assembly layer supplies it: the host-pinned
   * value first, else `mainCheckoutOf(cwd)`. Validation here always treats
   * it as **required** — an explicit empty string / relative value must not
   * be silently read as `process.cwd()` (after a rebind that is exactly the
   * task worktree).
   */
  readonly projectIdentityRoot: string | undefined;
}

/**
 * Pure result of normalizing one root candidate. Does not throw — each
 * consumer maps a rejection to its own typed error (the MCP side must keep
 * its existing `McpLifecycleError` kind split, see `mcp/roots.ts`), so the
 * normalization rule has exactly one implementation.
 */
export type RootRejection =
  | { readonly reason: "missing" }
  | { readonly reason: "not_normalizable"; readonly shown: string }
  | { readonly reason: "not_absolute"; readonly shown: string };

export type RootNormalization =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly rejection: RootRejection };

/** Absent / blank / contains NUL / not absolute → rejection; otherwise the normalized absolute root. */
export function normalizeRootCandidate(
  value: string | undefined
): RootNormalization {
  if (typeof value !== "string") {
    return { ok: false, rejection: { reason: "missing" } };
  }

  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    return {
      ok: false,
      rejection: { reason: "not_normalizable", shown: trimmed },
    };
  }

  const normalized = stripTrailingSeparators(path.normalize(trimmed));
  if (!path.isAbsolute(normalized)) {
    return { ok: false, rejection: { reason: "not_absolute", shown: trimmed } };
  }
  return { ok: true, root: normalized };
}

/** Diagnostic echo: truncate to a bounded length so over-long paths cannot blow up error messages. */
export function quoteRoot(value: string, limit: number): string {
  const shown = value.length > limit ? `${value.slice(0, limit)}…` : value;
  return `'${shown}'`;
}

/** Strip trailing separators but keep the filesystem root itself (posix `/`, win32 `C:\`). */
function stripTrailingSeparators(p: string): string {
  const { root } = path.parse(p);
  let out = p;
  while (
    out.length > root.length &&
    (out.endsWith(path.sep) || out.endsWith("/"))
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Resolve the session roots. Any validation failure throws before file
 * reads / spawn / tool execution, and `detail` names the failing role
 * (`productRoot` / `taskRoot` / `installRoot` /
 * `projectIdentityRoot`) so a newly-wired consumer sees at assembly time
 * which root is missing.
 *
 * The "consistent with the pinned task root" check is deliberately **not**
 * here: non-ask faces carry it via
 * `resolveMcpRoots({ expectedWorkspaceRoot })` (the `McpLifecycleError`
 * kind split is unchanged for existing callers); no second synonymous check
 * is opened in parallel.
 */
export function resolveSessionRoots(
  input: ResolveSessionRootsInput
): SessionRoots {
  const productRoot = requireRoot(input.productRoot, "productRoot");
  const taskRoot = requireRoot(input.taskRoot, "taskRoot");
  const installRoot = requireRoot(input.installRoot, "installRoot");
  const projectIdentityRoot = requireRoot(
    input.projectIdentityRoot,
    "projectIdentityRoot"
  );

  return { productRoot, taskRoot, installRoot, projectIdentityRoot };
}

/** Absent → `missing_root`; present but unusable → `invalid_root`. */
function requireRoot(value: string | undefined, label: string): string {
  const result = normalizeRootCandidate(value);
  if (result.ok) return result.root;

  const { rejection } = result;
  if (rejection.reason === "missing") {
    throw new SessionRootError(
      "missing_root",
      `${label} is required and was not provided`
    );
  }
  const requirement =
    rejection.reason === "not_absolute"
      ? "must be an absolute path"
      : "must be a normalizable absolute path";
  throw new SessionRootError(
    "invalid_root",
    `${label} ${requirement}, got ${quoteRoot(rejection.shown, MAX_ROOT_DETAIL_CHARS)}`
  );
}

/**
 * `resolveInstallRoot` only needs to compute once: the install location is
 * fixed for the process lifetime, so there is deliberately no reset seam
 * (tests needing a different install root inject `opts.installRoot` instead
 * of poking the process-level cache).
 */
let cachedInstallRoot: string | undefined;

/**
 * iknow's own install root: walk up from **this module's file** to the
 * nearest directory containing `package.json`.
 *
 * The anchor is deliberately `import.meta.url`, not any session root or
 * `process.cwd()` — a subagent worker's cwd may be a bare task worktree
 * without `node_modules`, where cwd-relative resolution would crash with
 * `Cannot find package`. Both dev (`src/…`) and packaged (`dist/…`) layouts
 * land on the same package root.
 */
export function resolveInstallRoot(): string {
  if (cachedInstallRoot !== undefined) return cachedInstallRoot;

  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) {
      cachedInstallRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new SessionRootError(
    "missing_root",
    `installRoot could not be derived: no package.json above ${quoteRoot(start, MAX_ROOT_DETAIL_CHARS)}`
  );
}

/**
 * (ADR-0071) Pre-assembly derivation of the
 * session folder grouping root for the three production call sites
 * (`cli.ts` / `serve.ts` / `hub-bridge.ts`). Mirrors the build-engine
 * formula:
 *
 *   `mainCheckoutOf(opts.explicitProjectIdentityRoot ?? process.cwd())`
 *
 * Two reasons it lives here rather than being inlined at each call site:
 *   1. The three callers + the engine must agree on the same root for the
 *      store and the session-roots resolver — drift would split the session
 *      pool across two folders. One source.
 *   2. Production assembly wants to construct the store BEFORE the engine
 *      runs (the store is host-injected into the worktree provisioner /
 *      SessionHub before build-engine returns), so this is computed in the
 *      same shape the engine will independently validate inside
 *      `resolveSessionRoots`.
 *
 * `process.cwd()` is read here ONLY as a fallback when the host didn't pin
 * one — same contract as `resolveWorkspaceRoot` slot 3.
 */
export function deriveProjectIdentityRoot(opts: {
  readonly explicit?: string | undefined;
  readonly cwd?: string | undefined;
}): string {
  const cwd = opts.cwd ?? process.cwd();
  const value = opts.explicit ?? cwd;
  return mainCheckoutOf(value);
}

// --------------------------------------------------------------------------
// Live `taskRoot` holder + single writer.
//
// `resolveSessionRoots` stays a pure function (above). The live holder
// sits alongside it as a sibling export of the same module — the SSOT
// for the conversation's current effective root. Writes are gated through
// ONE entry point (`writeLiveTaskRoot`), reached only via the build-engine
// wrapper around host `provision` / `enter` / `exit` seams
// (`withLiveTaskRootWrite`).
//
// Stable roots (productRoot / projectIdentityRoot / installRoot /
// mcpConfigRoot / stateAnchor / memoryDir / todoDir / traceDir) are NOT
// carried here — the cell holds a single `taskRoot` string, nothing else.
// --------------------------------------------------------------------------

/**
 * Internal mutable shell — extends the public `LiveTaskRoot` surface with
 * a closure-captured setter. Module-scoped: only `writeLiveTaskRoot` casts
 * to this type, so the setter cannot leak through the public `LiveTaskRoot`
 * interface. Tests can read via `cell.read()`; only the wrapper around
 * host seams can write.
 */
interface LiveTaskRootInternal extends LiveTaskRoot {
  readonly __write: (value: string) => void;
}

/**
 * Live `taskRoot` cell. Reads return the current snapshot value
 * (synchronously, atomically — JS single-threaded closure reads of a
 * captured `let` have no partial-update window). Writes go through
 * `writeLiveTaskRoot`, the single writer entry point — see
 * `withLiveTaskRootWrite` for the build-engine wrapper.
 */
export interface LiveTaskRoot {
  /** Current snapshot value. */
  read(): string;
}

/**
 * Construct a `LiveTaskRoot` cell from a validated initial value
 * (typically `sessionRoots.taskRoot` produced by `resolveSessionRoots`).
 * The initial value is the pre-rebind snapshot; successful resolutions of
 * the host `provision` / `enter` / `exit` seams update the cell via
 * `writeLiveTaskRoot` / `withLiveTaskRootWrite`.
 */
export function createLiveTaskRoot(initial: string): LiveTaskRoot {
  let current = initial;
  const cell: LiveTaskRootInternal = {
    read: () => current,
    __write: (value: string): void => {
      current = value;
    },
  };
  return cell;
}

/**
 * Single writer — update the live `taskRoot` cell. Called only by the
 * build-engine wrapper around host seams (via `withLiveTaskRootWrite`); the
 * public `LiveTaskRoot` interface does not expose a setter, so external
 * callers cannot bypass the wrapper.
 *
 * Does NOT re-validate the input — the seam contract (`WorktreeProvisionFn`
 * / `WorktreeEnterFn` / `WorktreeExitFn`) already requires the resolver
 * to return a normalized absolute root. Wrapping this with extra
 * `normalizeRootCandidate` would surface seam contract violations as
 * `SessionRootError` instead of letting them propagate as the seam's
 * typed error, which would mask the original failure mode.
 */
export function writeLiveTaskRoot(cell: LiveTaskRoot, value: string): void {
  (cell as LiveTaskRootInternal).__write(value);
}

/**
 * Wrap an async root-resolver seam so successful resolutions also update the
 * live `taskRoot` cell.
 *
 *   - seam resolves → write cell, return the resolved value unchanged;
 *   - seam throws (any typed error) → cell **unchanged** (no write, no
 *     rollback — failure means the prior value stays put), error
 *     propagates verbatim to the caller.
 *
 * The wrap is the single writer entry point. build-engine applies this
 * helper to host `provision` / `enter` / `exit` seams uniformly — every
 * successful seam resolution reaches `writeLiveTaskRoot` through here.
 * Stable roots are not affected; only the seam-resolved value
 * (== `taskRoot`) is written.
 */
export function withLiveTaskRootWrite<
  F extends (...args: any[]) => Promise<unknown>,
>(
  seam: F,
  cell: LiveTaskRoot,
  /**
   * How to extract the ROOT from the seam result. Omitted for plain string
   * seams (`provision` / `exit`); the enter seam resolves to
   * `{ path, receipt }` and passes `(r) => r.path` so the cell keeps
   * receiving the root while the receipt flows to the tool layer.
   */
  rootOf: (value: Awaited<ReturnType<F>>) => string = (value) => value as string
): F {
  return (async (...args: any[]) => {
    const resolved = (await seam(...args)) as Awaited<ReturnType<F>>;
    writeLiveTaskRoot(cell, rootOf(resolved));
    return resolved;
  }) as F;
}
