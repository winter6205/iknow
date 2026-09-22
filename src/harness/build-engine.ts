/**
 * Source-of-truth harness assembly for the LLM + tool-call loop.
 *
 * `buildHarnessEngine({ env, askUser })` is the assembly point for the LLM
 * adapter, permission middleware, executor, and engine — plus the 8-tool
 * ACI tool set, which it obtains from the SSOT factory
 * `createDefaultAciRegistry` (`src/harness/aci/tools/registry.ts`). Both the
 * CLI (chat / ask), the session server (`iknow serve` → SessionHub.ensureDeps),
 * and the TUI (`iknow tui` → buildTuiDeps) share that factory so the tool set
 * can never drift between entry points.
 *
 * Bundling rule: this module only depends on `env` (LLM/web config) and a
 * caller-supplied `askUser`. It does not import CLI-runtime bundles
 * (`store` / `session`) nor the session-server HTTP/session layer.
 */
import Anthropic from "@anthropic-ai/sdk";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  createRealAnthropicAdapter,
  buildThinkingParams,
  createExecutor,
  createLoopEngine,
  withTransportRetry,
  translateAnthropicTransportFault,
  type LoopEngineDeps,
  type ThinkingParams,
} from "./index.js";
import { createAciExecutor } from "./aci/index.js";
import {
  setActiveExtraSecrets,
  clearActiveExtraSecrets,
} from "./sandbox/env-isolation.js";
import { createPermissionPolicy } from "./permission/policy.js";
import { resolveProjectPermissionSource } from "./permission/project-settings.js";
import type { PermissionModeContext } from "./permission/modes.js";
import type { GraphModeContext } from "./graph/mode.js";
import { createGraphAssembly, type GraphAssembly } from "./graph/assembly.js";
import type { LiveGraphLedgerHost } from "./graph/ledger.js";
import type { LastReadLedgerHost } from "./aci/last-read-ledger.js";
import { createDefaultAciRegistry } from "./aci/tools/registry.js";
import type { AciRegistry } from "./aci/aci-registry.js";
import { runOverflowJudge } from "./aci/tool-overflow.js";
import { errorMessage } from "./errors.js";
import type { AciCatalog } from "./aci/types.js";
import { createLspNotifier } from "./lsp/notifier.js";
import { withLazyLspWarmup } from "./lsp/warmup.js";
import { DEFAULT_LSP_IDLE_TIMEOUT_MS } from "./lsp/client.js";
import type { LspCtx } from "./lsp/types.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import type { Registry, ToolCall } from "./tools/types.js";
import type { RegistryImpl } from "./tools/registry.js";
import type { ValidateFunction } from "ajv";
import { homedir } from "node:os";
import path from "node:path";
import type { AskUser, PostToolUseHook } from "./permission/types.js";
import {
  createSecretsGuardHook,
  type HookErrorEvent,
} from "./permission/index.js";
import {
  composePostHooks,
  composePreHooks,
  createPluginHooksFromCatalog,
  createSettingsHookContribution,
} from "./hooks/index.js";
import {
  loadIknowSettings,
  resolveWorktreeExclusive,
  resolveWorktreeOnMutate,
  type IknowSettings,
} from "../config/settings.js";
import { createEgressPolicyFactory } from "./sandbox/egress/assembly.js";
import {
  createWorktreeIsolationExecutor,
  createWorktreeOnMutateHolder,
  classifyCall,
  mainCheckoutOf,
  isTaskWorktreePath,
  type MutateClass,
  type WorktreeGateReader,
  type WorktreeIsolationHostOpts,
  type WorktreeOnMutateHolder,
} from "./isolation/worktree-gate.js";
import {
  wireModelFromRoute,
  type IknowEnv,
  type LlmEnv,
} from "../config/env.js";
import {
  createSecretRegistry,
  type SecretRegistry,
} from "./secret-roundtrip/index.js";
import { ValidationError } from "../shared/errors.js";
import {
  createIknowSystemResolver,
  initIknowWorkspaceSafe,
  createGitSnapshotProvider,
  runIndexDemotion,
  type McpServiceSummary,
  type McpToolSummary,
  type SkillSummary,
  type DeferredInternalToolSummary,
} from "./identity/index.js";
import {
  resolveProjectMemoryDir,
  createSystemResolver,
  createAutoMemoryHook,
  assembleStaticSystemPrompt,
  buildMemoryPrefetchOverlay,
  type AutoMemoryHook,
  type MemoryLiveFlags,
  type OverlayPrefetchFn,
  type PrefetchQueryOpts,
  type SystemResolver,
} from "./memory/index.js";
import { createAdapterExtractLlm } from "./auto-memory-wire.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import { createSkillScanner, type PluginSkillDir } from "./skill/scanner.js";
import { createSkillCatalog } from "./skill/catalog.js";
import type { SkillCatalog, SkillCatalogFaces } from "./skill/catalog.js";
import { createSkillRescanner, type SkillRescanner } from "./skill/rescan.js";
import {
  createSkillIndexDeltaSeam,
  type SkillIndexSnapshotEntryShape,
} from "./skill/index-delta.js";
import { resolvePluginCatalog, resolvePluginRoots } from "./plugin/roots.js";
import { loadMcpConfig } from "./mcp/config.js";
import { createMcpManager, type McpManager } from "./mcp/manager.js";
import { resolveMcpRoots, type McpRoots } from "./mcp/roots.js";
import {
  createLiveTaskRoot,
  resolveInstallRoot,
  resolveSessionRoots,
  withLiveTaskRootWrite,
  type LiveTaskRoot,
  type SessionRoots,
} from "./session-roots.js";
import {
  createSubAgentManager,
  type SubAgentManager,
  type SubagentActivityReader,
} from "./subagent/manager.js";
import { assessSubagentIsolation } from "./subagent/capability.js";
import type { SkillIndexSnapshotEntry } from "./subagent/envelope.js";
import { buildWorkerToolSurface } from "./subagent/role.js";
import {
  createDefaultSubAgentSpawn,
  resolveSubagentTraceDir,
} from "./subagent/spawn.js";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
  type BackgroundTaskManager,
} from "./background/manager.js";
import { resolveTasksDir } from "./background/paths.js";
import { reapStaleTasks } from "./background/stale-reap.js";

export type BuildEngineOpts = {
  readonly env: IknowEnv;
  readonly askUser: AskUser;
  /** Process working directory used as the soft sandbox root for fs tools. */
  readonly sandboxRoot?: string;
  /** Entry surface (default "chat"); BOOTSTRAP only activates for chat/tui. */
  readonly surface?: "chat" | "tui" | "ask" | "serve";
  /** Memory-layer switch (default true). The ask entry passes enabled:false to
   *  strip memory tools and the memory_layer prompt section. */
  readonly memory?: { readonly enabled: boolean };
  /** Optional session-level policy source. When provided, served sessions can
   *  accumulate "always-allow" rules via the web SPA so the user does not have
   *  to re-confirm the same tool each turn. Memory-only (no disk persistence);
   *  cleared when the server restarts. */
  readonly session?: import("./permission/types.js").SessionGrantsPolicySource;
  /** W2: permission mode context (default / plan / full_auto). REPL slash
   *  command flips this in place without rebuilding the engine. */
  readonly permissionMode?: PermissionModeContext;
  /** Session holder for the graph orchestration overlay (ADR-0030) — REPL
   *  `/graph` and Shift+Tab flip the same cell. Present = this entry wires the overlay:
   *  `run_graph` joins the registry and visibility/orchestration sections gate
   *  on `BuiltEngine.graphAssembly` per-round snapshots. Absent = not wired
   *  (ask / legacy callers) → tool and sections don't exist, byte-identical. */
  readonly graphMode?: GraphModeContext;
  /**
   * Live-graph ledger host — held per session runtime (parallel to graphMode,
   *
   // (ADR-0047)
   * not a per-engine snapshot); the host owns reset / teardown. Absent =
   * `run_graph` handler builds no ledger (no behavior change, same shape as
   * an absent graphMode).
   */
  readonly liveGraphLedger?: LiveGraphLedgerHost;
  /**
   * Optional seam for the last-read ledger host (`conversationId → canonical
   *
   // (ADR-0084)
   * path`). Default = each registry builds its own (in-process memory), write
   * gate still active. Injecting the same instance lets read-paths survive
   * registry rebuilds across rebinds; production currently does not inject,
   * so a root-rebuilt engine starts from an empty table (table lives and dies
   * with the registry).
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /** Test seam: userHome / cwd overrides (default homedir() / process.cwd()). */
  readonly userHome?: string;
  readonly cwd?: string;
  /**
   * ADR-0019: per-root state anchor — CLI `--workspace-root` / env
   * `IKNOW_WORKSPACE_ROOT`. After a rebind the host moves cwd into the task
   * worktree, so this acts as the state anchor (memory store) only when it is
   * not itself a task worktree; inside a tree it falls back to
   * `sessionRoots.productRoot` — redirection still works but state never lands
   * in the tree. Kept on the write/fence side: fs-policy paths and bwrap bind
   * roots (task worktrees live under `<productRoot>/.iknow/worktrees/…`, so
   * anchoring state at productRoot would fence off every in-tree write).
   * Not added to `LoopEngineDeps` (minimal-change discipline).
   * Default → `resolveWorkspaceRoot({ env: process.env })` (priority chain
   * explicit > env > cwd, enforced by the resolver as SSOT).
   */
  readonly workspaceRoot?: string;
  /**
   * worktree-mcp-rebind-lifecycle: stable main checkout root. `resolveMcpRoots`
   * derives `mcpConfigRoot` from it; unchanged across rebinds. Default → same
   * as `workspaceRoot` (hosts may pass `productRoot === workspaceRoot`
   * explicitly; this keeps the single-root call sites compiling).
   */
  readonly productRoot?: string;
  /**
   * Project identity root — the project the user is working on, stable across
   * rebinds. One pin for four consumers: discovery root for project
   * `AGENTS.md` / `.iknow/rules` / project skills, memory-store namespace name
   * (`<basename>-<sha1>`), read-only main-repo allowance for `read_file`, and
   * the identity root subagents inherit.
   *
   * Why not `productRoot`: it also serves `mcpConfigRoot` and the state anchor,
   * and hosts set it from `workspaceRoot` per ADR-0019; but under
   * `--workspace-root <dir>` redirection `<dir>` is not the project, so
   * deriving identity from it would silently drop the project's own
   * `AGENTS.md` / rules / skills (today those come from `cwd`).
   * Why not recompute per assembly: after a rebind `cwd` is the task worktree,
   * so recomputation can only fall back to the main checkout — and a startup
   * cwd inside the repo would jump the memory namespace from `app-<sha1>` to
   * `<repo>-<sha1>`. The host pins it once in startup opts (rebinds only
   * override `cwd` / `workspaceRoot`).
   * Default → `mainCheckoutOf(cwd)`: byte-equal to today's `cwd` without a
   * rebind; after a rebind it steps back to the main checkout, never the tree.
   */
  readonly projectIdentityRoot?: string;
  /**
   * Test seam: iknow's own install root (`<baseDir>`-style). Production
   * default → `resolveInstallRoot()` (anchored to `import.meta.url`,
   * independent of session roots / `process.cwd()`). Tests inject a tmp
   * fixture to assert worker bootstrap never asks the session roots.
   */
  readonly installRoot?: string;
  /** Test seam: MCP client factory override (stub injection for slow-connect assertions). */
  readonly createMcpClient?: (
    server: import("./mcp/config.js").McpServerConfig
  ) => import("./mcp/manager.js").McpClientHandle;
  /** Test seam: createMcpManager factory override (capture its args, e.g. timeoutMs passthrough). */
  readonly createMcpManager?: typeof import("./mcp/manager.js").createMcpManager;
  /**
   * ADR-0043: test seam overriding the assembly-time firstTurnReady window.
   * Default = 30_000ms, the production contract itself (see the constant at
   * the `mcpManager.start()` call site) — production callers omit this field,
   * byte-identical. Without the seam, testing "window elapsed" behavior would
   * bind one test's wall clock to the window length; a small injected value
   * runs the same path faster — semantics (timeout = absent, catalog freeze,
   * no flip-back rewrite) unchanged. Note: this shortens only the outer window
   * polling; per-server connect timeout stays `env.mcp.connectTimeoutMs`.
   * Window < connect timeout → "absent when window expires"; window > connect
   * timeout → server marks failed first and the window resolves early. Both
   * are real paths.
   */
  readonly mcpFirstTurnReadyTimeoutMs?: number;
  /**
   * ADR-0043: bypass switch for the assembly-time countTokens seam. When
   * `countTokens` is absent the assembly falls back to `adapter.countTokens`
   * — a real SDK call against an unreachable test baseUrl burns ~2.5s per
   * assembly in retry backoff just to reach the deterministic
   * "Connection error → skip this session" branch. Set true to start with
   * that skip semantics directly (overflow judgment and index demotion both
   * skip + warn once, deferrable built-ins stay resident). Use for assembly
   * tests that don't verify those two paths; tests that do must inject a
   * `countTokens` stub explicitly.
   */
  readonly skipCountTokens?: boolean;
  /** Test seam: subagent manager override (production builds its own when absent). */
  readonly subagentManager?: SubAgentManager;
  /**
   * ADR-0071: per-agent subagent trace directory =
   * `<parent session folder>/subagents/` (caller derives it via
   * `resolveSubagentTraceDir({ projectDir, conversationId })`).
   * Present → the manager lazily builds a file-mode JsonlTraceService per
   * spawn (`<subagentsDir>/agent-<taskId>.jsonl`, conversationId pinned to
   * taskId) + a one-shot `.meta.json`. Absent → NoopTrace (byte-stable
   * default). The old aggregated `subagentTrace` single instance is retired;
   * all callers pass `subagentsDir` now.
   */
  readonly subagentsDir?: string;
  /**
   * Assembly-time root seam, `<baseDir>/projects/<slug>` form (the serve hub
   * has no conversationId at assembly time; the engine is shared across
   * sessions and not rebuilt). Passed to `createSubAgentManager({ projectDir
   * })`, which derives the per-conversation leaf
   * `<projectDir>/<sanitize(convId)>/subagents/` at spawn time — same shape as
   * todo-write's `resolveConversationTodoPath`. Mutually exclusive with
   * `subagentsDir`: when both are given, `subagentsDir` wins (cli/TUI shape
   * byte-stable); production picks one per entry. Both absent → NoopTrace.
   */
  readonly projectDir?: string;
  /** Crash diagnostics / worker trace root for subagent lifecycle evidence. */
  readonly subagentDiagnosticsDir?: string;
  /**
   * Read-only activity projection reader for the subagent list: the name of
   * the tool each live worker is executing right now
   * (`SubagentInfo.inFlightTool`). The worker ledger is a store-layer artifact
   * and the harness may not import it, so the host that owns the codec
   * injects an opaque reader here and build-engine only threads it into
   * `createSubAgentManager({ readInFlightTool })`. Absent → the field never
   * appears on the list (byte-stable for every other caller).
   */
  readonly subagentActivityReader?: SubagentActivityReader;
  /** TUI tool-summary observation hook, passed to createAciExecutor (chat/serve omit → zero change). */
  readonly hooks?: PostToolUseHook;
  /** Test seam: settings object override (production default → loadIknowSettings({ cwd })).
   *  The secrets section drives secrets-guard assembly. */
  readonly settings?: IknowSettings;
  /** Test seam: secrets-guard construction/runtime error observation (silent when absent). */
  readonly onHookError?: (e: HookErrorEvent) => void;
  /**
   * ADR-0037: worktree isolation host seam (injected by the session-api hub).
   * The switch itself is read at startup (`resolveWorktreeOnMutate(settings)`):
   * the mutate gate wraps the executor only when the host provides the
   * provision seam *and* the switch is true; otherwise byte-identical
   * (default OFF). Provision creates the task worktree, rebinds the session
   * roots, and anchors passthrough per session (own task worktree → same-root
   * no-op; foreign worktree → typed `foreign_worktree` fail-closed). The gate
   * body lives in `harness/isolation/worktree-gate.ts`.
   */
  readonly worktreeIsolation?: WorktreeIsolationHostOpts;
  /**
   * Session project directory (`resolveProjectSessionDir(baseDir,
   * projectIdentityRoot)`), host-injected: all three entries (chat-session /
   * session-hub / TUI deps) derive the same root from the same
   * `(baseDir, projectIdentityRoot)` pair, and per-conversation file paths are
   * pinned at call time by resolveConversationTodoPath. Tests pass mkdtemp
   * paths. The ask surface omits it (oneshot stripping, same shape as memory /
   * subagent / skill orchestration). */
  readonly todoDir?: string;
  /**
   * Background-task registry root (`<poolRoot>/projects/<slug>/tasks/`),
   *
   // (ADR-0088)
   * host-injected seam — same discipline as `todoDir`: the host passes a
   * resolved absolute directory, build-engine never derives it. Fallback when
   * absent: `resolveTasksDir({ dataDir: <userHome>/.iknow,
   * projectIdentityRoot })` (the default pool root), keeping old callers
   * working — and it never falls back to workspaceRoot (per-root sharding is
   *
   // (ADR-0088)
   * exactly what this moved away from). All three entries derive the same
   * root from `(dataDir, projectIdentityRoot)`, so the registry and the
   * session folder hang under one `<slug>` without drift.
   */
  readonly tasksDir?: string;
  /**
   * Project memory-store root (`<poolRoot>/projects/<slug>/memory/`) — same
   *
   // (ADR-0099)
   * seam discipline as `tasksDir`. Fallback → `resolveProjectMemoryDir({
   * dataDir: <userHome>/.iknow, projectIdentityRoot })`. Never workspaceRoot.
   */
  readonly memoryDir?: string;
  /**
   * ADR-0043: overflow-governance countTokens seam (tests). Production
   * default = undefined → assembly takes `adapter.countTokens` (implemented
   * by `createRealAnthropicAdapter`, passing through the SDK
   * `client.messages.countTokens`). Tests stub it to return
   * `{ inputTokens: <n> }` and control threshold decisions without network.
   * Called once at assembly, after `await mcpManager.start()` (first-round
   * judgment, constant within a session); later rounds' `promptTools` do not
   * re-measure ("no recompute mid-session").
   */
  readonly countTokens?: (input: {
    readonly tools?: ReadonlyArray<unknown>;
    readonly system?: string;
  }) => Promise<{ readonly inputTokens: number }>;
  /**
   * ADR-0092: fs isolation-mode holder — passed through to the bash factory,
   * read once per call via `get()`. Production resolves the settings
   * `isolation.fsMode` once at assembly and stuffs it into the holder; early
   * entries only accept the injection seam. Absent → global mode (V1
   * baseline, bash.ts handler falls back at its entry).
   */
  readonly fsMode?: import("./sandbox/fs-mode.js").FsModeContext;
  /**
   * ADR-0119 / specs/yolo-mode.md: yolo no-sandbox holder — same shape as
   * `fsMode` (constructed once at assembly, held at runtime, each consumer
   * re-reads after a flip; the engine is not rebuilt). Passed through four
   * places: the main-chain registry (the bash factory reads per call), subagent
   * spawn (re-read each spawn → `IKNOW_YOLO` env wire), the ask-path registry,
   * and the worker-derived registry. Absent → non-yolo (fail-closed keeps the
   * fence, V1 baseline byte-for-byte unchanged).
   */
  readonly yolo?: import("./sandbox/yolo.js").YoloContext;
  /**
   * Runtime subagent concurrency-cap holder — when present,
   *
   // (ADR-0096)
   * `createSubAgentManager` passes it to the manager (replacing the
   * startup-only snapshot of `env.subagent.maxConcurrentWorkers`). Present =
   * TUI /config Enter loops call `holder.set(...)`, effective for the next
   * spawn gate; absent = static env/subagent value (byte-equal to prior
   * behavior). Same shape as `fsMode`: built once at assembly, held at
   * runtime, command and engine surfaces read the same frozen source.
   * Precedence: holder present → use holder exclusively (read per spawn);
   * env value is only the seed when the holder is absent; neither → default 15.
   */
  readonly subagentCapacityHolder?: import("./subagent/manager.js").SubagentCapacityHolder;
  /**
   * Runtime switch cell for `isolation.worktreeOnMutate`. Assembly seeds the
   *
   // (ADR-0096)
   * holder with the startup reading (`resolveWorktreeOnMutate(settings)`);
   * the TUI /config panel calls `set` at runtime — the mutate gate reads
   * `get()` at each wave entry, a flip takes effect on the next tool-call
   * wave (one read per wave, no re-read within). Absent → frozen startup
   * value (`createWorktreeOnMutateHolder(startup reading)`): gate shape is
   * byte-identical to today and the OFF setting has zero regression.
   *
   * Deliberate live consumers of the same holder: the mutate gate, worker
   * write-situation (`isolationOn` read at spawn), the git discipline prompt
   * section (re-read each system()), and spawn classification. Registry
   * membership (create-worktree present when the host seam exists) stays
   * assembly-time — tools stay registered; only policy follows the switch.
   *
   // (ADR-0096)
   */
  readonly worktreeOnMutateHolder?: WorktreeOnMutateHolder;
};

/**
 * Pure env → Anthropic adapter factory: no I/O, no assembly side effects. The
 * whole build-engine chain calls it internally (behavior unchanged); the hub's
 * `reloadFromEnv` also calls it for a minimal adapter hot-rebuild (without
 * rerunning buildHarnessEngine / MCP / subagent / skill).
 *
 * ADR-0094 (single thinking factory): per-turn thinking overrides merge in via
 * `overrides.thinking` — session-api's `withThinkingOverride` no longer builds
 * its own client field table, it only changes the thinking input here; the
 * same env yields the same client (baseUrl / apiKey / headers) and the same
 * wire model shape with or without the override.
 *
 * Returns `{ client, adapter }`: the client stays with the caller as a unified
 * close handle (SDK 0.115 has no close API; kept only for key/baseURL loading).
 */
export function createAdapterFromEnv(
  env: { readonly llm: LlmEnv },
  overrides?: { readonly thinking?: ThinkingParams }
): {
  readonly client: Anthropic;
  readonly adapter: LoopEngineDeps["adapter"];
} {
  const client = new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
    // provider.headers pass through as SDK `defaultHeaders`. Conditional
    // (ADR-0093)
    // spread, not `defaultHeaders: env.llm.headers` — when the field is absent
    // (no provider hit / provider without headers) the SDK options stay
    // byte-identical to today, no explicit-`undefined` key added; the env
    // layer already guarantees "value present ⇔ non-empty mapping".
    ...(env.llm.headers !== undefined
      ? { defaultHeaders: env.llm.headers }
      : {}),
  });
  const adapter = withTransportRetry(
    createRealAnthropicAdapter({
      client,
      model: wireModelFromRoute(env.llm.model),
      maxTokens: env.llm.maxOutputTokens,
      temperature: env.llm.temperature,
      // SSOT env→adapter params and stream arm. ADR-0094: overrides.thinking
      // present = per-turn override; absent = env value.
      thinking: overrides?.thinking ?? buildThinkingParams(env.llm),
      stream: env.llm.stream === "on",
    }),
    { translate: translateAnthropicTransportFault }
  );
  return { client, adapter };
}

/**
 * ADR-0037: engine-bundle SSOT — the minimal handle set a rebuilt engine must
 * hand back to its host. `BuiltEngine` is the full assembly view (`EngineBundle`
 * + assembly handles + session roots + snapshots); this type is the minimal
 * subset shared by host per-root rebuild seams (chat rebuildDeps / TUI
 * buildEngine / hub getOrBuildEngine).
 *
 * `deps` is required (loop-engine contract); the other handles exist only when
 * the assembly actually creates them (ask has no subagent / MCP / memory;
 * graphAssembly only when graphMode is present) — absent means the host never
 * calls them, zero behavior change.
 *
 * One shape for all three seams: after a worktree rebind the host rewires the
 * handles into ctx (split-brain fix). A shared shape keeps the three hosts
 * aligned on one line type instead of comparing inline literals.
 *
 * The hub path extends this with `mcpRoots?` / `mcpManager?` / `catalog?`
 * (per-root MCP face switching); TUI deps add `memoryFlags?` (TUI-only).
 */
export type EngineBundle = {
  readonly deps: LoopEngineDeps;
  /** Combined assembly shutdown (MCP first → subagentManager second); absent on the ask surface. */
  readonly shutdown?: () => Promise<void>;
  /** Subagent manager handle — post-rebind spawns land here; host drain consumes it too. */
  readonly subagentManager?: SubAgentManager;
  /** Graph assembly snapshot — `/graph` and Shift+Tab snapshots follow the active engine (present with graphMode). */
  readonly graphAssembly?: GraphAssembly;
  /** Auto-memory hook (present when the memory layer is on and not ask; still present when both switches are off — only the mechanical segment runs). */
  readonly autoMemory?: AutoMemoryHook;
  /** Auto-memory low-trust read: per-turn user-text overlay prefetch (present when autoExtract is on). */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
};

/**
 * Full return of `buildHarnessEngine` — superset of `EngineBundle`, adding
 * engine / skillCatalog / mcpManager / mcpRoots / sessionRoots / catalog /
 * memoryFlags. Host-assembly fields (engine / sessionRoots) keep their
 * original positions; the 6 `EngineBundle` fields keep original order.
 * `EngineBundle` is the naming SSOT — new builders should extend it rather
 * than this type.
 */
export type BuiltEngine = EngineBundle & {
  readonly engine: ReturnType<typeof createLoopEngine>;
  /**
   * Skill catalog (assembled for all surfaces; ask too — the skill tool is
   * present there). TUI deps derive slash candidates + load bodies from
   * available()/get(); chat/serve do not read it.
   */
  readonly skillCatalog?: SkillCatalog;
  /**
   * ADR-0098: skill rescan seam — the *same* holder as
   * `deps.skillIndexDelta` (built once at assembly, shared across sessions).
   * Exposed to the host's explicit reload face: swapping plugin skill roots
   * (`setPluginSkillDirs`) must land on the same instance for the next rescan
   * to see them. Absent when `surface === "ask"` (ask builds no delta seam).
   */
  readonly skillRescanner?: SkillRescanner;
  /**
   * MCP manager handle (absent on the ask surface). TUI deps build the /mcp
   * panel from status()/reload(); ask has zero mcp__* tools.
   */
  readonly mcpManager?: McpManager;
  /**
   * The two roots resolved by this assembly (`workspaceRoot` +
   * `mcpConfigRoot`). Not exposed on ask or when MCP assembly is absent.
   * Hub reload consumes this handle — hosts must not reinvent cwd/config
   * strategy.
   */
  readonly mcpRoots?: McpRoots;
  /**
   * ADR-0037: session three-roots SSOT for this assembly
   * (`productRoot` / `taskRoot` / `installRoot`). Exposed on every surface —
   * project identity, per-root state, and worker bootstrap consumers ask here
   * only, never re-joining `cwd/.iknow/...` or reading `process.cwd()`.
   */
  readonly sessionRoots: SessionRoots;
  /**
   * Full source of dynamic MCP tools (reg.catalog.all() includes mcp__* tools
   * appended via registerExternal; the inner frozen snapshot does not). TUI
   * deps flatten it to `{ server, tool }[]`; server-name resolution is in deps.ts.
   */
  readonly catalog?: AciCatalog;
  /**
   * Live taskRoot cell: exposed to host assembly for chat-session rebind / TUI
   * chrome consumers. Since ADR-0079, skill-body assembly (`loadSkillBody` /
   * ACI `skill()` / TUI slash) no longer reads this cell — the authoritative
   * write-situation disclosure path is worker prior + chat-session rebind
   * notification (shared `writeRootSegment` helper). Absent (legacy injected
   * deps shape) → those consumers degrade as before.
   */
  readonly liveTaskRoot?: LiveTaskRoot;
  /**
   * Worktree isolation mode. Chat-session rebind and the ACI registry use it
   * to compute `writeSituation(isolationOn, currentRoot)`. The value follows
   * the live worktree-on-mutate holder when the isolation host is present
   * (panel flip takes effect on the next read). Absent → consumers default
   * to `writable_main`.
   */
  readonly isolationOn?: boolean;
  /**
   * Live worktree-on-mutate holder singleton — the gate's `enabled`, the
   * bash UNBOUND_FENCE on main/ask registries, subagent spawn env, and host
   * verify assembly share the *same* instance. Exposed so the hub's verify
   * seam agrees with the gate on this axis. Absent (injected deps shape) →
   * consumers emit no segment.
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * Enter-worktree exclusive-lock mode, decided once at assembly
   *
   // (ADR-0070)
   * (`resolveWorktreeExclusive(settings)`; ADR-0037 keeps settings to a single
   * startup read — root rebind never reloads them).
   *
   * Pass-through seam: the session-api hub reads this when constructing the
   * `worktreeEnter` host closure; true → the closure runs the claim check
   * (typed `worktree_claimed` rejection), false → skipped entirely (identical
   * to today's behavior).
   *
   * No consumer inside build-engine uses this field (placeholder + pass-
   * through only); absent (injected deps shape) → consumers treat as OFF.
   *
   * Contrast with `isolationOn`: that requires the host to provide the
   * `worktreeIsolation` seam before it can be true (gate arming precondition);
   * this is a pure settings decision (independent of host seams), OFF default
   * = strictly today's enter path.
   */
  readonly worktreeExclusive?: boolean;
  /**
   * TUI live flags for /memory. Present when surface is `tui` and the memory
   * layer is on. The TUI mutates this box on Esc; the hook reads it per turn.
   */
  readonly memoryFlags?: MemoryLiveFlags;
  /**
   * memory-toggle-live: drop the memory_layer system snapshot so the next
   * turn reassembles it under the current live flags. Present only for the
   * TUI surface (the only host that can flip /memory mid-session); the
   * caller must tolerate a one-off prefix change (KV-cache break is the
   * accepted cost of an explicit user toggle).
   */
  readonly invalidateMemorySystem?: () => void;
};

/**
 * Build the harness engine deps + engine. `askUser` is required so the
 * permission middleware can prompt on `decision: "ask"` outcomes (#162).
 *
 * Throws when `env.llm.apiKey` is missing — the message contains the
 * `LLM mode needs` substring that CLI oneshot callers match on to emit the
 * `llm_mode_missing_api_key` envelope.
 */
export async function buildHarnessEngine(
  opts: BuildEngineOpts
): Promise<BuiltEngine> {
  const { env, askUser } = opts;
  if (!env.llm.apiKey) {
    // ValidationError keeps the HTTP layer's 400 mapping (http.ts sendError)
    // consistent for both CLI and serve; the message still carries the
    // `LLM mode needs` substring the CLI oneshot caller matches on.
    // Key source: settings.llm.apiKey (literal or ${VAR}).
    throw new ValidationError(LLM_API_KEY_MISSING_MESSAGE);
  }
  if (!askUser) {
    throw new Error(
      "ask_inlet_missing: buildHarnessEngine requires an AskUser implementation (chat/ask/serve must inject one)"
    );
  }
  // Adapter construction converges into the createAdapterFromEnv pure function
  // (shared by build-engine and hub.reloadFromEnv to prevent drift). The
  // apiKey guard stays before it (fail-fast text unchanged when missing).
  const { adapter } = createAdapterFromEnv(env);
  // ACI tool set (web_fetch/web_search extend it, aligned with ADR-0004);
  // sandbox root = opts.sandboxRoot ?? process.cwd().
  //
  // sandboxRoot assumptions:
  //   - CLI: `process.cwd()` is where the user runs `iknow chat` at the
  //     project root — fs tools' soft-sandbox escape beyond it throwing
  //     ToolExecutionError is reasonable.
  //   - serve: `process.cwd()` is the long-lived server launch directory, NOT
  //     the user's project root. serve callers must inject the root explicitly
  //     or the agent mistakes the server directory for its workspace. Current
  //     code uses the fallback; whether serve accepts --sandbox-root is a
  //     product decision parked with the web-tools manifest backlog.
  //
  // Soft-sandbox escape throws ToolExecutionError; bash cwd is not a security
  // boundary — the real boundary is allowlist-first + denylist + (eventually)
  // OS-level sandbox. Web tools are bounded by the network guard (hop-by-hop
  // SSRF check); category=read-only defaults to allow. Append-only: never
  // reorder the existing tools (policy byName keyspace stable per ADR-0006).
  const surface = opts.surface ?? "chat";
  // Memory switch (ask disables it explicitly); memoryDir = project-namespaced store root.
  const memoryEnabled = opts.memory?.enabled !== false;
  const memoryToolsEnabled = surface !== "ask" && memoryEnabled;
  // Test seam: userHome / cwd (defaults = real homedir() / process.cwd());
  // skill scanner and MCP config both read from here. Unit tests inject an
  // empty tmp home to avoid touching ~/.iknow.
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  // ADR-0019: per-root state anchor; priority chain
  // [opts.workspaceRoot (CLI explicit), env IKNOW_WORKSPACE_ROOT, cwd].
  // The resolver is pure (existsSync is its only IO) and fails fast with
  // typed `WorkspaceRootError` on an illegal CLI flag. Default = cwd.
  const workspaceRoot =
    opts.workspaceRoot ??
    resolveWorkspaceRoot({
      cwd,
      env: { [WORKSPACE_ROOT_ENV_KEY]: env.workspaceRoot },
    });
  // Non-ask surfaces resolve MCP roots once — one root set drives config /
  // manager cwd / ACI FS root / BuiltEngine.mcpRoots. An inconsistent explicit
  // sandboxRoot → root_mismatch (fail-closed, no spawn). ask skips the
  // resolver, keeping sandboxRoot = opts.sandboxRoot ?? cwd.
  // productRoot defaults through `mainCheckoutOf` rather than bare
  // workspaceRoot: after a rebind the host moves workspaceRoot onto the tree
  // too, and a bare fallback would let hosts that missed productRoot read
  // identity / write state inside a gitignored empty tree. Without a rebind
  // both are equal.
  let mcpRoots: McpRoots | undefined;
  let sandboxRoot: string;
  if (surface !== "ask") {
    mcpRoots = resolveMcpRoots({
      workspaceRoot,
      productRoot: opts.productRoot ?? mainCheckoutOf(workspaceRoot),
      ...(opts.sandboxRoot !== undefined
        ? { expectedWorkspaceRoot: opts.sandboxRoot }
        : {}),
    });
    sandboxRoot = mcpRoots.workspaceRoot;
  } else {
    sandboxRoot = opts.sandboxRoot ?? cwd;
  }
  // ADR-0037: session three-roots SSOT. On non-ask surfaces root validation
  // stays with `resolveMcpRoots` above (`McpLifecycleError` kind division
  // unchanged for callers); here validated values are assigned to roles and
  // `installRoot` is added. ask has no MCP resolver, so this resolution *is*
  // its checkpoint.
  //   productRoot → project identity + per-root state (stable across rebind)
  //   taskRoot    → writes and tool cwd (= sandboxRoot; the task worktree after rebind)
  //   installRoot → worker bootstrap (anchored to import.meta.url, never asks session roots)
  const sessionRoots = resolveSessionRoots({
    productRoot:
      mcpRoots?.mcpConfigRoot ??
      opts.productRoot ??
      mainCheckoutOf(workspaceRoot),
    taskRoot: sandboxRoot,
    installRoot: opts.installRoot ?? resolveInstallRoot(),
    // Values chosen at assembly (host-pinned first, else cwd); validation in
    // the SSOT — explicit empty/relative values fail closed as typed errors,
    // same as the other roots. `mainCheckoutOf` applies to *both* paths: the
    // identity root must not be a task worktree. Hosts pin the startup cwd,
    // and exited trees are kept on disk, so an operator can start
    // `iknow chat` inside a leftover tree — normalizing only the fallback
    // would make pinning worse than not pinning (a pinned empty tree hides
    // AGENTS.md / rules / skills, while unpinning can still reach the main
    // checkout).
    projectIdentityRoot: mainCheckoutOf(opts.projectIdentityRoot ?? cwd),
  });
  // Live `taskRoot` holder, initialized from `sessionRoots.taskRoot`. Writes
  // go through the build-engine wrapper around host seams
  // (`withLiveTaskRootWrite`); consumers arrive with later phases, so the
  // cell may sit dormant. Stable roots (productRoot / projectIdentityRoot /
  // installRoot / mcpConfigRoot / stateAnchor / memoryDir / todoDir /
  // traceDir) stay frozen — the cell only carries `taskRoot`.
  const liveTaskRoot: LiveTaskRoot = createLiveTaskRoot(sessionRoots.taskRoot);
  // Project identity root: shared by identity discovery (AGENTS.md / rules /
  // project skills / subagent inheritance) and the memory namespace — NOT
  // `productRoot`, which comes from `workspaceRoot` and under
  // `--workspace-root <dir>` redirection is not the project itself.
  const projectIdentityRoot = sessionRoots.projectIdentityRoot;
  // Project memory follows the session pool's project tree, no longer anchored to workspaceRoot.
  // (ADR-0099)
  const memoryDir = selectProjectMemoryDir(
    opts.memoryDir,
    userHome,
    projectIdentityRoot
  );
  // Tool-set SSOT factory (append-only order; env.web passes IKNOW_WEB_PROXY /
  // IKNOW_WEB_SEARCH_URL; invalid proxyUrl throws synchronously at assembly —
  // see registry.ts). The registry is built conditionally on memoryEnabled:
  // with memory, memoryDir is passed (10 built-ins incl. memory_recall +
  // memory_save); without (ask), omitted (8 built-ins). Registry / executor /
  // catalog agree by construction — no manual filtering.
  // Skill catalog assembly: scanSkillDirs reads three tiers
  // (~/.iknow/skills → <cwd>/.iknow/skills → IKNOW_SKILL_DIRS),
  // createSkillCatalog feeds the registry's skillCatalog opt → the skill tool
  // joins the registry on every surface, ask included. Degradation contract:
  // the scanner try/catches + warns per directory, scan errors are swallowed
  // with a warn, and assembly never blocks on them.
  // Settings seam (tests inject isolated settings; production default
  // loadIknowSettings). Loaded before LSP assembly so settings.lsp can feed
  // LspCtx (tool-layer timeouts / waits + client idle sweep + disabledServers
  // filter).
  const settings = opts.settings ?? loadIknowSettings({ cwd, home: userHome });
  // TUI live memory flags are computed right after settings load — the
  // memoryResolver construction point below needs them, and the auto-memory
  // hook section reuses the same values.
  const autoExtractOn = settings.memory?.autoExtract === true;
  const dreamOn = settings.memory?.dream === true;
  const memoryFlags: MemoryLiveFlags = {
    autoExtract: autoExtractOn,
    dream: dreamOn,
  };
  const tuiLive = surface === "tui" && memoryEnabled;
  // Worktree isolation mode resolved right after settings load — the
  // subagentManager construction below passes `isolationOn` to
  // createSubAgentManager, whose buildWorkerPayload combines it with the
  // resolved sandboxRoot to compute `writeSituation` for the envelope.
  // Single read point unchanged (worktreeIsolation host +
  // resolveWorktreeOnMutate); only the position moved earlier (pure O(1)).
  const isolationHost = opts.worktreeIsolation;
  const isolationEnabled =
    isolationHost !== undefined && resolveWorktreeOnMutate(settings);
  // Holder singleton hoisted: the gate's `enabled`, the bash registry's
  // UNBOUND_FENCE holder, the subagent spawn env snapshot, and the verify
  // consumer share one live holder (when absent, a frozen holder wrapping the
  // startup reading). If each consumer called `resolveWorktreeOnMutateSource`
  // separately, the holder-absent path would build independent cells — the
  // panel would flip one and the gate vs physical fence verdicts would split.
  const worktreeOnMutateSource = resolveWorktreeOnMutateSource(opts, settings);
  const isolationOnLive = (): boolean =>
    isolationHost !== undefined && worktreeOnMutateSource.get();
  // Enter-worktree exclusive-lock switch, resolved at assembly with the same
  // (ADR-0070)
  // fail-closed reading as `isolationEnabled` (missing / not true → false).
  // Read exactly here, once: root rebinds never reload settings, so the
  // frozen value lives as long as this engine. OFF → false → the session-api
  // `enterWorktree` closure skips the claim check entirely, keeping
  // enter-worktree byte-identical to today.
  // (ADR-0070)
  const worktreeExclusiveEnabled = resolveWorktreeExclusive(settings);
  // LSP invalidation seam: after edit_file commits, the assembly injects
  // lspNotifier.invalidate as the registry's onEdit callback (the notifier is
  // fire-and-forget with graceful degradation — see lsp/notifier.ts). SSOT:
  // LspCtx.directory must equal sandboxRoot (LS tools' NearestRoot ceiling and
  // the fs soft sandbox share root semantics), otherwise the same boundary
  // gets two values. The four settings.lsp fields are optional; absent values
  // fall back to tool/client defaults (requestTimeoutMs 20s /
  // diagnosticsWaitMs 2s / idleTimeoutMs 10min / disabledServers empty).
  // LSP subprocess lifecycle: language-server stdio pipes keep the host event
  // loop from draining, so processes never exit (e.g. after TUI /quit). The
  // pool is process-level shared (client.ts defaultPool, same cache warmup
  // spawns into — a per-engine pool would respawn on every assembly in
  // tests/multi-engine scenarios); termination is closed at host process-exit
  // seams via shutdownDefaultLspPool, not in this engine's shutdown — rebinds
  // call that mid-life.
  const lspCtx: LspCtx = {
    directory: sandboxRoot,
    // LSP `directory` follows the live taskRoot cell — the assembly-frozen
    // sandboxRoot is only the initial value; after a rebind `getClient` reads
    // `taskRoot` from the cell as the effective directory, so the NearestRoot
    // ceiling follows the live root. Gate unfliipped ⇒ cell initial =
    // sandboxRoot and `resolveDirectorySnapshot` falls back to the frozen
    // field, byte-identical to today.
    directoryCell: liveTaskRoot,
    ...(settings.lsp?.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: settings.lsp.requestTimeoutMs }
      : {}),
    ...(settings.lsp?.diagnosticsWaitMs !== undefined
      ? { diagnosticsWaitMs: settings.lsp.diagnosticsWaitMs }
      : {}),
    // Idle-sweep default 10min: injected when settings omit it; explicit 0
    // disables the sweep (negatives already dropped by the parser).
    ...(settings.lsp?.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: settings.lsp.idleTimeoutMs }
      : { idleTimeoutMs: DEFAULT_LSP_IDLE_TIMEOUT_MS }),
    ...(settings.lsp?.disabledServers !== undefined
      ? { disabledServers: settings.lsp.disabledServers }
      : {}),
  };
  const lspNotifier = createLspNotifier(lspCtx);
  // Plugin roots resolved once at assembly, reused within the engine instance
  // to avoid repeated IO per scan. "Resolve → scan → disabled filter" goes
  // through roots.ts's shared helper (same source as workers; the disabled-
  // filter branching stays in the helper). Consumers use
  // enabledInstallations — disabled plugins are skipped wholesale.
  // pluginAgentDirs self-resolves via createMergedCatalogResolver() (single
  // resolution source), no build-engine injection needed.
  const { catalog: pluginCatalog, enabled: enabledInstallations } =
    await resolvePluginCatalog({
      roots: resolvePluginRoots({
        ...(userHome !== undefined ? { userHome } : {}),
        settings,
      }),
      plugins: settings.plugins,
    });
  const pluginSkillDirs: PluginSkillDir[] = enabledInstallations.map((p) => ({
    dir: path.join(p.root, "skills"),
    plugin: p.name,
  }));
  const skillCatalog: SkillCatalogFaces = createSkillCatalog(
    await createSkillScanner({
      userHome,
      // Project skills are project identity → projectIdentityRoot (stable across rebind).
      projectIdentityRoot,
      env: process.env,
      // Empty array = no plugin skills (scanner default), no conditional spread needed.
      pluginSkillDirs,
    }).scan()
  );
  // ADR-0098: skill index-entry delta seam — the same assembly-time scan
  // result the frozen table above came from. `rescan()` re-scans with the
  // *current* root list; it never rewrites the frozen table (that belongs to
  // the `skillIndexList` holder, see the system section below). The session
  // anchor (conversationId) and the entry-history leaf root (projectDir) are
  // *call-time* parameters — serve engines are shared across sessions, so
  // assembly has no conversationId (same "assembly constant + call-time leaf"
  // shape as todoDir / agentStatus). Construction lifted to module level.
  const skillRescanner = createEngineSkillRescanner({
    surface,
    userHome,
    projectIdentityRoot,
    pluginSkillDirs,
  });
  // ADR-0098: one delta seam shared by the loop increment and the worker
  // snapshot — both "already-entered" views must be the same history (two
  // instances would drift, worker snapshot's entered-set vs loop's appended one).
  //
  // Declared before assignment: the manager construction below references the
  // seam, while its two inputs (`agentStatusTodoDir` / `skillIndexList`) are
  // finalized further down. The getter only reads at spawn time, so values
  // exist by then; `let` rather than `const` is exactly this ordering's cost
  // (same pattern as `skillIndexList`'s own `let`).
  let skillIndexSeam: ReturnType<typeof createSkillIndexDeltaSeam> | undefined;
  // Subagent manager assembled conditionally, same gate as MCP
  // (surface !== "ask"):
  //   - chat/tui/serve build createSubAgentManager({ spawn: defaultSubAgentSpawn });
  //     opts.subagentManager is the test override seam.
  //   - ask creates none (oneshot discards immediately; registry lacks
  //     spawn_subagent / subagent_result = the tool count is consistent across
  //     all three views).
  // The TUI product entry delegates to build-engine({surface:"tui"}) and
  // inherits subagentManager / shutdown — chat/tui/serve/ask share the SSOT,
  // tool surfaces never drift.
  // The default path no longer injects a coordinator section into deps.system;
  // onboarding guidance converges into the spawn_subagent tool description
  // (single source). The assembly seam remains: createIknowSystemResolver's
  // opts.coordinatorText still renders the section when given a non-empty
  // string explicitly (covered by seam tests).
  // Placed before registry assembly because the registry's subagentManager
  // opt consumes it there (same surface condition, parallel semantics).
  const subagentManager: SubAgentManager | undefined =
    surface !== "ask"
      ? (opts.subagentManager ??
        // sandboxRoot is the parent-root anchor for subagent narrowing
        // validation: def.sandboxRoot must lie under it (realpath guards
        // against symlink escape). Trace injection defaults to
        // NoopTraceService (byte-stable; tests override via
        // opts.subagentTrace / opts.subagentManager). Per-task wallclock:
        // env.subagent.taskTimeoutMs is consumed directly (settings/env merge
        // already done at the env layer); absent → manager falls back to its
        // 7200s constant. Concurrency cap passes via
        // env.subagent.maxConcurrentWorkers; absent → manager default 15.
        createSubAgentManager({
          spawn: createDefaultSubAgentSpawn({
            ...(opts.subagentDiagnosticsDir !== undefined
              ? { traceDir: opts.subagentDiagnosticsDir }
              : {}),
            workspaceRoot,
            // Worker subagents get the AGENTS.md and rules that exist in the
            // main checkout, not empty copies in the tree — the child's cwd
            // may be a bare tree, and identity discovery must not ask it.
            // The parent session's project identity root is passed.
            projectIdentityRoot,
            // Worker bootstrap (tsx loader) anchors to installRoot — when the
            // child cwd is a bare task worktree there is no node_modules
            // there, and cwd-relative resolution dies with
            // `Cannot find package 'tsx'`.
            installRoot: sessionRoots.installRoot,
            // Subagents inherit the parent session's rebound root: when the
            // engine is rebuilt at the task worktree (hub buildProductionEngine
            // / CLI rebuildDeps switch cwd/workspaceRoot to
            // `<repo>/.iknow/worktrees/<convId>`), the worker process starts
            // with that root as cwd; unbound (main repo root, not a task
            // worktree shape) → pass nothing and the child inherits the
            // parent's cwd, byte-identical to today. Worker registries never
            // carry the isolation seam → subagents never trigger a second
            // tree / second provision (pinned by worker-tool-surface tests).
            //
            // Difference from the plain `workspaceRoot` capture: sessionRoot
            // is a `() => liveTaskRoot.read()` getter, evaluated when the
            // spawn closure runs. After a rebind the first spawn lands on the
            // new taskRoot automatically and no new workers spawn under the
            // old root (matching the manager's sandboxRootCell form: def
            // validation under the old root rejects).
            ...(isTaskWorktreePath(workspaceRoot)
              ? { sessionRoot: () => liveTaskRoot.read() }
              : {}),
            // ADR-0092: the fs mode crosses the process boundary too — the
            // subagent's bash fence must match the parent session's mode, or
            // workspace-mode's "home rest not writable" is bypassed on the
            // subagent→bash arm. The holder object itself is passed (not a
            // `.get()` snapshot): the spawn factory reads it at every spawn,
            // so a runtime `/config fs workspace` flip affects the next
            // spawn. Same holder as the main-chain registry (`opts.fsMode`);
            // absent (tests / unwired entries) → child gets no such env key,
            // byte-stable. Direct assignment (no exactOptionalPropertyTypes):
            // the spawn-side test is `fsMode?.get() !== undefined`, so
            // `undefined` equals key-absent — one ternary saved.
            fsMode: opts.fsMode,
            // The gate switch is likewise read from the holder at spawn time
            // (IKNOW_WORKTREE_GATE_ON) — the worker bash fence's UNBOUND_FENCE
            // verdict must share its source with the parent session; passing
            // the holder singleton means a runtime panel flip affects the
            // next spawn.
            worktreeGate: worktreeOnMutateSource,
            // ADR-0119 / specs/yolo-mode.md: the yolo holder crosses the process
            // boundary too — a subagent's bash fence must match the parent
            // session (spec §6 four-route parity), otherwise children spawned in
            // a yolo session still run inside the fence. Same shape as fsMode:
            // the holder object itself is passed (not a `.get()` snapshot), and
            // the spawn factory reads it **on every spawn** — a runtime `/yolo`
            // flip affects the next spawn. Absent (tests / unwired entry) → the
            // `IKNOW_YOLO` key is not written, child env byte-unchanged (spawn.ts
            // checks holder.get() strictly equals true).
            yolo: opts.yolo,
          }),
          // The manager's parent-sandboxRoot ceiling follows the live root
          // too — same logic: the getter lets buildWorkerPayload read the
          // cell's current value at entry, so prefix-of-parent checks on defs
          // under the old root reject automatically.
          sandboxRootCell: () => liveTaskRoot.read(),
          sandboxRoot,
          // Pass the worktree isolation mode: manager.buildWorkerPayload
          // combines it with the resolved sandboxRoot to compute
          // `writeSituation` into the envelope; the worker prior renders the
          // write-root segment from it. Source = live holder (same cell as
          // the mutate gate); workers never re-decide.
          isolationOn: isolationOnLive,
          // opts.subagentsDir present → per-agent file-mode JsonlTraceService
          // inside the manager, replacing the old aggregated `subagentTrace`
          // single instance; absent → manager uses NoopTrace (same semantics
          // as before; test seam: when opts.subagentManager is injected the
          // caller controls it). opts.subagentDiagnosticsDir remains for the
          // subagent stderr pointer — it now defaults to following
          // subagentsDir (manager fallback), callers need not bind both.
          //
          // opts.projectDir seam passes through — the serve hub's assembly
          // no conversationId at assembly; the manager derives the
          // per-conversation leaf from def.conversationId in two steps at
          // spawn. Mutually exclusive with subagentsDir (when both are passed,
          // the manager prefers subagentsDir; cli/TUI byte-stable).
          ...(opts.subagentsDir !== undefined
            ? { subagentsDir: opts.subagentsDir }
            : {}),
          ...(opts.projectDir !== undefined
            ? { projectDir: opts.projectDir }
            : {}),
          // ADR-0085: parent-session ledger anchor — the manager drops
          // `{projectDir: opts.todoDir, conversationId: def.conversationId}`
          // into the worker envelope at spawn, so the worker's todo_write
          // attaches to the same todos.md as this loop's registry
          // (read/update; adds are typed-rejected for workers). Same gating
          // as subagentsDir/projectDir: absent → manager omits the field and
          // the worker tool surface keeps its old shape (byte-stable).
          ...(opts.todoDir !== undefined ? { todoDir: opts.todoDir } : {}),
          diagnosticsDir:
            opts.subagentDiagnosticsDir ??
            opts.subagentsDir ??
            resolveSubagentTraceDir(),
          taskTimeoutMs: env.subagent.taskTimeoutMs,
          maxConcurrentWorkers: env.subagent.maxConcurrentWorkers,
          // ADR-0096: capacity holder pass-through. When present → the
          // spawn gate reads holder.get() each time (command and engine
          // surfaces share the source), env value only seeds it when absent;
          // opts.maxConcurrentWorkers still passes for the legacy assemble
          // path (manager uses it fail-closed when the holder is absent).
          subagentCapacityHolder: opts.subagentCapacityHolder,
          // ADR-0098: the parent session's *current* model-index snapshot,
          // read fresh each spawn. def.conversationId is a call-time input:
          // entry history is a session-level leaf
          // (`<projectDir>/<sanitize(convId)>/skill-index.json`) while one
          // build-engine instance serves many sessions, so conversationId
          // cannot be pinned at assembly. The frozen-table half is
          // session-independent (identical for all sessions), carried by the
          // seam's ledger as `initialNames`; here only that session's
          // already-entered entries are merged. Seam absent (no todoDir /
          // rescanner, or ask) → getter absent → envelope omits the key →
          // worker runs its own rescan (old shape, byte-stable). The gate is
          // statically decidable here (todoDir/rescanner finalized at this
          // point; ask already excluded by the outer ternary); the seam
          // itself reads lazily (it is built after the frozen table).
          ...skillIndexSnapshotOption({
            todoDir: opts.todoDir,
            rescanner: skillRescanner,
            readSeam: () => skillIndexSeam,
          }),
          // Opaque pass-through: the ledger codec lives in the store layer,
          // which the harness may not import.
          readInFlightTool: opts.subagentActivityReader,
        }))
      : undefined;
  // bash background-task manager — conditional assembly (surface !== "ask"):
  //   - chat/tui/serve build createBackgroundTaskManager({ tasksDir: host-
  //     injected | pool-root default, spawn: defaultBackgroundSpawn }); the
  //     registry lands at `<poolRoot>/projects/<slug>/tasks/`.
  // (ADR-0088)
  //   - ask creates none (oneshot discards immediately; bash_output/bash_stop
  //     are also absent).
  // (ADR-0088)
  // The task registry follows the session pool's project tree rather than
  // workspaceRoot — multiple checkouts of one projectIdentityRoot share one
  // live ledger, and throwaway `--workspace-root` runs open no extra
  // registry. projectIdentityRoot equals the one in `sessionRoots` above
  // (session folder and task registry must land under the same slug).
  const tasksDir = selectBackgroundTasksDir(
    opts.tasksDir,
    userHome,
    projectIdentityRoot
  );
  // The old `stateAnchor` is no longer the anchor for tasks / memory (the
  // per-root sharding was dismantled).
  // (ADR-0088 ADR-0099)
  const backgroundManager: BackgroundTaskManager | undefined =
    surface !== "ask"
      ? createBackgroundTaskManager({
          tasksDir,
          spawn: defaultBackgroundSpawn,
        })
      : undefined;
  // Startup stale sweep, all surfaces (ask included): reap background task
  // (ADR-0021)
  // process groups whose owner_pid died (residual json marked dead + reap
  // marker appended to log). Only owner-dead records; starttime mismatch /
  // missing starttime skip conservatively. Never throws — sweep failures warn
  // and startup never blocks on them.
  if (typeof process !== "undefined") {
    try {
      const summary = await reapStaleTasks({
        tasksDir,
      });
      if (summary.reaped.length > 0) {
        console.warn(
          `[build-engine] reaped ${summary.reaped.length} stale background task(s): ${summary.reaped.join(", ")}`
        );
      }
    } catch (err) {
      console.warn(
        `[build-engine] background stale reap skipped: ${errorMessage(err)}`
      );
    }
  }
  // Worktree isolation host seam + switch verdict are lifted above registry
  // assembly. A later amendment revoked "tool present ⇔ gate armed": the tool
  // surface depends only on the host seam's presence (see the registry
  // pass-through below), while `isolationEnabled` only arms the mutate gate —
  // with the switch OFF the model can still create/enter for explicit
  // rebinds, just without a gate intercepting writes. Settings are read once
  // at the startup load point. `isolationHost` / `isolationEnabled` already
  // moved up right after settings load (see above) because the subagentManager
  // construction needs isolationOn.
  // Single-writer seam wrap: host `provision` / `enter` / `exit` are wrapped
  // with `withLiveTaskRootWrite` so successful resolutions update the live
  // `taskRoot` cell. Failed seams (typed errors) leave the cell unchanged and
  // propagate verbatim — no write, no rollback. The wrap is a pure
  // pass-through for the resolved value (registry / gate behavior
  // byte-identical).
  const wrappedProvision = isolationHost
    ? withLiveTaskRootWrite(isolationHost.provision, liveTaskRoot)
    : undefined;
  const wrappedEnter = isolationHost?.worktreeEnter
    ? withLiveTaskRootWrite(
        isolationHost.worktreeEnter,
        liveTaskRoot,
        // The enter seam resolves to `{ path, receipt }` — the cell keeps
        // receiving the root; the receipt flows verbatim to the
        // enter-worktree tool.
        (resolved) => resolved.path
      )
    : undefined;
  const wrappedExit = isolationHost?.worktreeExit
    ? withLiveTaskRootWrite(isolationHost.worktreeExit, liveTaskRoot)
    : undefined;
  // Secret handling mode driven by settings.secrets.mode. Default =
  // "roundtrip" (recognize + placeholder substitution + bash restoration +
  // output mask); "block" = the legacy deny-only preToolUse guard, with the
  // roundtrip mechanism fully off. Invalid values were dropped by
  // settings.parseSecrets → only "roundtrip" | "block" | undefined reach here.
  const secretsMode: "roundtrip" | "block" =
    settings.secrets?.mode ?? "roundtrip";
  // Per-engine secret registry — constructed only in roundtrip mode,
  // compiling DEFAULT + extras into a frozen registry.patterns. Block mode
  // builds none: loop-engine skips recognition when secretRegistry is absent
  // and secretsMode="block", bash tools get no registry, and output masking
  // does not cover registry values.
  let secretRegistry: SecretRegistry | undefined;
  if (secretsMode !== "block") {
    secretRegistry = createSecretRegistry({
      patterns: settings.secrets?.patterns,
    });
  }
  // Output-mask backstop: in roundtrip mode write the registry-tracked secret
  // values into the active extras slot (jsonl / format / stream-draft / hub
  // call `currentSecretValues()` with no arguments, so this covers them).
  // Block mode must clear the slot so a previous roundtrip engine's extras
  // can't leak into a block engine within the same process.
  if (secretsMode !== "block") {
    setActiveExtraSecrets(secretRegistry!.values());
  } else {
    clearActiveExtraSecrets();
  }
  // MCP resources conditional assembly: the registry must see mcpManager,
  // but createMcpManager needs `reg.registerExternal` (the dynamic mcp__*
  // injection seam). Mutual dependency → broken with closure holders:
  //   1. declare the two holders as let
  //   2. mcpManager captures reg via `(defs) => reg!.registerExternal(defs)`
  //      (the call happens in mcpManager.start()'s async phase, by which
  //      time reg is constructed)
  //   3. then construct reg with the defined mcpManager (list/read tool
  //      closures capture the holder the same way; handlers see mcpManager
  //      at call time)
  let reg: AciRegistry | undefined;
  let mcpManager: McpManager | undefined;
  /**
   * ADR-0043: manual-reconnect pending event holder (consumed by
   * loop-engine's `deps.mcpReconnect.takePending`). manager.onManualReconnect
   * pushes; loop-engine takes + clears at step boundaries (one-shot).
   * ask surface (no manager) stays undefined → seam absent, zero appends.
   */
  let mcpReconnectPending:
    { events: Array<{ server: string; tools: string[] }> } | undefined;
  /**
   * ADR-0043: MCP name-directory session-level snapshot holder. Frozen once
   * after the firstTurnReady window resolves (chat/tui/serve); deps.system's
   * mcp seam reads only this snapshot (constant within a session). ask
   * surface (no manager) stays undefined → seam absent, section absent.
   */
  let mcpNameDirectorySnapshot: ReadonlyArray<McpServiceSummary> | undefined;
  // With the graph overlay wired, this is the single assembly-time snapshot:
  // (ADR-0030)
  // registry (tool presence), promptTools (visibility), and deps.system
  // (orchestration section) all read it rather than separate holders. ask has
  // no graphAssembly (graphMode assembly triggers only in chat/tui/serve).
  const graphAssembly: GraphAssembly | undefined = opts.graphMode
    ? createGraphAssembly(opts.graphMode)
    : undefined;
  // Ordering is critical (ADR-0043): `reg` must be constructed before
  // `await mcpManager.start()` inside the `if (surface !== "ask")` block —
  // mcpManager's registerExternal closure needs reg in place, otherwise the
  // bootSlot throws on `reg === undefined` along
  // listTools → registerTools → registerExternal and marks the slot failed
  // (no flip-back; the guard only lets through late successes of timedOut
  // slots). The old order (reg after await start) was broken when
  // firstTurnReady introduced a blocking wait — reg must be lifted explicitly
  // above every path that can trigger registerExternal.
  //
  // Note: the reg here is temporarily assembled with mcpManager ===
  // undefined. Once the real mcpManager finishes constructing inside the if
  // block, the "rebuild reg with mcpManager" step at its end reconstructs it
  // (the registry fixes its tool set to the mcpManager at construction time,
  // no cell pass-through), filling in conditional tools like
  // list_mcp_resources / read_mcp_resource. Two constructions = the only
  // stable scheme for mcpManager assembly; after the rebuild the reg instance
  // is replaced by its final value, and external consumers always see the
  // final reg that includes mcpManager.
  if (surface !== "ask") {
    // Config / manager consume only the mcpRoots resolved once above — no re-reading cwd.
    const config = await loadMcpConfig({
      home: userHome,
      mcpConfigRoot: mcpRoots!.mcpConfigRoot,
    });
    mcpManager = (opts.createMcpManager ?? createMcpManager)({
      config: config.servers,
      workspaceRoot: mcpRoots!.workspaceRoot,
      // Closure captures the reg holder — by the time mcpManager.start() fires asynchronously reg is assigned.
      registerExternal: (defs) => {
        if (!reg) {
          throw new Error(
            "[build-engine] reg not constructed when mcpManager tried to register"
          );
        }
        return reg.registerExternal(defs);
      },
      // reload seam: manager.reload withdraws the server's previously
      // registered mcp__* tools by name before rebuilding — without the
      // injection, stale names linger in externalByExt after reload and the
      // re-registration collides on duplicates, silently failing the new
      // server's tools (same assembly in TUI deps).
      unregisterExternal: (names) => {
        if (!reg) return;
        reg.unregisterExternal(names);
      },
      // env-injected connect timeout (default 60_000, mitigating npx -y cold starts).
      timeoutMsOverride: env.mcp.connectTimeoutMs,
      ...(opts.createMcpClient ? { createClient: opts.createMcpClient } : {}),
    });
    // ADR-0043: manual-reconnect event holder — the manager's
    // onManualReconnect callback fires on the TUI / CLI reconnect success
    // path and pushes events here; loop-engine takes + clears them at the
    // next step boundary, appending a user message (transcript). The reload
    // path (host-decided after manager reload completes) does not currently
    // trigger this holder on its own — the reconnect UI calls
    // manualReconnectListeners explicitly once reload succeeds.
    mcpReconnectPending = {
      events: [],
    };
    mcpManager.onManualReconnect((serverName, toolNames) => {
      mcpReconnectPending!.events.push({
        server: serverName,
        tools: [...toolNames],
      });
    });
    // First reg construction (placeholder; rebuilt once the real mcpManager is in place)
    reg = createDefaultAciRegistry({
      env,
      sandboxRoot,
      // Egress allow-set data plane: full set = code-carried preset ∪
      // (ADR-0097 ADR-0104)
      // settings.isolation.network user additions, funneled through
      // createEgressPolicyFactory; no config section → preset-only and the
      // factory always returns a policy (the egress session must start,
      // --unshare-net always present). askApproval transcribes the existing
      // AskUser into `(host) => Promise<boolean>`: interactive entries ask
      // once on first sight of a new domain; worker / hub-less entries never
      // build this and stay fail-closed.
      egressPolicyFactory: createEgressPolicyFactory({
        settings,
        commandLabel: "bash",
      }),
      askApproval: (host) =>
        askUser({
          tool: "egress-domain-approval",
          input: { host },
          summaryHint: `允许沙箱内访问域 ${host}?`,
        }),
      // Pass the live taskRoot cell to the write_file / edit_file factories.
      // Gate unfliipped ⇒ cell initial = sandboxRoot, byte-identical to
      // today; handlers read a snapshot via cell.read(). Stable roots don't
      // take this seam — factories keep their own stable roots via opts.
      liveTaskRoot,
      // ADR-0092: fs isolation holder + homeRoot passed to the bash factory.
      // Holder absent → global mode (V1 baseline); homeRoot takes this
      // layer's resolved `userHome` (opts.userHome test seam ?? homedir()) —
      // not left for the bash factory to call `homedir()` again, otherwise
      // the userHome seam would change settings / persona / state but not
      // the workspace-mode fence's home ro-bind source.
      fsMode: opts.fsMode,
      // ADR-0119 / specs/yolo-mode.md: the yolo holder is threaded to the bash
      // factory on the same path (read per call, the same holder as fsMode).
      yolo: opts.yolo,
      homeRoot: userHome,
      // UNBOUND_FENCE holder for the bash factory (the singleton, see above).
      worktreeOnMutate: worktreeOnMutateSource,
      // Read-only pass for the main checkout holding project identity files
      // (ADR-0037 allows read-only main-repo access). The registry forwards
      // it to read_file / grep / glob and into the bash factory as a closed-
      // world read whitelist member (the bash assembly wires it to fs-policy;
      // the fence mounts it --ro-bind, so the main repo can't be written);
      // write / edit never gain this root. In ON mode the stable identity
      // root is handed to these factories even when the initial root is
      // already the main repo; they re-evaluate the task-worktree shape
      // against the live taskRoot per handler call, so the next wave of the
      // same run also sees a rebind — while OFF passes no such root.
      ...(isolationEnabled ? { projectIdentityRoot } : {}),
      // graphAssembly carries only the handler isEnabled gate and the
      // loop-engine switch verdict (with resident registration the registry
      // no longer filters the tool surface by it). Overlay absent → not
      // passed, handler stays permanently disabled.
      ...(graphAssembly ? { graphAssembly } : {}),
      // Live-graph ledger host pass-through — the handler resolves the
      // session ledger by ctx.conversationId. Absent → zero tool behavior change.
      ...(opts.liveGraphLedger
        ? { liveGraphLedger: opts.liveGraphLedger }
        : {}),
      // Last-read ledger shared across rebind-rebuilt registries (read memory
      // (ADR-0084)
      // survives root switches); unwired hosts (ask / direct tests) → the
      // registry builds its own and the gate works as usual.
      ...lastReadLedgerOption(opts),
      ...(memoryToolsEnabled ? { memoryDir } : undefined),
      skillCatalog,
      ...(subagentManager ? { subagentManager } : undefined),
      // Capacity holder → registry → tool factory (when
      // (ADR-0096)
      // `createSpawnSubAgentTool` is present, the holder feeds its description
      // getter — description and manager gate share a source, so a TUI
      // /config flip shows up immediately in tool descriptions the model
      // fetches). Same shape as subagentManager: absent → factories fall back
      // to manager.getCapacity(), matching existing assembly behavior.
      subagentCapacityHolder: opts.subagentCapacityHolder,
      // Background-task manager pass-through (same conditional gate) — the
      // bash tool's `background: true` branch becomes usable (returns
      // task_id immediately, not holding the tier timer).
      ...(backgroundManager ? { backgroundManager } : {}),
      // mcpManager conditional assembly: already in place at first
      // construction (see the createMcpManager call above), so the real
      // manager is passed and list_mcp_resources / read_mcp_resource exist.
      ...(mcpManager ? { mcpManager } : {}),
      onEdit: (file) => lspNotifier.invalidate(file),
      lspCtx,
      // Secret registry pass-through → the bash handler restores placeholders
      // before spawn. Constructed above; the registry factory dereferences
      // opts.secretRegistry lazily at handler call, no circular dependency.
      ...(secretRegistry ? { secretRegistry } : {}),
      // Host-injected todoDir reaches the registry (the todo_write
      // conditional-assembly switch). The ask branch omits it at the call
      // site → the tool never enters the registry (same shape as
      // memoryEnabled / subagentManager / skillCatalog). The worker assembly
      // path (createWorkerDeps → createDefaultAciRegistry) passes the same
      // todoDir when the parent session forwards `todoLedger` through the
      // envelope (ADR-0085: shared parent ledger, `add` typed-rejected in
      // the tool handler). NOTE: this gate expression and the one at
      // agentStatusTodoDir below are the same semantics inlined twice —
      // change one, sync the other.
      ...(opts.todoDir ? { todoDir: opts.todoDir } : {}),
      // ADR-0019 (T4 / review-fix H3): per-root state anchor threaded into
      // bash + read_file factories so the fs-policy fence protects
      // `<workspaceRoot>/.iknow` at parity with `<home>/.iknow`. Always
      // resolved (opts.workspaceRoot wins; env SSOT `IKNOW_WORKSPACE_ROOT`
      // is read from `env.workspaceRoot`, not raw `process.env`, so
      // `.env` / `.env.local` overrides ride the same surface). Spread-guard
      // keeps the legacy callers (no opts.workspaceRoot, no env var) on their
      // `sandboxRoot` fallback inside registry.ts.
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      ...(opts.subagentDiagnosticsDir
        ? { traceDir: opts.subagentDiagnosticsDir }
        : {}),
      // ADR-0037 amendment: worktree ACI tools' presence keys only on the
      // host seam being present, decoupled from the mutate-gate verdict
      // (isolationEnabled) — with the switch OFF the model can still
      // create/enter for an explicit rebind, just without a gate blocking
      // writes. Per-seam conditional spreads stay as they are, so
      // provision-only entries (TUI/CLI) still register just create-worktree.
      // Worker / hub-less entries pass no host seam → tools absent from the
      // registry (mirror filtering).
      ...(isolationHost
        ? {
            worktreeProvision: wrappedProvision!,
            // Pass the enter seam when present; absent (TUI wires provision
            // only) → enter-worktree not registered.
            ...(wrappedEnter ? { worktreeEnter: wrappedEnter } : {}),
            // Pass the exit seam when present; absent → exit-worktree not registered.
            ...(wrappedExit ? { worktreeExit: wrappedExit } : {}),
            // task-worktree-lifecycle: discovery and explicit removal are
            // host-only seams; they do not change the live root themselves.
            ...(isolationHost.worktreeList
              ? { worktreeList: isolationHost.worktreeList }
              : {}),
            ...(isolationHost.worktreeRemove
              ? { worktreeRemove: isolationHost.worktreeRemove }
              : {}),
          }
        : {}),
    });
    // ADR-0043: assembly awaits `manager.start({firstTurnReadyTimeoutMs})`.
    // Servers connected within the window join first-turn assembly; the rest
    // are absent for the session (no auto retry), stepping back to manual
    // reconnect (`onManualReconnect`). Window length comes from the
    // module-level production constant, overridable only via the
    // `opts.mcpFirstTurnReadyTimeoutMs` test seam — same polling path, length
    // only. Ordering critical: `reg` must exist before
    // `await mcpManager.start()` or the registerExternal closure throws on
    // the undefined registry and marks the boot slot failed.
    try {
      await mcpManager.start({
        firstTurnReadyTimeoutMs: resolveFirstTurnReadyTimeoutMs(
          opts.mcpFirstTurnReadyTimeoutMs
        ),
      });
    } catch (err) {
      // The internal void allSettled never rejects; this catch is a backstop
      // for a future timeout closeout, currently warn-only. Assembly emits
      // the first turn as usual, absent servers treated as session-absent.
      console.warn(
        `[build-engine] MCP manager start window error: ${errorMessage(err)}`
      );
    }
    // ADR-0043: the name directory is frozen at the first turn and constant
    // within the session — after the firstTurnReady window resolves,
    // connected services + tool names freeze into a session-level snapshot
    // that deps.system's mcp seam reads. A late connection of a window-
    // absent server (flip-back) no longer leaks into the directory;
    // otherwise adjacent rounds' system bytes would drift and break the
    // constancy assertion (observed: a late connection once introduced a new
    // server mid-session). Successful manual reconnects update the
    // directory via onManualReconnect → a notification appended to messages
    // (never a directory rewrite).
    mcpNameDirectorySnapshot = mcpManager
      .status()
      .map((server) => {
        const prefix = `mcp__${server.name}__`;
        const tools: McpToolSummary[] = [];
        for (const def of reg!.catalog.all()) {
          if (!def.name.startsWith(prefix)) continue;
          // Absent/empty description → the tool row carries none (a
          // contract-allowed state, see the mcpNameDirectorySegment
          // comment). toAciToolDef already maps tool.description ?? "" into
          // ToolDef.description, so an empty string here means "no description".
          tools.push({
            name: def.name,
            ...(def.description.length > 0
              ? { description: def.description }
              : {}),
          });
        }
        return {
          name: server.name,
          state: server.state,
          tools,
        } satisfies McpServiceSummary;
      })
      .filter((s) => s.state === "connected");
  } else {
    // ask path: no mcpManager, reg built once, no manager tools, no start.
    reg = createDefaultAciRegistry({
      env,
      sandboxRoot,
      liveTaskRoot,
      // ADR-0092 (ask path): fs isolation holder + homeRoot to the bash
      // factory. Holder absent → global mode (V1 baseline); homeRoot takes
      // this layer's `userHome` as in the main construction path.
      fsMode: opts.fsMode,
      // ADR-0119 / specs/yolo-mode.md (ask path): the yolo holder is threaded
      // to the bash factory on the same path — a non-TUI entry never carries
      // `--yolo` (typed rejection at parse time), so in production this is
      // always undefined; kept here to mirror the main chain and not drop the
      // assembly-surface field.
      yolo: opts.yolo,
      homeRoot: userHome,
      // UNBOUND_FENCE holder (ask path, same singleton as the main build).
      worktreeOnMutate: worktreeOnMutateSource,
      ...(isolationEnabled ? { projectIdentityRoot } : {}),
      ...(graphAssembly ? { graphAssembly } : {}),
      ...(opts.liveGraphLedger
        ? { liveGraphLedger: opts.liveGraphLedger }
        : {}),
      // Same as the first construction — shared last-read ledger (the ask
      // (ADR-0084)
      // path has no conversationId, so the gate degrades to "deny every
      // non-empty overwrite", consistent with fail-closed; read / bash still
      // run, they just aren't recorded).
      ...lastReadLedgerOption(opts),
      ...(memoryToolsEnabled ? { memoryDir } : undefined),
      skillCatalog,
      ...(subagentManager ? { subagentManager } : undefined),
      ...(backgroundManager ? { backgroundManager } : {}),
      // No mcpManager, nothing passed → list_mcp_resources / read_mcp_resource absent.
      onEdit: (file) => lspNotifier.invalidate(file),
      lspCtx,
      ...(secretRegistry ? { secretRegistry } : {}),
      // The ask path (this branch) passes no todoDir → todo_write is not
      // assembled (same gate as the first construction's todoDir passthrough;
      // the surface !== "ask" condition backstops once more here).
      ...(surface !== "ask" && opts.todoDir ? { todoDir: opts.todoDir } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      ...(opts.subagentDiagnosticsDir
        ? { traceDir: opts.subagentDiagnosticsDir }
        : {}),
      // Same as the main construction path: tool present ⇔ host seam
      // present (ADR-0037).
      ...(isolationHost
        ? {
            worktreeProvision: wrappedProvision!,
            ...(wrappedEnter ? { worktreeEnter: wrappedEnter } : {}),
            ...(wrappedExit ? { worktreeExit: wrappedExit } : {}),
            ...(isolationHost.worktreeList
              ? { worktreeList: isolationHost.worktreeList }
              : {}),
            ...(isolationHost.worktreeRemove
              ? { worktreeRemove: isolationHost.worktreeRemove }
              : {}),
          }
        : {}),
    });
  }

  // ADR-0043: overflow governance is judged once at assembly (first round),
  // frozen for the session. The judgment point is after `mcpManager.start()`
  // (or right after reg construction on the ask path): MCP schemas count in
  // the measured total but MCP entries are already lazy — only the 5
  // deferrable built-ins participate in retiring. `runOverflowJudge` (pure
  // logic in aci/tool-overflow.ts) owns the pool / count / retire ladder;
  // this file owns the wiring. countTokens priority: explicit opts > real
  // adapter call; both absent → skip the session. System text is a
  // simplified static snapshot (`assembleStaticSystemPrompt` + an identity
  // stub): the judgment measures the tool-surface area (95%+ of tokens), not
  // system-text nuances, so the full resolver chain is not re-assembled.
  const overflowSystemText = await assembleStaticSystemPrompt({
    projectIdentityRoot,
    userHome,
    workspaceRoot,
  });
  const overflowInput = {
    system:
      "## Identity\n" +
      // A stub of the identity constants (no import chain needed; quantity
      // is small and irrelevant to the threshold).
      "iknow harness identity.\n\n" +
      overflowSystemText,
  };
  const countTokensFn = selectCountTokensFn(adapter, opts);
  // First-round judgment, runs once (constant within the session).
  // Failure/absent = skip + warn (all deferrable built-ins stay resident);
  // over threshold = retire per the ordered list, stamp lazy:true.
  let deferredRetireNames: ReadonlyArray<string> = [];
  if (countTokensFn !== undefined) {
    // Must re-measure after each retire, so it re-reads the visible set.
    const sampleTools = (): ReadonlyArray<unknown> => reg.visibleSchemas();
    try {
      const result = await runOverflowJudge({
        tools: reg.catalog.all(),
        // Threshold = contextWindow * 0.1 (env.compress.contextWindow SSOT).
        threshold: env.compress.contextWindow * 0.1,
        countTokens: async () => {
          const v = await countTokensFn({
            tools: sampleTools(),
            system: overflowInput.system,
          });
          return v.inputTokens;
        },
      });
      if (result.reason === "retired") {
        deferredRetireNames = result.retire;
        reg.retireBuiltin([...result.retire]);
      } else if (result.reason === "countTokens_failed") {
        // Failure/absent → skip this session; all deferrable built-ins stay
        // resident; one warn, no throw, no retry.
        console.warn(
          `[build-engine] overflow judge skipped: countTokens failed: ${errorMessage(
            result.cause
          )}`
        );
      }
      // reason === "no_overflow" → zero action (all stay resident)
    } catch (err) {
      // runOverflowJudge never throws (SDK errors fold into the
      // countTokens_failed branch); this catch is defensive — assembly must
      // never block.
      console.warn(
        `[build-engine] overflow judge unexpected error: ${errorMessage(err)}`
      );
    }
  }
  // Session-constant retirement list (holder; the system resolver closure
  // reads it every round). Carries each tool's description at retire time
  // (SSOT = registry; `retireBuiltin` only flips `aci.lazy`); a name missing
  // from the catalog renders as a bare-name row.
  const deferredInternalToolsList: ReadonlyArray<DeferredInternalToolSummary> =
    deferredRetireNames.map((name) => {
      const def = reg.catalog.get(name);
      return def?.description
        ? { name, description: def.description }
        : { name };
    });

  // ADR-0046: index demotion — when the MCP directory + `<available_skills>`
  // together exceed 10% of the endpoint window, strip descriptions from the
  // largest entries down, keeping names only. Timing = the same
  // assembly-time first-round judgment as built-in schema retirement (retire
  // first, then look at the index), no mid-session recompute: the verdict
  // lands in holders that `deps.system` reads, so adjacent rounds' system
  // stays deep-equal. Deliberately not merged into `runOverflowJudge`'s
  // countTokens call: the ladder measures the whole first-request surface
  // while this gate measures the two index sections — one measurement can't
  // yield both, and merging would silently change the gate.
  // `<deferred_internal_tools>` is not an input here (retired built-ins keep
  // their rendering path). Failure (throw / non-finite) or an absent
  // countTokens → skip this session + one warn; both sections keep their
  // descriptions (same skip contract as the retirement pass).
  let skillIndexList: ReadonlyArray<SkillSummary> = skillCatalog
    .available()
    .map((entry) => ({
      name: entry.name,
      description: entry.description ?? "",
      ...(entry.disabled ? { disabled: true } : {}),
    }));
  if (countTokensFn !== undefined) {
    try {
      const demotion = await runIndexDemotion({
        mcp: mcpNameDirectorySnapshot ?? [],
        skills: skillIndexList,
        threshold: env.compress.contextWindow * 0.1,
        countTokens: async (indexText) => {
          // Measured surface = exactly the two text sections the model sees;
          // tools omitted (the schema area was judged by the ladder above).
          const v = await countTokensFn({ system: indexText });
          return v.inputTokens;
        },
      });
      if (demotion.reason === "demoted") {
        mcpNameDirectorySnapshot = demotion.mcp;
        skillIndexList = demotion.skills;
      } else if (demotion.reason === "countTokens_failed") {
        console.warn(
          `[build-engine] index demotion skipped: countTokens failed: ${errorMessage(
            demotion.cause
          )}`
        );
      }
      // no_index / no_overflow → zero action (both sections keep descriptions)
    } catch (err) {
      // runIndexDemotion never throws (folded into countTokens_failed);
      // defensive catch — assembly must never block.
      console.warn(
        `[build-engine] index demotion unexpected error: ${errorMessage(err)}`
      );
    }
  }

  // With the graph overlay wired, this is the single assembly-time snapshot:
  // (ADR-0030)
  // registry (tool presence), promptTools (visibility), and deps.system
  // (orchestration section) all read it (`reg`/`graphAssembly` are built
  // before `await mcpManager.start()` inside the MCP block).
  // The parent catalog is not the worker surface: rebuild the worker registry
  // through the same factory with the worker-only option shape, then apply
  // (ADR-0040)
  // the worker deny-list in the classifier below — this keeps host-only tools
  // (create-worktree, bash_stop) out of the isolation decision without a
  // second exclusion list.
  const workerBaseTools = createDefaultAciRegistry({
    env,
    sandboxRoot,
    skillCatalog,
    lspCtx,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    fsMode: opts.fsMode,
    // ADR-0119: the yolo holder threads to the worker-derived bash factory in
    // the same shape as the parent session (worker surface derives from the
    // same registry factory — byte-identical assembly, only the deny-list
    // differs).
    yolo: opts.yolo,
    homeRoot: userHome,
    worktreeOnMutate: worktreeOnMutateSource,
  }).catalog.all();
  // Dynamic registry wrapper so the executor resolves registerExternal mcp__
  // tools (see createDynamicExecutorRegistry for the contract).
  const dynamicExecutorRegistry = createDynamicExecutorRegistry(reg);
  const baseExecutor = createExecutor(dynamicExecutorRegistry);
  // 5-step permission middleware: dangerous commands are hard-walled
  // unconditionally. `createAciExecutor` already assembles the permission
  // executor internally — don't wrap another layer.
  // (ADR-0084)
  // Project `settings.permissions` enters the project layer. Read root =
  // `projectIdentityRoot` (the project identity anchor, see the sessionRoots
  // comment above) — project contracts live only at the identity root; after
  // a rebind cwd is a bare task worktree and reading cwd would silently drop
  // project rules. Fail-loud propagates as-is (typed ProjectSettingsError):
  // schema violations / coexisting toml+JSON SSOT must be visible at startup,
  // never swallowed into a degraded config. "No project rules" = undefined,
  // dropped by `createPermissionPolicy`'s spread-guard (same shape as key
  // absence), no extra conditional branch here.
  // ADR-0090: relative paths in declarative rules anchor at the session sandboxRoot;
  // `knownToolNames` takes the full reg.catalog (built-in + dynamic mcp__*)
  // so deny/ask rules naming unknown tools warn at load time (the rules
  // still compile and take effect once such tools register dynamically).
  const policy = createPermissionPolicy({
    project: resolveProjectPermissionSource({
      projectIdentityRoot,
      workRoot: sandboxRoot,
      knownToolNames: new Set(reg.catalog.all().map((def) => def.name)),
    }),
    ...(opts.session ? { session: opts.session } : {}),
    // W2: mode context — REPL toggles this via /permissions; absent → default.
    ...(opts.permissionMode ? { mode: opts.permissionMode } : {}),
  });
  // Secrets guard assembly — only legacy "block" mode wires a preToolUse
  // short-circuit at the earliest step, ahead of the permission layer;
  // complementary to opts.hooks (postToolUse observation). Missing
  // secrets.enabled defaults the builtin set on; empty patterns use builtin
  // defaults, invalid custom regexes are dropped with an onHookError warning
  // rather than poisoning the guard. The default roundtrip mode wires no guard.
  const secretsGuard =
    secretsMode === "block"
      ? createSecretsGuardHook({
          ...(settings.secrets ? { ...settings.secrets } : {}),
          ...(opts.onHookError ? { onHookError: opts.onHookError } : {}),
        })
      : undefined;
  // User command hooks from settings.hooks fold into the Pre/Post seams and
  // compose with the secrets guard via the multiplexer (builtin first).
  // Absent section = empty contribution; TUI Post observation never overlaps Pre.
  const settingsHooks = createSettingsHookContribution({
    hooks: settings.hooks,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    ...(opts.onHookError ? { onError: opts.onHookError } : {}),
  });
  // Plugin hooks file source. Chain order = builtin → settings command →
  // plugin: if an earlier hook answers, the plugin hook never spawns (one
  // less I/O, interception ownership unchanged). No hooksFiles → no plugin
  // contribution is built and pre/post are byte-identical to before. cwd =
  // taskRoot (the assembly-frozen sandboxRoot — hook subprocess cwd does not
  // feed session-root rebind math). onError spread-guard lives inside opts:
  // absent callback = absent key (exactOptional semantics).
  const pluginHooksOpts: Parameters<typeof createPluginHooksFromCatalog>[0] = {
    entries: pluginCatalog.hooksEntries,
    installations: enabledInstallations,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    onError: opts.onHookError,
  };
  const pluginHooks = createPluginHooksFromCatalog(pluginHooksOpts);
  // The composer skips undefined slots (unconfigured sources), so the
  // assembly needs no conditional spreads — including empty plugin
  // contributions' `.pre` / `.post`.
  const preToolUse = composePreHooks([
    secretsGuard,
    settingsHooks.pre,
    pluginHooks.pre,
  ]);
  // Post order: TUI observation (opts.hooks) → settings command Post → plugin Post.
  const postToolUse = composePostHooks([
    opts.hooks,
    settingsHooks.post,
    pluginHooks.post,
  ]);
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
    hooks: {
      preToolUse,
      ...(postToolUse ? { postToolUse } : {}),
    },
  });

  // Fold-in: the workspace-mutation classifier SSOT lives in `classifyCall`
  // (worktree-gate.ts) and routes on `FILE_WRITE_TOOL_NAMES`
  // (symbol-mutate.ts). This override only adds the spawn_subagent-specific
  // role-aware decision; for every other tool it composes with the SSOT, so
  // (ADR-0040)
  // there is no second truth source for "does this tool write the workspace".
  //
  // `spawn_subagent` is read-only only when the child's effective capability
  // (ADR-0040)
  // surface passes both dimensions from capability.ts. The role default
  // mirrors spawn-subagent-tool.ts; malformed role values are deliberately
  // mapped to an unknown role so the classifier stays fail-closed before the
  // inner executor performs schema validation.
  const classifyWithSubagentIsolation = (call: ToolCall): MutateClass => {
    if (call.name !== "spawn_subagent") return classifyCall(call);
    if (!isolationOnLive()) return "read";
    const input = (call.input ?? {}) as Record<string, unknown>;
    const rawRole = input.subagent_type;
    const role =
      rawRole === undefined
        ? "general-purpose"
        : typeof rawRole === "string"
          ? rawRole
          : "__invalid_subagent_type__";
    const disallowedTools = Array.isArray(input.disallowedTools)
      ? (input.disallowedTools as ReadonlyArray<string>)
      : undefined;
    const effectiveWorkerTools = buildWorkerToolSurface(
      workerBaseTools,
      disallowedTools
    );
    const decision = assessSubagentIsolation({
      role,
      availableTools: effectiveWorkerTools.map((tool) => tool.name),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    });
    return decision.conclusion === "readonly" ? "read" : "mutate";
  };

  // ADR-0037: mutate gate at the harness executor seam; host seams
  // (provision / enter / exit) come from session-api hub / TUI / CLI.
  // **Host absent → no wrapping** (a blocked mutate would be a dead end) —
  // byte-identical to unwrapped. Wrapping keys on "host present" rather than
  // startup isolationEnabled: the panel can flip OFF→ON at runtime, so under
  // (ADR-0096)
  // OFF the gate stays assembled and reads the holder per wave (falsy =
  // transparent). **Never auto-provision**: flipping ON only restores "block
  // unbound mutate + point at create-worktree". Git-work prompt, worker
  // writeSituation, and spawn classification re-read the same holder.
  // The gate reads the live
  // `liveTaskRoot` cell (single write point `withLiveTaskRootWrite`),
  // snapshotted once per executeAll wave; before any rebind it equals the
  // old assembly-frozen sandboxRoot.
  const loopExecutor =
    isolationHost !== undefined
      ? createWorktreeIsolationExecutor({
          enabled: worktreeOnMutateSource,
          liveTaskRoot,
          provision: wrappedProvision!,
          // Passthrough anchoring is decided per session by provision (own
          // task tree → same-root no-op; foreign root → typed
          // foreign_worktree); no engine-level bound marker, since one
          // engine can serve several sessions.
          classify: classifyWithSubagentIsolation,
          inner: executor,
        })
      : executor;

  // Single registry source: reg.inner is already the final view conditioned
  // on memoryEnabled (8 or 10 tools), so deps.registry / executor / catalog
  // agree — the ask entry naturally excludes memory tools. LSP warmup does
  // not start at assembly: this view arms it lazily, only on first language
  // server tool-name resolution (SSOT in lsp/warmup.ts).
  const registryTools: Registry = withLazyLspWarmup(reg.inner, lspCtx);

  // Eager + idempotent init of the global identity workspace
  // (initIknowWorkspaceSafe swallows failures with a warn; never blocks
  // assembly). Persona always seeds `<userHome>/.iknow` (userHome is the test
  // seam; workspaceRoot / cwd must not receive user.md).
  await initIknowWorkspaceSafe({
    workspace: path.join(userHome, ".iknow"),
  });
  // MCP conditional assembly moved above (registry call order — see the
  // mcpManager block and holder pattern there). Summary of the four-entry
  // rule: ask never creates a manager; chat/tui/serve load + merge config,
  // create the manager and fire start() without awaiting, so buildHarnessEngine
  // return time depends only on fast registry assembly. The shutdown handle is
  // exposed via BuiltEngine.shutdown; process-exit hooks close all clients,
  // cancel in-flight work and SIGTERM stdio descendants. The MCP name-directory
  // snapshot is read live by the deps.system resolver (manager.status() ×
  // mcp__* names in reg.catalog); manual-reconnect pending rides the
  // mcpReconnectPending holder.
  // Single gate expression: one condition (not ask, and host injected todoDir)
  // drives both the loop injection seam (deps.agentStatus, appended as a user
  // message) and the system read-rule paragraph (resolver opts.agentStatusReadRule,
  // the stable-reading sentence) — the two can never drift apart; ask or absent
  // todoDir removes both. The same expression also appears inline in the
  // registry todoDir seam above; change one, sync the other.
  // (ADR-0028)
  const agentStatusTodoDir: string | undefined =
    surface !== "ask" && opts.todoDir ? opts.todoDir : undefined;
  // ADR-0098: both inputs are now final (`skillIndexList` is the post-demotion
  // frozen table, `agentStatusTodoDir` the expression above) — only here is
  // the seam built. The manager's spawn getter only reads closure references,
  // so the construction order (manager above, assignment here) is safe.
  skillIndexSeam = buildSkillIndexSeamOrUndefined({
    todoDir: agentStatusTodoDir,
    rescanner: skillRescanner,
    frozenNames: skillIndexList.map((skill) => skill.name),
    frozenEntries: skillIndexList.map((skill) =>
      skill.description === undefined
        ? { name: skill.name }
        : { name: skill.name, description: skill.description }
    ),
  });
  // memory-toggle-live: build the memory_layer resolver early — the
  // deps.system seam and BuiltEngine.invalidateMemorySystem share this one
  // instance. TUI attaches live flags (catalog sections follow the /memory
  // toggle); other surfaces keep the original snapshot form.
  const memorySystemResolver = memoryToolsEnabled
    ? buildMemorySystemResolver({
        projectIdentityRoot,
        userHome,
        workspaceRoot,
        memoryDir,
        autoExtract: settings.memory?.autoExtract === true,
        flags: memoryFlags,
        flagsActive: tuiLive,
      })
    : undefined;
  const deps: LoopEngineDeps = {
    adapter,
    executor: loopExecutor,
    registry: registryTools,
    // Inject secretRegistry so roundtrip mode can placeholder-replace user
    // text in run(); absent under block mode → recognition skipped.
    ...(secretRegistry ? { secretRegistry } : {}),
    // Under block mode inject secretsMode explicitly so the loop-engine
    // recognition layer skips recognize; roundtrip default = undefined (no change).
    ...(secretsMode === "block" ? { secretsMode: "block" as const } : {}),
    // env first (CLI --max-turns injected by the surface); undefined =
    // (ADR-0012)
    // unlimited (default), so long exploration is not killed by turn counting.
    maxTurns: env.llm.maxTurns,
    detectToolLoop: env.loop?.detectToolLoop !== false,
    timeoutMs: env.llm.timeoutMs,
    // Dual-clock passthrough for the streaming arm. Conditional spread —
    // absent fields make loop-engine fall back to the single clock; the
    // streaming gate is decided there via adapter.streamMode, not duplicated
    // in the assembly layer.
    ...(env.llm.idleTimeoutMs !== undefined
      ? { modelIdleTimeoutMs: env.llm.idleTimeoutMs }
      : {}),
    ...(env.llm.hardCapMs !== undefined
      ? { modelHardCapMs: env.llm.hardCapMs }
      : {}),
    // Inject reg.visibleSchemas (including discovered lazy tools) as
    // promptTools; the fallback path (default back to deps.registry.list())
    // is handled in loop-engine. `run_graph` stays resident and promptTools
    // is no longer filtered by the graph snapshot — a graph-off run() still
    // advertises run_graph (its isEnabled gate rejects the call), keeping
    // promptTools byte-stable across turns so prefix caching is never broken
    // by graph toggling.
    promptTools: reg.visibleSchemas,
    // Per-turn system assembly: identity/soul/user_profile/bootstrap +
    // memory_layer via deps.system (loop-engine calls deps.system?.() each
    // turn and passes it through as adapter.step request.system). Two-layer
    // seam: createIknowSystemResolver is always attached; it injects the
    // memoryResolver to render the memory_layer section when memory is
    // enabled and stays silent otherwise (ask still gets the identity
    // sections). The skills injection (catalog.available() → SkillSummary
    // projection) applies to all surfaces — even ask: if skill tools are
    // present the model should know the available skills; the resolver
    // filters disabled entries before rendering <available_skills>.
    system: createIknowSystemResolver({
      // ADR-0037: the "Project path" section reads the stable
      // projectIdentityRoot — the assembly no longer uses the cwd seam. The
      // live taskRoot reaches the human-readable view only via the envSnapshot
      // section below (after rebind the readable view follows the live root
      // while system prompt bytes stay stable, preserving the KV-cache
      // contract), so cwd is not passed.
      projectIdentityRoot,
      userHome,
      workspaceRoot,
      surface,
      memoryEnabled: memoryToolsEnabled,
      ...(memorySystemResolver ? { memoryResolver: memorySystemResolver } : {}),
      // Skills index = the frozen holder taken after the first-turn judgment
      // (`skillIndexList`) — demotion strips descriptions above the threshold
      // and the renderer emits bare-name lines by data shape (single SSOT, no
      // second judgment inside the section function). Under threshold the
      // holder is a verbatim projection of `catalog.available()`. Constant
      // within the session → adjacent-turn system deep-equal.
      skills: () => skillIndexList,
      // ADR-0043: MCP name-directory section injection seam (progressive
      // disclosure "index resident tier") — injected only when mcpManager
      // exists (chat/tui/serve); ask has no manager → seam absent → section
      // absent (byte-level zero change, KV-cache stability contract). The
      // directory is a session-level snapshot (see the
      // mcpNameDirectorySnapshot freeze point above): finalized once the
      // firstTurnReady window resolves, deep-equal across turns; servers that
      // connect late never leak back in, and directory deltas from manual
      // reconnect go through a tail append notification (not a rewrite).
      ...(mcpNameDirectorySnapshot
        ? {
            mcp: () => mcpNameDirectorySnapshot,
          }
        : {}),
      // ADR-0043: overflow-governance retired-tool index section (optional) —
      // frozen after the first-turn judgment, constant in session (holder
      // defined above). Empty list (nothing over threshold / failure) → the
      // closure returns [] → section absent; non-empty renders
      // <deferred_internal_tools> (one `- name: description` line per entry,
      // stable alphabetical; missing description degrades to bare name). Same
      // shape as the MCP name directory, additive section not touching
      // IKNOW_ASSEMBLY_ORDER. ask reaches this seam too (no MCP but possibly
      // retired builtins); failed governance → empty list → section absent.
      deferredInternalTools: () => deferredInternalToolsList,
      // Default paths stop injecting the coordinator section — guidance lives
      // in the spawn_subagent tool description (SSOT). The seam stays: callers
      // may pass coordinatorText explicitly to have it rendered.
      // Agent-status read-rule section gate — derived from the same
      // agentStatusTodoDir expression as deps.agentStatus below (only surfaces
      // carrying the bar assemble the reading-rule sentence).
      ...(agentStatusTodoDir ? { agentStatusReadRule: true } : {}),
      // Git block injection seam: cwd = `projectIdentityRoot` (stable root,
      // decoupled from session rebind); one synchronous snapshot at assembly,
      // frozen in session. Degenerate states (not a git repo / git unusable /
      // cwd unresolvable) → provider returns undefined → section absent, no error.
      git: createGitSnapshotProvider({ cwd: projectIdentityRoot }),
      // Git work-discipline section: same live source as isolationOnLive
      // (host present ∧ holder.get()). ON → injected for chat/tui/serve;
      // OFF → field evaluates false each system() call (segment absent).
      // ask is blocked again inside createIknowSystemResolver; worker
      // createWorkerDeps bypasses this layer entirely.
      gitWorkDiscipline: isolationOnLive,
      // The `orchestration` system section was retired — its content moved
      // into the graph mode-switch hints (loop-engine tail append, see the
      // graphModeChange seam below). The graph assembly snapshot is now a
      // single point for loop-engine on/off judgment against its own last snapshot.
    }),
    // env.compress passthrough → deps.compress (optional LoopEngineDeps seam).
    // IknowCompressEnv fields are required (contextWindow / thresholdTokens);
    // compression off when absent is backstopped by the loop-engine field-
    // absence path. Unconditional passthrough here (policy-budget window
    // default 256000 is handled at the env layer).
    compress: {
      contextWindow: env.compress.contextWindow,
      thresholdTokens: env.compress.thresholdTokens,
    },
    // Agent-status bar injection seam — present when not ask and the host
    // (ADR-0028)
    // injected todoDir (same gate as todo_write registration above, reusing
    // the session dir); loop-engine appends the current bar as a user message
    // before each model call. Absent for ask; worker deps (createWorkerDeps,
    // built independently) never pass through here. The hub's per-run runDeps
    // spreads these engine deps so serve inherits, and TUI inherits via
    // buildTuiDeps. The gate lives in the single agentStatusTodoDir expression
    // above, same source as the resolver's agentStatusReadRule (no drift).
    ...(agentStatusTodoDir
      ? { agentStatus: { todoDir: agentStatusTodoDir } }
      : {}),
    ...skillIndexDeltaOption(skillIndexSeam),
    // Environment-presence event seam — injected for tui only (data source
    // for human-readable chrome; cwd comes from liveTaskRoot.read, the live
    // assembly holder, read fresh right before each model call). After
    // rebind the next wave's readable view (TUI cwd / git summary) follows
    // the live root. ask / chat / serve / worker absent → zero IO, zero
    // events (byte-identical). readEnvSnapshot never throws; events go to
    // host UI only, never into messages / verify / the agent-status bar.
    // (ADR-0028)
    ...(surface === "tui"
      ? { envSnapshot: { readCwd: liveTaskRoot.read } }
      : {}),
    // Graph mode-switch injection seam — passed to loop-engine when
    // `graphAssembly` exists; at step boundaries it compares this snapshot
    // against the previous value and, on flip, appends a single-line user
    // hint (graph-on includes orchestration guidance / graph-off closure
    // note) immutably at the messages tail; same value → zero appends.
    // Absent (ask / worker / entry without overlay) → zero appends. Shape
    // mirrors agentStatus: the "not wired → pass through unchanged" form of
    // `promptTools` is the byte-identical contract. `lastSeenEnabled.value =
    // undefined` means "not yet seen in this deps lifetime" — loop-engine
    // records the initial value on the first step without appending (a new
    // session has no flip to announce; starting graph-off must not inject an
    // off hint), then compares adjacent steps.
    ...(graphAssembly
      ? {
          graphModeChange: {
            assembly: graphAssembly,
            lastSeenEnabled: { value: undefined as boolean | undefined },
          },
          // Per-run one-shot presence injection seam — passed alongside
          // (ADR-0081)
          // graphModeChange when graphAssembly exists (same assembly source,
          // decoupled seams: change holds flip state, presence reads the round
          // snapshot once). Absent (ask / worker / no overlay) → zero appends.
          graphModePresence: {
            assembly: graphAssembly,
            appendedThisRun: { value: false },
          },
        }
      : {}),
    // ADR-0043: MCP manual-reconnect append seam — passed to loop-engine when
    // the mcpReconnectPending holder exists (manager assembled, chat/tui/serve);
    // takePending consumes once (take + clear). ask (no manager) → seam absent
    // → zero appends.
    ...(mcpReconnectPending
      ? {
          mcpReconnect: {
            takePending: (): ReadonlyArray<{
              server: string;
              tools: ReadonlyArray<string>;
            }> => {
              const taken = [...mcpReconnectPending!.events];
              mcpReconnectPending!.events.length = 0;
              return taken;
            },
          },
        }
      : {}),
  };
  const engine = createLoopEngine(deps);
  // Auto-memory gate: two conditions — memory layer present and not the ask
  // (ADR-0031)
  // surface. Either failing → hook absent, zero host calls, zero LLM, zero
  // disk writes. Read-path prefetch follows autoExtract only (dream-only must
  // not inject user messages). (autoExtractOn / dreamOn / memoryFlags /
  // tuiLive are defined at the settings load point.) When extract and dream
  // (ADR-0031)
  // are both off the hook still exists: the mechanical pass (memory_gc +
  // capability sweep) must run on the completed gate, otherwise stale
  // capability entries never get soft-archived. Zero-LLM is guaranteed inside
  // the hook (dual-off enters only runMechanicalPass) and extract is still
  // gated by the live `enabled` flag.
  const autoMemory =
    memoryEnabled && surface !== "ask"
      ? createAutoMemoryHook({
          memoryDir,
          llm: createAdapterExtractLlm(adapter),
          enabled: autoExtractOn,
          dream: dreamOn,
          flags: memoryFlags,
          staticLayer: () =>
            assembleStaticSystemPrompt({
              projectIdentityRoot,
              userHome,
              workspaceRoot,
            }),
          onError: (error) => {
            console.warn(
              `[memory/auto] ingest skipped: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          },
        })
      : undefined;
  const overlayMemoryPrefetch =
    memoryEnabled && surface !== "ask" && (autoExtractOn || tuiLive)
      ? async (
          query: string,
          prefetchOpts?: PrefetchQueryOpts
        ): Promise<string> => {
          if (memoryFlags.autoExtract !== true) return "";
          try {
            return await buildMemoryPrefetchOverlay({
              memoryDir,
              query,
              excludeIds: prefetchOpts?.excludeIds,
            });
          } catch (error) {
            // EXIT: log-and-continue — missing prefetch must not fail the turn.
            console.warn(
              `[memory/prefetch] overlay skipped: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            return "";
          }
        }
      : undefined;
  return {
    deps,
    engine,
    ...(autoMemory ? { autoMemory } : {}),
    ...(overlayMemoryPrefetch ? { overlayMemoryPrefetch } : {}),
    ...(tuiLive ? { memoryFlags } : {}),
    ...tuiMemoryInvalidateField(tuiLive, memorySystemResolver),
    ...(subagentManager ? { subagentManager } : {}),
    // Expose skillCatalog + mcpManager + catalog for TUI deps extension
    // building (TuiExtensions.skillCatalog / mcp.status / mcp.reload /
    // listMcpTools). These are general surface accessories, not TUI-only —
    // existing consumers unchanged.
    skillCatalog,
    // ADR-0098: rescan seam exposed — it is the **cross-entry shared** mutable
    // holder (plugin skill roots change on explicit reload): the serve hub's
    // skill-reload endpoint calls setPluginSkillDirs on the **same engine**,
    // and only the next rescan of the frozen holder and the index-delta seam
    // sees the new roots. Host without todoDir / ask surface → absent (same
    // gate as deps.skillIndexDelta, zero behavior change).
    ...skillRescannerOption(skillRescanner),
    ...(mcpManager ? { mcpManager } : {}),
    ...(mcpRoots ? { mcpRoots } : {}),
    sessionRoots,
    catalog: reg.catalog,
    // Live taskRoot cell exposed so the hub's loadSkillBody reads a snapshot
    // at call time — the same cell instance the registry factory consumes.
    liveTaskRoot,
    // Isolation-tier judgment for hub / chat-session rebind writeSituation.
    // Same live holder as the mutate gate — a panel flip is visible on the
    // next property read.
    get isolationOn() {
      return isolationOnLive();
    },
    // Enter-occupancy-lock setting passthrough — the session-api hub reads it
    // (ADR-0070)
    // when constructing the `worktreeEnter` host closure to decide whether to
    // run the occupancy check; this layer never reads, consumes or mutates the
    // host seam (the value is only a mirror of the one-shot settings resolve).
    // Unlike `isolationOn` it does not depend on the worktreeIsolation host
    // seam; strictly reflects settings (default OFF / missing / non-true → false).
    worktreeExclusive: worktreeExclusiveEnabled,
    // The host calls beginRound() before each run() (both chat and hub run
    // entries). Absent = this entry has no overlay wired.
    ...(graphAssembly ? { graphAssembly } : {}),
    // shutdown composes MCP + subagent + background cleanup. Order:
    // mcpManager first → subagentManager second (no shared mutable state;
    // Promise.all fires concurrently — the ordering is a semantic label, not
    // strict serialization; with all three absent on ask, shutdown is absent
    // too). backgroundManager.shutdown() kills leftover background process
    // groups, likewise safe inside Promise.all.
    // Note: LSP subprocess termination is **not here** — engine shutdown can
    // fire mid-process (chat rebind closes the old engine), while the LSP pool
    // is process-level shared (a per-engine pool would respawn the language
    // server on every assembly in tests/multi-engine setups); termination +
    // latch happen only at host-process exit seams (TUI shutdownExtensions /
    // chat exit), see client.ts shutdownDefaultLspPool.
    ...(mcpManager || subagentManager || backgroundManager || autoMemory
      ? {
          shutdown: async (): Promise<void> => {
            await Promise.all([
              mcpManager?.shutdown(),
              subagentManager?.shutdown(),
              backgroundManager?.shutdown(),
              // ADR-0086: best-effort `memory_gc` + capability sweep on
              // process exit. The hook's `onExit` is optimistic by contract
              // (never throws) and is deliberately not the only gate — the
              // completed-turn gate stays authoritative.
              autoMemory?.onExit?.(),
            ]);
          },
        }
      : {}),
  };
}

/**
 * Conditional passthrough for the last-read ledger host (shared by the two
 *
 // (ADR-0084)
 * registry constructions). Host not wired (ask / direct test calls) → empty
 * object → the registry builds its own and the write gate still applies
 * (read memory just isn't shared across registries). One expression serves
 * both assembly sites instead of duplicating the `?( … ) : {}` branch (S5
 * ratchet: buildHarnessEngine is an existing god function and may only keep
 * an equal or smaller number of branches).
 */
function lastReadLedgerOption(opts: BuildEngineOpts): {
  readonly lastReadLedger?: LastReadLedgerHost;
} {
  return opts.lastReadLedger ? { lastReadLedger: opts.lastReadLedger } : {};
}

/** ADR-0098: conditional exposure of the rescan seam (same rationale as `lastReadLedgerOption`). */
function skillRescannerOption(rescanner: SkillRescanner | undefined): {
  readonly skillRescanner?: SkillRescanner;
} {
  return rescanner ? { skillRescanner: rescanner } : {};
}

/**
 * ADR-0098: skill-index entry-delta seam — same gate as agentStatus (the one
 * todoDir expression = "session folder present + not ask") and same shape:
 * assembly supplies a constant seam (rescanner + projectDir + frozen name
 * set), loop-engine calls it right before each model call, and the seam
 * resolves the session anchor (`deps.conversationId`) at call time into the
 * `<projectDir>/<sanitize(convId)>/skill-index.json` entry-history leaf.
 *
 * The frozen name set comes from this layer's holder (post-demotion final
 * form) — names already in the frozen table never count as new. Host without
 * todoDir / ask surface / no rescan seam → seam absent, zero injection
 * (existing assembly and tests byte-identical).
 *
 * Extracted to module level for the same reason as `lastReadLedgerOption` /
 * `resolveWorktreeOnMutateSource` (S5 ratchet on buildHarnessEngine branches).
 */
function skillIndexDeltaOption(
  seam: ReturnType<typeof createSkillIndexDeltaSeam> | undefined
): {
  readonly skillIndexDelta?: ReturnType<typeof createSkillIndexDeltaSeam>;
} {
  return seam === undefined ? {} : { skillIndexDelta: seam };
}

/**
 * Conditional exposure of the worker snapshot getter (seam absent → the key
 * itself is omitted, same style as `lastReadLedgerOption`).
 *
 * **Returns `{}` when the seam is absent** (rather than "a getter that always
 * returns undefined"): on the manager side "getter absent" and "getter
 * returns undefined" both end in an omitted key, but the former is a
 * declarative "this assembly has no such line", while the latter requires
 * reading a function body — and wiring tests can assert directly whether the
 * assembly passed it.
 *
 * The getter's inner still **passes `undefined` through verbatim** (not an
 * empty array): in the envelope's tri-state, "key omitted" = the worker falls
 * back to its own rescan, "empty array" = the parent definitely has no skills.
 * Rendering "this session has not loaded any yet" as an empty array would
 * make the worker emit an empty-list sentence and drop skills it could have
 * scanned itself.
 */
function skillIndexSnapshotOption(input: {
  /** Gate decidable at assembly time (same as `agentStatusTodoDir`: not ask + has a landing dir). */
  readonly todoDir: string | undefined;
  readonly rescanner: SkillRescanner | undefined;
  /** The seam's **call-time** read — the seam itself is built only after the frozen table is final (see the assignment-site comment). */
  readonly readSeam: () =>
    ReturnType<typeof createSkillIndexDeltaSeam> | undefined;
}): {
  readonly skillIndexSnapshot?: (
    conversationId: string | undefined
  ) => readonly SkillIndexSnapshotEntry[] | undefined;
} {
  // The gate's branch count stays in the helper (S5 ratchet on
  // buildHarnessEngine branches); same condition pair as
  // `buildSkillIndexSeamOrUndefined`.
  if (input.todoDir === undefined || input.rescanner === undefined) return {};
  return {
    skillIndexSnapshot: (conversationId) =>
      input.readSeam()?.enteredEntries(conversationId),
  };
}

/**
 * The delta seam body itself (or its absence) — same gate and source as
 * `buildSkillIndexDeltaSeam`, extracted separately because **the worker
 * snapshot getter needs it too** (`enteredEntries` is the synchronous face of
 * the same seam). The two consumer lines share one instance: "already
 * entered" in the worker snapshot and "already entered" that the loop delta
 * appends must be the same history — two seams would double-book.
 *
 * Absent (either todoDir or rescanner missing) → undefined: the worker
 * snapshot getter is absent with it, and the worker falls back to its own
 * rescan (old form byte-stable).
 */
function buildSkillIndexSeamOrUndefined(input: {
  readonly todoDir: string | undefined;
  readonly rescanner: SkillRescanner | undefined;
  readonly frozenNames: readonly string[];
  readonly frozenEntries?: readonly SkillIndexSnapshotEntryShape[];
}): ReturnType<typeof createSkillIndexDeltaSeam> | undefined {
  if (input.todoDir === undefined || input.rescanner === undefined)
    return undefined;
  return createSkillIndexDeltaSeam({
    rescanner: input.rescanner,
    projectDir: input.todoDir,
    initialNames: input.frozenNames,
    ...(input.frozenEntries !== undefined
      ? { initialEntries: input.frozenEntries }
      : {}),
    // `isIndexedName` is not passed (default accepts all): the written name
    // list already comes from `computeSkillIndexDelta` via the **rescan face's**
    // `modelIndex()` — eligibility was decided in that beat. Re-gating here
    // with the assembly-time catalog would mark skill names **created during
    // the session** (nonexistent at assembly) as illegal, dropping exactly the
    // deltas this seam exists to append.
  });
}

/**
 * ADR-0098: assembly-time construction of the rescan seam — the `ask` surface
 * builds none (oneshot throwaway; delta seam and frozen holder both absent);
 * other surfaces build one holder where `pluginSkillDirs` is only the
 * **initial** value, later swapped exclusively by explicit reload via
 * `setPluginSkillDirs()`.
 *
 * Extracted to module level for the same reason as `lastReadLedgerOption` /
 * `buildSkillIndexDeltaSeam` (S5 ratchet on buildHarnessEngine branches).
 */
function createEngineSkillRescanner(input: {
  readonly surface: "chat" | "tui" | "ask" | "serve";
  readonly userHome: string;
  readonly projectIdentityRoot: string;
  readonly pluginSkillDirs: readonly PluginSkillDir[];
}): SkillRescanner | undefined {
  if (input.surface === "ask") return undefined;
  return createSkillRescanner({
    userHome: input.userHome,
    projectIdentityRoot: input.projectIdentityRoot,
    env: process.env,
    pluginSkillDirs: input.pluginSkillDirs,
  });
}

/**
 * Gate switch-source resolution: holder present → use the injected live cell;
 *
 // (ADR-0096)
 * absent → build a frozen holder from the startup reading on the spot.
 *
 * Extracted to module level for the same reason as `lastReadLedgerOption`
 * (S5 ratchet). The holder-absent path must stay byte-identical to today:
 * `resolveWorktreeOnMutate` remains the only fail-closed read point, still
 * read once after settings load, merely wrapped in a holder for the gate's
 * `get()`.
 */
function resolveWorktreeOnMutateSource(
  opts: BuildEngineOpts,
  settings: IknowSettings
): WorktreeGateReader {
  return (
    opts.worktreeOnMutateHolder ??
    createWorktreeOnMutateHolder(resolveWorktreeOnMutate(settings))
  );
}

/**
 * Dynamic registry wrapper — feed createExecutor a RegistryImpl view that can
 * resolve mcp__ tools registered dynamically via registerExternal.
 *
 * Constraints:
 *   - reg.inner is frozen after construction (the registerExternal contract:
 *     inner.list() does not change after registerExternal). This wrapper
 *     never mutates inner; on an inner miss it consults reg.catalog (the
 *     dynamic source).
 *   - list() still returns the reg.inner.list() snapshot; createExecutor
 *     does not depend on list() being dynamic (executor.ts only uses
 *     get/getValidator).
 *   - get()/getValidator() prefer reg.inner (frozen at construction, zero
 *     overhead), falling back to reg.catalog.get(name) on a miss; validators
 *     for dynamic defs are compiled once on the spot and cached, using an ajv
 *     instance configured identically to registry.makeAjv (strict +
 *     allErrors + formats).
 *
 * Assembled only here; aci-registry.ts and permission-executor.ts untouched.
 */
function createDynamicExecutorRegistry(
  reg: import("./aci/aci-registry.js").AciRegistry
): RegistryImpl {
  // **Lazy** ajv init: constructing Ajv + addFormats is heavy at startup,
  // and MCP assembly must not slow buildHarnessEngine down (slow connects
  // must not block; unit tests tolerate <200ms). Created on first dynamic hit.
  let externalAjv: Ajv.default | undefined;
  const dynamicValidatorCache = new Map<string, ValidateFunction>();

  function ensureAjv(): Ajv.default {
    if (externalAjv === undefined) {
      externalAjv = new Ajv.default({ strict: true, allErrors: true });
      addFormats.default(externalAjv);
    }
    return externalAjv;
  }

  return Object.freeze({
    list: () => reg.inner.list(),
    get: (name: string) => reg.inner.get(name) ?? reg.catalog.get(name),
    getValidator: (name: string) => {
      const inner = reg.inner.getValidator(name);
      if (inner !== undefined) return inner;
      // Dynamic source: compile only when reg.catalog really has the name
      // (and reg.inner does not). reg.catalog.get already does the
      // byName ∪ externalByExt fallback.
      if (reg.inner.get(name) !== undefined) return undefined;
      const dyn = reg.catalog.get(name);
      if (dyn === undefined) return undefined;
      let v = dynamicValidatorCache.get(name);
      if (v === undefined) {
        v = ensureAjv().compile(dyn.inputSchema);
        dynamicValidatorCache.set(name, v);
      }
      return v;
    },
  });
}

/**
 * memory-toggle-live: consolidation of the memory_layer system resolver
 * construction (extracted from an inline tri-state expression in
 * `buildHarnessEngine` for the S5 complexity ratchet).
 *
 * The TUI surface (`flags` present) attaches live flags — the resolver takes
 * per-flag-value snapshot tiers, and a `/memory` toggle takes effect next
 *
 // (ADR-0042)
 * round via `invalidateMemorySystem`; other surfaces keep the single-snapshot
 * form, byte-for-byte unchanged. Loading `autoExtract` into ctx shares the
 *
 // (ADR-0034)
 * assembly contract (false → no catalog injection).
 */
function buildMemorySystemResolver(args: {
  readonly projectIdentityRoot: string;
  readonly userHome: string;
  readonly workspaceRoot: string;
  readonly memoryDir: string;
  readonly autoExtract: boolean;
  readonly flags?: MemoryLiveFlags;
  /** Only the TUI surface activates live flags (ignored elsewhere). */
  readonly flagsActive?: boolean;
}): SystemResolver {
  const ctx = {
    projectIdentityRoot: args.projectIdentityRoot,
    userHome: args.userHome,
    workspaceRoot: args.workspaceRoot,
    memoryDir: args.memoryDir,
    ...(args.autoExtract ? { autoExtract: true } : {}),
  };
  return args.flagsActive && args.flags
    ? createSystemResolver(ctx, { flags: args.flags })
    : createSystemResolver(ctx);
}

/**
 * memory-toggle-live: snapshot-invalidation field exposed for the TUI surface
 * only — yields `{ invalidateMemorySystem }` when a resolver exists and the
 * surface is TUI, otherwise an empty object.
 */
function tuiMemoryInvalidateField(
  tuiLive: boolean,
  resolver: SystemResolver | undefined
): { readonly invalidateMemorySystem: () => void } | Record<string, never> {
  return tuiLive && resolver
    ? { invalidateMemorySystem: resolver.invalidate }
    : {};
}

/**
 * ADR-0043: production contract (ms) for the assembly-time firstTurnReady
 * window — MCP servers connected within the window join the first-turn
 * assembly (session on record); those not connected in time are absent for
 * the whole session (not in the name directory, not in tools), with no auto
 * retry. Test seams only override the window length; production callers
 * never pass it ⇒ this constant applies, byte-level unchanged.
 */
const MCP_FIRST_TURN_READY_TIMEOUT_MS = 30_000;

/**
 * Resolver for the `opts.mcpFirstTurnReadyTimeoutMs` test seam: absent ⇒
 * production constant; present ⇒ injected value (see the BuildEngineOpts
 * field doc). Both paths use the same window-polling code with only the
 * length differing, so this picks a length and adds no window-semantics branch.
 */
function resolveFirstTurnReadyTimeoutMs(injected?: number): number {
  return injected ?? MCP_FIRST_TURN_READY_TIMEOUT_MS;
}

/**
 * ADR-0043: assembly-time countTokens source selection (extracted so the
 * assembly body need not inline a four-branch precedence judgment).
 *
 * Priority: explicit `countTokens` > `skipCountTokens` bypass > real adapter
 * call. Explicit injection must always win — otherwise a caller exercising
 * the overflow path who also set skip would be silently bypassed and the
 * assertion would quietly rot.
 *
 * The `skipCountTokens` seam (see the BuildEngineOpts field doc) avoids the
 * adapter's SDK call (test-env baseUrl is unreachable; SDK maxRetries=2 +
 * backoff would burn ~2.5s per assembly); it is shaped like an absent
 * countTokens. An adapter that does not implement countTokens (stub /
 * offline) also falls into the absent semantics — the assembly skips this
 * session's overflow judgment and index demotion.
 */
function selectCountTokensFn(
  adapter: LoopEngineDeps["adapter"],
  opts: Pick<BuildEngineOpts, "countTokens" | "skipCountTokens">
): BuildEngineOpts["countTokens"] {
  if (opts.countTokens !== undefined) return opts.countTokens;
  if (opts.skipCountTokens === true) return undefined;
  if (adapter.countTokens === undefined) return undefined;
  // Real adapter: pass only tools + system (messages absent = the SDK accepts
  // empty; in the first-turn judgment scenario messages are necessarily empty).
  return async (input: {
    readonly tools?: ReadonlyArray<unknown>;
    readonly system?: string;
  }) => {
    return adapter.countTokens!({
      tools: input.tools as ReadonlyArray<unknown> | undefined,
      system: input.system,
    });
  };
}

/**
 * tasksDir source selection (extracted so the assembly body keeps a single
 *
 // (ADR-0088)
 * call — same gate as `selectCountTokensFn`, avoiding new branches in the
 * existing large function).
 *
 * Host injection wins (explicitly derived by the three entries); absent →
 * fall back to the **pool-root** default `~/.iknow` (the `resolveServeDataDir`
 * default, with the `userHome` test seam honored) — never fall back to
 *
 // (ADR-0087)
 * workspaceRoot, the per-root sharding exactly what this indirection removes.
 */
function selectBackgroundTasksDir(
  injected: string | undefined,
  userHome: string,
  projectIdentityRoot: string
): string {
  return (
    injected ??
    resolveTasksDir({
      dataDir: path.join(userHome, ".iknow"),
      projectIdentityRoot,
    })
  );
}

/**
 * memoryDir source selection — host injection wins; absent → fall back to
 *
 // (ADR-0099)
 * the pool-root default `~/.iknow`. Never fall back to workspaceRoot.
 */
function selectProjectMemoryDir(
  injected: string | undefined,
  userHome: string,
  projectIdentityRoot: string
): string {
  return (
    injected ??
    resolveProjectMemoryDir({
      dataDir: path.join(userHome, ".iknow"),
      projectIdentityRoot,
    })
  );
}
