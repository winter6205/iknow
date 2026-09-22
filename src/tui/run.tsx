/** @jsxImportSource @opentui/react */
/**
 * src/tui/run.tsx
 *
 * OpenTUI render entry: full product-path assembly.
 *  - prepareRuntime → buildTuiDeps (real adapter + ACI tool set + askUser
 *    bridge + postToolUse events);
 *  - createInflightRegistry + createTuiBridge (SessionStore + SessionHub
 *    + soleInflightId attribution + contextWindow pass-through);
 *  - createToolEventSink + createTuiAskUserBridge;
 *  - resolvePermissionMode (`--auto-mode` / IKNOW_PERMISSION_MODE initial
 *    value) + createSessionGrants (always-grant persistence) + injection
 *    into deps and TuiApp;
 *  - session resume: `iknow tui <id>` → loadSessionFile → attachSession
 *    → initialSession prop;
 *  - `<TuiApp bridge askBridge toolEventSink cwd dataDir permissionMode
 *    sessionGrants info initialSession onQuit/>`, onQuit triggers
 *    renderer.destroy.
 *
 * Error paths: renderer construction / runtime throw → typed stderr
 * message + exit code 1. runTui has exactly one catch point; all cleanup
 * (terminal teardown + renderer destroy) converges there. createRenderer
 * stays injectable for tests to induce failures. A third error path lives
 * outside the catch: non-TTY fail-fast — on the production path (no
 * injected createRenderer) with non-interactive stdin/stdout, emit typed
 * stderr + exit 1 before any assembly (newer OpenTUI builds a renderer on
 * non-TTY successfully, which would hang without this guard).
 *
 * Renderer-after-assembly ordering invariant (2026-09-14 incident): the
 * assembly chain (prepareRuntime / workspaceRoot / permissionMode /
 * buildTuiDeps) throws typed plain objects (provider_api_key_missing /
 * WorkspaceRootError); creating the renderer first would probe the terminal
 * (OSC 10/11 capability queries + alternate screen) and leave capability
 * replies stranded after a throw. Non-TTY fail-fast still precedes all
 * assembly and rendering. Error bodies render via the same
 * discriminated-union dispatch as cli.ts (`isLlmProviderConfigError` /
 * `isWorkspaceRootError`) — never `String(plain object)` →
 * `[object Object]`.
 *
 * Terminal teardown: all three exits (catch / /quit / normal) go through
 * the `teardownTerminal` closure calling one `teardownTuiTerminal` —
 * disable mouse tracking (raw mode still on; restoring cooked mode first
 * would echo in-flight mouse reports to the shell prompt) → destroy
 * (restores cooked mode internally) → discard buffered stdin capability
 * replies (OSC 10/11 `rgb:` / DECRQM `$y`) → raw-mode fallback. See the
 * function's header comment for the ordering rationale.
 */
import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  prepareRuntime,
  registerShutdown,
  type RuntimeBundle,
} from "../cli/runtime.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import {
  buildTuiDeps,
  type BuildTuiDepsOptions,
  type TuiExtensions,
} from "./deps.js";
import { createTuiAskUserBridge } from "./ask-user.js";
import { createInflightRegistry, createTuiBridge } from "./hub-bridge.js";
import { resolveTraceRoot } from "../cli/trace-root.js";
import { createToolEventSink, TuiApp, type TuiAppProps } from "./app.js";
import { attachSession, type TuiSessionState } from "./session-state.js";
import { createSessionGrants } from "../harness/permission/session-grants.js";
import { initIknowWorkspaceSafe } from "../harness/identity/index.js";
import { deriveProjectIdentityRoot } from "../harness/session-roots.js";
import { resolvePermissionMode } from "../cli/runtime.js";
import {
  createGraphModeContext,
  resolveGraphMode,
} from "../harness/graph/mode.js";
import { createLiveGraphLedgerHost } from "../harness/graph/ledger.js";
import { createPreimageLedger } from "../session-api/store/preimage-ledger.js";
import {
  loadIknowSettings,
  resolveFsIsolationMode,
  resolveWorktreeExclusive,
  resolveWorktreeOnMutate,
} from "../config/settings.js";
import { createFsModeContext } from "../harness/sandbox/fs-mode.js";
import {
  createYoloContext,
  createYoloController,
  type YoloContext,
  type YoloController,
} from "../harness/sandbox/yolo.js";
import { createSubagentCapacityHolder } from "../harness/subagent/manager.js";
import { createWorktreeOnMutateHolder } from "../harness/isolation/worktree-gate.js";
import { createTuiWorktreeIsolationHost } from "./worktree-host.js";
import { resolveVerifyConfig } from "../session-api/serve.js";
import { createEnvLoader, type EnvLoader } from "../config/env-loader.js";
import type { IknowEnv } from "../config/env.js";
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
} from "../config/env.js";
import { persistModelFailure } from "./persist-model-failure.js";
import { createEnvDisplayStore } from "./env-display-store.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  isWorkspaceRootError,
  renderWorkspaceRootError,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import {
  persistFsModeChanges,
  persistMemoryChanges,
  persistModelChanges,
  persistSubagentCapChanges,
  persistThinkingChanges,
  persistWorktreeOnMutateChanges,
  resolveThinkingSettingsPath,
  type SubagentCapPersistPatch,
} from "../config/persist-settings.js";
import { homedir } from "node:os";
import { shutdownDefaultLspPool } from "../harness/lsp/client.js";
import { beginStderrGate, endStderrGate } from "./stderr-gate.js";

/** Typed error prefix for renderer startup failures (message constants, no magic strings). */
export const TUI_RENDERER_ERROR_PREFIX = "TUI 渲染后端初始化失败";

export interface RunTuiOptions {
  /** `iknow tui <session-id>` resume; default = new session. */
  readonly sessionId?: string;
  /** Session pool root (--data-dir); default ~/.iknow (ADR-0087). */
  readonly dataDir?: string;
  /**
   * ADR-0019: per-root state anchor — passed through from the CLI
   * `--workspace-root` flag. Resolved once at assembly and forwarded to
   * the build engine. Persona seeds stay at userHome/.iknow, not
   * workspaceRoot. The session pool is not sharded by it (ADR-0087).
   */
  readonly workspaceRoot?: string;
  /** JSONL trace output path. Default (via resolveTraceRoot) uses this
   *  entry's resolved dataDir — the same pool the hub writes per-session
   *  traces to, so reader-side tools/panels never scan a root that
   *  diverges from the writer. */
  readonly traceOut?: string;
  /**
   * `iknow tui --auto-mode`: explicit initial permission mode, taking
   * precedence over IKNOW_PERMISSION_MODE. Undefined → env → default.
   */
  readonly permissionMode?: string;
  /**
   * ADR-0119 / specs yolo-mode: the `iknow tui --yolo` startup switch.
   * true → the session starts in yolo (the fence retires entirely); the
   * initial value is normalized through `createYoloContext` (illegal input
   * fail-closes to false). Absent / undefined = non-yolo (fail-closed, the
   * fence stays, V1 baseline byte-identical).
   *
   * Deliberately **not persisted**: the yolo axis never enters settings /
   * session files / a config-panel row — each session supplies its initial
   * value explicitly, in-session toggles go through the memory holder only
   * (spec §5).
   */
  readonly yolo?: boolean;
  /** Test seam: override the renderer factory (to induce startup errors);
   *  production uses createCliRenderer. */
  readonly createRenderer?: (config: CliRendererConfig) => Promise<CliRenderer>;
}

/** Self-managed Ctrl+C: do not exit the process; interruption goes through
 *  the app-layer Esc path (after the 2026-09-18 keybinding migration Ctrl+C
 *  only does selection copy; the process-level SIGINT remains as a safety
 *  net).
 *  alternate-screen: keeps scrollback clean.
 *  No freeze: OpenTUI 0.5.1's CliRenderer constructor writes the
 *  config.useThread default on Linux, so a frozen object throws
 *  "not extensible" (observed). */
const RENDERER_CONFIG: CliRendererConfig = {
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
};

/**
 * Typed-error catch contract: render startup-failure error bodies.
 *
 * LLM provider / workspace-root errors are typed **plain objects**
 * (`satisfies` shape, not Error instances) — a bare `String(err)` renders
 * them as `[object Object]`, hiding kind / providerId / apiKeyEnv (the
 * TUI-side symptom of the 2026-09-14 incident). Branch order mirrors cli.ts
 * `printCliError`: discriminated unions first, then Error, other objects
 * via JSON (lossless; circular refs fall back to the constructor name).
 * Never emit `[object Object]`.
 */
export function describeTuiStartError(err: unknown): string {
  if (isLlmProviderConfigError(err)) return formatLlmProviderConfigError(err);
  if (isWorkspaceRootError(err)) return renderWorkspaceRootError(err);
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      // Circular refs / BigInt cannot be JSON-ified: fall back to the
      // constructor name, still never producing [object Object].
      return `[${err.constructor?.name ?? "object"}]`;
    }
  }
  return String(err);
}

/** Minimal stdin surface needed for terminal teardown (structural type:
 *  tests inject a fake; production = process.stdin). */
export interface TuiTerminalStdin {
  readonly isRaw?: boolean;
  read: () => unknown;
  setRawMode?: (mode: boolean) => unknown;
}

/** Discard bytes that have already arrived in stdin but were never
 *  consumed (capability-query replies).
 *
 *  The `read()` loop mirrors OpenTUI's own buffer purge in `resume()`: OSC
 *  10/11 `rgb:` / DECRQM `$y` replies (same family: mouse-tracking `M`
 *  reports) arriving within the exit window would otherwise be echoed by
 *  the shell as keyboard input into the next prompt after this process
 *  exits. We consume them proactively; when the stream is closed /
 *  unreadable, read throws and is treated as nothing to clean.
 *
 *  Only bytes already in the **user-space buffer** are consumed (the same
 *  synchronous drain as OpenTUI resume()); bytes still in the kernel tty
 *  queue are invisible to this function — see the teardownTuiTerminal
 *  header note. */
/** ADR-0096 — subagent concurrency-cap persistence channel
 *  (fire-and-forget; failures surface as app.tsx notices). Same shape as
 *  `persistFsMode` but returns `{ok, reason}` instead of throwing: the
 *  TuiAppProps.onPersistSubagentCap contract is like that — the tool
 *  description getter reflects the holder's current value, so a file-layer
 *  failure does not roll back the holder. `activeEnvLoader.markSelfWrite`
 *  prevents the settings self-write loop, as in `persistThinking` /
 *  `persistFsMode`. */
async function persistSubagentCapImpl(
  patch: SubagentCapPersistPatch,
  activeEnvLoader: EnvLoader
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const path = resolveThinkingSettingsPath({
      home: homedir(),
    });
    const { bytes } = await persistSubagentCapChanges(path, patch);
    activeEnvLoader.markSelfWrite(path, bytes);
    return { ok: true as const };
  } catch (err) {
    return {
      ok: false as const,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** ADR-0096 — worktree-gate persistence channel (fire-and-forget; failures
 *  surface as app.tsx notices). Item-for-item same shape as `persistFsMode`:
 *  user-layer key `isolation.worktreeOnMutate`, `markSelfWrite` to suppress
 *  the self-write loop, errors rethrown (the
 *  TuiAppProps.onPersistWorktreeOnMutate contract = Promise<void>, app's
 *  catch renders the notice), and a flipped holder is not rolled back — the
 *  gate adjudicates the next wave on the new value (ADR-0037: flipping ON
 *  only blocks unbound-tree mutations and never auto-provisions). */
async function persistWorktreeOnMutateImpl(
  on: boolean,
  activeEnvLoader: EnvLoader
): Promise<void> {
  try {
    const path = resolveThinkingSettingsPath({
      home: homedir(),
    });
    const { bytes } = await persistWorktreeOnMutateChanges(path, {
      worktreeOnMutate: on,
    });
    activeEnvLoader.markSelfWrite(path, bytes);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function drainTuiStdin(stdin: TuiTerminalStdin): void {
  for (;;) {
    let chunk: unknown;
    try {
      chunk = stdin.read();
    } catch {
      // EXIT: stream closed / unreadable — nothing buffered to discard; teardown continues.
      return;
    }
    // EXIT: buffer empty (null = EOF, undefined = no more data).
    if (chunk === null || chunk === undefined) return;
    // Discard: these bytes are replies to this process's own queries and belong to no caller.
  }
}

/**
 * Single terminal-teardown implementation (shared by catch / `/quit` /
 * normal exit).
 *
 * The order is the contract; each of the four steps covers a gap that
 * OpenTUI 0.5.1 `renderer.destroy()` does **not**:
 *  1. `useMouse = false` (send the mouse-disable sequence while raw mode
 *     is still on). destroy() restores cooked mode first and the native
 *     layer disables mouse only afterwards — in-flight mouse reports
 *     echoed within that window show up as `35;83;40M`-style garbage.
 *  2. `destroy()`: restore cooked mode / leave alternate screen / remove
 *     stdin listeners / release native pointers. Left to OpenTUI, not
 *     reimplemented here.
 *  3. `drainTuiStdin`: drop buffered capability replies — placed **after**
 *     destroy so bytes that arrived during the destroy window are also
 *     caught; at this point OpenTUI's stdin listener is detached and the
 *     stream paused, so this read cannot race the parser. Bytes still in
 *     the kernel tty queue are skipped (invisible to the synchronous API;
 *     that leg is short-circuited by the assembly-before-renderer ordering
 *     — a failed assembly never emits the queries in the first place).
 *  4. Raw-mode fallback: restore cooked mode when destroy threw or never
 *     ran (externally destroyed but raw still on). Only called when
 *     `isRaw === true`; a no-op on the normal path.
 *
 * Idempotent: an already-destroyed renderer skips steps 1–2 but still runs
 * 3–4 — both the `if (!renderer.isDestroyed)` guard on app.tsx `/quit` and
 * the whenDestroyed teardown path re-enter here. Failures never propagate
 * upward: teardown errors must not mask the caller's original error.
 */
export function teardownTuiTerminal(
  renderer?: CliRenderer,
  stdin: TuiTerminalStdin = process.stdin
): void {
  // EXIT: renderer never created (assembly failure under the ordering
  // invariant) = terminal never probed, nothing to tear down.
  if (renderer === undefined) return;
  if (!renderer.isDestroyed) {
    try {
      renderer.useMouse = false;
    } catch {
      // EXIT: render loop already broken (native released, etc.) — skip this
      // step, but destroy / drain must still run; teardown cannot stop halfway.
    }
    try {
      renderer.destroy();
    } catch {
      // EXIT: destroy failure must not propagate (would mask the caller's error); raw mode is handled by the fallback below.
    }
  }
  drainTuiStdin(stdin);
  if (stdin.isRaw === true && typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(false);
    } catch {
      // EXIT: stream closed — the terminal resets on process exit; no further action.
    }
  }
}

/**
 * ADR-0119 §launch: `--yolo` seeds the holder only; the enter state
 * combination (permission -> full_auto, fsMode -> global, snapshot for exit)
 * must be applied at startup too, or the session runs fence-less with a
 * default permission posture. The gate reads the **normalized holder** (the
 * single source of truth for the yolo axis), never the raw flag value. No
 * probe gate: a bwrap-less host still assembles yolo (requireBwrap sequencing
 * ruling); its exit refusal stays symmetric.
 */
function applyYoloLaunchSeed(yolo: YoloContext, controller: YoloController) {
  if (yolo.get()) {
    controller.enterAtLaunch();
  }
}

/**
 * Start the TUI render loop; returns the process exit code (0 = normal
 * exit, 1 = typed startup failure). cli.ts assigns it to process.exitCode.
 */
export async function runTui(options: RunTuiOptions = {}): Promise<number> {
  // Non-TTY fail-fast: newer OpenTUI creates a renderer successfully on
  // non-TTY, so without this guard assembly proceeds all the way to
  // whenDestroyed and hangs forever (observed on pipes / redirection).
  // Intercept before any assembly or renderer creation — no resources to
  // clean, so this path intentionally stays outside the single catch below.
  // Test paths that inject createRenderer skip the check — they induce
  // renderer error paths, unrelated to TTY probing.
  if (
    options.createRenderer === undefined &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  ) {
    process.stderr.write(
      `${TUI_RENDERER_ERROR_PREFIX}：未检测到交互终端（TTY），TUI 需在交互终端中运行（管道/重定向场景请用非交互子命令）\n`
    );
    return 1;
  }
  const factory = options.createRenderer ?? createCliRenderer;
  let renderer: CliRenderer | undefined;
  let onQuitBridge: { destroy: (conversationId?: string) => void } | undefined;
  // conversationId of the active session at /quit time (passed by app.tsx
  // quit() via onQuit). The resume hint prints after whenDestroyed +
  // shutdownExtensions have restored the terminal to the main screen; an
  // unfiled draft (undefined) prints nothing.
  let quitResumeConversationId: string | undefined;
  // Expose the TUI extension surface (skillCatalog / mcp.status / mcp.reload
  // / shutdown), injected synchronously by buildTuiDeps' onExtensions
  // callback. The exit path calls shutdownExtensions() to close the MCP
  // manager (avoiding leaked stdio children); the idempotent wrapper lets
  // onQuit and the whenDestroyed fallback share one shutdown promise, so a
  // double close cannot produce a spurious warn.
  let tuiExtensions: TuiExtensions | undefined;
  // Settings hot-reload: EnvLoader is hoisted outside the try — all three
  // exit paths (/quit onQuitBridge / signal registerShutdown / catch) must
  // release the fs watcher handle, otherwise the event loop never drains
  // and the process hangs after /quit. Assignment happens after assembly
  // succeeds; stop() is idempotent, so an uninitialized (pre-assembly throw)
  // case is a no-op.
  let envLoader: EnvLoader | undefined;
  let shutdownPromise: Promise<void> | undefined;
  // Late-bound hub reference box — declared before shutdownExtensions (that
  // closure lives outside the try and cannot see try-local state). The /quit
  // path must also close per-root rebuilt engines via shutdownExtensions;
  // the signal path is covered by combinedShutdown (hub.shutdown is
  // idempotent, so dual-path calls are harmless).
  const hubRef: { current?: { shutdown: () => Promise<void> } } = {};
  const shutdownExtensions = (): Promise<void> => {
    if (shutdownPromise === undefined) {
      shutdownPromise = (async () => {
        // Release the watcher first (no more reload events), then close MCP/subagent.
        envLoader?.stop();
        // Kill the process-wide LSP pool (root cause of /quit hangs):
        // language-server children from warmup / lsp_* spawn keep stdio
        // pipes open, so the event loop never drains. Placed before any
        // early return — even an early assembly failure (before onExtensions
        // injection) must reap warmup children; idempotent + latched, no-op
        // when nothing was spawned. Engine shutdown does not own this
        // (rebind calls it mid-flight and must not latch the shared pool).
        await shutdownDefaultLspPool();
        const ext = tuiExtensions;
        if (!ext) return;
        try {
          await ext.shutdown();
        } catch (err) {
          process.stderr.write(
            `[tui] MCP shutdown failed: ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
        }
        // ext.shutdown() only closes the initial engine; when tuiExtensions
        // was never injected (early exit during assembly) the line above has
        // already returned — hub.shutdown is the backstop that closes
        // per-root rebuilt engines (the hub holds all engineByRoot handles).
        try {
          await hubRef.current?.shutdown();
        } catch (err) {
          process.stderr.write(
            `[tui] hub shutdown failed: ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
        }
      })();
    }
    return shutdownPromise;
  };
  // All three exit paths (catch / /quit onQuitBridge / whenDestroyed normal
  // close) share this single terminal-teardown closure — ordering contract
  // in teardownTuiTerminal. No-op while the renderer was never created
  // (assembly-time throw under the ordering invariant).
  const teardownTerminal = (): void => teardownTuiTerminal(renderer);
  try {
    const runtime = await prepareRuntime();
    // Resolve the root before any lazy session create. The resolver's
    // final cwd fallback is an entry-level binding, never a SessionHub
    // create-time cwd backfill.
    const envWsRoot = runtime.env.workspaceRoot;
    const cwd = process.cwd();
    const workspaceRoot = resolveWorkspaceRoot({
      explicit: options.workspaceRoot,
      cwd,
      env: { [WORKSPACE_ROOT_ENV_KEY]: envWsRoot },
    });
    // Assembly chain: runtime → deps → bridge/ask/tool bridges → TuiApp.
    // The persona seed always lives at `<homedir>/.iknow`, never follows
    // workspaceRoot.
    await initIknowWorkspaceSafe();
    // EnvLoader as the env source: the first get() lazily loads the initial
    // env; later watcher events reload automatically. Using it for the
    // initial env (not bundle.env) keeps the initial adapter and the
    // envProvider's first snapshot consistent (both equal in production).
    // envLoader is declared outside the try (all exit paths must stop it);
    // after a successful assembly it is certainly non-null, so we take a
    // local const for closures (TS cannot narrow a `let` field).
    envLoader = createEnvLoader({
      cwd: process.cwd(),
      home: homedir(),
    });
    const activeEnvLoader = envLoader;
    let currentEnv: IknowEnv = activeEnvLoader.get();
    // Single publication point for env-derived display snapshots: the hub
    // publishes via onEnvChange after a successful reloadFromEnv, and each
    // subscriber (ContextBar's model segment / TuiApp's thinking baseline)
    // refreshes itself. Do **not** re-render TuiApp — a whole-tree repaint
    // is user-visible flicker, and the old props baseline would
    // unconditionally overwrite user-edited thinking / effort.
    const envDisplay = createEnvDisplayStore({
      model: currentEnv.llm.model,
      defaultThinking: {
        mode: currentEnv.llm.thinking,
        effort: currentEnv.llm.thinkingEffort,
      },
    });
    const bundle: RuntimeBundle = { env: currentEnv, session: runtime.session };
    // ADR-0087: session pool = explicit dataDir else ~/.iknow; never sharded by workspaceRoot.
    const dataDir = resolveServeDataDir(options.dataDir);
    // Reader-side scan root for traces (ACI tools + panels) defaults to this
    // entry's writer-side dataDir — one resolution, so readers never diverge
    // from writers (flag > IKNOW_TRACE_OUT env > dataDir).
    const traceOut = resolveTraceRoot(options.traceOut, dataDir);
    // Settings bidirectional persistence: /thinking /effort panel Esc → write
    // back to settings.json. ADR-0084 write-target layering: thinking /
    // memory are **user-layer keys** (llm / memory sections) and project
    // files no longer adopt them (the project allowlist = verify / secrets /
    // permissions), so writes always target <home>/.iknow/settings.json
    // regardless of whether a project file exists (the old project-preferred
    // rule would have written user-layer keys into files nobody reads
    // anymore). After each write, register the self-write sentinel
    // (activeEnvLoader.markSelfWrite) so our own fs.watch does not loop
    // back. Failure → return { ok:false, reason } for app to render as a
    // notice, never crash the TUI (the in-memory override stays).
    // persistThinkingChanges writes atomically (tmp + rename) and does not
    // rebuild the adapter (the sentinel swallows the reload; current env /
    // adapter untouched).
    const persistThinking: NonNullable<
      TuiAppProps["onPersistThinking"]
    > = async (patch) => {
      try {
        // home comes from the same homedir() call as EnvLoader /
        // loadIknowSettings; reader and writer never land on two layers.
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistThinkingChanges(path, patch);
        activeEnvLoader.markSelfWrite(path, bytes);
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const persistMemory: NonNullable<TuiAppProps["onPersistMemory"]> = async (
      patch
    ) => {
      try {
        // Same as persistThinking: memory is also a user-layer key → always write <home>/.iknow/settings.json.
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistMemoryChanges(path, patch);
        activeEnvLoader.markSelfWrite(path, bytes);
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const persistFsMode: NonNullable<TuiAppProps["onPersistFsMode"]> = async (
      mode
    ) => {
      try {
        // Same as persistThinking: fsMode is also a user-layer key (isolation
        // section, outside the ADR-0084 allowlist) → always write
        // <home>/.iknow/settings.json.
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistFsModeChanges(path, { fsMode: mode });
        activeEnvLoader.markSelfWrite(path, bytes);
      } catch (err) {
        // app.tsx's onPersistFsMode contract is Promise<void (failures
        // render as notices by the caller); rethrow here so app's catch
        // handles it.
        throw err instanceof Error ? err : new Error(String(err));
      }
    };

    // /model panel Enter persistence (ADR-0093). Unlike thinking / memory
    // this **must explicitly refresh env and rebuild the adapter** — the
    // model is a next-round assembly parameter and writing the file alone
    // does not switch it. Chain:
    //   1) persistModelChanges atomically writes <home>/.iknow/settings.json;
    //   2) markSelfWrite registers the content hash so the watcher event
    //      triggered by our own write is swallowed (otherwise it would race
    //      the explicit reload below);
    //   3) activeEnvLoader.reload(): EnvLoader.get() caches, so a bare get()
    //      still returns the old env — the explicit reload reads the new
    //      model into the cache;
    //   4) bridge.hub.reloadFromEnv(): the hub rebuilds the adapter from
    //      envProvider = () => get() and, on success, fires onEnvChange →
    //      envDisplay.publish → display syncs in place (ContextBar / /info
    //      Model rows).
    // Any step failing → { ok:false, reason } rendered as a notice by app;
    // no TUI crash.
    const persistModel: NonNullable<TuiAppProps["onPersistModel"]> = async (
      patch
    ) => {
      let wrote = false;
      try {
        // Same as persistThinking: model is also a user-layer key → always write <home>/.iknow/settings.json.
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistModelChanges(path, patch);
        wrote = true;
        activeEnvLoader.markSelfWrite(path, bytes);
        activeEnvLoader.reload();
        await bridge.hub.reloadFromEnv();
        return { ok: true as const };
      } catch (err) {
        // Typed **plain objects** (provider_api_key_missing) are not Errors:
        // persistModelFailure dispatches on the discriminated union first
        // (typed-error catch contract).
        return persistModelFailure(wrote, err);
      }
    };

    const inflight = createInflightRegistry();
    const toolEventSink = createToolEventSink();
    const askBridge = createTuiAskUserBridge();
    // ADR-0090: startup permission-mode precedence: `--auto-mode` (explicit) >
    // IKNOW_PERMISSION_MODE > project permissions.defaultMode > "default".
    // The project settings root is projectIdentityRoot, not cwd: after a
    // rebind the cwd is a bare task worktree without `.iknow`. Fail-loud
    // values (legacy / full_auto) propagate up through
    // resolvePermissionMode and are rendered by this function's error path.
    const permissionMode = resolvePermissionMode(options.permissionMode, {
      cwd: deriveProjectIdentityRoot({ cwd: workspaceRoot }),
    });
    const sessionGrants = createSessionGrants();
    // Graph-mode session holder (ADR-0030) — initial value from settings
    // (off by default); Shift+Tab and `/graph` flip it in place without
    // rebuilding the engine. Settings are read exactly once at startup and
    // one object drives graph / verify / depsOpts.settings — per-root
    // rebuilt engines reuse it, and a missing `.iknow/` inside a worktree
    // must never trigger an implicit settings reload.
    const startupSettings = loadIknowSettings();
    const graphMode = createGraphModeContext(
      resolveGraphMode({ settings: startupSettings.graph })
    );
    // Filesystem-isolation holder (ADR-0092) — initial value from settings
    // (default global); `/config` flips it in place. The holder feeds both
    // the engine (buildTuiDeps → BuildEngineOpts.fsMode → bash factory
    // per-call read) and TuiApp (command surface). Orthogonal to
    // permissionMode / graphMode — Shift+Tab does not touch it. Settings are
    // read once at startup (see the startupSettings note).
    const fsMode = createFsModeContext(resolveFsIsolationMode(startupSettings));
    // ADR-0119 / specs/yolo-mode.md: the yolo-axis holder + the single-point
    // enter/exit action. Initial value comes from the `--yolo` flag
    // (`createYoloContext` normalizes fail-closed: illegal input → false =
    // fence on); at runtime `/yolo` + the confirm modal flip it in place (the
    // idempotent set, the snapshot + symmetric bwrap-probe semantics live in
    // harness/sandbox/yolo.ts). The holder feeds the engine (buildTuiDeps →
    // BuildEngineOpts.yolo → the bash factory per-call read / the subagent env
    // wire), bridge → hub (the verify command surface, homomorphic) and TuiApp
    // (command surface + the mode-row red marker). **Not persisted**: the yolo
    // axis never enters settings / session files / a config-panel row, so
    // there is no persist channel and no markSelfWrite here (spec §5).
    const yolo = createYoloContext(options.yolo);
    const yoloController = createYoloController({
      yolo,
      permission: permissionMode,
      fsMode,
    });
    applyYoloLaunchSeed(yolo, yoloController);
    // ADR-0096: subagent concurrency-cap holder (same shape as fsMode).
    // Initial value comes from env.subagent.maxConcurrentWorkers (the
    // env > settings > default-15 chain is pinned in env.ts). At runtime the
    // /config panel Enter cycles it (3→5→9→15→unlimited→3). One holder
    // reference serves the engine (BuildEngineOpts.subagentCapacityHolder →
    // createSubAgentManager → spawn gate), TuiApp (command surface), and the
    // registry (spawn_subagent tool description via a getter that reads the
    // holder live) — so the gate value, the description's N, and
    // SubAgentCapacityError.maxConcurrentWorkers always agree. The cap row's
    // persist channel mirrors persistFsMode (the closure holds
    // `activeEnvLoader` to suppress the settings.json self-write loop;
    // failure falls back to an app.tsx notice and the holder is not rolled
    // back). The IIFE returns the tuple in one shot to keep runTui under the
    // complexity gate.
    const [subagentCapHolder, persistSubagentCap] = (() => {
      // Initial value must come from `currentEnv` (the env > settings > 15
      // chain pinned in env.ts), not `startupSettings.subagent?.…`: with
      // IKNOW_SUBAGENT_MAX_CONCURRENT_WORKERS set but the settings key
      // absent, the manager gate would use the env value while the panel
      // showed the settings/default value — two truths at once. Panel display
      // shows the effective value (holder.get() = the value resolved through
      // the env chain), same source as the gate; no separate "env overrides
      // settings" notice — holder.get() is already the effective value, and
      // an Enter flip in-session writes the user layer (when env has higher
      // priority, env still wins on the next reload, matching /model display
      // semantics). Note: writing the user layer does not override env.
      const initial = currentEnv.subagent.maxConcurrentWorkers;
      const holder = createSubagentCapacityHolder(initial);
      const persist = (p: SubagentCapPersistPatch) =>
        persistSubagentCapImpl(p, activeEnvLoader);
      return [holder, persist] as const;
    })();
    // ADR-0096: worktree-gate holder (same shape as fsMode / cap) — initial
    // value from the startup read `resolveWorktreeOnMutate(startupSettings)`
    // (settings still read exactly once). The /config panel worktree row
    // Enter flips it; the holder feeds both the engine (buildTuiDeps →
    // BuildEngineOpts.worktreeOnMutateHolder → the mutate gate reads it at
    // each wave entry) and TuiApp (command/display surfaces). Same IIFE
    // closure pattern to keep runTui simple.
    const [worktreeOnMutateHolder, persistWorktreeOnMutate] = (() => {
      const holder = createWorktreeOnMutateHolder(
        resolveWorktreeOnMutate(startupSettings)
      );
      const persist = (on: boolean) =>
        persistWorktreeOnMutateImpl(on, activeEnvLoader);
      return [holder, persist] as const;
    })();
    // Live-graph ledger host — a TUI singleton resolved by conversationId
    // across sessions (web panels / session switching); destroyed by
    // resetSession / hub.shutdown.
    const liveGraphLedger = createLiveGraphLedgerHost();
    // ADR-0036: preimage accumulator shared by the engine (write tools fill it
    // via deps.ts's capture closure) and the hub (appendSessionEvents drains it
    // onto the transcript). One TUI singleton, resolved by conversationId.
    const preimageLedger = createPreimageLedger();

    // The initial TUI engine is built before createTuiBridge, so bind this
    // host seam late to the Hub that owns dirty-root persistence. Mutates
    // cannot reach the seam until the bridge has been created below.
    const bridgeRef: { hub?: ReturnType<typeof createTuiBridge>["hub"] } = {};
    // worktree-host.ts factory assembly (the TUI-seam version of the
    // name pass-through fix; unit-testable). Manual destructuring silently
    // drops new WorktreeProvisionContext fields while still compiling — a
    // TUI-seam trace (2026-09-05) reproduced the same regression the CLI
    // seam had had (a requested name was dropped and a UUID-only leaf was
    // created). Fail-closed behavior when the hub is absent belongs to this
    // file's bridging logic (only here is bridgeRef known).
    const worktreeIsolation = createTuiWorktreeIsolationHost({
      provisionWorktree: (ctx) =>
        bridgeRef.hub?.provisionWorktree(ctx) ??
        Promise.reject(
          new Error("TUI Hub is not ready for worktree provision")
        ),
    });

    const depsOpts: BuildTuiDepsOptions = {
      askUser: askBridge.ask,
      onToolEvent: (event) => toolEventSink.emit(event),
      soleInflightId: () => inflight.soleId(),
      permissionMode,
      graphMode,
      // ADR-0092: pass the fs-isolation holder to the engine (build-engine →
      // BuildEngineOpts.fsMode → bash factory per-call read).
      fsMode,
      // ADR-0119 / specs/yolo-mode.md: the yolo holder to the engine
      // (build-engine → BuildEngineOpts.yolo → the bash factory per-call read
      // / the subagent env wire).
      yolo,
      // ADR-0096: subagent concurrency-cap holder — buildTuiDeps →
      // BuildEngineOpts.subagentCapacityHolder → createSubAgentManager
      // (spawn gate reads it live per call) + registry → spawn_subagent tool
      // description (same-source getter). One frozen reference shared by all
      // three surfaces, so a /config panel flip takes global effect.
      subagentCapHolder,
      // ADR-0096: worktree-gate holder — buildTuiDeps →
      // BuildEngineOpts.worktreeOnMutateHolder → the mutate gate reads it at
      // each wave entry. A panel flip affects the next tool-call wave; it
      // never auto-provisions (ADR-0037).
      worktreeOnMutateHolder,
      liveGraphLedger,
      preimageLedger,
      sessionGrants,
      // ADR-0019: pass workspaceRoot to the build-engine identity / memory /
      // skill seams. The startup workspace is also the stable productRoot —
      // a rebuild only swaps workspaceRoot.
      ...(workspaceRoot ? { workspaceRoot, productRoot: workspaceRoot } : {}),
      // Pass the already-resolved dataDir to the deps layer so the todo
      // session-folder root and the bridge's SessionStore land in the same
      // projects/<slug>/ (resolveServeDataDir computes once upstream).
      ...(dataDir !== undefined ? { dataDir } : {}),
      // The startup settings object + isolation host seam passed through
      // (build-engine gates mutations accordingly).
      settings: startupSettings,
      worktreeIsolation,
      // Observability floor: the same value as createTuiBridge's traceOut
      // below — the hub writes per-session turn/tool records and the deps
      // factory lands subagent events in the same
      // `<traceOut>/<conversationId>.jsonl`.
      traceOut,
      onExtensions: (ext) => {
        tuiExtensions = ext;
      },
    };
    // buildTuiDeps returns flat LoopEngineDeps & { subagentManager?,
    // shutdown? } (not a nested { deps, ... }); the rest destructuring strips
    // the two handles, leaving LoopEngineDeps.
    const {
      subagentManager,
      shutdown,
      graphAssembly,
      autoMemory,
      overlayMemoryPrefetch,
      memoryFlags,
      invalidateMemorySystem,
      ...deps
    } = await buildTuiDeps(bundle, depsOpts);
    // Attach the MCP + subagent combined shutdown to process signal handling
    // (runtime.ts semantics, consistent with chat/serve). registerShutdown
    // takes a structural `{ shutdown?: }`, so the TUI passes only the handle
    // — deps / engine / subagentManager shapes are hook-agnostic. When
    // shutdown is absent (defensive; impossible for this shape),
    // registerShutdown is a no-op internally. The TUI's exitOnCtrlC=false
    // means the renderer does not consume Ctrl+C (the app layer only uses it
    // for selection copy), so SIGINT still reaches the Node process handler.
    // Settings hot-reload: envLoader.stop() must also run on shutdown —
    // long-lived processes must release the fs watcher handle before exit
    // (avoid leaked watcher loops). The signal path (registerShutdown) does
    // not pass through onQuitBridge, so release the watcher here; the /quit
    // path releases via shutdownExtensions (idempotent, double stop is
    // harmless). The late-bound hub reference lets combinedShutdown —
    // registered before the bridge exists — close rebuilt engines via
    // bridgeRef.
    const combinedShutdown = async (): Promise<void> => {
      envLoader?.stop();
      if (shutdown) await shutdown();
      // Per-root rebuilt engines (created via the buildEngine seam after a
      // rebind) are closed by the hub here (the initial engine is not in
      // engineByRoot, so no double close).
      if (bridgeRef.hub) await bridgeRef.hub.shutdown();
      // Signal path shares the /quit root cause: LSP child stdio pipes keep
      // the event loop non-empty.
      await shutdownDefaultLspPool();
    };
    registerShutdown({ shutdown: combinedShutdown });
    const bridge = createTuiBridge({
      // Pass the resolved dataDir: earlier code handed raw options.dataDir to
      // the bridge while TuiApp already used the resolveServeDataDir value, so
      // the bridge's internal SessionStore location drifted from the display
      // layer (worst with an explicit workspaceRoot).
      dataDir,
      workspaceRoot,
      // Stable productRoot = startup workspace; the bridge forwards it to the
      // hub one-way.
      ...(workspaceRoot ? { productRoot: workspaceRoot } : {}),
      deps,
      subagentManager,
      // Ledger host injected into the bridge — the hub resolves it by conversationId.
      liveGraphLedger,
      // Shared preimage accumulator: the hub drains what the engine's write
      // tools captured, so both sides must hold the same instance.
      preimageLedger,
      // Inject the startup deps root + the per-root engine-rebuild seam:
      // after a rebind the session root leaves the startup root → ensureDeps
      // reruns buildTuiDeps at the new root through this seam with the same
      // depsOpts (same startup settings + stable productRoot), so the next
      // turn runs on the worktree-root engine. The onExtensions callback
      // synchronously overwrites tuiExtensions — display surfaces follow the
      // active engine.
      engineRoot: workspaceRoot,
      buildEngine: async (root) => {
        // buildTuiDeps yields flat deps (same shape as the initial build);
        // the hub's buildEngine seam wants { deps, ...handles } — re-cohere
        // here. productRoot persists via depsOpts; only cwd / workspaceRoot
        // are overridden.
        const {
          subagentManager: sm,
          shutdown: sd,
          graphAssembly: ga,
          autoMemory: am,
          overlayMemoryPrefetch: om,
          ...flatDeps
        } = await buildTuiDeps(bundle, {
          ...depsOpts,
          cwd: root,
          workspaceRoot: root,
        });
        return {
          deps: flatDeps,
          ...(sd ? { shutdown: sd } : {}),
          ...(sm ? { subagentManager: sm } : {}),
          ...(ga ? { graphAssembly: ga } : {}),
          ...(am ? { autoMemory: am } : {}),
          ...(om ? { overlayMemoryPrefetch: om } : {}),
        };
      },
      // Auto-memory hooks are assembled by build-engine per
      // settings.memory.autoExtract; absent (default OFF) → the hub never
      // calls them, behavior byte-identical.
      autoMemory,
      overlayMemoryPrefetch,
      traceOut,
      // settings.verify section → closed-loop config (forwarded through
      // hub-bridge to SessionHub). Missing command (including a missing
      // verify section) → { command: "" }, and runClassifier takes over when
      // the hub assembles subagentManager. Shares the resolveVerifyConfig
      // assembly with serve. The same startup settings object is used (no
      // settings re-read).
      verifyConfig: resolveVerifyConfig(startupSettings.verify),
      // Hand the graph assembly snapshot to the hub — each postMessage takes
      // one snapshot (the message **after** `/graph on` is the first with
      // run_graph assembled).
      ...(graphAssembly ? { graphAssembly } : {}),
      inflight,
      contextWindow: currentEnv.compress.contextWindow,
      // Pass the validated startup env to the hub's override path — override-
      // rebuilt adapters use this env instead of falling back to process.env.
      overrideEnv: { llm: currentEnv.llm },
      // Pass the env source to the hub — ensureDeps / reloadFromEnv read the
      // latest env via activeEnvLoader.get().
      envProvider: () => activeEnvLoader.get(),
      // On env change (after a successful reloadFromEnv) publish only the
      // display snapshot; subscribers refresh in place, and the TuiApp tree
      // is **not** re-rendered (this callback never calls root.render).
      onEnvChange: (env) => {
        currentEnv = env;
        envDisplay.publish({
          model: env.llm.model,
          defaultThinking: {
            mode: env.llm.thinking,
            effort: env.llm.thinkingEffort,
          },
        });
      },
      // ADR-0070: enter-occupancy-lock tier, passed once — resolved at the
      // startup load point then frozen (ADR-0037), threading bridge → hub →
      // provisioner closures. OFF (absent / non-true) → occupancy checks are
      // fully skipped (zero regression).
      worktreeExclusive: resolveWorktreeExclusive(startupSettings),
      // The same fs holder (ADR-0092) forwarded to bridge → hub — the TUI's
      // verify command surface and bash tool surface share one tier (verify
      // reads the holder per call; a `/config` flip affects the next call,
      // same instance as bash). serve uses the same wiring.
      fsMode,
      // ADR-0119 / specs/yolo-mode.md: the same yolo holder forwarded to
      // bridge → hub — the TUI's verify command surface and bash tool surface
      // must be homomorphic (the hub's verify call site reads the holder per
      // call, so a `/yolo` flip affects the next call, the same instance as
      // the bash side).
      yolo,
    });
    // Once the bridge is ready, backfill the late-bound hub reference (see bridgeRef above).
    bridgeRef.hub = bridge.hub;
    // The same backfill point feeds shutdownExtensions (the /quit path).
    hubRef.current = bridge.hub;
    // Settings hot-reload: subscribe to EnvLoader — settings file changes →
    // reload env (on success) → the hub's adapter hot-rebuild path (never
    // touching build-engine directly). A failed reload (bad JSON, etc.) →
    // EnvLoader keeps the old env internally and reports via onError; we do
    // not surface it here (stderr already written); the adapter keeps the old
    // reference.
    activeEnvLoader.subscribe(() => {
      void bridge.hub.reloadFromEnv().catch(() => {
        // reloadFromEnv can only throw if envProvider reloaded successfully
        // (almost unreachable here); on apiKey-missing degradation the .catch
        // swallows it → cachedDeps stays and the old adapter is kept silently.
      });
    });

    let initialSession: TuiSessionState | undefined;
    if (options.sessionId) {
      const file = await bridge.loadSessionFile(options.sessionId);
      initialSession = attachSession(file);
    }

    onQuitBridge = {
      destroy: (conversationId?: string): void => {
        // /quit double-confirm → wait for in-flight flush → trigger onQuit.
        // shutdown closes the MCP layer (clients + in-flight cancellation +
        // SIGTERM to stdio children), then destroys the renderer.
        // Fire-and-forget: app proceeds to its own destroy (see the end of
        // app.tsx quit()), so nothing hangs; whenDestroyed awaits the same
        // shutdown as a fallback.
        quitResumeConversationId = conversationId;
        // The single teardown must complete "mouse disable + drain" within
        // the same tick **before** app.tsx quit()'s renderer.destroy()
        // (ordering contract in teardownTuiTerminal). Since this function
        // destroys on its own, app.tsx's `if (!renderer.isDestroyed)` guard
        // naturally skips (idempotent, no double native release).
        teardownTerminal();
        void shutdownExtensions();
      },
    };

    // Ordering invariant: the renderer factory runs **after the assembly
    // chain** — prepareRuntime / resolveWorkspaceRoot / resolvePermissionMode
    // / buildTuiDeps above throw typed plain objects
    // (provider_api_key_missing, etc.); creating the renderer first would
    // probe the terminal (OSC 10/11 capability queries + alternate screen)
    // and leave capability replies stranded after a throw.
    renderer = await factory(RENDERER_CONFIG);
    // Alternate screen is live from here on: bare `process.stderr.write`
    // from background modules (lsp warmup / notifier / memory …) would land
    // at the cursor position — visibly inside the input box. Gate the trace
    // for the renderer's lifetime and replay it after terminal restore.
    beginStderrGate();

    const root = createRoot(renderer);
    // This function is the **only** root.render call site for <TuiApp>
    // (mounted once at startup): later env changes flow exclusively through
    // envDisplay.publish (see onEnvChange above) and each subscriber
    // refreshes in place — re-entering root.render recomputes the whole tree
    // (user-visible flicker), and the render-time props snapshot would
    // overwrite user-edited thinking / effort. TuiApp receives only the
    // envDisplay subscription, never model / defaultThinking value props.
    const mountApp = (): void => {
      root.render(
        <TuiApp
          bridge={bridge}
          askBridge={askBridge}
          toolEventSink={toolEventSink}
          initialSession={initialSession}
          cwd={cwd}
          dataDir={dataDir}
          permissionMode={permissionMode}
          graphMode={graphMode}
          // ADR-0092: fs-isolation holder + persist callback for the command
          // surface (the engine-side holder goes via depsOpts.fsMode).
          fsMode={fsMode}
          onPersistFsMode={persistFsMode}
          // ADR-0119 / specs/yolo-mode.md: the yolo holder + controller to the
          // command surface (`/yolo` reads the holder to decide the confirm
          // direction, and after confirmation runs the controller's enter /
          // exit; the engine-side holder goes via depsOpts.yolo, the
          // bridge → hub side via the same yolo reference). **No persist
          // callback** — the yolo axis is not persisted (spec §5).
          yolo={yolo}
          yoloController={yoloController}
          // ADR-0096: cap holder + persist callback for the command surface
          // (same shape as fsMode); the engine-side holder goes via
          // depsOpts.subagentCapHolder. Same reference, so one /config panel
          // flip works globally. When the holder exists the panel prefers
          // holder.get(); `subagentCapDisplay` is only passed as a fallback
          // snapshot when the holder is absent.
          subagentCapHolder={subagentCapHolder}
          onPersistSubagentCap={persistSubagentCap}
          // ADR-0096: worktree-gate holder + persist callback for the command
          // surface (same shape as fsMode / cap); the engine shares the same
          // reference via depsOpts.worktreeOnMutateHolder. `isolationOn`
          // remains as a fallback snapshot when the holder is absent.
          worktreeOnMutateHolder={worktreeOnMutateHolder}
          onPersistWorktreeOnMutate={persistWorktreeOnMutate}
          sessionGrants={sessionGrants}
          // TuiApp consumes skillCatalog (slash candidates + /skill
          // load-and-send). onExtensions injects it synchronously during
          // buildTuiDeps assembly; the optional default = empty catalog
          // (safe degradation for tests / abnormal assembly paths).
          skillCatalog={tuiExtensions?.skillCatalog}
          // The slash-candidate "hot in-session" rescan seam (same machine as
          // the engine's `deps.skillIndexDelta`). mountApp is the only
          // root.render point (mounted once at startup), so this prop is an
          // **assembly-time snapshot**, like skillCatalog beside it. The main
          // scenario (SKILL.md files landing mid-session in user / project
          // roots) is covered across rebinds by the stable
          // projectIdentityRoot; the plugin-root refresh after a rebind is a
          // known limitation.
          skillRescanner={tuiExtensions?.skillRescanner}
          // When a slash command assembles skill bodies, read the live
          // taskRoot snapshot (passed through TuiExtensions; default
          // undefined → no trailer).
          liveTaskRoot={tuiExtensions?.liveTaskRoot}
          // The slash assembly's two-argument form needs `isolationOn` paired
          // with liveTaskRoot to compute writeSituation. Absent → undefined →
          // app.tsx fail-closes to writable_main, byte-equal to the pre-
          // change form.
          isolationOn={tuiExtensions?.isolationOn}
          // TuiApp consumes the MCP board surface (status / reload /
          // listMcpTools); default undefined → /mcp reports "MCP 未装配".
          mcp={
            tuiExtensions
              ? {
                  status: tuiExtensions.mcp.status,
                  reload: tuiExtensions.mcp.reload,
                  listMcpTools: tuiExtensions.listMcpTools,
                }
              : undefined
          }
          // Env-derived display snapshot (model routing string + thinking
          // baseline) — app and ContextBar read current values and subscribe
          // through it, replacing per-layer props passing.
          envDisplay={envDisplay}
          // Settings bidirectional persistence: panel Esc → persistThinking
          // closure writes settings.json (failure shown as a notice, no TUI
          // crash).
          onPersistThinking={persistThinking}
          onPersistMemory={persistMemory}
          // /model panel (ADR-0093): providers come from the **same startup
          // settings object** (no settings re-read, same discipline as graph
          // / verify); an empty registry → app-layer /model shows a notice
          // instead of opening the panel.
          providers={startupSettings.llm?.providers ?? []}
          onPersistModel={persistModel}
          defaultMemory={loadIknowSettings().memory}
          memoryFlags={memoryFlags}
          invalidateMemorySystem={invalidateMemorySystem}
          onQuit={onQuitBridge!.destroy}
        />
      );
    };
    mountApp();
    await whenDestroyed(renderer);
    // Normal exit (signal close / direct destroy returns this await) also
    // tops up teardown before returning — app.tsx /quit already destroyed
    // early (the renderer is not destroyed twice), so here we only add drain
    // + raw-mode fallback.
    teardownTerminal();
    // Terminal is back on the main screen: release the stderr gate so the
    // buffered background traces replay here (visible, correctly ordered)
    // instead of having bled into the live TUI.
    endStderrGate();
    // Backstop — exit paths not taken over by onQuit (signals / direct
    // destroy): if shutdownExtensions has started it is a no-op; otherwise
    // ensure MCP shutdown completes before runTui returns, avoiding leaked
    // stdio descendants.
    await shutdownExtensions();
    // /quit on a filed session → print the resume hint after terminal
    // restore (drafts without an id print nothing).
    if (quitResumeConversationId) {
      process.stdout.write(
        `Resume this session with:\niknow --resume ${quitResumeConversationId}\n`
      );
    }
    return 0;
  } catch (err) {
    // The single catch point: write a typed message to stderr; terminal
    // teardown converges here. describeTuiStartError dispatches
    // discriminated unions first (provider / workspace-root errors are plain
    // objects; `String(err)` would render them [object Object]).
    const cause = describeTuiStartError(err);
    process.stderr.write(
      `${TUI_RENDERER_ERROR_PREFIX}：${cause}。请重新安装依赖（npm ci）后重试\n`
    );
    teardownTerminal();
    // Same gate release as the normal path: when the throw came after
    // arming, the error line above was buffered and replays here (order
    // preserved); pre-assembly throws never armed it → already written.
    endStderrGate();
    // Best-effort MCP close on the error path too (if the throw came after
    // buildTuiDeps, tuiExtensions is already injected; if buildTuiDeps itself
    // threw, no-op). Does not affect the exit code.
    await shutdownExtensions();
    void onQuitBridge;
    return 1;
  }
}

/** Renderer destroy event = end of the TUI lifecycle (/quit / signal / forced destroy). */
function whenDestroyed(renderer: CliRenderer): Promise<void> {
  if (renderer.isDestroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => resolve());
  });
}
