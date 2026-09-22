/**
 * buildTuiDeps delegates to buildHarnessEngine({ surface: "tui" }) — assembly
 * is SSOT-ized: the TUI no longer builds its own adapter / executor /
 * permission / registry / system and goes entirely through the single harness
 * assembly point (same source as chat / ask / serve, so the tool surface can
 * never drift). The TUI therefore inherits subagentManager (self-built for
 * surface !== "ask") + the combined shutdown handle (MCP + subagent cleanup).
 * The coordinator segment is absent by default — its guidance landing moved to
 * the spawn_subagent tool description (SSOT); the assembly seam stays, and
 * callers can still render that segment explicitly via
 * createIknowSystemResolver opts.coordinatorText.
 *
 * Observability seam: opts.onToolEvent + opts.soleInflightId are wrapped by
 * wrapTuiHook in this module into BuildEngineOpts.hooks (PostToolUseHook),
 * passed through build-engine into createAciExecutor — postToolUse fires →
 * attribution via soleInflightId → onToolEvent (tool summary line events; the
 * official observation hook in permission/types.ts, fires after each call).
 *
 * After assembly, build-engine's skillCatalog + mcpManager + catalog are used
 * to build the TUI extension surface (TuiExtensions), consumed through the
 * synchronous opts.onExtensions callback (slash candidates / MCP board /
 * shutdown closure). The MCP connect timeout passes through build-engine from
 * env.mcp.connectTimeoutMs (default 60_000).
 * Pure TS module, no ink / OpenTUI dependencies.
 */
import type { LoopEngineDeps } from "../harness/index.js";
import {
  buildHarnessEngine,
  type EngineBundle,
} from "../harness/build-engine.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import type { PostToolUseHook } from "../harness/permission/types.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import type { GraphModeContext } from "../harness/graph/mode.js";
import type { FsModeContext } from "../harness/sandbox/fs-mode.js";
import type { YoloContext } from "../harness/sandbox/yolo.js";
import type { SubagentCapacityHolder } from "../harness/subagent/manager.js";
import type { WorktreeOnMutateHolder } from "../harness/isolation/worktree-gate.js";
import type { LiveGraphLedgerHost } from "../harness/graph/ledger.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import { randomUUID } from "node:crypto";
import type { MemoryLiveFlags } from "../harness/memory/index.js";
import type { RuntimeBundle } from "../cli/runtime.js";
import type { AskUser } from "../harness/permission/types.js";
import type { WorktreeIsolationHostOpts } from "../harness/isolation/worktree-gate.js";
import type { IknowSettings } from "../config/settings.js";
import type { LiveTaskRoot } from "../harness/session-roots.js";
import { deriveProjectIdentityRoot } from "../harness/session-roots.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { SkillRescanner } from "../harness/skill/rescan.js";
import type { McpServerStatus } from "../harness/mcp/manager.js";
import { loadMcpConfig } from "../harness/mcp/config.js";
import type { AciToolDef } from "../harness/aci/types.js";
import {
  resolveProjectSessionDir,
  resolveSubagentTraceDir,
} from "../session-api/store/session-store.js";
import { createPreimageCapture } from "../session-api/store/preimage-capture.js";
import type { PreimageCapture } from "../harness/aci/preimage-port.js";
import { readWorkerInFlightToolName } from "../session-api/store/index.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import { resolveTasksDir } from "../harness/background/paths.js";
import { MEMORY_DIR_NAME } from "../shared/session-tree-names.js";

/** Tool summary line event (postToolUse projection, observability-only). */
export interface TuiToolEvent {
  readonly conversationId: string;
  readonly toolName: string;
  /** tool_use_id — the TUI pairs it with streaming tool_call_start to flip
   *  summary lines to ok/failed; when absent (host did not inject / old
   *  replay) fall back to appending legacy string lines. */
  readonly toolUseId?: string;
  /** ok | validation_failed | tool_not_found | execution_failed */
  readonly kind: string;
  readonly input: unknown;
  readonly message?: string;
  /**
   * Observation side-channel carrier — the handler envelope's meta (full
   * old/new text). Unrelated to the model-facing (MCP/Anthropic) `payload`
   * concept: this field only carries the diff's old/new content and never
   * enters the model's tool_result. Present only when ok and meta exists.
   * Extended later with stdout / stderr — bash subprocess output, the data
   * source of the result-preview tail window; same observation bypass,
   * invisible to the model.
   */
  readonly payload?: {
    readonly oldContent?: string;
    readonly newContent?: string;
    readonly stdout?: string;
    readonly stderr?: string;
  };
}

export interface BuildTuiDepsOptions {
  readonly askUser: AskUser;
  /** Tool completion event; attribution rules live in hub-bridge.ts
   *  (attribute only when a single session is in flight). */
  readonly onToolEvent?: (event: TuiToolEvent) => void;
  /**
   * Attribution query: whether exactly one session is in flight now (returns
   * its id if so). With concurrent sessions events are suppressed — better to
   * miss than to mis-attribute (see hub-bridge.ts known boundary).
   */
  readonly soleInflightId?: () => string | undefined;
  /**
   * Mutable permission-mode context (the TUI flips it with Shift+Tab).
   * Absent = static default context (historical behavior preserved; the hub's
   * ToolExecutionContext still adapts via asModeContext).
   */
  readonly permissionMode?: PermissionModeContext;
  /**
   * Session-level grant registry — the permission modal's "always allow"
   * writes an allow rule into the session layer (highest-priority normal
   * layer), so later calls of the same tool pass checkPermission without
   * asking. Absent = no session layer (historical behavior).
   */
  readonly sessionGrants?: SessionGrants;
  /**
   * Graph-orchestration overlay holder (ADR-0030; the TUI flips it with
   * Shift+Tab or `/graph`). Passed through to build-engine — `run_graph` and
   * the orchestration segment gate on the returned `graphAssembly` snapshot
   * each round. Absent = this entry point has no overlay wired.
   */
  readonly graphMode?: GraphModeContext;
  /**
   * Filesystem isolation tier holder (ADR-0092; the TUI flips it via
   * `/config`). Passed through to build-engine — `BuildEngineOpts.fsMode` →
   * the bash factory reads it per call (foreground fence and background spawn
   * share one frozen value; sandbox discipline). Absent = this entry point
   * has no fs tier (the engine defaults to the global tier).
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0119 / specs/yolo-mode.md: yolo no-sandbox holder (same shape as
   * fsMode). Passed through to build-engine — `BuildEngineOpts.yolo` → the bash
   * factory reads per call (foreground fence / background spawn / verify /
   * subagent env wire share one source). Absent = this entry point did not wire
   * the yolo axis (the engine uses the non-yolo fail-closed default).
   *
   * Not persisted: the yolo axis never enters settings / session files / a
   * config panel row (spec §5).
   */
  readonly yolo?: YoloContext;
  /**
   * Runtime subagent concurrency cap holder (ADR-0096; same shape as fsMode).
   * Passed through to build-engine — `BuildEngineOpts.subagentCapacityHolder`
   * → `createSubAgentManager` (the spawn gate reads it fresh each time) +
   * registry → the spawn_subagent tool description (getter, same source).
   * Absent = engine and tool surface use the static env/subagent values
   * (byte-equal to prior behavior).
   */
  readonly subagentCapHolder?: SubagentCapacityHolder;
  /**
   * Worktree-gate runtime toggle holder (ADR-0096; same shape as fsMode /
   * cap). Passed through to build-engine —
   * `BuildEngineOpts.worktreeOnMutateHolder` → the mutate gate reads it fresh
   * at each wave entry (one read per wave; a panel flip takes effect on the
   * next wave of tool calls). Absent = the gate falls back to the boot-time
   * frozen reading (`resolveWorktreeOnMutate(settings)`), byte-equal to prior
   * behavior.
   */
  readonly worktreeOnMutateHolder?: WorktreeOnMutateHolder;
  /**
   * Live-graph ledger host (self-built singleton in run.tsx). Passed through
   * to build-engine — the `run_graph` handler resolves the session ledger by
   * ctx.conversationId. Absent = the tool keeps no ledger (no behavior
   * change).
   */
  readonly liveGraphLedger?: LiveGraphLedgerHost;
  /** ADR-0036: preimage ledger shared with the hub's commit side. The write
   *  tools fill it via the capture closure built below; the hub drains it when
   *  appending this session's `tool_result` events. Absent → no capture. */
  readonly preimageLedger?: import("../session-api/store/preimage-ledger.js").PreimageLedgerHost;
  /** Test seam: userHome override (default homedir()). */
  readonly userHome?: string;
  /** Test seam: cwd override (default process.cwd()). */
  readonly cwd?: string;
  /**
   * ADR-0019: per-root state anchor — the CLI `--workspace-root` flag passes
   * through to build-engine. The TUI entry (tui/run.tsx) forwards
   * `RunTuiOptions.workspaceRoot` to buildTuiDeps → buildHarnessEngine. The
   * TUI keeps no global state beyond userHome/cwd; workspaceRoot stays
   * one-directional and transparent at the deps layer.
   */
  readonly workspaceRoot?: string;
  /**
   * Session pool root (same shape as `createTuiBridge.dataDir` /
   * `RunTuiOptions.dataDir`) — the todo session-folder root derives from this
   * + `workspaceRoot` via
   * `resolveProjectSessionDir(resolveServeDataDir(dataDir),
   * deriveProjectIdentityRoot({ cwd: workspaceRoot }))`. Absent →
   * `resolveServeDataDir` defaults to `~/.iknow` (ADR-0087). run.tsx passes
   * the already-resolved dataDir so the bridge's SessionStore and the todo
   * landing share the same projects/<slug>/.
   */
  readonly dataDir?: string;
  /**
   * Stable main checkout root. Captured at first assembly and passed through
   * rebinds verbatim; reload's mcpConfigRoot derives only from this — never
   * recomputed from cwd.
   */
  readonly productRoot?: string;
  /**
   * Observability floor: JSONL trace write directory. When present, the three
   * subagent events go to build-engine (same shape as the serve hub:
   * `<traceOut>/subagent.jsonl`).
   */
  readonly traceOut?: string;
  /**
   * Current TUI session's conversationId (ADR-0071) — used to derive
   * `<parent session folder>/subagents/`. The caller (tui/run.tsx) forwards
   * it after getting soleInflightId from hub-bridge.
   *
   * Fact: at TUI assembly time (run.tsx's buildTuiDeps call site) nothing is
   * marked inflight yet — the session is injected by the hub per run and the
   * engine is built before the first message. So run.tsx currently does not
   * pass this field and buildTuiDeps uses the randomUUID() fallback (accepted
   * per SC8: unique per build; re-derived on rebuild / ensureSession). Where
   * subagent records actually land is the def.conversationId that
   * subagentManager receives at spawn (hub-bridge postMessage → tool ctx →
   * manager); the file anchor is
   * `<projectDir>/<assembly-time id>/subagents/agent-<taskId>.jsonl`.
   */
  readonly conversationId?: string;
  /** Test seam: MCP client factory override (inject a stub to avoid real stdio startup). */
  readonly createMcpClient?: (
    server: import("../harness/mcp/config.js").McpServerConfig
  ) => import("../harness/mcp/manager.js").McpClientHandle;
  /**
   * Test seam: createMcpManager factory override. The counterpart of
   * createMcpClient — tests capture createMcpManager's arguments here (e.g.
   * timeoutMs forwarding) to avoid mock.module triggering the bun require
   * deadlock (known bun 1.3.14 issue).
   */
  readonly createMcpManager?: typeof import("../harness/mcp/manager.js").createMcpManager;
  /**
   * Synchronous callback fired after assembly, exposing the extension surface
   * (skillCatalog / mcp / shutdown) for consumption: slash candidate
   * derivation, MCP status display, exit path closure.
   */
  readonly onExtensions?: (ext: TuiExtensions) => void;
  /**
   * Worktree isolation host seam (ADR-0037) — passed through to
   * buildHarnessEngine. The switch itself is read from `settings` at the
   * build-engine load point; when ON, the TUI engine's mutates are gated:
   * provision creates the task worktree and rebinds only this session's root
   * (the TUI hub's per-root rebuild seam lives in run.tsx / hub-bridge).
   * Absent → no wrapping, byte-identical to prior behavior.
   */
  readonly worktreeIsolation?: WorktreeIsolationHostOpts;
  /**
   * The settings object read at the boot assembly point — the `settings` seam
   * passed to buildHarnessEngine. Per-root rebuilds after a rebind reuse the
   * same object run.tsx passed, so a worktree's missing `.iknow/`
   * (gitignored) never silently reloads project settings. Absent →
   * build-engine loads its own default (equivalent to prior behavior).
   */
  readonly settings?: IknowSettings;
}

/**
 * The TUI extension surface exposed after assembly.
 *  - skillCatalog: read available()/get() to derive slash candidates + loaded
 *    bodies;
 *  - mcp.status / reload: MCP server connection snapshot + reload after
 *    re-reading the two config levels;
 *  - listMcpTools: pull all mcp__* tools once → flat `{ server, tool }[]`;
 *    the detail view filters by server (avoids N filter passes);
 *  - shutdown: called on the TUI exit path — close all MCP clients + cancel
 *    in-flight + SIGTERM stdio.
 */
export interface TuiExtensions {
  readonly skillCatalog: SkillCatalog;
  /**
   * Live rescan seam for the loadable surface. The TUI slash candidate panel
   * refreshes through it when opened (a SKILL.md written mid-session enters
   * candidates immediately, without waiting for the next turn). This is the
   * **same holder** as `BuiltEngine.skillRescanner` /
   * `deps.skillIndexDelta`. Absent (ask surface / no todoDir injected /
   * fixture) → candidates stay the `skillCatalog` assembly snapshot forever.
   */
  readonly skillRescanner?: SkillRescanner;
  /**
   * Live taskRoot cell, consumed by TUI chrome renderers
   * (worktreeIsolationLines / resolveWorktreeChromeRoot). Since ADR-0079 the
   * slash assembly of skill bodies no longer reads this cell (bodies carry no
   * write-root trailer). Absent (fixture / tests) → chrome degrades to
   * workspaceRoot.
   */
  readonly liveTaskRoot?: LiveTaskRoot;
  /**
   * Worktree isolation tier (from build-engine's single `isolationEnabled`
   * read point). Since ADR-0079 the slash assembly of skill bodies no longer
   * consumes it; the field stays for assembly-surface compatibility (kept in
   * sync with app.tsx TuiAppProps.isolationOn).
   */
  readonly isolationOn?: boolean;
  readonly mcp: {
    readonly status: () => readonly McpServerStatus[];
    readonly reload: () => Promise<void>;
  };
  readonly listMcpTools: () => ReadonlyArray<McpToolExtEntry>;
  readonly shutdown: () => Promise<void>;
}

/** Minimal extension surface consumed by the MCP board (TuiAppProps.mcp; deps.ts SSOT). */
export interface TuiMcpViewExt {
  readonly status: () => readonly McpServerStatus[];
  readonly reload: () => Promise<void>;
  readonly listMcpTools: () => ReadonlyArray<McpToolExtEntry>;
}

export interface McpToolExtEntry {
  readonly server: string;
  readonly tool: AciToolDef;
}

/**
 * Recover the server name from a dynamic tool name: `mcp__<server>__<tool>`
 * (either segment may itself contain `__` — the manager's sanitizeSegment only
 * replaces non-`[A-Za-z0-9_]` with `_`, keeping hyphens / dots). Returns the
 * middle `server` segment; on too few segments (non-standard shape) returns
 * the original name. Pure function + exported for direct unit assertions.
 */
export function mcpServerOfToolName(name: string): string {
  const body = name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
  const sep = body.indexOf("__");
  if (sep === -1) return name;
  return body.slice(0, sep);
}

/**
 * Optional-field landing helper: emits `{ [key]: value }` only when the value
 * is present, otherwise an empty object. The conditional-spread chain in
 * `buildTuiDeps`' return block all goes through here, so host destructuring
 * semantics are unchanged (absent fields simply do not appear).
 */
function presentFields<V>(
  key: string,
  value: V | undefined
): { readonly [k: string]: V } {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Observability seam: wraps the TUI's onToolEvent + soleInflightId attribution
 * into build-engine's PostToolUseHook (passed through to
 * createAciExecutor). Semantics match the pre-delegation form: postToolUse
 * fires → soleInflightId attribution → onToolEvent projection into
 * TuiToolEvent. soleInflightId absent/undefined (concurrent sessions) →
 * events suppressed.
 */
/** ADR-0036: build the pre-write capture seam when the hub shares its ledger
 *  with this assembly. Absent ledger → `undefined` (no capture). The closure
 *  writes blobs + records refs the hub drains at commit; Gate B holds because
 *  deps.ts is host-side and the harness stays clean. */
function buildTuiPreimageCapture(
  opts: BuildTuiDepsOptions,
  projectDir: string
): PreimageCapture | undefined {
  const ledger = opts.preimageLedger;
  if (ledger === undefined) return undefined;
  return createPreimageCapture({
    getProjectDir: () => projectDir,
    ledger,
    isEnabled: () => opts.settings?.codeRestore?.enabled !== false,
  });
}

function wrapTuiHook(opts: BuildTuiDepsOptions): PostToolUseHook {
  return (result) => {
    if (!opts.onToolEvent) return;
    const conversationId = opts.soleInflightId?.();
    // Concurrent sessions → cannot attribute → suppress (known v1 boundary, see hub-bridge.ts).
    if (conversationId === undefined) return;
    opts.onToolEvent({
      conversationId,
      toolName: result.name,
      // Pass tool_use_id through so the TUI pairs it with streaming
      // tool_call_start (result.toolUseId is required; see permission/types.ts
      // PostToolUseHook).
      toolUseId: result.toolUseId,
      kind: result.kind,
      input: result.input,
      message: result.message,
      // meta passthrough → TuiToolEvent.payload (observation side channel).
      payload: result.meta,
    });
  };
}

export async function buildTuiDeps(
  bundle: RuntimeBundle,
  opts: BuildTuiDepsOptions
): Promise<
  /**
   * deps fields are flattened in sync with `EngineBundle` —
   * `Omit<EngineBundle,"deps">` locks the SSOT; `memoryFlags?` is a
   * TUI-only extension (Esc flips the box). Not returning a plain
   * `EngineBundle` because this shape flattens `deps` into
   * `LoopEngineDeps`, so hosts destructure without `result.deps.x`.
   */
  LoopEngineDeps &
    Omit<EngineBundle, "deps"> & {
      readonly memoryFlags?: MemoryLiveFlags;
      readonly invalidateMemorySystem?: () => void;
    }
> {
  if (!bundle.env.llm.apiKey) {
    // key source = settings.llm.apiKey (literal or ${VAR}).
    throw new Error(LLM_API_KEY_MISSING_MESSAGE);
  }
  // userHome / cwd test seams (default = real homedir() / process.cwd()),
  // same shape as build-engine's. The assembly-time skill scanner and mcp
  // config both read from here.
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  // Compatibility with `opts.traceOut` (test seam / old path) → still lands in
  // diagnosticsDir (stderr pointer); when absent, the manager's internal
  // effectiveDiagnosticsDir follows subagentsDir as fallback.
  const traceOut = opts.traceOut;
  // ADR-0071: the TUI entry injects the "session folder root" so todo_write
  // is present in the main loop — same-source SSOT with chat / serve: the
  // same `(baseDir, projectIdentityRoot)` derivation formula
  // (resolveProjectSessionDir) resolves one conversation to one projectDir.
  // The TUI's conversationId is injected by the hub per run (hub-bridge →
  // SessionHub), not assembled here — this layer only provides the root.
  const todoProjectDir = resolveProjectSessionDir(
    resolveServeDataDir(opts.dataDir),
    deriveProjectIdentityRoot({ cwd: opts.workspaceRoot })
  );
  // ADR-0088: background task registry root — same `(dataDir,
  // projectIdentityRoot)` pair as todoProjectDir, so tasks/ is a sibling in
  // the same project slug tree. Decoupled from workspaceRoot (throwaway roots
  // do not open a second live ledger).
  const tasksDir = resolveTasksDir({
    dataDir: resolveServeDataDir(opts.dataDir),
    projectIdentityRoot: deriveProjectIdentityRoot({ cwd: opts.workspaceRoot }),
  });
  const memoryDir = join(todoProjectDir, MEMORY_DIR_NAME);
  // ADR-0071: subagent lifecycle / content trace goes per-agent via
  // `<parent session folder>/subagents/agent-<taskId>.jsonl`.
  // The TUI subagent root = `<projectDir>/<conversationId>/subagents/`.
  //
  // At TUI assembly time the deps layer cannot know the real conversationId —
  // the session is injected by the hub per run (hub-bridge.ensureSession →
  // mark → subagentManager gets the task def.conversationId), and run.tsx
  // builds the initial engine while inflight is still empty. Two valid
  // shapes:
  //   - (a) caller knows (opts.conversationId present) → use it;
  //   - (b) caller does not know → assembly-time randomUUID() fallback,
  //     accepted (unique per build; re-derived at rebuild/ensureSession, with
  //     the engine-rebuild seam as the transfer point — the hub's buildEngine
  //     path gets the real conversationId).
  // Two-phase seam design: assembly-time root + call-time id — the existing
  // resolveConversationTodoPath in todo-write.ts is isomorphic; do not invent
  // a new shape.
  // The TUI bridge's postMessage hook (inflight.mark) forwards the session id
  // into the tool ctx.conversationId, which is enough for the manager to use
  // def.conversationId.
  const subagentsConversationId = opts.conversationId ?? randomUUID();
  const subagentsDir = resolveSubagentTraceDir({
    projectDir: todoProjectDir,
    conversationId: subagentsConversationId,
  });
  // Live-graph ledger host — self-built at the TUI assembly point, hanging on
  // the session runtime parallel to graphMode.
  const liveGraphLedger = opts.liveGraphLedger;
  const built = await buildHarnessEngine({
    env: bundle.env,
    askUser: opts.askUser,
    surface: "tui",
    memory: { enabled: true },
    todoDir: todoProjectDir,
    // ADR-0088: the registry root follows the session pool, not workspaceRoot.
    tasksDir,
    // ADR-0099: project memory follows the same tree, not workspaceRoot.
    memoryDir,
    // The sandbox root keeps TUI's historical semantics (launch dir =
    // process.cwd()); build-engine already defaults to process.cwd(), so it
    // is not passed explicitly.
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.sessionGrants ? { session: opts.sessionGrants } : {}),
    // Overlay holder passthrough — the conditional assembly seam for
    // run_graph / the orchestration segment.
    ...(opts.graphMode ? { graphMode: opts.graphMode } : {}),
    // ADR-0092: fs isolation holder passthrough — the bash factory reads per
    // call (build-engine guards on `!== undefined`, so absent and explicit
    // undefined are equivalent).
    fsMode: opts.fsMode,
    // ADR-0119 / specs/yolo-mode.md: yolo holder passthrough — the bash factory
    // reads per call (build-engine treats `undefined` and "key absent" the same
    // = non-yolo fail-closed).
    yolo: opts.yolo,
    // ADR-0096: cap holder passthrough — build-engine uses it instead of a
    // one-shot boot snapshot of env.subagent.maxConcurrentWorkers (the spawn
    // gate reads holder.get() each time); forwarded in the same source to
    // registry → the spawn_subagent tool description getter. Both paths in
    // one: one flip of the TUI /config panel takes effect globally.
    // Direct passthrough — BuildEngineOpts.subagentCapacityHolder is optional
    // and absent = undefined, so the `!== undefined` guard needs no ternary.
    subagentCapacityHolder: opts.subagentCapHolder,
    // ADR-0096: worktree gate holder passthrough — build-engine reads
    // holder.get() at each mutate-wave entry instead of one boot reading.
    // Same as above, direct passthrough (optional + `!== undefined` guard).
    worktreeOnMutateHolder: opts.worktreeOnMutateHolder,
    // Live-graph ledger host passthrough (self-built at the TUI assembly point).
    ...(liveGraphLedger ? { liveGraphLedger } : {}),
    // ADR-0036: pre-write capture seam (undefined when the hub shares no ledger
    // — buildHarnessEngine forwards it straight to the write tools).
    preimageCapture: buildTuiPreimageCapture(opts, todoProjectDir),
    // Observability seam: tool summary lines — postToolUse projected into TuiToolEvent.
    ...(opts.onToolEvent ? { hooks: wrapTuiHook(opts) } : {}),
    // Test seams: userHome / cwd overrides (same shape as build-engine's).
    ...(opts.userHome ? { userHome } : {}),
    ...(opts.cwd ? { cwd } : {}),
    // ADR-0019: per-root state anchor passthrough to build-engine.
    ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
    // Stable productRoot passthrough (absent → build-engine bridges to workspaceRoot).
    ...(opts.productRoot ? { productRoot: opts.productRoot } : {}),
    // Observability floor: subagent lifecycle / content go per-agent
    // (subagentsDir); `opts.traceOut` is still passed as
    // subagentDiagnosticsDir (stderr pointer) for old-path compatibility;
    // when absent the manager internally follows subagentsDir.
    subagentsDir,
    // Same store reader the hub's rebuild path injects, so the initial build
    // and every rebind assemble identically.
    subagentActivityReader: readWorkerInFlightToolName,
    ...(traceOut !== undefined ? { subagentDiagnosticsDir: traceOut } : {}),
    // Test seam: createMcpManager factory override (passthrough; tests capture args).
    // prettier-ignore kept on one line verbatim (88 chars > 80 cols; reformatting disabled here).
    // prettier-ignore
    ...(opts.createMcpManager ? { createMcpManager: opts.createMcpManager } : {}),
    // Test seam: MCP client factory override.
    ...(opts.createMcpClient ? { createMcpClient: opts.createMcpClient } : {}),
    // Boot-assembly settings object + worktree isolation host seam
    // passthrough (the switch itself is still read at build-engine's load point).
    ...(opts.settings ? { settings: opts.settings } : {}),
    ...(opts.worktreeIsolation
      ? { worktreeIsolation: opts.worktreeIsolation }
      : {}),
  });

  // Build the TUI extension surface from build-engine's exposed assemblies.
  // skillCatalog / mcpManager / catalog all come from the single
  // buildHarnessEngine assembly point (surface="tui" is fully assembled;
  // mcpManager only as a defensive default when the manager is absent).
  const mcpManager = built.mcpManager;
  const skillCatalog = built.skillCatalog;
  const skillRescanner = built.skillRescanner;
  const catalog = built.catalog;

  // reload: re-read the two config levels (users trigger it after editing
  // ~/.iknow/mcp.json or a project mcp.json); manager.reload internally does
  // shutdown + rebuild + background start.
  // Idempotent: no mcp.json → empty servers → reload to empty set.
  // mcpConfigRoot locks the assembly-time productRoot /
  // BuiltEngine.mcpRoots — it never drifts with task cwd and never reads
  // process.cwd().
  const mcpConfigRoot =
    built.mcpRoots?.mcpConfigRoot ??
    opts.productRoot ??
    opts.workspaceRoot ??
    cwd;
  const reload = async (): Promise<void> => {
    if (!mcpManager) return;
    const cfg = await loadMcpConfig({ home: userHome, mcpConfigRoot });
    await mcpManager.reload(cfg.servers);
  };

  // listMcpTools: take all mcp__* dynamic tools from catalog.all(), reverse-
  // parse the server name (mcp__<server>__<tool>) and flatten to
  // {server, tool}[]. The tool set changes after reload (unregister +
  // register), so the detail view just refetches on each entry (TuiApp cache
  // policy: fetch once when the board is first entered, refresh after reload).
  const listMcpTools = (): ReadonlyArray<McpToolExtEntry> => {
    if (!catalog) return [];
    const out: McpToolExtEntry[] = [];
    for (const def of catalog.all()) {
      if (!def.name.startsWith("mcp__")) continue;
      out.push({ server: mcpServerOfToolName(def.name), tool: def });
    }
    out.sort((a, b) => a.server.localeCompare(b.server));
    return out;
  };

  // After assembly, expose the extension surface through the synchronous
  // callback. shutdown is consolidated in build-engine's combined handle
  // (MCP client close + in-flight cancel + SIGTERM stdio descendants +
  // subagent drain). With surface="tui", skillCatalog / mcpManager / shutdown
  // are all built outside the ask surface; asserted here to narrow the types;
  // extreme defensive defaults (empty catalog / no-op shutdown) keep the
  // callback from throwing.
  opts.onExtensions?.({
    skillCatalog: skillCatalog!,
    // Rescan seam exposed to the TUI slash candidate panel — same holder as
    // the engine's `deps.skillIndexDelta` (plugin-root refresh happens only
    // on that one holder). Absent (ask surface / no todoDir injected) →
    // TuiApp degrades to the cached snapshot, byte-identical to the old form.
    // Routed through `presentFields` rather than an inline ternary: the
    // file's existing optional-field discipline (and the complexity ratchet
    // does not accept new branches).
    ...presentFields("skillRescanner", skillRescanner),
    // Live taskRoot cell exposed for TUI chrome rendering. Since ADR-0079 the
    // slash assembly of skill bodies no longer reads this cell (bodies carry
    // no write-root trailer).
    ...(built.liveTaskRoot !== undefined
      ? { liveTaskRoot: built.liveTaskRoot }
      : {}),
    // Worktree isolation tier exposure. Since ADR-0079 the slash assembly no
    // longer consumes it; kept so the TuiExtensions surface stays compatible
    // (in sync with TuiAppProps.isolationOn).
    ...(built.isolationOn !== undefined
      ? { isolationOn: built.isolationOn }
      : {}),
    mcp: {
      status: () => mcpManager?.status() ?? [],
      reload,
    },
    listMcpTools,
    shutdown: async () => {
      // Always built for surface="tui"; extreme defensive default is no-op.
      if (built.shutdown) await built.shutdown();
    },
  });

  return {
    ...built.deps,
    ...presentFields("subagentManager", built.subagentManager),
    ...presentFields("shutdown", built.shutdown),
    ...presentFields("graphAssembly", built.graphAssembly),
    // Auto-memory hooks flattened out with deps; run.tsx destructures and
    // hands them to createTuiBridge → SessionHub. Absent (memory layer off) →
    // field does not appear; both-off still exposes (mechanical segment).
    ...presentFields("autoMemory", built.autoMemory),
    ...presentFields("overlayMemoryPrefetch", built.overlayMemoryPrefetch),
    ...presentFields("memoryFlags", built.memoryFlags),
    // Memory-system snapshot invalidation handle, flattened with deps — the
    // app layer calls it on /memory commit; the flip takes effect next round.
    // Absent (non-TUI / injected shape) → do not call.
    ...presentFields("invalidateMemorySystem", built.invalidateMemorySystem),
  };
}
