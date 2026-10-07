/**
 * Type contracts for the LSP client layer (`src/harness/lsp/`).
 *
 * `server.ts` (server info + NearestRoot) and `client.ts` (getClient) read
 * their types from here; the handler layer (`aci/tools/lsp.ts`) consumes
 * `LspCtx` only indirectly via `getClient(ctx, file)`.
 *
 * **Not included**: vscode-jsonrpc client internals (hidden inside client.ts),
 * ACI tool schemas (defined in aci/tools/lsp.ts), tsserver request/response
 * payloads (passed through opaquely to typescript-language-server).
 *
 * Goal: keep `src/harness/lsp/` a self-contained in-house LSP client module;
 * the assembly layer (build-engine.ts) only needs the `LspCtx` shape.
 */

/**
 * Immutable LSP client context, built once at assembly time.
 * `directory` is the upper bound (stop) for NearestRoot search; for this
 * single-user, single-project local product it equals process.cwd().
 *
 * When `directoryCell` is present, `getClient` treats `directoryCell.read()`
 * as the effective root (the live task root after a worktree rebind) and
 * `directory` is only the fallback for callers that never flip the cell.
 * After a rebind, both the NearestRoot bound and the pool key follow the live
 * root; clients bound to the old root are disposed by a lazy sweep at the
 * `getClient` entry point.
 */
export interface LspCtx {
  /** Upper bound for NearestRoot search (never walks outside). */
  readonly directory: string;
  /**
   * Live task-root cell. When present, `getClient` reads it once at entry as
   * the effective `directory` (overriding the field above). Absent → use the
   * frozen value (un-rebind path stays byte-for-byte unchanged).
   */
  readonly directoryCell?: import("../session-roots.js").LiveTaskRoot;
  /**
   * Per-request LSP timeout cap (ms). Defaults to the tool layer's
   * DEFAULT_LSP_REQUEST_TIMEOUT_MS (20_000). From settings.lsp.requestTimeoutMs.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Deadline for lsp_diagnostics read wait (ms). Defaults to the tool layer's
   * DIAGNOSTICS_WAIT_MS (2_000). From settings.lsp.diagnosticsWaitMs.
   */
  readonly diagnosticsWaitMs?: number;
  /**
   * Idle-client reclaim threshold (ms). ≤0 or undefined → no sweep.
   * From settings.lsp.idleTimeoutMs; the default (10min) is injected by the
   * assembly layer (build-engine passes 600_000) since client.ts sweep is the consumer.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Disabled server ids. A matched server is treated as unconfigured
   * (no-server) in getClientDetailed. From settings.lsp.disabledServers.
   */
  readonly disabledServers?: ReadonlyArray<string>;
  /**
   * Connection pool instance (MCP / multi-workspace). Absent → client.ts
   * module default pool. Type lives in client.ts; use import type to avoid a runtime cycle.
   */
  readonly pool?: import("./client.js").LspClientPool;
  /**
   * Override language-server / tsserver executable resolution. Return an
   * absolute path or PATH name; undefined falls back to node_modules + which.
   */
  readonly resolveBin?: (
    pkgName: string,
    binName: string
  ) => Promise<string | undefined>;
}

/**
 * LSP server startup config — per-language (`Typescript`) declaration of
 * "how to spawn + how to resolve root" inside server.ts.
 *
 * Kept as a flat declaration isomorphic to the info struct in lsp.ts (the
 * registry/spawn/client split was deliberately not adopted).
 *
 * When `spawn` returns `undefined`, the server is unavailable in the current
 * environment (tsserver bin missing / typescript-language-server binary
 * missing); client.ts records this as broken and does not throw (the handler
 * renders the plain string `"(no LSP server available)"`).
 */
export interface LspServerInfo {
  readonly id: string;
  /** Walk up from file to the nearest lockfile dir as root; bounded by ctx.directory. */
  readonly root: (file: string, ctx: LspCtx) => Promise<string | undefined>;
  /** File extensions this server handles (client.ts early-return: reject files not listed). */
  readonly extensions: ReadonlyArray<string>;
  /**
   * Spawn the server subprocess. Returns `{ process, initialization }`, which
   * client.ts wraps into a vscode-jsonrpc connection and sends initialize.
   */
  readonly spawn: (
    root: string,
    ctx: LspCtx
  ) => Promise<LspServerHandle | undefined>;
  /**
   * Human-readable install hint: a single `npm i -g <pkg>` sentence attached
   * when rendering the spawn-failed sentinel. Absent → sentinel omits the hint.
   */
  readonly installHint?: string;
  /**
   * Absolute executable paths this server probes inside the active project /
   * worktree, in the order it probes them.
   *
   * Doubles as recovery evidence: client.ts re-checks these paths after an
   * `executable-resolution` failure, so a completed install into the project is
   * detectable without a new caller. Absent → no automatic recovery signal
   * (an explicit `retryFailedLspStart` still works).
   */
  readonly executableCandidates?: (
    root: string,
    ctx: LspCtx
  ) => Promise<readonly string[]> | readonly string[];
}

/** Handle returned by spawn: subprocess + initializationOptions (passes tsserver.path to typescript-language-server). */
export interface LspServerHandle {
  readonly process: import("node:child_process").ChildProcess;
  /**
   * initializationOptions passed through the LSP initialize handshake.
   *
   * Originally required as `{ tsserver: { path } }` for the single TS
   * language; with multi-language support each server declares its own —
   * pyright passes `{ pythonPath }`, while yaml/json/dockerfile need no
   * initialization (omitting is legal). Making it optional keeps existing TS
   * fixtures unchanged.
   */
  readonly initialization?: Record<string, unknown>;
}
