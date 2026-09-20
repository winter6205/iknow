/**
 * MCP manager: connection lifecycle + state machine + registerExternal wiring.
 *
 * Wraps the SDK `Client` + `StdioClientTransport` behind an injectable
 * `McpClientHandle`. Production defaults to `createRealClient` (bottom of this
 * file); unit tests inject an in-memory fake, so no real server is spawned.
 *
 * Per-server state machine:
 *   pending → connected   connect + first listTools done, registerExternal(defs)
 *   pending → failed      connect/listTools threw or timed out (default 60s, injectable)
 *   pending → disabled    config.status === "disabled", no client created
 *   connected → failed    onclose fired (no reconnect)
 *   connected → connected list_changed triggers incremental re-registration
 *
 * Concurrency:
 *   - list_changed arriving during an in-flight callTool: re-registration only
 *     appends new names (duplicates skipped) and never interrupts the call;
 *     callTool awaits through a manager-held AbortController `signal`.
 *   - shutdown: aborts in-flight callTool signals, closes the client, and
 *     SIGTERMs the spawned stdio child. In-flight calls settle as `abort`
 *     errors — never as false success, never hanging.
 *
 * No schema normalization: MCP inputSchema shapes were probed against ajv
 * strict and all pass; registerExternal reuses the existing ajv instance.
 */
import path from "node:path";

import {
  Client as SdkClient,
  type CallToolResult as SdkCallToolResult,
  type Resource as SdkResource,
  type ResourceContents as SdkResourceContents,
  type Tool as SdkTool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport as SdkStdioTransport } from "@modelcontextprotocol/client/stdio";
import {
  McpLifecycleError,
  ToolExecutionError,
  errorMessage,
} from "../errors.js";
import type { AciToolDef } from "../aci/types.js";
import { toAciToolDef } from "./adapter.js";
import type { McpServerConfig, McpStdioServer } from "./config.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-server state-machine snapshot. */
export type McpServerState = "pending" | "connected" | "failed" | "disabled";

export interface McpServerStatus {
  readonly name: string;
  readonly state: McpServerState;
  readonly source: McpServerConfig["source"];
  readonly error?: string;
}

/** One server + tool pair at registration. */
export interface McpToolEntry {
  readonly server: string;
  readonly tool: SdkTool;
}

/** Result wrapper for one tool call. */
export interface McpCallResult {
  readonly result: SdkCallToolResult;
}

/**
 * MCP resource-channel types shared between manager and tool layer.
 * All public shapes are readonly; the aggregation loop pushes into a mutable
 * form and freezes before returning (see MutableListResourcesResult).
 */
export interface McpResource {
  readonly server: string;
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPerServerState {
  readonly server: string;
  readonly state: McpServerState;
  readonly nextCursor?: string;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface ListResourcesOpts {
  readonly server?: string;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export interface ListResourcesResult {
  readonly resources: ReadonlyArray<McpResource>;
  readonly perServer: ReadonlyArray<McpPerServerState>;
}

/** Internal mutable form — the aggregation loop pushes here; frozen into ListResourcesResult before return. */
interface MutableListResourcesResult {
  resources: McpResource[];
  perServer: McpPerServerState[];
}

export interface ReadResourceResult {
  readonly server: string;
  readonly uri: string;
  readonly contents: ReadonlyArray<McpResourceContent>;
}

/**
 * Abstract MCP client handle so unit tests can inject a stub without spawning
 * a real child process.
 *  - `connect()` → establish the session to the server;
 *  - `listTools()` → fetch the tool list;
 *  - `callTool(name, args, { timeout, signal, resetTimeoutOnProgress })`
 *  - `close()` → close the session;
 *  - `onListChanged(tools)` → server-pushed tool changes;
 *  - `onClose()` → SDK-side connection-close notification (drives failed, no reconnect);
 *  - `listResources({ cursor, signal })` → SDK primitive `resources/list`;
 *  - `readResource(uri, { signal })` → SDK primitive `resources/read`.
 */
export interface McpClientHandle {
  readonly connect: () => Promise<void>;
  readonly listTools: () => Promise<readonly SdkTool[]>;
  readonly callTool: (
    name: string,
    args: unknown,
    options?: {
      readonly timeout?: number;
      readonly signal?: AbortSignal;
      readonly resetTimeoutOnProgress?: boolean;
    }
  ) => Promise<McpCallResult>;
  readonly close: () => Promise<void>;
  readonly onListChanged: (cb: (tools: readonly SdkTool[]) => void) => void;
  readonly onClose: (cb: () => void) => void;
  /**
   * List resources exposed by the server. Optional `cursor` for pagination.
   * Returns the SDK `{ resources, nextCursor? }` shape — the manager passes it
   * through and only merges per-server results.
   */
  readonly listResources: (opts?: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly resources: readonly SdkResource[];
    readonly nextCursor?: string;
  }>;
  /**
   * Read a specific resource by URI. Returns the SDK `{ contents }` shape
   * (TextResourceContents | BlobResourceContents union).
   */
  readonly readResource: (
    uri: string,
    opts?: {
      readonly signal?: AbortSignal;
    }
  ) => Promise<{ readonly contents: readonly SdkResourceContents[] }>;
}

/** Shared stdio transport params for createClient / createRealClient. */
export interface McpTransportOpts {
  /** stdio child cwd (= the resolver-returned workspaceRoot). */
  readonly cwd: string;
}

export interface McpManagerOptions {
  /** Two-level merged server list from config loading. */
  readonly config: readonly McpServerConfig[];
  /**
   * Resolver-returned current session/task root. Used as the stdio child cwd
   * and as the MCP tools' FS root. Missing / blank / non-absolute → the
   * constructor throws `McpLifecycleError` (`missing_cwd` / `invalid_cwd`);
   * never falls back to `process.cwd()`.
   */
  readonly workspaceRoot: string;
  /** Seam to append mcp__ tools into the ACI registry. */
  readonly registerExternal: (defs: readonly AciToolDef[]) => void;
  /**
   * Reload seam: withdraw the old slot's registered mcp__* tools by name.
   * Without it, reload silently skips unregistering and stale names remain in
   * externalByExt, so a same-name re-register trips the registry's duplicate
   * gate — production assembly must inject this.
   */
  readonly unregisterExternal?: (names: readonly string[]) => void;
  /**
   * Connect timeout in ms (default 60_000 to tolerate npx cold starts;
   * production assembly injects it via env). Tests may inject a short timeout.
   */
  readonly timeoutMsOverride?: number;
  /** Tool-call timeout override (adapter maps tier=long to 30 min; hook for unit tests). */
  readonly callTimeoutMsOverride?: number;
  /**
   * Abstract client factory; overridden in tests; production = `createRealClient`.
   * The second arg `transport.cwd` always equals the manager-held `workspaceRoot`.
   */
  readonly createClient?: (
    server: McpServerConfig,
    transport: McpTransportOpts
  ) => McpClientHandle;
}

/**
 * ADR-0043: first-turn readiness options.
 *
 * `firstTurnReadyTimeoutMs` (ms) — window during which build-engine assembly
 * waits for all MCP connections to settle (connected or failed):
 *   - servers connected within the window enter first-turn assembly (registered
 *     in the ACI registry, listed for the session);
 *   - servers not connected within the window are absent from the session —
 *     neither in the directory nor in tools;
 *   - when the window expires the wait resolves and the first turn proceeds;
 *     absent servers get no automatic retry in this session.
 *
 * Absent (undefined) = fire-and-forget: build-engine does not wait.
 */
export interface McpStartOptions {
  readonly firstTurnReadyTimeoutMs?: number;
}

/**
 * ADR-0043: manual-reconnect notification seam — after a user-triggered
 * reconnect succeeds, tell loop-engine to append a user message (same shape as
 * graphModeChange).
 *
 * Callback args:
 *   - `serverName`: config name of the server just connected;
 *   - `toolNames`: the full `mcp__${server}__${tool}` names it exposes.
 *
 * Fired once per successful reconnect; multiple registrations share the same
 * trigger. Dispatch lives inside the manager: after `reload`, once per slot
 * that turns connected (from pending/failed) within that reload generation.
 * `start()`'s initial connect never dispatches — first connect is not a reconnect.
 */
export type McpManualReconnectListener = (
  serverName: string,
  toolNames: ReadonlyArray<string>
) => void;

/**
 * SSOT for the error surfaced when an mcp__ tool is called before discovery.
 * aci-executor and permission-executor throw the same shape at their mcp__
 * entry points (registry miss + catalog hit but discover skipped); tests
 * reference this constant instead of the literal. Typed and template-pinned
 * per ADR-0043.
 */
export const MCP_TOOL_NOT_LOADED_MESSAGE =
  "tool <name> not loaded — call tool_search first";

export interface McpManager {
  /**
   * Start connections. Two modes:
   *   - `opts` absent = background start, resolves immediately (never blocks
   *     the build path).
   *   - `opts.firstTurnReadyTimeoutMs` present = block until every server is
   *     connected/failed or the window expires; servers that miss the window
   *     stay out of this session's tool directory.
   *
   * Calling start() again on the same manager lets existing background tasks
   * continue (no side effects). To rebuild, go through `shutdown` + a fresh
   * manager — the manager keeps no cross-start serialization.
   */
  readonly start: (opts?: McpStartOptions) => Promise<void>;
  /**
   * ADR-0043: manual-reconnect success callback (multi-register). Fires after
   * the reconnect completes and the tools are registered into the ACI
   * registry. This seam is consumed by loop-engine's message-append hook
   * (wired during build-engine assembly).
   */
  readonly onManualReconnect: (cb: McpManualReconnectListener) => void;
  /**
   * Reload the server set: collect old slots' registered tool names →
   * unregisterExternal them → shutdown all → clear slots → rebuild from new
   * config → start(). Idempotent: callable before start or after shutdown.
   * Returns without blocking on connections (the internal start() is
   * fire-and-forget, same semantics as start itself).
   */
  readonly reload: (config: readonly McpServerConfig[]) => Promise<void>;
  /** Close all clients, cancel in-flight calls, SIGTERM stdio children. */
  readonly shutdown: () => Promise<void>;
  /** Snapshot of current states (alphabetical by name). */
  readonly status: () => readonly McpServerStatus[];
  /**
   * List resources across all connected servers (or just one if `server` is
   * specified). Aggregates per-server `listResources` calls in alphabetical
   * order and attaches a `perServer` state snapshot (with `nextCursor`).
   * Unconnected servers are skipped without throwing — callers check
   * `perServer[].state`. An SDK error surfaces as ToolExecutionError.
   */
  readonly listResources: (
    opts?: ListResourcesOpts
  ) => Promise<ListResourcesResult>;
  /**
   * Read a resource by server + URI; both required. Unknown server →
   * ToolExecutionError. Known but not connected → ToolExecutionError carrying
   * the slot's current state.
   */
  readonly readResource: (
    server: string,
    uri: string,
    opts?: { readonly signal?: AbortSignal }
  ) => Promise<ReadResourceResult>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface Slot {
  readonly config: McpServerConfig;
  state: McpServerState;
  error?: string;
  /**
   * Timeout marker set only by the connect-timeout path (the setTimeout
   * callback). Separates "late success after a timeout" from a real failure:
   * bootSlot may flip failed back to connected only when this is set; real
   * failures are terminal. Cleared after a successful flip-back (see bootSlot).
   */
  timedOut?: boolean;
  handle?: McpClientHandle;
  /** Aborts all in-flight callTool calls on shutdown. */
  callAbort?: AbortController;
  /** Local mirror of registered tool names, for list_changed incremental diff (duplicates skipped). */
  registered?: Set<string>;
  /** Background connect task; kept for diagnostics only (abort does not cancel the promise). */
  bg?: Promise<void>;
  /**
   * Manual-reconnect arming: true = this slot was rebuilt via reload. When the
   * slot turns connected (fresh connect or a timeout flip-back), bootSlot
   * dispatches `notifyManualReconnect` once. Never armed at construction —
   * the initial connect is not a reconnect.
   */
  notifyReconnect?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Keep in sync with the IKNOW_MCP_CONNECT_TIMEOUT_MS default (60_000) in
// src/config/env.ts. Production assembly (deps.ts / build-engine.ts) injects
// timeoutMsOverride via env; this fallback only serves standalone
// createMcpManager callers (tests/scripts) and prevents dual-default drift.
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 1_800_000; // long tier (see TIMEOUT_TIER_MS in aci/types.ts)

export function createMcpManager(opts: McpManagerOptions): McpManager {
  const workspaceRoot = requireWorkspaceRoot(opts.workspaceRoot);
  const timeoutMs = opts.timeoutMsOverride ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMsOverride ?? DEFAULT_CALL_TIMEOUT_MS;

  /** Slots indexed by name. */
  const slots = new Map<string, Slot>();

  /**
   * Lifecycle generation: incremented by shutdown / reload. bootSlot captures
   * the generation at start; a late connect/listTools/list_changed from an
   * older generation must skip registration and flip-back — late connects may
   * not cross a terminated manager lifecycle.
   */
  let bootGeneration = 0;

  /**
   * Reset slots from config — shared by the constructor and reload (reload
   * first awaits shutdown to end the old slots, then clears and rebuilds
   * here). Alphabetical order keeps tests stable. `fromReload` arms the new
   * slots so servers that connect after a reload dispatch a manual-reconnect
   * notification.
   */
  function rebuildSlots(
    config: readonly McpServerConfig[],
    fromReload = false
  ): void {
    slots.clear();
    for (const cfg of [...config].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      slots.set(cfg.name, {
        config: cfg,
        state: cfg.status === "disabled" ? "disabled" : "pending",
        ...(fromReload ? { notifyReconnect: true } : {}),
      });
    }
  }

  rebuildSlots(opts.config);

  /** Push the slot's tools through registerExternal (incremental diff). */
  function registerTools(slot: Slot, tools: readonly SdkTool[]): void {
    const seen = slot.registered ?? new Set<string>();
    slot.registered = seen;
    const defs: AciToolDef[] = [];
    for (const t of tools) {
      const name = `mcp__${slot.config.name}__${sanitize(t.name)}`;
      if (seen.has(name)) continue;
      seen.add(name);
      defs.push(
        toAciToolDef({
          server: slot.config.name,
          tool: t,
          call: async (toolName, args, callOpts) => {
            const handle = slot.handle;
            if (!handle) {
              throw new Error(`MCP server ${slot.config.name} not connected`);
            }
            // Merge the caller's signal with the slot's shutdown signal so an
            // in-flight callTool receives abort when shutdown() runs.
            const sig = mergeAbort(callOpts?.signal, slot.callAbort?.signal);
            const result = await handle.callTool(toolName, args, {
              timeout: callOpts?.timeout ?? callTimeoutMs,
              signal: sig,
              resetTimeoutOnProgress: callOpts?.resetTimeoutOnProgress ?? true,
            });
            return result.result;
          },
          timeoutMs: callTimeoutMs,
        })
      );
    }
    if (defs.length > 0) opts.registerExternal(defs);
  }

  /** Mark the slot failed and warn one line. */
  function markFailed(slot: Slot, reason: string): void {
    if (slot.state === "failed" || slot.state === "disabled") return;
    slot.state = "failed";
    // When createRealClient captures the child's stderr (stderr: "pipe"),
    // append the buffered tail on failure — the key evidence for startup /
    // protocol root causes. Stub clients have no _stderrTail, so the reason
    // stays pure there.
    const tail = (
      slot.handle as unknown as { _stderrTail?: () => string } | undefined
    )?._stderrTail?.();
    slot.error =
      tail && tail.length > 0 ? `${reason}\n[server stderr]\n${tail}` : reason;
    console.warn(
      `[mcp/manager] server '${slot.config.name}' failed: ${slot.error}`
    );
  }

  /**
   * Dispatch the manual-reconnect notification once when an armed slot reaches
   * connected. Tool names follow registerExternal's `mcp__${server}__${tool}`
   * scheme. The marker is cleared on dispatch — one reconnect, one notice;
   * list_changed incremental re-registration never re-announces.
   */
  function notifyReconnectIfArmed(slot: Slot, tools: readonly SdkTool[]): void {
    if (slot.notifyReconnect !== true) return;
    delete slot.notifyReconnect;
    notifyManualReconnect(
      slot.config.name,
      tools.map((t) => `mcp__${slot.config.name}__${sanitize(t.name)}`)
    );
  }

  /** Boot one server in the background. */
  function bootSlot(slot: Slot): Promise<void> {
    const gen = bootGeneration;
    const transportOpts: McpTransportOpts = { cwd: workspaceRoot };
    let created: McpClientHandle;
    try {
      created = opts.createClient
        ? opts.createClient(slot.config, transportOpts)
        : createRealClient(slot.config, transportOpts);
    } catch (err) {
      // EXIT: spawn/factory throw → typed failed slot; start() must not hang or reject
      markFailed(slot, errorMessage(err));
      return Promise.resolve();
    }
    slot.handle = created;
    slot.callAbort = new AbortController();

    const timeoutHandle = setTimeout(() => {
      // Set the marker before failing so bootSlot can tell whether a late
      // success may flip back. Real throw paths never set it — failed is
      // terminal there. If the lifecycle already ended (shutdown/reload),
      // skip: don't write a stale timeout reason into an ended slot.
      if (gen !== bootGeneration) return;
      slot.timedOut = true;
      markFailed(slot, "connect timeout");
    }, timeoutMs);

    // onclose → failed (no reconnect). list_changed → incremental re-registration.
    created.onClose(() => {
      if (gen !== bootGeneration) return;
      if (slot.state !== "connected") return;
      markFailed(slot, "connection closed by server");
    });
    created.onListChanged((tools) => {
      if (gen !== bootGeneration) return;
      if (slot.state !== "connected") return;
      try {
        registerTools(slot, tools);
      } catch (err) {
        // Re-registration conflict → warn but keep this server alive; already
        // registered tools stay.
        console.warn(
          `[mcp/manager] server '${slot.config.name}' list_changed re-registration skipped: ${errorMessage(
            err
          )}`
        );
      }
    });

    return (async () => {
      try {
        await created.connect();
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (gen !== bootGeneration) return;
        markFailed(slot, errorMessage(err));
        return;
      }
      // Lifecycle ended: a late connect must not continue to listTools / registration / flip-back.
      if (gen !== bootGeneration) {
        clearTimeout(timeoutHandle);
        return;
      }
      // The timeout may have marked failed during connect. Only "late success
      // after a timeout" may proceed to listTools (the flip-back entry); a real
      // failure (no timedOut marker) always returns — failed is terminal.
      if (slot.state !== "pending") {
        if (slot.state !== "failed" || !slot.timedOut) {
          clearTimeout(timeoutHandle);
          return;
        }
        // The timedOut marker stays for now: the flip-back-success guard below
        // clears it; if listTools really throws, the catch keeps failed and a
        // stale marker is harmless.
      }
      try {
        const tools = await created.listTools();
        clearTimeout(timeoutHandle);
        if (gen !== bootGeneration) return;
        if (slot.state !== "pending") {
          // Late success after a timeout: flip back to connected within this
          // same bootSlot task. registerTools dedupes via `registered`, so
          // repeat calls are idempotent.
          if (slot.state === "failed" && slot.timedOut) {
            registerTools(slot, tools);
            slot.state = "connected";
            delete slot.timedOut;
            // Clear the error on recovery: status() only fills error for
            // failed slots, so a stale timeout reason should not ride along on
            // an already-restored connection.
            delete slot.error;
            // A flip-back counts as a successful reconnect too (a server
            // absent after reload got its second chance), so dispatch per the
            // arming marker.
            notifyReconnectIfArmed(slot, tools);
          }
          return;
        }
        registerTools(slot, tools);
        slot.state = "connected";
        notifyReconnectIfArmed(slot, tools);
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (gen !== bootGeneration) return;
        markFailed(slot, errorMessage(err));
      }
    })();
  }

  /**
   * Boot every non-disabled slot in the background; shared by start / reload.
   * Not awaited — the collected tasks only swallow errors silently; the
   * connections finish in the background.
   */
  function bootstrapAll(): void {
    const tasks: Promise<void>[] = [];
    for (const slot of slots.values()) {
      if (slot.state === "disabled") continue;
      slot.bg = bootSlot(slot);
      tasks.push(slot.bg);
    }
    void Promise.allSettled(tasks);
  }

  /**
   * ADR-0043: block until all non-disabled slots reach a terminal state
   * (connected/failed) or `timeoutMs` elapses. Terminality is detected by
   * polling — bootSlot is fire-and-forget and decides each slot's fate from
   * its own per-server timeout and connect/listTools errors; this helper only
   * wraps that in a fixed race window for first-turn readiness.
   *
   * Absent servers get no retry and stay out of this session's name directory.
   * `disabled` slots are skipped throughout (polling gate) and never block the
   * terminal check.
   */
  function awaitFirstTurnReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const isPending = (slot: Slot): boolean => slot.state === "pending";

    return new Promise<void>((resolve) => {
      const tick = (): void => {
        let anyPending = false;
        for (const slot of slots.values()) {
          if (slot.state === "disabled") continue;
          if (isPending(slot)) {
            anyPending = true;
            break;
          }
        }
        if (!anyPending || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  /**
   * Manual-reconnect listener seam: callbacks stored here; fire-once semantics
   * belong to the dispatch site. The dispatch entry stays inside the manager
   * to keep a single injection point.
   */
  const manualReconnectListeners = new Set<McpManualReconnectListener>();
  function onManualReconnect(cb: McpManualReconnectListener): void {
    manualReconnectListeners.add(cb);
  }
  /**
   * Internal dispatch: triggered by reload's reconnect-success path. Calls
   * every listener best-effort — a throwing listener must not break the
   * others (observer only, never reverse-affects manager state). start()'s
   * initial connect never dispatches: the notice covers only user-triggered
   * reconnects, so a first-turn absentee is announced only when a manual
   * reload reconnects it.
   */
  function notifyManualReconnect(
    serverName: string,
    toolNames: ReadonlyArray<string>
  ): void {
    for (const cb of manualReconnectListeners) {
      try {
        cb(serverName, toolNames);
      } catch {
        // Swallow listener errors — observer only.
      }
    }
  }

  async function start(opts?: McpStartOptions): Promise<void> {
    bootstrapAll();
    if (opts?.firstTurnReadyTimeoutMs !== undefined) {
      await awaitFirstTurnReady(opts.firstTurnReadyTimeoutMs);
    }
  }

  async function reload(config: readonly McpServerConfig[]): Promise<void> {
    // Capture every old slot's registered names (mcp__<server>__<tool>) before
    // shutdown/rebuild: `registered` lives on the slot and slots.clear() would
    // wipe it along with the slots. Missing this leaves stale names in the
    // external registry, where a same-name re-register trips the duplicate
    // gate. Disabled / never-connected slots have nothing registered; the
    // flat-mapped list is then empty and unregister is idempotent.
    const oldNames: string[] = [];
    for (const slot of slots.values()) {
      if (slot.registered) oldNames.push(...slot.registered);
    }
    // shutdown cancels in-flight calls, closes clients and marks failed —
    // only once the old state is fully terminated do we withdraw these names
    // from the external registry (no call can slip through a stale name
    // afterwards). A missing unregisterExternal (unwired assembly) skips
    // silently to keep reload idempotent.
    await shutdown();
    opts.unregisterExternal?.(oldNames);
    rebuildSlots(config, true);
    bootstrapAll();
  }

  async function shutdown(): Promise<void> {
    // Bump the generation first to block all late registrations from in-flight
    // bootSlot / list_changed callbacks.
    bootGeneration += 1;
    const tasks: Promise<void>[] = [];
    for (const slot of slots.values()) {
      if (slot.state === "disabled") continue;
      const handle = slot.handle;
      const abort = slot.callAbort;
      // Cancel all in-flight calls
      if (abort) abort.abort();
      if (handle) {
        tasks.push(
          handle.close().catch((err) => {
            // close failure only warns
            console.warn(
              `[mcp/manager] server '${slot.config.name}' close error: ${errorMessage(
                err
              )}`
            );
          })
        );
      }
    }
    await Promise.allSettled(tasks);
    // createRealClient's close path SIGTERMs before handle.close() returns;
    // the SDK's StdioClientTransport.close() already destroys the child as a
    // built-in fallback. One more layer here: SIGTERM transport.pid directly.
    for (const slot of slots.values()) {
      const child = (
        slot.handle as unknown as { _stdioPid?: number } | undefined
      )?._stdioPid;
      if (child && typeof child === "number") {
        try {
          process.kill(child, "SIGTERM");
        } catch {
          /* ignore ESRCH etc. */
        }
      }
    }
    for (const slot of slots.values()) {
      if (slot.state !== "disabled") slot.state = "failed";
    }
  }

  function status(): readonly McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const slot of slots.values()) {
      out.push(
        slot.state === "failed" && slot.error
          ? {
              name: slot.config.name,
              state: slot.state,
              source: slot.config.source,
              error: slot.error,
            }
          : {
              name: slot.config.name,
              state: slot.state,
              source: slot.config.source,
            }
      );
    }
    // Alphabetical by name for test stability
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // -------------------------------------------------------------------------
  // Resource channel (list/read)
  // -------------------------------------------------------------------------

  /**
   * Aggregate one slot's resources into `out`. A non-connected slot records its
   * current state in perServer (no throw); an SDK error surfaces as
   * ToolExecutionError (shielding SDK error types).
   */
  async function collectSlotResources(
    slot: Slot,
    opts: ListResourcesOpts | undefined,
    out: MutableListResourcesResult
  ): Promise<void> {
    if (!slot.handle || slot.state !== "connected") {
      out.perServer.push({ server: slot.config.name, state: slot.state });
      return;
    }
    let result: {
      readonly resources: readonly SdkResource[];
      readonly nextCursor?: string;
    };
    try {
      result = await slot.handle.listResources({
        cursor: opts?.cursor,
        // Merge caller + shutdown signals, same as the callTool path: an
        // in-flight listResources receives abort when shutdown() runs.
        signal: mergeAbort(opts?.signal, slot.callAbort?.signal),
      });
    } catch (err) {
      throw new ToolExecutionError(
        `mcp server '${slot.config.name}' listResources failed: ${errorMessage(err)}`
      );
    }
    for (const r of result.resources) {
      out.resources.push({
        server: slot.config.name,
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      });
    }
    out.perServer.push({
      server: slot.config.name,
      state: slot.state,
      nextCursor: result.nextCursor,
    });
  }

  /** Find the slot by server name and verify it is connected; throws ToolExecutionError otherwise. */
  function lookupConnectedSlot(server: string, op: string): Slot {
    if (!server) {
      throw new ToolExecutionError(`mcp ${op}: server name is required`);
    }
    const slot = slots.get(server);
    if (!slot) {
      throw new ToolExecutionError(`mcp server '${server}' not configured`);
    }
    if (!slot.handle || slot.state !== "connected") {
      throw new ToolExecutionError(
        `mcp server '${server}' not connected (state=${slot.state})`
      );
    }
    return slot;
  }

  /**
   * Aggregate listResources: no `server` → all servers; specified → only that
   * one. Unconnected slots are skipped (no throw — perServer exposes their
   * state). SDK errors surface as ToolExecutionError, translated at this layer.
   * `cursor` is passed through to each server; there is no cross-page
   * aggregation (the SDK's listResources already aggregates when `cursor` is
   * absent and forwards verbatim per page when present).
   */
  async function listResources(
    opts?: ListResourcesOpts
  ): Promise<ListResourcesResult> {
    const out: MutableListResourcesResult = { resources: [], perServer: [] };
    // Alphabetical by name so aggregation order is test-stable
    const ordered = [...slots.values()].sort((a, b) =>
      a.config.name.localeCompare(b.config.name)
    );
    for (const slot of ordered) {
      if (opts?.server && slot.config.name !== opts.server) continue;
      await collectSlotResources(slot, opts, out);
    }
    return out;
  }

  /**
   * Read one resource URI from one server. Unknown server → ToolExecutionError
   * "not configured"; known but not connected → ToolExecutionError carrying the
   * current state. SDK errors surface as ToolExecutionError.
   */
  async function readResource(
    server: string,
    uri: string,
    opts?: { readonly signal?: AbortSignal }
  ): Promise<ReadResourceResult> {
    if (!uri) {
      throw new ToolExecutionError(
        `mcp readResource: uri is required (server='${server}')`
      );
    }
    const slot = lookupConnectedSlot(server, "readResource");
    let raw: { readonly contents: readonly SdkResourceContents[] };
    try {
      raw = await slot.handle!.readResource(uri, {
        // Merge caller + shutdown signals, same as the callTool path: an
        // in-flight readResource receives abort when shutdown() runs.
        signal: mergeAbort(opts?.signal, slot.callAbort?.signal),
      });
    } catch (err) {
      throw new ToolExecutionError(
        `mcp server '${server}' readResource('${uri}') failed: ${errorMessage(err)}`
      );
    }
    return {
      server,
      uri,
      contents: raw.contents.map(projectResourceContent),
    };
  }

  const manager: McpManager = {
    start,
    onManualReconnect,
    reload,
    shutdown,
    status,
    listResources,
    readResource,
  };

  // Test hook: expose the slots' handles (for in-flight callTool + triggering
  // list_changed). Live getter — collects current handles from slots on each
  // read, so the view never goes stale.
  Object.defineProperty(manager, "_handles", {
    get() {
      const arr: McpClientHandle[] = [];
      for (const s of slots.values()) if (s.handle) arr.push(s.handle);
      return arr;
    },
  });

  return Object.freeze(manager);
}

// ---------------------------------------------------------------------------
// Production path — real SDK client + stdio transport (unit tests use stubs)
// ---------------------------------------------------------------------------

/**
 * Production client factory: wraps the MCP SDK's `Client` +
 * `StdioClientTransport` as an McpClientHandle. list_changed is subscribed in
 * the constructor via `Client`'s `listChanged.tools.onChanged`; onclose via
 * the transport's `onclose`.
 *
 * Only stdio is wired here; remote (url) servers are not implemented — the
 * caller must filter them out or treat them as disabled at assembly time.
 *
 * `opts.cwd` is the stdio child's working directory (= the manager's
 * workspaceRoot); relative command / args paths resolve against it and never
 * inherit `process.cwd()`.
 */
export function createRealClient(
  server: McpServerConfig,
  opts: McpTransportOpts
): McpClientHandle {
  if (server.kind !== "stdio") {
    throw new Error(
      `createRealClient: only stdio is wired up, got kind=${server.kind} for server '${server.name}'`
    );
  }

  // stderr: "pipe" (default "inherit"): MCP servers often log structurally to
  // stderr (e.g. codebase-memory-mcp's slog lines `level=info msg=mcp.request
  // ...`), which would otherwise stream into the parent's stderr and get drawn
  // into the TUI render area / status bar. Capturing lets us discard the
  // buffer while healthy and keep the tail for diagnostics only on markFailed.
  const transport = new SdkStdioTransport({
    command: (server as McpStdioServer).entry.command,
    args: [...((server as McpStdioServer).entry.args ?? [])],
    env: (server as McpStdioServer).entry.env
      ? { ...(server as McpStdioServer).entry.env }
      : undefined,
    cwd: opts.cwd,
    stderr: "pipe",
  });

  // Stderr ring buffer: keep only the latest segment (2KB) for markFailed to
  // append. With stderr:"pipe" the SDK creates its PassThrough (_stderrStream)
  // in the transport constructor already, so the data listener attaches here
  // without waiting for spawn.
  const MAX_STDERR_TAIL = 2048;
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    const s = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    stderrTail = (stderrTail + s).slice(-MAX_STDERR_TAIL);
  });

  // The SDK fires transport close through Client._onclose internally; hook it
  // once more here as insurance.
  transport.onclose = () => {
    closeCallbacks.forEach((cb) => cb());
  };

  let listChangedCallbacks: Array<(tools: readonly SdkTool[]) => void> = [];
  let closeCallbacks: Array<() => void> = [];

  const sdk = new SdkClient(
    { name: "iknow", version: "0.0.0" },
    {
      listChanged: {
        tools: {
          autoRefresh: true,
          onChanged: (err, items) => {
            if (err) {
              console.warn(
                `[mcp/manager] '${server.name}' list_changed error: ${err.message}`
              );
              return;
            }
            const tools = items ?? [];
            for (const cb of listChangedCallbacks) cb(tools);
          },
        },
      },
    }
  );

  // Record that connect finished (fallback for the close-signal path) —
  // transport.pid only becomes readable after the SDK's transport.start(), so
  // bind after connect instead of reading the pid before start (which is null).
  let started = false;
  const originalConnect = sdk.connect.bind(sdk);
  (sdk as unknown as { connect: typeof sdk.connect }).connect = (async (
    t: unknown
  ) => {
    await originalConnect(t as never);
    started = true;
  }) as typeof sdk.connect;

  const handle: McpClientHandle = {
    connect: async () => {
      await sdk.connect(transport as never);
    },
    listTools: async () => {
      const out = await sdk.listTools();
      return out.tools as readonly SdkTool[];
    },
    callTool: async (name, args, callOpts) => {
      const result = await sdk.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        {
          timeout: callOpts?.timeout,
          signal: callOpts?.signal,
          resetTimeoutOnProgress: callOpts?.resetTimeoutOnProgress ?? true,
        }
      );
      return { result };
    },
    // Forward the resources/list + resources/read SDK primitives
    listResources: async (opts) => {
      const result = await sdk.listResources(
        { cursor: opts?.cursor } as never,
        { signal: opts?.signal } as never
      );
      const page = result as { resources: SdkResource[]; nextCursor?: string };
      return {
        resources: (page.resources ?? []) as readonly SdkResource[],
        nextCursor: page.nextCursor,
      };
    },
    readResource: async (uri, opts) => {
      const result = await sdk.readResource(
        { uri } as never,
        { signal: opts?.signal } as never
      );
      const page = result as { contents: SdkResourceContents[] };
      return {
        contents: (page.contents ?? []) as readonly SdkResourceContents[],
      };
    },
    close: async () => {
      try {
        await sdk.close();
      } finally {
        // Fallback SIGTERM for the stdio child — spawned descendants must
        // always receive it.
        if (started && transport.pid) {
          try {
            process.kill(transport.pid, "SIGTERM");
          } catch {
            /* ESRCH etc. */
          }
        }
      }
    },
    onListChanged: (cb) => {
      listChangedCallbacks.push(cb);
    },
    onClose: (cb) => {
      closeCallbacks.push(cb);
    },
  };

  // Expose the pid so manager.shutdown can SIGTERM again as a backstop
  (handle as unknown as { _stdioPid: number | undefined })._stdioPid =
    transport.pid ?? undefined;
  // Expose the stderr tail so manager can append it into error on markFailed (diagnostics).
  (handle as unknown as { _stderrTail: () => string })._stderrTail = () =>
    stderrTail;

  return handle;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Constructor-time validation of the manager's workspaceRoot. Missing →
 * `missing_cwd`; blank / non-absolute / contains NUL → `invalid_cwd`. No
 * process.cwd() fallback; normalization mirrors roots.ts (the manager only
 * consumes an already-resolved workspaceRoot, never introduces productRoot).
 */
function requireWorkspaceRoot(value: string | undefined): string {
  if (typeof value !== "string") {
    throw new McpLifecycleError(
      "missing_cwd",
      "workspaceRoot is required and was not provided"
    );
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\0")) {
    throw new McpLifecycleError(
      "invalid_cwd",
      "workspaceRoot must be a normalizable absolute path"
    );
  }
  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    throw new McpLifecycleError(
      "invalid_cwd",
      "workspaceRoot must be an absolute path"
    );
  }
  // Strip trailing separators, but keep the filesystem root itself.
  const { root } = path.parse(normalized);
  let out = normalized;
  while (
    out.length > root.length &&
    (out.endsWith(path.sep) || out.endsWith("/"))
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * ResourceContents is a TextResourceContents | BlobResourceContents union —
 * pass through only the fields that exist, normalizing the object shape after
 * the type guards.
 */
function projectResourceContent(c: SdkResourceContents): McpResourceContent {
  const text = (c as { text?: string }).text;
  const blob = (c as { blob?: string }).blob;
  return {
    uri: c.uri,
    mimeType: c.mimeType,
    text,
    blob,
  };
}

/**
 * Merge two AbortSignals: the result aborts when either does.
 * If one side is undefined, return the other reference.
 * package.json engines.node >= 20 → AbortSignal.any is always available (no fallback).
 */
function mergeAbort(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined
): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  // Either side already aborted → return a directly (behaviorally equivalent)
  if (a.aborted || b.aborted) return a;
  return AbortSignal.any([a, b]);
}
