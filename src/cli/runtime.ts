/**
 * Runtime bootstrap for CLI: env + harness engine.
 *
 * The CLI ask/chat product path runs on the harness foundation (real
 * Anthropic adapter + LoopEngine). The ACI tool set has 8 tools (bash /
 * read_file / grep / glob / edit_file / write_file / web_fetch /
 * web_search), aligned with permission-policy byName keys (ADR-0004 /
 * ADR-0006).
 *
 * Tool assembly itself lives in `src/harness/build-engine.ts` (SSOT): CLI
 * and serve share the same 8-tool set; this module only assembles the
 * bundle (env/session) and forwards.
 */
import {
  buildHarnessEngine as buildCoreEngine,
  type BuiltEngine,
} from "../harness/build-engine.js";
import {
  initIknowWorkspaceSafe,
  runHostInitScriptSafe,
} from "../harness/identity/index.js";
import type { AskUser } from "../harness/permission/types.js";
import {
  parsePermissionMode,
  createPermissionModeContext,
  type PermissionModeContext,
} from "../harness/permission/modes.js";
import { readProjectDefaultMode } from "../harness/permission/project-settings.js";
import { readWorkerInFlightToolName } from "../session-api/store/index.js";
import type { GraphModeContext } from "../harness/graph/mode.js";
import { loadIknowEnv, type IknowEnv } from "../config/env.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import type { SessionContext } from "../shared/schema.js";

export type RuntimeBundle = {
  env: IknowEnv;
  session: SessionContext;
};

/**
 * Resolve the initial permission mode for CLI entry points.
 * Priority: explicit > env IKNOW_PERMISSION_MODE > project
 * `permissions.defaultMode` > default.
 *
 * `projectDefaultModeSettings` (optional) carries the **project identity
 * root** to light-read `defaultMode` from — not the process cwd (after a
 * worktree rebind the cwd is a bare task worktree with no `.iknow/`).
 * When the argument is present the file is always read: legacy shapes and
 * `defaultMode: "full_auto"` fail loud from `readProjectDefaultMode`
 * (ADR-0090 — a shared repo must not self-grant automatic mode), and the
 * caller's startup error path renders the typed `ProjectSettingsError`.
 *
 * The returned context is always mutable (PermissionModeContext exposes
 * `set`); ask/serve callers simply don't call it. Only the chat REPL's
 * `/permissions` slash command actually flips it.
 */
export function resolvePermissionMode(
  explicit: unknown,
  projectDefaultModeSettings?: { readonly cwd: string }
): PermissionModeContext {
  const projectDefaultMode =
    projectDefaultModeSettings === undefined
      ? undefined
      : readProjectDefaultMode({ cwd: projectDefaultModeSettings.cwd });
  const parsed =
    parsePermissionMode(explicit) ??
    parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ??
    projectDefaultMode;
  return createPermissionModeContext(parsed ?? "default");
}

export async function prepareRuntime(): Promise<RuntimeBundle> {
  const env = loadIknowEnv();

  const session: SessionContext = {};

  return { env, session };
}

// Re-export BuiltEngine so existing callers (`cli.ts` / `chat-session.ts` /
// tests) keep importing it from this module unchanged.
export type { BuiltEngine } from "../harness/build-engine.js";

/**
 * Harness assembly for the CLI ask/chat product path.
 *
 * Thin wrapper around `buildHarnessEngine` in `src/harness/build-engine.ts`:
 * pulls `env` from the CLI runtime bundle and forwards. Tool assembly
 * itself (the 8 ACI tools + Anthropic adapter + permission middleware) is
 * the harness layer's responsibility so CLI and serve cannot drift.
 *
 * `askUser: AskUser` is a required parameter for all three entry points;
 * when missing, startup throws `ask_inlet_missing` (thrown inside
 * `buildHarnessEngine`).
 */
/**
 * CLI wrapper assembly opts (exported so hosts can **annotate** their own
 * opts literals).
 *
 * Why annotation is mandatory: an unannotated `const` skips TS
 * excess-property checks, so a field the interface does not declare is
 * silently dropped (observed: `projectIdentityRoot` went dead end-to-end on
 * `iknow chat`).
 *
 * The other direction (declared here, missing from forwarding) is not
 * compiler-checked either, so forwarding no longer uses a manual whitelist:
 * apart from the three fields needing reshaping, everything passes through
 * as rest, and new fields follow automatically.
 */
export interface CliBuildEngineOpts {
  askUser: AskUser;
  surface?: "chat" | "tui" | "ask" | "serve";
  /** Memory-layer switch passthrough (ask explicitly off, chat explicitly on; absent defaults to true). */
  memory?: { readonly enabled: boolean };
  /** Permission-mode context. The chat REPL passes a mutable context
   *  (flippable via /permissions); ask/serve pass a static context (never
   *  set, same type). Absent -> engine default. */
  permissionMode?: PermissionModeContext;
  /** ADR-0030: graph orchestration overlay holder passthrough (chat passes
   *  a mutable context; ask passes none -> run_graph and the orchestration
   *  segment are not assembled). */
  graphMode?: GraphModeContext;
  /**
   * ADR-0092: fs isolation-tier holder — forwarded to build-engine's bash
   * factory (read per call). Declared here so the CLI entries that wire it are
   * compile-checked (the wrapper forwards `rest` wholesale, so an undeclared key
   * would still travel at runtime and the drop would be silent).
   */
  fsMode?: import("../harness/sandbox/fs-mode.js").FsModeContext;
  /**
   * ADR-0119 / ADR-0130: yolo-axis (fence-retire) holder — forwarded to
   * build-engine, which threads it to the four routes (foreground bash /
   * background spawn / verify sandbox-run / subagent worker env wire). Absent →
   * non-yolo (fail-closed keeps the fence). ADR-0130's eval state is the second
   * face that reaches the same branch, so it supplies the same holder.
   */
  yolo?: import("../harness/sandbox/yolo.js").YoloContext;
  /** Host-injected session-scoped todoDir, semantically the "session
   *  project root" (`resolveProjectSessionDir(baseDir, projectIdentityRoot)`).
   *  todo_write consumes it at main-loop assembly; the per-conversation file
   *  path is derived at call time by `resolveConversationTodoPath` (SSOT in
   *  todo-write.ts). chat/ask CLI entry points resolve it and forward. */
  todoDir?: string;
  /** ADR-0019: per-root state anchor — the CLI `--workspace-root` flag
   *  forwards to build-engine (the `[explicit, env, cwd]` priority chain
   *  runs at the build-engine layer). Each CLI entry point
   *  (runChat/runOneShot/runTui/runServe) resolves then forwards. */
  workspaceRoot?: string;
  /**
   * Stable main checkout root (worktree MCP rebind lifecycle): captured at
   * first assembly and forwarded verbatim across rebinds; `resolveMcpRoots`
   * derives `mcpConfigRoot` from it. The wrapper only forwards — never
   * recomputes from `process.cwd()`.
   */
  productRoot?: string;
  /**
   * ADR-0037: project identity root — pinned once by the host at startup,
   * forwarded verbatim across rebinds. The wrapper only forwards, never
   * recomputes from `process.cwd()`; presence is tested with
   * `!== undefined`, not truthiness — an empty string must reach the SSOT's
   * fail-closed; a truthiness test would swallow it and assembly would
   * silently degrade to `mainCheckoutOf(cwd)` (observed).
   */
  projectIdentityRoot?: string;
  /** Crash diagnostics / worker trace root for subagent lifecycle evidence. */
  subagentDiagnosticsDir?: string;
  /**
   * ADR-0037: worktree isolation host seam — forwarded to build-engine.
   * The toggle itself is read by build-engine from `settings` at the
   * startup load point; when ON, chat-engine mutates are gated and
   * provision creates the task worktree + rebinds this session's roots
   * only. Absent -> no wrapping (behaves as before).
   */
  worktreeIsolation?: import("../harness/isolation/worktree-gate.js").WorktreeIsolationHostOpts;
  /**
   * Startup-assembly settings object passthrough. Per-root rebuilds after
   * rebind (chat rebuildDeps seam) reuse the same object — `.iknow/` is
   * absent inside the worktree (gitignored), so never implicitly reload
   * project settings. Absent -> build-engine loads defaults.
   */
  settings?: import("../config/settings.js").IknowSettings;
  /**
   * Engine root override (task-worktree path on per-root rebuild).
   * Default = process.cwd() (same as build-engine).
   */
  cwd?: string;
}

/**
 * Drop keys whose value is `undefined` (under `exactOptionalPropertyTypes`,
 * "key present with value undefined" differs from "key absent"). Only
 * `undefined` is filtered; no truthiness filtering.
 *
 * The return type is "every key optional, values excluding `undefined`" —
 * not `T`: after dropping keys a required field may be gone, so casting
 * back to `T` would be unsound.
 */
function withoutUndefined<T extends object>(
  value: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export async function buildHarnessEngine(
  bundle: RuntimeBundle,
  opts: CliBuildEngineOpts
): Promise<BuiltEngine> {
  // CLI-entry conditional workspaceRoot resolve: when the explicit flag or
  // the env SSOT exists, resolve once here to obtain a typed
  // WorkspaceRootError (print-friendly); otherwise forward undefined and
  // let build-engine fall back to cwd.
  //
  // Data-pool default anchor (ADR-0087): the session pool root is always
  // `~/.iknow`, no longer sharded by cwd / workspaceRoot (the
  // `<cwd>/.iknow` form is retired). This field only affects the per-root
  // state anchor (memory library / skill seam / project `AGENTS.md`
  // discovery) and is independent of the session pool root.
  const envWsRoot = bundle.env.workspaceRoot;
  const resolvedWorkspaceRoot =
    opts.workspaceRoot !== undefined || envWsRoot !== undefined
      ? resolveWorkspaceRoot({
          explicit: opts.workspaceRoot,
          cwd: process.cwd(),
          env: { [WORKSPACE_ROOT_ENV_KEY]: envWsRoot },
        })
      : undefined;
  // Seed the persona at `<homedir>/.iknow` only; `--workspace-root` / cwd
  // must not receive user.md. Failures warn and do not block (build-engine
  // repeats this via the userHome seam).
  await initIknowWorkspaceSafe();
  // Host-side user init script (default ~/.iknow/init.sh, overridable via
  // IKNOW_HOST_INIT_SCRIPT). The spawn comes from the host process,
  // bypassing the agent bash tool -> no permission prompt, no allowlist.
  // Missing file -> skip; failure -> warn, assembly continues (degraded
  // contract). Order matters: initIknowWorkspaceSafe (seed templates)
  // first, then runHostInitScriptSafe, so user scripts can read templates.
  await runHostInitScriptSafe();
  // surface forwards to buildCoreEngine, which decides whether the BOOTSTRAP
  // segment activates; the memory switch forwards, its two branches live in
  // buildCoreEngine; permissionMode forwards to policy.mode, the chat REPL
  // holds the context flipped by /permissions; workspaceRoot (ADR-0019)
  // forwards to per-root identity / memoryDir seams; todoDir forwards to the
  // registry so todo_write is present (surface !== ask only).
  // Only these three fields need wrapper reshaping (env source swap /
  // surface default / workspaceRoot entry resolver); everything else passes
  // through as rest — a hand-written whitelist guards only one direction, so
  // adding a field here and missing it in forwarding would be a
  // compile-green silent drop.
  const {
    askUser,
    surface,
    workspaceRoot: _resolvedByEntry,
    ...passthrough
  } = opts;
  return buildCoreEngine({
    // Keys explicitly given `undefined` must be dropped: under
    // `exactOptionalPropertyTypes`, `{ cwd: undefined }` is not "no cwd".
    // Values themselves are not truthiness-filtered — empty strings must
    // reach each root's fail-closed and must not be swallowed here.
    ...withoutUndefined(passthrough),
    // Wrapper-owned fields go **after** the spread: if a key the interface
    // does not declare but this layer injects (e.g. `env`) sneaks into rest
    // via a non-annotated literal, the explicit field still wins.
    env: bundle.env,
    askUser,
    surface: surface ?? "chat",
    // Same store reader the hub and TUI assemblies inject, so no surface can
    // drift on whether live spawn cards light up their activity slot.
    subagentActivityReader: readWorkerInFlightToolName,
    ...(resolvedWorkspaceRoot !== undefined
      ? { workspaceRoot: resolvedWorkspaceRoot }
      : {}),
  });
}

/**
 * Lifecycle hook — bind the `shutdown` handle to process exit events.
 *
 * Long-lived CLI entries (chat REPL / serve / tui) hold MCP manager
 * background connections plus the subagent manager child-process pool;
 * before exit they must close stdio children and cancel in-flight calls.
 * `BuiltEngine.shutdown` is a combined handle
 * (Promise.all([mcpManager?.shutdown(), subagentManager?.shutdown()])) —
 * mcpManager first / subagentManager second is a semantic annotation only
 * (no shared mutable state, Promise.all runs concurrently). This hook just
 * calls shutdown once. The ask entry never creates managers -> shutdown is
 * absent -> this function returns a no-op handle; callers need no
 * special-casing.
 *
 * The parameter type is deliberately structural
 * `{ readonly shutdown?: () => Promise<void> }` — `BuiltEngine`,
 * `SessionHub`, and TUI-local subagent handles all satisfy it; the hook
 * only cares about one shutdown call.
 *
 * Usage:
 *   const built = await buildHarnessEngine(...);
 *   registerShutdown(built);  // chat: hook once
 *   const { hub } = await startSessionServe(...);
 *   registerShutdown(hub);    // serve: hub exposes built.shutdown
 *
 * `dispose()` is for tests or one-shot cleanup (bound signal listeners are
 * unaffected and still fire on process exit).
 */
export function registerShutdown(built: {
  readonly shutdown?: () => Promise<void>;
}): {
  readonly dispose: () => Promise<void>;
} {
  let shuttingDown = false;
  // Re-kill one-shot: after the first signal's dispose completes, re-send
  // it once so external handlers (e.g. chat-session's onSigint counter) get
  // a chance to force-exit. With no external handler (serve / plain
  // registerShutdown), unconditional re-kill ping-pongs with our own
  // handler into a microtask loop (vitest's synchronous process.emit path
  // masks it; hangs observed under real node/bun signal delivery).
  // `reKilled` guards this: set on entry for the first signal; the second
  // signal lands as a hard exit without re-killing. The re-kill goes
  // through setImmediate so the handler returns to the event loop first,
  // reducing the chance that Unix same-signal coalescing loses the second
  // SIGINT/SIGTERM.
  let reKilled = false;
  const dispose = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (built.shutdown) {
      try {
        await built.shutdown();
      } catch (err) {
        console.warn(
          `[runtime] shutdown hook failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    if (reKilled) {
      // Second signal exits directly (user force-kill semantics), no waiting for the close fallback.
      const code = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 128;
      process.exit(code);
      return;
    }
    reKilled = true;
    void dispose().finally(() => {
      setImmediate(() => {
        process.kill(process.pid, sig);
      });
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // once:true — process.beforeExit fires each loop turn; run dispose only at the last moment.
  process.once("beforeExit", () => {
    void dispose();
  });
  return Object.freeze({ dispose });
}
