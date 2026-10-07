/**
 * LSP client layer — wraps `LspServerInfo` handles from `server.ts` into
 * vscode-jsonrpc `MessageConnection`s and reuses one connection per
 * (root, server.id) via the cache trio: clients cache / broken memory /
 * inflight dedup.
 *
 * Multi-language dispatch: `getClient` routes `file` by extension through
 * `resolveServer(file)` in `server.ts` (`.py`→Pyright, `.yaml`→YamlLS,
 * `.json`→JsonLS, `Dockerfile`→DockerfileLS, `.ts`→Typescript) instead of
 * hard-coding a default; no match → early-return `undefined`
 * (`"(no LSP server)"`). `opts.server` is a test injection point that
 * overrides the dispatch result.
 *
 * Cancellation: interrupts go through JSON-RPC `$/cancelRequest` and never
 * kill the tsserver subprocess. No tool path terminates processes. Process
 * termination lives in the pool: reclaim seams (`sweepIdleClients` / worktree
 * rebind stale sweep / `disposeAll`) kill the subprocess of reclaimed entries
 * and may run mid-process; `shutdownAll()` additionally latches and may only
 * be called at host-process exit seams (engine shutdown is not one: chat
 * rebind tears down the old engine mid-process, and latching the shared pool
 * there would leave a rebuilt engine permanently spawn-failed). Regular tool
 * operations only `connection.dispose()` (release the connection, no signals
 * to the subprocess).
 *
 * Edit sync + self-healing: `notifyChange(file)` pushes the latest on-disk
 * text after edit_file writes via standard `textDocument/didChange` (full
 * sync), so later requests see new content; when the server process exits
 * unexpectedly the key is evicted from `clients` (not added to `broken`) so
 * the next call respawns. Per-request timeout (`$/cancelRequest`) is
 * implemented in the tool layer (aci/tools/lsp.ts) — closer to the abort
 * bridge and error translation than racing inside sendRequest.
 */
import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import {
  createMessageConnection,
  CancellationTokenSource,
  CancellationToken,
} from "vscode-jsonrpc/node";
import type { MessageConnection } from "vscode-jsonrpc/node";

import type { LspCtx, LspServerHandle, LspServerInfo } from "./types.js";
import { resolveServer } from "./server.js";
import { languageIdFor } from "./language.js";

/**
 * Default idle-client reclaim threshold: the resident engine (build-engine)
 * injects this when settings.lsp.idleTimeoutMs is unset so the sweep takes
 * effect; the worker does not read settings files but injects the same default
 * (same sweep as the resident engine).
 */
export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Client wrapper: exposes thin pass-through sendRequest / sendNotification / dispose to the handler layer. */
export interface LspClient {
  /** Underlying vscode-jsonrpc `MessageConnection` (for advanced uses like cancel). */
  readonly connection: MessageConnection;
  /** tsserver subprocess handle (diagnostics / lifecycle observation only; termination goes through the pool seams). */
  readonly process: ChildProcess;
  /**
   * JSON-RPC request: pass through method/params, return unknown payload.
   * Optional `token` (vscode-jsonrpc `CancellationToken`) for cancellation —
   * when the token is cancelled, vscode-jsonrpc automatically sends a
   * `$/cancelRequest` notification and does not kill the tsserver subprocess.
   */
  sendRequest(
    method: string,
    params: unknown,
    token?: CancellationToken
  ): Promise<unknown>;
  /** JSON-RPC notification: pass through method/params. */
  sendNotification(method: string, params: unknown): Promise<void>;
  /**
   * Idempotent open (textDocument/didOpen): tsserver builds no project for an
   * unopened file, so symbol operations all return empty. Repeated calls for
   * the same file send didOpen only once (per-connection cache).
   *
   * Low-level API — a bare ensureOpen never releases the open: the uri stays
   * open until the connection ends. Request paths should use
   * `withDocumentOpen` (no open held between calls). Kept for "open is the
   * goal" uses (warmup project preload).
   */
  ensureOpen(file: string): Promise<void>;
  /**
   * Request-scoped document lifetime: on entry `didOpen` as needed (refcount
   * ++), on exit refcount-- and at zero send `didClose` and drop the uri's
   * open record and diagnostics cache. `fn` throwing still zeroes out
   * (try/finally) — timeout / RPC error / ToolExecutionError never leak open
   * state.
   *
   * Concurrency: overlapping scopes on the same uri share one didOpen; the
   * last leaver sends didClose.
   */
  withDocumentOpen<T>(file: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Sync the latest on-disk text to the server:
   *   - uri never opened → equivalent to `ensureOpen(file)` (didOpen reads the latest text);
   *   - already open → read the full file and send `textDocument/didChange`
   *     (full sync, supported by default by tsserver / typescript-language-server),
   *     per-uri version starting at 1 from didOpen, +1 each time.
   *
   * File read failure → reject (the caller notifier layer already catches; no extra swallowing here).
   */
  notifyChange(file: string): Promise<void>;
  /** Get the latest pushed diagnostics for a file (latest-wins; none → undefined). */
  getDiagnostics(uri: string): ReadonlyArray<unknown> | undefined;
  /**
   * Get a file's diagnostics entry (items plus pushVersion). `pushVersion` is
   * the textDocument version the server carried when pushing (passed through
   * when params.version is a number, else undefined); the tool layer uses it to
   * judge whether new post-edit diagnostics have arrived.
   */
  getDiagnosticsEntry(
    uri: string
  ):
    | { readonly items: ReadonlyArray<unknown>; readonly pushVersion?: number }
    | undefined;
  /**
   * Current didChange version for the uri: didOpen=1, notifyChange +1 each
   * time; not open → undefined. The tool layer uses this to mark "edited"
   * (version ≥ 2) and wait for pushVersion to catch up to openVersion.
   */
  getOpenVersion(uri: string): number | undefined;
  /**
   * Fingerprint of the latest text synced to the server for the uri (content
   * identity, not open → undefined). Under request-scoped opens the LSP version
   * restarts at 1 on every didOpen, so version numbers can't distinguish two
   * opens of the same file; cross-request cache keys (symbol tree) must use the
   * fingerprint, not the version.
   */
  getDocumentFingerprint(uri: string): string | undefined;
  /**
   * Server capabilities from the `initialize` response (verbatim snapshot).
   *
   * Absent ≠ unsupported: typescript-language-server in practice does not
   * declare `callHierarchyProvider` yet implements call hierarchy — pruning on
   * this would misfire. Only an explicit `false` means "unsupported, don't send RPC".
   */
  getServerCapabilities(): Record<string, unknown>;
  /**
   * Release the connection (does not kill the process). Process lifecycle is
   * closed by the pool's reclaim and exit seams — "close connection" and "kill
   * subprocess" are separate; the client only does the former.
   */
  dispose(): void;
}

/**
 * Where a language-server interaction failed. The six stages the failure
 * contract must keep distinguishable, plus the pool's own terminal state:
 *
 *   - `server-selection`: no server matched the file, the server is disabled,
 *     or no project root marker was found — nothing was started;
 *   - `executable-resolution`: the server's own resolution chain (override →
 *     project node_modules/.bin → project venv → harness node_modules → PATH)
 *     found no executable;
 *   - `process-spawn`: the process could not be spawned (ENOENT, EACCES) or has
 *     no usable stdio;
 *   - `process-exit`: the server process died before the handshake completed;
 *   - `initialization`: the `initialize` handshake itself failed;
 *   - `request-timeout` / `unsupported-method`: **not** startup stages — a
 *     per-request deadline and a server capability gap respectively. They are
 *     rendered by the tool layer (timeout error / method-not-found sentinel) and
 *     must never mark a server broken, so they are named here to keep the whole
 *     vocabulary in one place;
 *   - `pool-shutdown`: the pool latched by a host-exit seam; it never respawns.
 */
export type LspFailureStage =
  | "server-selection"
  | "executable-resolution"
  | "process-spawn"
  | "process-exit"
  | "initialization"
  | "request-timeout"
  | "unsupported-method"
  | "pool-shutdown";

/**
 * Failure reasons from getClientDetailed (sentinel layering):
 *   - `no-server`: resolveServer matched no extension, or the hit server.id is
 *     in ctx.disabledServers (treated as unconfigured);
 *   - `no-root`: server.root() found no project root marker;
 *   - `spawn-failed`: the start failed (see `stage`) or the broken memory was hit.
 *
 * `stage` and `cause` are what make the result actionable: `serverId` alone
 * could not distinguish a missing binary from a crashed server, which is the gap
 * the T1 evidence recorded. `stage` is optional only because call sites outside
 * this module construct synthetic `{ reason }` fallbacks; every failure this
 * module produces carries one.
 */
export type LspClientFailure = {
  reason: "no-server" | "no-root" | "spawn-failed";
  serverId?: string;
  stage?: LspFailureStage;
  /** Bounded evidence: the underlying error message and/or server stderr tail. */
  cause?: string;
};

/** A recorded failed start, kept per (root, serverId) until a retry clears it. */
export interface LspBrokenStart {
  readonly reason: "spawn-failed";
  readonly serverId: string;
  readonly stage: LspFailureStage;
  readonly cause?: string;
}

/**
 * Cap on retained stderr / cause text. A language server can flood stderr
 * before dying; the failure record keeps only the tail, which is where the
 * actionable message lives.
 */
const MAX_CAUSE_CHARS = 500;

/** Last-resort truncation of a single stderr chunk before it reaches the tail. */
const MAX_STDERR_CHUNK_CHARS = 4096;

/**
 * Same-session recovery attempts allowed per (root, serverId) key. Bounded on
 * purpose: a repair that keeps failing must not turn into an unbounded respawn
 * loop. Exhausting the budget leaves the key broken and keeps every other key
 * working — recovery is per key, never a pool-wide disable.
 */
export const MAX_LSP_RECOVERY_ATTEMPTS = 3;

/** Short, bounded description of an unknown thrown value. */
function errorCause(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_CAUSE_CHARS);
}

/**
 * Keep the tail of the server's stderr as evidence for a failed start. The old
 * behavior (`child.stderr?.resume()`) drained and discarded it, so a startup
 * failure reported no cause at all.
 */
function captureStderrTail(child: ChildProcess): () => string {
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    tail = (tail + text.slice(-MAX_STDERR_CHUNK_CHARS)).slice(-MAX_CAUSE_CHARS);
  });
  return () => tail.trim();
}

/**
 * Instantiable LSP connection pool. Production engines share the process-level
 * default pool (`getClient` with no ctx.pool lands on defaultPool via
 * `poolOf`; the warmup spawn cache uses the same source, one per process — a
 * per-engine pool would respawn the language server at every assembly in
 * multi-engine/test scenarios); `ctx.pool` is an injection point for test
 * isolation (createLspClientPool). Termination semantics: reclaim seams (idle
 * sweep / rebind stale sweep / `disposeAll`) kill the subprocess of reclaimed
 * entries and may run mid-process; `shutdownAll()` additionally sets a
 * one-way latch (all later getClient return spawn-failed) and may only be
 * called at host-process exit seams (see the file-header cancellation note) —
 * never on engine shutdown / pool rebuild paths.
 */
export class LspClientPool {
  /** key = `${root}:${server.id}` → established, reused clients. */
  readonly clients = new Map<string, LspClient>();
  /** key = `${root}:${server.id}` → the failed start, with its stage and cause. */
  readonly broken = new Map<string, LspBrokenStart>();
  readonly inflight = new Map<string, Promise<LspClient | undefined>>();
  readonly lastUsedAt = new Map<string, number>();
  /**
   * Recovery attempts already spent per key. Survives clearing a broken entry
   * so the budget cannot be reset by retrying (see `retryFailedStart`).
   */
  readonly recoveryAttempts = new Map<string, number>();

  /**
   * Last observed `directoryCell` value. At the `getClient` entry, if the
   * cell's current value ≠ this, a rebind happened — entries whose root
   * equals the old taskRoot are stale: kill the subprocess and evict
   * (`sweepStaleForRebind`).
   *
   * `undefined` ≡ first call (untracked), no sweep — equivalent to "no flip
   * has occurred".
   */
  lastSeenTaskRoot: string | undefined = undefined;

  /**
   * Terminate one entry: close connection + SIGTERM subprocess + evict
   * caches. Shared by the three reclaim seams and `shutdownAll` to avoid
   * copy-paste.
   *
   * Closing the connection does not release the subprocess's stdio pipe
   * handles, so the event loop stays busy — a reclaimed subprocess must be
   * SIGTERMed explicitly or it lives until host exit (a process leak under
   * long sessions / rebinds).
   */
  private terminate(key: string, client: LspClient): void {
    client.dispose();
    // kill returns false on a dead process; harmless.
    client.process.kill("SIGTERM");
    this.evictCachedClient(key, client);
  }

  /**
   * Rebind detection: when `directoryCell` is present and this call's value
   * differs from `lastSeenTaskRoot`, the taskRoot flipped. Terminate every
   * entry whose root equals the **old** taskRoot (close connection + SIGTERM
   * subprocess) and evict it; update `lastSeenTaskRoot` to the current value.
   *
   * Why lazy sweep instead of a flip event handler:
   *  - no subscription infrastructure needed, handled at the single
   *    `getClient` entry point;
   *  - no active calls → no sweep cost (the un-rebind path has zero side
   *    effects, aligned with the byte-identical guard — early return when
   *    `lastSeenTaskRoot === currentValue`);
   *  - the first cross-root call after a rebind closes things down within the
   *    call stack, naturally coupling with the "never write the old root"
   *    contract (write paths must pass through `getClient` first).
   *
   * The sweep scans by **root === old taskRoot** in full, without serverId
   * filtering: once the cell flips, `lastSeenTaskRoot` updates, and a
   * filtered-out server's client under the old root would never be swept
   * again — a subprocess leak in multi-language sessions. The server hit by
   * this dispatch is the routing target, not the reclaim scope.
   *
   * Note: the sweep compares against the **old taskRoot**, not the
   * `ctx.directory` bound — the nearest project root marker returned by
   * `server.root()` (`/root`) can legitimately differ from the taskRoot
   * (`/work`); sweeping by the snapshot bound would kill valid clients of
   * different LSP server roots in the same tree.
   */
  sweepStaleForRebind(currentTaskRoot: string): void {
    const previous = this.lastSeenTaskRoot;
    if (previous === undefined) {
      this.lastSeenTaskRoot = currentTaskRoot;
      return;
    }
    if (previous === currentTaskRoot) return;
    // key = `${root}:${server.id}`; server.id contains no ":", so splitting
    // at the last separator yields a root segment consistent with how keys are
    // built — `/work` won't match `/work-2` or sibling roots with ":" in names.
    for (const [key, client] of [...this.clients]) {
      const sep = key.lastIndexOf(":");
      if (sep === -1 || key.slice(0, sep) !== previous) continue;
      this.terminate(key, client);
      this.broken.delete(key);
    }
    this.lastSeenTaskRoot = currentTaskRoot;
  }

  evictCachedClient(key: string, expected?: LspClient): void {
    if (expected !== undefined && this.clients.get(key) !== expected) return;
    this.clients.delete(key);
    this.lastUsedAt.delete(key);
  }

  sweepIdleClients(idleTimeoutMs: number | undefined): void {
    if (
      idleTimeoutMs === undefined ||
      !Number.isFinite(idleTimeoutMs) ||
      idleTimeoutMs <= 0 ||
      this.clients.size === 0
    )
      return;
    const now = Date.now();
    for (const [key, client] of [...this.clients]) {
      if (now - (this.lastUsedAt.get(key) ?? 0) > idleTimeoutMs) {
        this.terminate(key, client);
      }
    }
  }

  /**
   * Reclaim all entries and clear failure memory / in-flight tables. No latch:
   * later getClient still respawns (pool stays usable, just without resident
   * subprocesses).
   */
  async disposeAll(): Promise<void> {
    for (const [key, client] of [...this.clients]) {
      this.terminate(key, client);
    }
    this.broken.clear();
    this.recoveryAttempts.clear();
    this.inflight.clear();
  }

  /**
   * Clear one recorded failed start so the next `getClient` really spawns again
   * — the install-to-retry recovery seam.
   *
   * Bounded: at most `MAX_LSP_RECOVERY_ATTEMPTS` clears per key per session,
   * counted in `recoveryAttempts` which survives the clear, so a repair that
   * keeps failing cannot become an unbounded respawn loop. Returns false once
   * the budget is spent (the key stays broken) or when nothing was failed.
   *
   * Deliberately **not** a shutdown path: it never touches the `shutDown`
   * latch, never terminates other entries, and never clears the whole pool, so
   * a recovered key and every untouched key stay usable in the same session.
   */
  retryFailedStart(root: string, serverId: string): boolean {
    const key = `${root}:${serverId}`;
    if (!this.broken.has(key)) return false;
    const spent = this.recoveryAttempts.get(key) ?? 0;
    // EXIT: budget spent → refuse and leave the failed start recorded, so the
    // caller keeps seeing the typed stage instead of an endless retry.
    if (spent >= MAX_LSP_RECOVERY_ATTEMPTS) return false;
    this.recoveryAttempts.set(key, spent + 1);
    this.broken.delete(key);
    return true;
  }

  /**
   * Spend one recovery attempt for `key` and drop its failed-start record.
   * Shared by the explicit `retryFailedStart` and the automatic
   * install-detected path so both draw on the same bounded budget.
   */
  consumeRecovery(key: string): boolean {
    const spent = this.recoveryAttempts.get(key) ?? 0;
    if (spent >= MAX_LSP_RECOVERY_ATTEMPTS) return false;
    this.recoveryAttempts.set(key, spent + 1);
    this.broken.delete(key);
    return true;
  }

  /**
   * Final lifecycle state (engine shutdown / exit paths only): terminate all
   * spawned subprocesses + clear the pool. Afterwards getClientDetailed always
   * returns spawn-failed and never respawns (guards against exit-path
   * re-spawn leaks).
   *
   * The only difference from disposeAll is this latch: disposeAll allows
   * respawning afterward, this does not.
   */
  shutDown = false;

  async shutdownAll(): Promise<void> {
    this.shutDown = true;
    for (const [key, client] of [...this.clients]) {
      this.terminate(key, client);
    }
    this.clients.clear();
    this.lastUsedAt.clear();
    this.broken.clear();
    this.recoveryAttempts.clear();
    this.inflight.clear();
  }
}

const defaultPool = new LspClientPool();

export function createLspClientPool(): LspClientPool {
  return new LspClientPool();
}

/**
 * Terminate all LSP subprocesses in the process-level default pool (consumed
 * by engine shutdown / exit paths). The default pool is shared across engines
 * (warmup spawn cache uses the same source), one per process — closing it
 * terminates everything, so call it only at host-process exit seams, never
 * mid-way through rebuilding a single engine.
 */
export function shutdownDefaultLspPool(): Promise<void> {
  return defaultPool.shutdownAll();
}

function poolOf(ctx: LspCtx): LspClientPool {
  return ctx.pool ?? defaultPool;
}

/**
 * Effective directory for this call: when `ctx.directoryCell` is present use
 * its current value; otherwise fall back to the frozen `ctx.directory` (the
 * un-rebind path stays byte-for-byte unchanged).
 *
 * Read once at entry: the whole path within one `getClient` call uses the same
 * value, avoiding read drift if the cell is flipped externally mid-call.
 */
export function resolveDirectorySnapshot(ctx: LspCtx): string {
  return ctx.directoryCell ? ctx.directoryCell.read() : ctx.directory;
}

/**
 * Get (or establish) the LSP client for (file, ctx) and surface the failure
 * reason (sentinel layering).
 *
 * Flow:
 *   0. Entry lazy sweep: reclaim idle clients per ctx.idleTimeoutMs.
 *   1. `server = opts?.server ?? resolveServer(file)`; no match → no-server.
 *      A hit server.id in ctx.disabledServers → no-server (unconfigured).
 *   2. `root = await server.root(file, ctx)`; undefined → no-root.
 *   3. `key = root + ":" + server.id`; `broken` hit → spawn-failed.
 *   4. `clients.has(key)` → reuse cache (refresh lastUsedAt).
 *   5. `inflight.has(key)` → share the in-flight spawn Promise (dedup).
 *   6. Otherwise start `spawnClient`: mark `broken` on failure; store in
 *      `clients` on success; `.finally` releases `inflight`.
 *
 * `opts.server` injects a test double and overrides the `resolveServer(file)`
 * dispatch result (default routes by extension).
 *
 * @returns `{ client }` or `{ failure }` — exactly one field (failure is always
 *          present when client is missing; failure.serverId feeds sentinel rendering).
 */
export async function getClientDetailed(
  ctx: LspCtx,
  file: string,
  opts?: { readonly server?: LspServerInfo }
): Promise<{ client?: LspClient; failure?: LspClientFailure }> {
  const pool = poolOf(ctx);
  // After the terminal lifecycle latch, never spawn again (guards against
  // re-spawn leaks on exit paths) — see shutdownAll.
  if (pool.shutDown) {
    return {
      failure: {
        reason: "spawn-failed",
        stage: "pool-shutdown",
        cause: "LSP pool was shut down by a host-exit seam; it never respawns",
      },
    };
  }
  pool.sweepIdleClients(ctx.idleTimeoutMs);
  const server = opts?.server ?? resolveServer(file);
  if (!server) {
    return {
      failure: {
        reason: "no-server",
        stage: "server-selection",
        cause: `no LSP server handles ${file}`,
      },
    };
  }
  if (ctx.disabledServers?.includes(server.id)) {
    return {
      failure: {
        reason: "no-server",
        serverId: server.id,
        stage: "server-selection",
        cause: `server ${server.id} is disabled in settings.lsp.disabledServers`,
      },
    };
  }
  // Per-call directory snapshot: read the live root cell once at entry so the
  // whole path (NearestRoot stop / pool key) uses the same value. Consistency
  // within a wave shares the same basis as the batch snapshot — an external
  // cell flip mid-call cannot pollute it. Note the sweep is triggered by the
  // cell value **flipping**, not by comparing against server.root: different
  // files on the same server can legitimately have different server.root
  // values (different markers under the same tree) yet all belong to the same
  // taskRoot and must not be swept.
  const directorySnapshot = resolveDirectorySnapshot(ctx);
  const ctxForRoot: LspCtx =
    ctx.directoryCell !== undefined
      ? { ...ctx, directory: directorySnapshot }
      : ctx;
  if (ctx.directoryCell !== undefined) {
    pool.sweepStaleForRebind(directorySnapshot);
  }
  const root = await server.root(file, ctxForRoot);
  if (!root) {
    return {
      failure: {
        reason: "no-root",
        serverId: server.id,
        stage: "server-selection",
        cause: `no project root marker for ${server.id} above ${file} within ${ctxForRoot.directory}`,
      },
    };
  }

  const key = `${root}:${server.id}`;
  const cached = pool.clients.get(key);
  if (cached) {
    pool.lastUsedAt.set(key, Date.now());
    return { client: cached };
  }
  // Nothing established for this key yet: a recorded failed start blocks it
  // unless an approved install has since landed within the recovery budget.
  const blocked = await blockedByRecordedFailure({
    pool,
    server,
    root,
    ctx: ctxForRoot,
    key,
  });
  if (blocked !== undefined) return blocked;
  const pending = pool.inflight.get(key);
  if (pending) {
    const client = await pending;
    return client ? { client } : spawnFailedFor(server.id, pool.broken.get(key));
  }

  const task = spawnClient(pool, server, root, ctxForRoot)
    .then((outcome) => {
      if ("client" in outcome) {
        pool.clients.set(key, outcome.client);
        pool.lastUsedAt.set(key, Date.now());
        return outcome.client;
      }
      pool.broken.set(key, {
        reason: "spawn-failed",
        serverId: server.id,
        stage: outcome.stage,
        ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      });
      return undefined;
    })
    .catch((err: unknown) => {
      // EXIT: an unexpected throw inside the start path (not one of the typed
      // outcomes) still records a typed failure instead of escaping as an
      // unhandled rejection.
      pool.broken.set(key, {
        reason: "spawn-failed",
        serverId: server.id,
        stage: "process-spawn",
        cause: errorCause(err),
      });
      return undefined;
    })
    .finally(() => {
      pool.inflight.delete(key);
    });
  pool.inflight.set(key, task);
  const client = await task;
  return client
    ? { client }
    : spawnFailedFor(server.id, pool.broken.get(key));
}

/**
 * Typed spawn-failed projection for one key: the recorded stage plus whatever
 * evidence was retained, defaulting to `executable-resolution` when nothing
 * was recorded.
 */
function spawnFailedFor(
  serverId: string,
  broken: LspBrokenStart | undefined
): { failure: LspClientFailure } {
  return {
    failure: {
      reason: "spawn-failed",
      serverId,
      stage: broken?.stage ?? "executable-resolution",
      ...(broken?.cause !== undefined ? { cause: broken.cause } : {}),
    },
  };
}

/**
 * The recorded-failure gate for one key. `undefined` means the caller may
 * spawn: either nothing was recorded, or an approved install has landed since
 * the failure and the bounded recovery budget still has an attempt.
 * Otherwise the typed failure to return verbatim.
 */
async function blockedByRecordedFailure(args: {
  readonly pool: LspClientPool;
  readonly server: LspServerInfo;
  readonly root: string;
  readonly ctx: LspCtx;
  readonly key: string;
}): Promise<{ failure: LspClientFailure } | undefined> {
  const recorded = args.pool.broken.get(args.key);
  if (recorded === undefined) return undefined;
  // An approved install into the project may have landed since the failure.
  // Re-check the server's own candidate paths and spend one bounded recovery
  // attempt when one now exists, so the next call really spawns.
  const installed = await serverHasExecutableNow(
    args.server,
    args.root,
    args.ctx
  );
  return installed && args.pool.consumeRecovery(args.key)
    ? undefined
    : spawnFailedFor(args.server.id, recorded);
}

/**
 * Whether the server's project/worktree executable candidates exist right now.
 *
 * The install-completed signal for automatic recovery: the recorded failure said
 * "no executable", and now one of the exact paths resolution probes is present.
 * A server that declares no candidates yields false — an unchanged environment
 * keeps its recorded failure.
 */
async function serverHasExecutableNow(
  server: LspServerInfo,
  root: string,
  ctx: LspCtx
): Promise<boolean> {
  if (server.executableCandidates === undefined) return false;
  try {
    const candidates = await server.executableCandidates(root, ctx);
    return candidates.some((candidate) => existsSync(candidate));
  } catch {
    // EXIT: candidate probing itself failed → no evidence of an install, so the
    // recorded failed start stands.
    return false;
  }
}

/**
 * Clear one failed start for (root, serverId) so the next `getClient` respawns —
 * the same-session recovery seam after an approved install or repair.
 *
 * Bounded by `MAX_LSP_RECOVERY_ATTEMPTS` per key (returns false when spent) and
 * never routed through `shutdownAll` / the `shutDown` latch, so it is not
 * terminal. Returns true when the failed start was cleared.
 */
export function retryFailedLspStart(
  ctx: LspCtx,
  opts: { readonly root: string; readonly serverId: string }
): boolean {
  return poolOf(ctx).retryFailedStart(opts.root, opts.serverId);
}

/**
 * Thin wrapper over `getClientDetailed` that returns only the client for
 * (file, ctx), normalizing failures to undefined. Signature and behavior stay
 * compatible with existing callers (notifier / warmup / probes).
 */
export async function getClient(
  ctx: LspCtx,
  file: string,
  opts?: { readonly server?: LspServerInfo }
): Promise<LspClient | undefined> {
  return (await getClientDetailed(ctx, file, opts)).client;
}

/**
 * Result of one start attempt: an established client, or the stage that failed
 * plus whatever evidence was available (server stderr tail, error message,
 * exit status).
 */
type SpawnOutcome =
  | { readonly client: LspClient }
  | { readonly stage: LspFailureStage; readonly cause?: string };

/** How one `initialize` round-trip ended: the response, or what beat it. */
type Handshake =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "error"; readonly err: unknown }
  | { readonly kind: "exited"; readonly exit: { readonly code: number | null } }
  | { readonly kind: "spawn-error"; readonly reason: string };

/**
 * The server's process handle, or the typed stage that stopped it. A server
 * that resolved no executable and a server whose spawn threw are both
 * `executable-resolution` failures, each carrying its own evidence.
 */
async function resolveServerHandle(
  server: LspServerInfo,
  root: string,
  ctx: LspCtx
): Promise<
  | { readonly ok: true; readonly handle: LspServerHandle }
  | { readonly ok: false; readonly outcome: SpawnOutcome }
> {
  try {
    const spawned = await server.spawn(root, ctx);
    // EXIT: the server's resolution chain (override → project node_modules/.bin
    // → project venv → harness node_modules → PATH) found no executable.
    if (!spawned) {
      return {
        ok: false,
        outcome: {
          stage: "executable-resolution",
          cause: `no executable resolved for ${server.id} (root ${root})`,
        },
      };
    }
    return { ok: true, handle: spawned };
  } catch (err) {
    // EXIT: spawn threw while resolving / creating the process — no child
    // exists, so there is nothing to keep alive; report the cause instead of
    // swallowing.
    return {
      ok: false,
      outcome: { stage: "executable-resolution", cause: errorCause(err) },
    };
  }
}

/**
 * The `initialize` request raced against the two ways it can be lost — the
 * process exiting first, or the spawn failing / the pipe closing before any
 * answer. Whichever lands first wins; the caller names the stage and tears
 * down.
 */
async function awaitInitialize(args: {
  readonly connection: MessageConnection;
  readonly child: ChildProcess;
  readonly root: string;
  readonly initialization: Record<string, unknown> | undefined;
  readonly spawnErrorPromise: Promise<string>;
  readonly exitedEarly: Promise<{ readonly code: number | null }>;
}): Promise<Handshake> {
  // tsserver wants `path` passed through in initializationOptions.
  // connection.listen() must come first to start the reader loop, or
  // sendRequest throws "Call listen() first." (vscode-jsonrpc requirement).
  args.connection.listen();
  return Promise.race([
    Promise.resolve(
      args.connection.sendRequest("initialize", {
        processId: args.child.pid ?? null,
        rootUri: pathToFileURL(args.root).href,
        // Advertise only the methods the harness actually sends: textDocument
        // sync + diagnostic push subscription. Symbol capabilities are the
        // **server's** (reported in its capabilities response), not declared
        // client-side.
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
          },
          workspace: { symbol: { dynamicRegistration: false } },
        },
        initializationOptions: args.initialization,
      })
    ).then(
      (result) => ({ kind: "ok" as const, result }),
      (err: unknown) => ({ kind: "error" as const, err })
    ),
    args.exitedEarly.then((exit) => ({ kind: "exited" as const, exit })),
    // A process that dies without ever exiting emits `error` and then `close`;
    // surface it as soon as the event lands instead of waiting on a handshake
    // that can never be answered.
    Promise.race([
      args.spawnErrorPromise,
      new Promise<string>((resolve) =>
        args.child.once("close", () => resolve("closed"))
      ),
    ]).then((reason) => ({ kind: "spawn-error" as const, reason })),
  ]);
}

/**
 * Teardown + typed stage for a handshake that never answered: release what
 * this attempt created (a connection without a live, handshaken server is
 * useless), kill the child, and attach the retained stderr tail to the cause
 * so the failure carries its evidence.
 */
function failedStartOutcome(args: {
  readonly serverId: string;
  readonly connection: MessageConnection;
  readonly child: ChildProcess;
  readonly stderrTail: string;
  readonly handshake: Exclude<Handshake, { readonly kind: "ok" }>;
}): SpawnOutcome {
  args.connection.dispose();
  args.child.kill("SIGTERM");
  const stderr = args.stderrTail;
  const withStderr = (cause: string): string =>
    stderr.length > 0 ? `${cause} | stderr: ${stderr}` : cause;
  switch (args.handshake.kind) {
    case "exited":
      return {
        stage: "process-exit",
        cause: withStderr(
          `${args.serverId} exited with code ${String(args.handshake.exit.code)} before initialize`
        ),
      };
    case "spawn-error":
      return { stage: "process-spawn", cause: withStderr(args.handshake.reason) };
    default:
      return {
        stage: "initialization",
        cause: withStderr(errorCause(args.handshake.err)),
      };
  }
}

/**
 * Establish a single server connection: spawn the subprocess → pipe stdio into
 * a MessageConnection → send the `initialize` handshake → `listen()` → wrap as
 * an `LspClient`.
 *
 * Every failure path names its stage instead of collapsing to `undefined`:
 *   - `server.spawn` resolved nothing → `executable-resolution` (its own
 *     resolution chain found no executable);
 *   - `server.spawn` threw, or the child has no stdio, or the process failed to
 *     spawn (ENOENT / EACCES) → `process-spawn`;
 *   - the child died before the handshake answered → `process-exit`;
 *   - `initialize` itself failed → `initialization`.
 *
 * A failed start disposes the connection and kills the child it created, so a
 * dead server never accumulates processes in a long session.
 */
async function spawnClient(
  pool: LspClientPool,
  server: LspServerInfo,
  root: string,
  ctx: LspCtx
): Promise<SpawnOutcome> {
  // Same cache key as getClient: the exit self-heal hook needs it to evict from `clients`.
  const key = `${root}:${server.id}`;
  const started = await resolveServerHandle(server, root, ctx);
  if (!started.ok) return started.outcome;
  const handle = started.handle;

  const { process: child, initialization } = handle;
  if (!child.stdout || !child.stdin) {
    // EXIT: without both pipes the JSON-RPC transport cannot exist. Nothing was
    // started successfully; report it as a spawn-stage failure, not silence.
    child.kill("SIGTERM");
    return {
      stage: "process-spawn",
      cause: `${server.id} process exposes no stdio pipes`,
    };
  }

  // EXIT: once a failed start is torn down (below), an already-queued write on
  // the request pipe surfaces as EPIPE / ERR_STREAM_DESTROYED. The failure is
  // being reported through the typed outcome, so absorb the pipe error here
  // rather than letting it reach the host as an unhandled rejection.
  child.stdin?.on("error", () => undefined);

  let spawnError: string | undefined;
  const spawnErrorPromise = new Promise<string>((resolve) => {
    child.once("error", (err: Error) => {
      spawnError = errorCause(err);
      resolve(spawnError);
    });
  });
  // A spawn that never created a process has no pid. That is the only reliable
  // synchronous signal for "the OS refused the executable", so the handshake is
  // never written into a pipe with nothing behind it.
  if (typeof child.pid !== "number" || child.pid <= 0) {
    const reason = await Promise.race([
      spawnErrorPromise,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(`${server.id} could not be spawned`), 250)
      ),
    ]);
    child.kill("SIGTERM");
    return { stage: "process-spawn", cause: reason };
  }

  const stderrTail = captureStderrTail(child);
  const exitedEarly = new Promise<{ code: number | null }>((resolve) => {
    child.once("exit", (code: number | null) => resolve({ code }));
  });

  const connection = createMessageConnection(child.stdout, child.stdin);

  const handshake = await awaitInitialize({
    connection,
    child,
    root,
    initialization,
    spawnErrorPromise,
    exitedEarly,
  });

  if (handshake.kind !== "ok") {
    // Release what this attempt created before reporting: the connection is
    // useless without a live, handshaken server.
    return failedStartOutcome({
      serverId: server.id,
      connection,
      child,
      stderrTail: stderrTail(),
      handshake,
    });
  }
  const initializeResult = handshake.result as
    { capabilities?: Record<string, unknown> } | undefined;
  // Snapshot of declared server capabilities: only used for the "explicit
  // false → don't send" check (absent ≠ unsupported, see getServerCapabilities).
  const serverCapabilities = initializeResult?.capabilities ?? {};

  // LSP `initialized` notification (production correctness): the server only
  // reaches its ready state after it follows the initialize response. Pyright
  // verified in practice gates on it — without `initialized` it ignores all
  // later requests; tsserver does not gate, so TS worked before and sending it
  // is harmless to tsserver (idempotent). Probes (scripts/lsp-probe.ts) no
  // longer send their own to avoid double-init.
  await connection.sendNotification("initialized", {});

  // Push diagnostics: tsserver / typescript-language-server do not implement
  // pull-based textDocument/diagnostic (LSP 3.16+), so use publishDiagnostics
  // notifications to keep the latest per-uri diagnostic list. Latest-wins: a
  // later push for the same uri overwrites the earlier one. Each entry also
  // records the textDocument version the server carried when pushing
  // (params.version passed through when numeric, else undefined) so the tool
  // layer can tell whether post-edit diagnostics have arrived.
  const diagStore = new Map<
    string,
    { items: ReadonlyArray<unknown>; pushVersion?: number }
  >();
  connection.onNotification(
    "textDocument/publishDiagnostics",
    (params: unknown) => {
      if (!params || typeof params !== "object") return;
      const p = params as {
        uri?: unknown;
        diagnostics?: unknown;
        version?: unknown;
      };
      if (typeof p.uri !== "string") return;
      const items = Array.isArray(p.diagnostics) ? p.diagnostics : [];
      const pushVersion = typeof p.version === "number" ? p.version : undefined;
      diagStore.set(p.uri, { items, pushVersion });
    }
  );

  // Open-document state: a **single** record keyed by uri per connection
  // (version / refcount / pinned co-located, avoiding drift between multiple
  // Maps). tsserver keeps a per-project open-file table and a repeated
  // didOpen for the same uri trips a version assertion, so dedup locally.
  //
  //   - `version`: set to 1 on didOpen, +1 per `didChange` (consumers of
  //     getOpenVersion: symbol-cache version keys, old-vs-new diagnostic waits);
  //   - `refs`: request-scoped hold count (entered/exited by withDocumentOpen);
  //   - `pinned`: permanent hold from a bare `ensureOpen` (warmup preloading) —
  //     a pinned uri never closes when scoped refs drop to zero (see the
  //     LspClient.ensureOpen doc).
  interface OpenDoc {
    version: number;
    refs: number;
    pinned: boolean;
    /** Fingerprint of the latest text synced to the server (see getDocumentFingerprint). */
    fingerprint: string;
    /** Disk mtime (ms) at last sync; checked before requests to detect out-of-band edits. */
    mtimeMs: number;
  }
  const openDocs = new Map<string, OpenDoc>();

  /**
   * Text fingerprint = content identity (sha1). Content, not the version
   * number, is the cross-request cache key: re-didOpen after didClose resets
   * the LSP version to 1, so versions can't distinguish two opens of the same
   * file; the fingerprint only changes when content does — consumers (symbol
   * tree cache) judge staleness by it.
   */
  const fingerprintOf = (text: string): string =>
    createHash("sha1").update(text, "utf8").digest("hex");

  /** File mtime (ms); stat failure (file deleted) → NaN meaning "cannot compare". */
  const mtimeOf = async (file: string): Promise<number> => {
    try {
      return (await stat(file)).mtimeMs;
    } catch {
      // EXIT: stat failed (deleted / unreadable) → NaN meaning "cannot
      // compare". Callers skip alignment on it: better to miss one didChange
      // than to send one based on empty content.
      return Number.NaN;
    }
  };

  /**
   * Out-of-band change alignment: with no file watcher, compare mtime for
   * still-open uris **before sending a request** — on change, re-read the full
   * file and send a full-sync didChange.
   *
   * Needed for warmup-pinned documents (bare ensureOpen): they stay open
   * across many requests, so an external edit (bypassing edit_file / notifier)
   * makes the server-side text stale. Request-scoped opens just read the disk,
   * so mtime matches → skipped (no redundant didChange).
   */
  const alignToDisk = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    const entry = openDocs.get(uri);
    if (!entry) return;
    const current = await mtimeOf(file);
    // NaN (mtime unreadable): don't compare — better to miss one didChange
    // than to send empty content by mistake.
    if (Number.isNaN(current) || current === entry.mtimeMs) return;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      // EXIT: file deleted / unreadable → no didChange; keep the server-side
      // state (stale text still serves), synced at the next open or alignment.
      return;
    }
    const latest = openDocs.get(uri);
    if (!latest) return; // closed by a concurrent last-exit while reading
    const nextVersion = latest.version + 1;
    latest.version = nextVersion;
    latest.fingerprint = fingerprintOf(text);
    latest.mtimeMs = current;
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
  };

  /** Zero-out: didClose + drop the open record and the uri's diagnostics cache. */
  const closeDocument = async (uri: string): Promise<void> => {
    openDocs.delete(uri);
    // Drop the diagnostics cache in lockstep: keeping it would let the next
    // request read a previous (possibly stale) push.
    diagStore.delete(uri);
    await connection.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  };

  // In-flight open dedup (same shape as the pool's inflight trio): concurrent
  // calls for the same file share one "read + didOpen". Only **established**
  // records land in openDocs — no half-built entries: a readFile failure voids
  // the whole task and the next call retries (failures are retryable).
  const opening = new Map<string, Promise<void>>();

  const openDocument = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    if (openDocs.has(uri)) return;
    const pending = opening.get(uri);
    if (pending) return pending;
    const task = (async () => {
      const text = await readFile(file, "utf8");
      const mtimeMs = await mtimeOf(file);
      openDocs.set(uri, {
        version: 1,
        refs: 0,
        pinned: false,
        fingerprint: fingerprintOf(text),
        mtimeMs,
      });
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdFor(file),
          version: 1,
          text,
        },
      });
    })().finally(() => {
      opening.delete(uri);
    });
    opening.set(uri, task);
    return task;
  };

  const ensureOpen = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    const existing = openDocs.get(uri);
    if (existing) {
      // Already open → just mark pinned (warmup semantics: opening is the
      // goal; never closed by scope exit).
      existing.pinned = true;
      return;
    }
    await openDocument(file);
    const opened = openDocs.get(uri);
    if (opened) opened.pinned = true;
  };

  const withDocumentOpen = async <T>(
    file: string,
    fn: () => Promise<T>
  ): Promise<T> => {
    const uri = pathToFileURL(file).href;
    // Ref claim (refs++) and the in-registry check must land in the same tick:
    // while `await openDocument` yields, the entry may be closed by a last-exit
    // (closeDocument deletes synchronously), so a later `get` returns
    // undefined. Loop until we truly hold a ref before entering fn — "the
    // document stays open across overlapping scopes" is a structural
    // guarantee, not a single-point if fallback.
    let entry = openDocs.get(uri);
    while (!entry) {
      await openDocument(file);
      entry = openDocs.get(uri);
    }
    entry.refs += 1;
    try {
      // Pre-request alignment: openDocument reads the disk fresh so mtime is
      // already synced; alignment actually sends a didChange only when reusing
      // a document opened earlier that changed out-of-band since. Placed after
      // the ref claim: alignment's own awaits no longer give a last-exit a
      // chance to close our document, and an alignment throw still zeroes out
      // via finally (no leaked open state).
      await alignToDisk(file);
      return await fn();
    } finally {
      // Zero out even if fn throws (try/finally): timeout / RPC error /
      // ToolExecutionError must not leak open state. Release by **captured
      // entry identity** (not a re-get): if another scope reopened as a new
      // object, the identity mismatch prevents closing the wrong document.
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0 && !entry.pinned && openDocs.get(uri) === entry) {
        await closeDocument(uri);
      }
    }
  };

  const notifyChange = async (file: string): Promise<void> => {
    const uri = pathToFileURL(file).href;
    if (!openDocs.has(uri)) {
      // Not open → didOpen-equivalent path: read the file now (latest text),
      // then close immediately (request-scoped semantics: never stay open
      // between calls). The server got the new content from didOpen, so no
      // follow-up didChange needed.
      await withDocumentOpen(file, async () => undefined);
      return;
    }
    // Already open → read the full file and send a full-sync didChange.
    // readFile failure rejects directly: the notifier layer already catches
    // (best-effort); keeping the original error here aids stderr attribution.
    const text = await readFile(file, "utf8");
    const mtimeMs = await mtimeOf(file);
    const current = openDocs.get(uri);
    if (!current) return; // closed concurrently while reading → don't notify a closed doc
    const nextVersion = current.version + 1;
    current.version = nextVersion;
    // Keep the books in sync: the server-side text now equals the disk text
    // just read, so update fingerprint/mtime too — otherwise the next
    // request's alignment would resend this same didChange.
    current.fingerprint = fingerprintOf(text);
    current.mtimeMs = mtimeMs;
    await connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
  };

  const client: LspClient = {
    connection,
    process: child,
    // vscode-jsonrpc `sendRequest(method, ...args)` infers the params shape
    // from the argument count: passing 3 args (params + token) sets
    // `numberOfParams=2` even when token is undefined, wrapping named params
    // into a positional array `[params, null]` → tsserver replies -32602
    // "defines parameters by name but received parameters by position".
    // Pass token as the 3rd argument only when it actually exists.
    sendRequest: (method, params, token) =>
      connection.sendRequest(
        method,
        params,
        ...(token !== undefined ? [token] : [])
      ),
    sendNotification: (method, params) =>
      connection.sendNotification(method, params),
    getDiagnostics: (uri: string) => diagStore.get(uri)?.items,
    getDiagnosticsEntry: (uri: string) => diagStore.get(uri),
    getOpenVersion: (uri: string) => openDocs.get(uri)?.version,
    getDocumentFingerprint: (uri: string) => openDocs.get(uri)?.fingerprint,
    getServerCapabilities: () => serverCapabilities,
    ensureOpen,
    withDocumentOpen,
    notifyChange,
    dispose: () => connection.dispose(),
  };

  // Self-heal on unexpected process exit: after a server crash, leaving the
  // dead connection in the `clients` cache would fail every later request in
  // the session. On exit, evict the cache key **this instance** occupies so
  // the next getClient respawns.
  //   - Not added to `broken`: spawn succeeded before, so this is a
  //     restartable failure, semantically different from a spawn failure
  //     (missing bin);
  //   - guard `clients.get(key) === client`: after eviction a respawn may
  //     already have installed a new client — a late exit from the old
  //     process must not evict it too;
  //   - if the process exits after dispose() (deliberate close), eviction is
  //     idempotent and harmless (the cache should be released anyway), no
  //     need to distinguish deliberate from accidental exit.
  child.once("exit", () => {
    pool.evictCachedClient(key, client);
  });

  return { client };
}

/**
 * Bridge a Node.js `AbortSignal` to a vscode-jsonrpc `CancellationToken` —
 * wrap a `CancellationTokenSource`: aborting the signal cancels the source,
 * and vscode-jsonrpc automatically sends `$/cancelRequest` when its token is
 * cancelled.
 *
 * Usage: handlers get `ctx.signal` passed through by the executor, convert it
 * via this helper and hand the token to `client.sendRequest`; that way
 * interrupting an `interruptBehavior: "cancel"` LSP tool truly goes through
 * the JSON-RPC cancellation channel, without killing tsserver.
 */
export function signalToCancellationToken(signal: AbortSignal): {
  token: CancellationToken;
  dispose: () => void;
} {
  const source = new CancellationTokenSource();
  const onAbort = (): void => {
    source.cancel();
  };
  if (signal.aborted) {
    source.cancel();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    token: source.token,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * The JSON-RPC `-32601 MethodNotFound` code. Language servers return it for
 * unimplemented providers (the vscode-languageserver framework's fallback
 * message is `Unhandled method <m>`).
 */
export const METHOD_NOT_FOUND = -32601;

/**
 * method → provider field name in the `initialize` capabilities response.
 * The mount point is not limited to the textDocument prefix:
 * `workspace/symbol` maps to `workspaceSymbolProvider`, so look up by full
 * method name. Methods absent from the table (e.g.
 * `callHierarchy/incomingCalls` — its provider is declared only at the
 * prepareCallHierarchy step) are always sent.
 */
const METHOD_CAPABILITY_KEYS: Record<string, string> = {
  "textDocument/definition": "definitionProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
  "textDocument/implementation": "implementationProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/prepareCallHierarchy": "callHierarchyProvider",
  "textDocument/typeDefinition": "typeDefinitionProvider",
  "textDocument/declaration": "declarationProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/foldingRange": "foldingRangeProvider",
  "textDocument/selectionRange": "selectionRangeProvider",
  "textDocument/documentHighlight": "documentHighlightProvider",
  "textDocument/semanticTokens/full": "semanticTokensProvider",
  "textDocument/inlayHint": "inlayHintProvider",
  "textDocument/inlineValue": "inlineValueProvider",
  "textDocument/diagnostic": "diagnosticProvider",
  "workspace/symbol": "workspaceSymbolProvider",
};

/**
 * Whether the server **explicitly declares** no support for a method (its
 * provider field in capabilities is `false`). **Absent ≠ unsupported** —
 * typescript-language-server verified in practice does not declare
 * `callHierarchyProvider` yet implements call hierarchy; pruning on
 * declarations would wrongly cut TS's 10/10 fidelity surface (probes likewise
 * discipline on MethodNotFound-skip, not declaration pruning). Only an
 * explicit `false` means "definitely absent, don't send".
 */
export function serverDeclaresUnsupported(
  capabilities: Record<string, unknown>,
  method: string
): boolean {
  const key = METHOD_CAPABILITY_KEYS[method];
  if (key === undefined) return false;
  return capabilities[key] === false;
}

/**
 * Decide whether an RPC error means "the server does not implement this
 * method" — a capability gap, not a failed request and certainly not a spawn
 * failure. On a hit the caller translates it into the model-readable sentinel
 * (plain string); it must **not** mark broken or evict the client (the
 * connection and process are fine; other methods still work).
 *
 * The primary check is the numeric code (stable); the message prefix is a
 * fallback for errors not wrapped by vscode-jsonrpc.
 */
export function isMethodNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === METHOD_NOT_FOUND) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.startsWith("Unhandled method ");
}

/**
 * Cancel an in-flight request — via the JSON-RPC `$/cancelRequest` notification.
 *
 * **Never terminates the tsserver subprocess**: termination would break
 * resident reuse and leave later requests without the shared connection. The
 * cancellation signal is handled by tsserver itself.
 *
 * @param client Target client (its `connection` sends the cancellation).
 * @param reqId Request id to cancel (assigned by vscode-jsonrpc).
 */
export function cancelRequest(client: LspClient, reqId: number): Promise<void> {
  return client.connection.sendNotification("$/cancelRequest", {
    id: reqId,
  });
}
