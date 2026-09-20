/**
 * Bootstrap: SessionHub + HTTP listen + static web.
 * SessionStore is required (the hub needs it); caller_role retired from wire.
 */
import { homedir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { SessionHub, type SessionHubOptions } from "./hub.js";
import { liteTitleGeneratorOptions } from "./title-generation.js";
import { listenSessionServer, type ListeningServer } from "./http.js";
import { SessionStore } from "./store/index.js";
import { loadIknowEnv } from "../config/env.js";
import { createEnvLoader, type EnvLoader } from "../config/env-loader.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import {
  loadIknowSettings,
  resolveFsIsolationMode,
  resolveWorktreeExclusive,
} from "../config/settings.js";
import {
  initIknowWorkspaceSafe,
  runHostInitScriptSafe,
} from "../harness/identity/index.js";
import { deriveProjectIdentityRoot } from "../harness/session-roots.js";
import { readProjectDefaultMode } from "../harness/permission/project-settings.js";
import type { ServeAskUserHandle } from "../harness/permission/ask-user.js";
import {
  resolveSessionDefaultWorkspace,
  ensureDefaultWorkspace,
} from "./default-workspace.js";
import {
  parsePermissionMode,
  createPermissionModeContext,
} from "../harness/permission/modes.js";
import {
  createGraphModeContext,
  resolveGraphMode,
} from "../harness/graph/mode.js";
import { createFsModeContext } from "../harness/sandbox/fs-mode.js";
import { createLiveGraphLedgerHost } from "../harness/graph/ledger.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  json_mode?: boolean;
  /** Session pool root; defaults to ~/.iknow. */
  dataDir?: string;
  /**
   * ADR-0019: per-root state anchor — CLI `--workspace-root` flag / env
   * `IKNOW_WORKSPACE_ROOT` passed through to the serve entry. hub /
   * build-engine consume it; persona seed does not follow workspaceRoot.
   * host-init stays global. The session pool root does not shard on it
   * (ADR-0087).
   */
  workspaceRoot?: string;
  /**
   * ADR-0094: user-layer settings root (EnvLoader + recents/trust lists).
   * Production default = homedir() (same source as loadIknowSettings /
   * recentsHome). Tests may inject a tmp path to isolate the real ~/.iknow.
   */
  home?: string;
  hubOptions?: Omit<SessionHubOptions, "store">;
  /** Trace output file path; forwarded to SessionHub for per-session JSONL trace. */
  traceOut?: string;
  /** Optional serve AskUser handle so the SPA can list + resolve pending
   *  permission requests. When omitted, hubOptions.askUser is used verbatim. */
  askHandle?: ServeAskUserHandle;
};

/**
 * Resolve the session pool root: explicit dataDir wins (absolute-pathed);
 * else `~/.iknow` (ADR-0071 / ADR-0087). Does **not** shard on workspaceRoot
 * — transcripts are not per-checkout state. Pure (no IO).
 */
export function resolveServeDataDir(dataDir?: string): string {
  if (dataDir) return path.resolve(dataDir);
  return join(homedir(), ".iknow");
}

// Shared assembly (SSOT for the cli / serve / tui entries): settings.verify → VerifyConfig.
// serve keeps the re-export for tui/run.tsx (tui → session-api same-direction dependency).
import { resolveVerifyConfig } from "../config/verify-config.js";
export { resolveVerifyConfig };

/**
 * ADR-0094: EnvLoader construction for the serve entry (home default =
 * homedir(), same source as loadIknowSettings / recentsHome; tests inject a
 * tmp path via `opts.home`). Extracted to a single point so startSessionServe
 * does not carry the branch complexity.
 */
function createServeEnvLoader(opts?: ServeOptions): EnvLoader {
  return createEnvLoader({
    cwd: process.cwd(),
    home: opts?.home ?? homedir(),
  });
}

export async function startSessionServe(
  opts?: ServeOptions
): Promise<{ listening: ListeningServer; hub: SessionHub }> {
  // An explicit workspaceRoot (CLI --workspace-root / env IKNOW_WORKSPACE_ROOT)
  // anchors per-root identity + data; absent → dataDir falls back to legacy
  // ~/.iknow and identity seeding is skipped (unbound — ADR-0023: serve does
  // not treat process.cwd() as a seed). Resolve conditionally once: with an
  // explicit flag or the env SSOT present, go through the resolver (invalid
  // CLI flag → typed WorkspaceRootError, fail fast with a friendly print);
  // both absent → undefined, keeping the hub unbound (dataDir defaults to
  // ~/.iknow, no cwd state seeded).
  const envWsRoot = loadIknowEnv().workspaceRoot;
  const workspaceRoot =
    opts?.workspaceRoot !== undefined || envWsRoot !== undefined
      ? resolveWorkspaceRoot({
          explicit: opts?.workspaceRoot,
          cwd: process.cwd(),
          env: { [WORKSPACE_ROOT_ENV_KEY]: envWsRoot },
        })
      : undefined;
  // Persona seed always lives at `<homedir>/.iknow`. Bound `--workspace-root`
  // must not receive user.md. Failures warn, do
  // not block (build-engine repeats this with the userHome seam).
  await initIknowWorkspaceSafe();
  // serve also runs the host-side init script (default ~/.iknow/init.sh),
  // sharing runHostInitScriptSafe with chat/ask: missing file → skip,
  // failure → non-blocking. host-init stays global — no workspaceRoot.
  await runHostInitScriptSafe();
  const dataDir = resolveServeDataDir(opts?.dataDir);
  // Store namespace keys by projectIdentityRoot, not cwd: derive from
  // the same root the engine will independently validate inside
  // resolveSessionRoots so the two stores never disagree.
  const projectIdentityRoot = deriveProjectIdentityRoot({
    cwd: workspaceRoot,
  });
  const store = new SessionStore(dataDir, projectIdentityRoot);

  // Stable productRoot = the startup bind root (explicit workspace or default
  // workspace). After a rebind the task worktree only swaps the session
  // workspaceRoot; MCP config still reads this root.
  let productRoot: string;
  if (workspaceRoot !== undefined) {
    productRoot = workspaceRoot;
  } else {
    await ensureDefaultWorkspace();
    productRoot = resolveSessionDefaultWorkspace();
  }

  // Settings are read exactly once at the startup load point: the same
  // object drives graph / verify assembly and is pinned via hub opts.settings
  // to all later engine builds — after a rebind the worktree root lacks
  // `.iknow/` (gitignored), so an implicit
  // loadIknowSettings({cwd: worktreeRoot}) would silently drop project
  // settings.
  const startupSettings = loadIknowSettings();
  // ADR-0090: initial permission-mode priority at serve startup:
  // env IKNOW_PERMISSION_MODE > project permissions.defaultMode > "default"
  // (the CLI flag is TUI-only). Project settings are read from
  // projectIdentityRoot (derived above), not cwd: after a rebind cwd is a
  // bare task worktree without `.iknow`. Fail-loud (legacy / full_auto)
  // propagates as-is onto the startup error path. The holder is a local
  // variable shared by hub and the http layer — web Shift+Tab switches at
  // runtime via POST /api/v1/permission-mode (same nextShiftTabMode SSOT as
  // the TUI), so defining it before `new SessionHub` suffices.
  const projectDefaultMode = readProjectDefaultMode({
    cwd: projectIdentityRoot,
  });
  const permissionModeCtx = createPermissionModeContext(
    parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ??
      projectDefaultMode ??
      "default"
  );
  // ADR-0030: graph-overlay holder — initial value from settings (off by
  // default), toggled at runtime by POST /api/v1/graph-mode (the serve
  // counterpart of `/graph`). Same shape as permissionModeCtx: hub and the
  // http layer share one instance (one holder across all entries).
  const graphModeCtx = createGraphModeContext(
    resolveGraphMode({ settings: startupSettings.graph })
  );
  // ADR-0092: filesystem-isolation holder — initial value from settings
  // (default "global"), toggled at runtime by POST /api/v1/fs-mode (the
  // serve counterpart of `/config`). Same shape as permissionModeCtx: hub
  // and the http layer share one instance. Orthogonal to permissionMode /
  // graphMode.
  const fsModeCtx = createFsModeContext(
    resolveFsIsolationMode(startupSettings)
  );
  // ADR-0070: enter-worktree exclusive-lock flag, resolved once at the
  // startup load point. `resolveWorktreeExclusive(settings)` is the single
  // read point (same shape as `resolveWorktreeOnMutate`; missing / non-true
  // → OFF), then passed through to hub opts.worktreeExclusive; the hub feeds
  // it to createTaskWorktreeProvisioner (frozen in the closure, not re-read
  // on rebind — ADR-0037 hard requirement). OFF default = exactly today's
  // enter path (zero regression pinned).
  const worktreeExclusive = resolveWorktreeExclusive(startupSettings);
  // Live-graph ledger host — a serve-process-level singleton resolving
  // per-conversation ledgers; destroyed by resetSession / hub.shutdown.
  const liveGraphLedger = createLiveGraphLedgerHost();

  // ADR-0094: single-source runtime LLM env (serve entry) — EnvLoader is
  // injected into the hub. Same shape as the TUI: construct → pass
  // envProvider through to the hub → subscribe triggers hub.reloadFromEnv
  // for hot rebuild (whitelisted fields, e.g. model, changed).
  // EnvLoader.stop() releases synchronously during listening.close()
  // (mirrors the TUI combined shutdown).
  const envLoader: EnvLoader = createServeEnvLoader(opts);

  const hub = new SessionHub({
    store,
    defaultJsonMode: opts?.json_mode ?? false,
    traceOut: opts?.traceOut,
    // settings.verify section → closed-loop config. Missing command (incl.
    // a missing verify section) → { command: "" }; when the hub assembles
    // subagentManager, runClassifier takes over; un-assembled → verify-loop
    // is transparently off for backward compatibility.
    // serve cwd = process startup directory (consistent with the build-engine
    // sandboxRoot fallback, see the hub.sandboxRoot comment).
    verifyConfig: resolveVerifyConfig(startupSettings.verify),
    // Pin the settings object loaded at startup to the hub — after a rebind,
    // engines built on the worktree root reuse the same object instead of
    // implicitly reloading project settings.
    settings: startupSettings,
    // serve, like chat/tui, is a conversational entry, so BOOTSTRAP is
    // active (surface="serve" → bootstrapActive=true), sharing the
    // ~/.iknow/state.json bootstrap_seeded state machine; ask (oneshot
    // script) is the sole exception.
    surface: "serve",
    permissionMode: permissionModeCtx,
    graphMode: graphModeCtx,
    // ADR-0092: fs-isolation holder consumed by hub engines (bash factory
    // reads per call).
    fsMode: fsModeCtx,
    // ADR-0070: boolean resolved once at the startup load point — passed
    // through to the hub and frozen in the provisioner closure. OFF →
    // `worktreeExclusive` is absent from opts (undefined → the provisioner's
    // `opts.worktreeExclusive === true` check is false → exclusivity checks
    // are skipped entirely, behavior byte-for-byte identical to today).
    ...(worktreeExclusive ? { worktreeExclusive: true } : {}),
    // Ledger host injected into the hub.
    liveGraphLedger,
    // ADR-0113: inject the title generator only when a lite slot exists
    // (absent → the key does not appear, the hub never triggers it).
    ...liteTitleGeneratorOptions({ envProvider: () => envLoader.get() }),
    ...opts?.hubOptions,
    // Startup bind root pass-through — bash fence / identity share the
    // stable productRoot (MCP config); rebind does not change productRoot.
    workspaceRoot: productRoot,
    productRoot,
    // ADR-0023: recents/trust lists land in home — with an explicit
    // `--workspace-root` / `IKNOW_WORKSPACE_ROOT` pre-bind, write to
    // `<homedir>/.iknow/workspaces.json` with confirmTrust=true (explicit
    // selection = explicit trust). Absent → the hub keeps its no-trust-gate,
    // no-recents semantics, see hub.ts.
    recentsHome: homedir(),
    // ADR-0094: env source — previously serve called loadIknowEnv() once;
    // now EnvLoader.get() feeds every ensureDeps / reloadFromEnv, so editing
    // whitelisted settings.json fields (model / apiKey / headers) takes
    // effect on the next POST /messages.
    envProvider: () => envLoader.get(),
    // Prefer the full handle when provided so web can resolve asks; fall back
    // to the bare askUser (back-compat for callers that only wire `.ask`).
    ...(opts?.askHandle
      ? { askUser: opts.askHandle.ask, askHandle: opts.askHandle }
      : {}),
  });

  // ADR-0094: subscribe to the EnvLoader — settings file changes → reload
  // env → the hub's adapter hot-rebuild path (build-engine is never touched
  // directly). A reload throw (bad JSON / missing apiKey) → the EnvLoader
  // keeps the old env internally and fires onError; the .catch here swallows
  // it (same as the TUI: cachedDeps untouched, the old adapter is silently
  // retained — degraded semantics aligned).
  envLoader.subscribe(() => {
    void hub.reloadFromEnv().catch((err) => {
      // reloadFromEnv threw (bad JSON / missing apiKey) → the EnvLoader
      // keeps the old env internally + onError notification; swallow here
      // and print to stderr (same as the TUI: cachedDeps untouched, old
      // adapter retained — degraded semantics aligned).
      // eslint-disable-next-line no-console
      console.error("[serve] reloadFromEnv failed:", err);
    });
  });

  // Bind to productRoot at startup (explicit flag/env or default
  // workspace). confirmTrust:true — explicit selection and the hard-coded
  // default both count as explicit trust.
  await hub.bindWorkspace(productRoot, { confirmTrust: true });

  const port =
    opts?.port ??
    (process.env.IKNOW_SERVE_PORT
      ? Number(process.env.IKNOW_SERVE_PORT)
      : 8787);
  const host = opts?.host ?? "127.0.0.1";
  // Context window: via the env SSOT (loadIknowEnv), served through
  // HealthResponse (the percentage denominator). Same source as hub.ensureDeps.
  const env = loadIknowEnv();

  const listening = await listenSessionServer({
    hub,
    host,
    port: Number.isFinite(port) ? port : 8787,
    contextWindow: env.compress.contextWindow,
    // Model name (settings.llm.model SSOT): served via HealthResponse for
    // the web status bar. Same startup-loaded object (no settings re-read).
    model: startupSettings.llm?.model,
    traceWriteFailures: () => hub.getTraceWriteFailures(),
    permissionMode: permissionModeCtx,
    graphMode: graphModeCtx,
    // ADR-0092: fs-isolation holder for the http layer (/api/v1/fs-mode endpoint).
    fsMode: fsModeCtx,
    // ADR-0020: serve accepts --trace-out and mounts the READ side too —
    // `/api/v1/traces*` + `/trace` SPA live on this same server/port.
    ...(opts?.traceOut !== undefined
      ? { trace: { traceDir: path.resolve(opts.traceOut) } }
      : {}),
  });

  // ADR-0094: EnvLoader.stop() releases synchronously during
  // listening.close() (mirrors the TUI combinedShutdown) — the fs watcher
  // handle is freed before the long-lived serve process exits. Repeated
  // close() calls are idempotent (EnvLoader.stop() is internally idempotent
  // and the wrapped close triggers it only once). Callers keep using the
  // original listening.close() without knowing about the EnvLoader.
  const originalClose = listening.close.bind(listening);
  const wrappedListening: ListeningServer = {
    ...listening,
    close: async () => {
      envLoader.stop();
      await originalClose();
    },
  };

  return { listening: wrappedListening, hub };
}
