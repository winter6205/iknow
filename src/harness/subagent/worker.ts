/**
 * Subagent worker process entry.
 *
 * Shape = headless re-entry of the same iknow binary: `node <iknow-bin> --subagent-worker`.
 * After the parent spawns us:
 *   - stdin  one JSON line = WorkerEnvelope (parseWorkerEnvelope, schema frozen);
 *   - the worker process runs its own run() (independent registry, no parent registry);
 *   - stdout one JSON line = SubAgentEnvelope (condensed result, truncateEnvelopeResult before emit);
 *   - stderr is logs only (never pollute the wire).
 *
 * Key disciplines:
 *   - stdout is a single strict wire: everything non-envelope goes to
 *     process.stderr.write; console.log to stdout is forbidden;
 *   - SIGTERM-friendly shutdown (runSubagentWorker is dispatched by cli.ts; the
 *     current implementation exits explicitly with process.exit(WORKER_EXIT_OK)
 *     to guarantee stdout flush);
 *   - exit-code semantics follow ADR-0111 invariant (b), codified in the
 *     WORKER_EXIT_* constants:
 *     exit 2 is envelope-protocol errors only (parse ProtocolError rethrown,
 *
 // (ADR-0001)
 *     caught by cli.ts);
 *     an escape from the run phase → best-effort failed envelope + exit 1;
 *   - env is inherited from the parent (no second env protocol invented);
 *   - the worker child has no spawn_subagent (v1 forbids nested dispatch —
 *     createDefaultAciRegistry gets no subagentManager).
 *
 * Test seam: production runSubagentWorker() uses real assembly; runWorkerOnce(opts)
 * splits envelope → run → truncateEnvelopeResult so tests inject stub deps
 * (createStubModel) without spawning a real worker child.
 */
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { workerFenceTmpBesideRecord } from "../sandbox/fence-tmp.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  loadIknowEnv,
  wireModelFromRoute,
  type IknowEnv,
  type SubagentModelEnv,
} from "../../config/env.js";
import { loadIknowSettings } from "../../config/settings.js";
import {
  FS_MODE_ENV_KEY,
  WORKSPACE_ROOT_ENV_KEY,
  WORKTREE_GATE_ON_ENV_KEY,
  resolveWorkspaceRoot,
} from "../../config/workspace-root.js";
import {
  createFsModeContext,
  parseFsModeFlag,
  type FsModeContext,
} from "../sandbox/fs-mode.js";
import {
  YOLO_ENV_KEY,
  createYoloContext,
  parseYoloFlag,
  yoloHolderSpread,
  type YoloContext,
} from "../sandbox/yolo.js";
import {
  createRealAnthropicAdapter,
  buildThinkingParams,
  createExecutor,
  withTransportRetry,
  translateAnthropicTransportFault,
  type LoopEngineDeps,
} from "../index.js";
import { createDefaultAciRegistry } from "../aci/tools/registry.js";
import { createAciExecutor } from "../aci/index.js";
import type { AciCatalog } from "../aci/types.js";
import { createLspNotifier } from "../lsp/notifier.js";
import { withLazyLspWarmup } from "../lsp/warmup.js";
import { DEFAULT_LSP_IDLE_TIMEOUT_MS } from "../lsp/client.js";
import { deriveFileRefs, writeToolNamesFrom } from "./file-refs.js";
import { createPermissionPolicy } from "../permission/policy.js";
import { resolveProjectPermissionSource } from "../permission/project-settings.js";
import { createNoAskUser } from "../permission/ask-user.js";
import {
  composePostHooks,
  composePreHooks,
  createPluginHooksFromCatalog,
  createSettingsHookContribution,
} from "../hooks/index.js";
import { type WorktreeGateReader } from "../isolation/worktree-gate.js";
import { createIknowSystemResolver } from "../identity/index.js";
import { createGitSnapshotProvider } from "../identity/git-snapshot.js";
import { createSkillScanner, type PluginSkillDir } from "../skill/scanner.js";
import { createSkillCatalog } from "../skill/catalog.js";
import { resolvePluginCatalog, resolvePluginRoots } from "../plugin/roots.js";
import { createJsonlTraceService, type TraceService } from "../trace/index.js";
import { run, epilogueSummary } from "../loop-engine.js";
import type { HarnessStreamEvent } from "../stream.js";
import { TRANSPORT_RETRY_DETAIL_INVISIBLE_TIMEOUT } from "../stream.js";
import { resetsModelIdle } from "../race-timers.js";
import {
  errorMessage,
  MaxTurnsExceeded,
  ModelStreamIncompleteError,
  ProtocolError,
} from "../errors.js";
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import {
  AgentCatalogLookupError,
  type AgentCatalogResolver,
} from "./catalog.js";
import { createMergedCatalogResolver } from "./user-catalog.js";
import { resolveSubagentCapabilities, type BashMode } from "./capability.js";
import {
  isTaskWorktreePath,
  mainCheckoutOf,
} from "../isolation/worktree-gate.js";
import {
  parseWorkerEnvelope,
  truncateEnvelopeResult,
  type SkillIndexSnapshotEntry,
  type SubAgentEnvelope,
  type WorkerEnvelope,
} from "./envelope.js";
import { toolConstraintsSegment } from "../identity/assemble.js";
import type { SkillSummary } from "../identity/assemble.js";
import type { SkillCatalogFaces } from "../skill/catalog.js";
import { writeRootSegment } from "../skill/body.js";

/** stderr log prefix (a warn line must never leak env values). */
const LOG_PREFIX = "[subagent-worker]";

function log(message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

/** default worker trace dir; the per-root anchor wins over the process cwd. */
const DEFAULT_WORKER_TRACE_DIR = "trace";

/**
 * Look up the catalog for the persona segment text (catalog body).
 * Missing role → general-purpose (aligned with the spawn_subagent default role).
 * Unknown ids take the catch path (defense-in-depth): the spawn side already
 * validates once with ajv, so this is a wire-mismatch backstop; the
 * envelope-role unit test explicitly locks the fallback content (never
 * silently swallowed — the assembly layer logs one line, output still has no persona).
 *
 * The catalog is passed in by the caller (the worker builds a merged resolver
 * per userHome at assembly time, including ~/.iknow/agents/ user roles).
 */
function resolvePersonaBody(
  role: string | undefined,
  catalog: AgentCatalogResolver
): string | undefined {
  const id = role ?? "general-purpose";
  try {
    return catalog.get(id).body;
  } catch (err) {
    if (err instanceof AgentCatalogLookupError) {
      log(`role '${id}' not in catalog; falling back to V1 baseline`);
      return undefined;
    }
    throw err;
  }
}

/**
 * Look up the catalog for bashMode and derive the tool-constraints segment text.
 * bashMode="readonly" → inject the "Tool constraints for this run" segment;
 * anything else (role absent / unknown / bashMode absent / bashMode="any") →
 * no injection, V1 baseline (byte-stable, segment absent).
 *
 * Defense contract mirrors resolvePersonaBody: role absent / unknown → no
 * throw; the assembly layer catches and falls back. The catalog is read-only
 * data with no side effects.
 */
function resolveConstraintsText(
  role: string | undefined,
  catalog: AgentCatalogResolver
): string | undefined {
  if (role === undefined) return undefined;
  try {
    const entry = catalog.get(role);
    if (entry.bashMode === "readonly") {
      return toolConstraintsSegment("readonly");
    }
    return undefined;
  } catch (err) {
    if (err instanceof AgentCatalogLookupError) {
      log(`role '${role}' not in catalog; falling back to V1 baseline`);
      return undefined;
    }
    throw err;
  }
}

/**
 * Additive-segment injection wrapper (base < persona < constraints).
 *
 * Order contract:
 *   - persona: catalog body, role identity.
 *   - constraints: appended when readonly mode, an extension of the mode semantics.
 *
 * ADR-0112: the addendum (envelope.systemPrompt, parent-model-writable) is
 * demoted out of the system channel — a writable segment buys no system seat,
 * it goes through user/untrusted instead (see priorMessagesFromEnvelope).
 * persona / constraints come from trusted role config (catalog) and are not demoted.
 *
 * When both default away, the outer short-circuit returns base: byte-stable,
 * preserving the V1 baseline. base absent → output is just the two extras
 * joined in order; either absent → that slot is filtered out of the extras
 * array and the order is unchanged.
 *
 * Additive segments append after the base system and never reorder the 6
 * LOCKED segments of IKNOW_ASSEMBLY_ORDER (identity / soul / usage /
 * user_profile / bootstrap / memory_layer).
 */
function withRoleExtras(
  base: () => Promise<string | undefined>,
  persona: string | undefined,
  constraints: string | undefined
): () => Promise<string | undefined> {
  return async () => {
    const baseText = await base();
    const extras = [persona, constraints].filter(
      (s): s is string => s !== undefined
    );
    if (extras.length === 0) return baseText;
    if (baseText === undefined) return extras.join("\n\n");
    return baseText + "\n\n" + extras.join("\n\n");
  };
}

/**
 * Worker assembly inputs (the createWorkerDeps seam).
 *
 * Production path runSubagentWorker() passes only env + sandboxRoot; tests may
 * override model (stub) / trace (noop) / skillCatalog / system / userHome / cwd.
 */
export interface CreateWorkerDepsOptions {
  /** The full IknowEnv read from loadIknowEnv() (production path). */
  readonly env: IknowEnv;
  /** Soft sandbox root (the worker fs tools' containment bound, from WorkerEnvelope.sandboxRoot). */
  readonly sandboxRoot: string;
  /** Test seam: inject a stub model (createStubModel) in place of the real Anthropic adapter. */
  readonly model?: LoopEngineDeps["adapter"];
  /** Test seam: custom skill catalog (default = worker's own scan). */
  readonly skillCatalog?: ReturnType<typeof createSkillCatalog>;
  /** Test seam: trace service (default = createJsonlTraceService; unit tests cover noop). */
  readonly trace?: TraceService;
  /** Test seam: override userHome (default homedir(); unit tests use tmp fixtures to isolate the real user dir). */
  readonly userHome?: string;
  /** Test seam: override cwd (default process.cwd()). */
  readonly cwd?: string;
  /** Test seam: override the system resolver (default createIknowSystemResolver). */
  readonly system?: LoopEngineDeps["system"];
  /** Test seam: override maxTurns (envelope.maxTurns > env.llm.maxTurns takes priority). */
  readonly maxTurns?: number;
  /** Deny-list from WorkerEnvelope.disallowedTools, passed through to
   *  createDefaultAciRegistry for def-list-time pruning (declared surface =
   *  actual surface). Absent / undefined prunes nothing, backward compatible. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** ADR-0019: per-root state anchor. Threaded to `createDefaultAciRegistry`
   *  → read_file's `extraReadRoots` so `<workspaceRoot>/.iknow` is reachable
   *  at parity with the home profile. ADR-0092 global mode: not a bind root;
   *  bash no longer threads it. Absent → registry falls back to sandboxRoot
   *  (legacy shape). */
  readonly workspaceRoot?: string;
  /**
   * ADR-0037: project identity root, two consumer surfaces.
   *   - Identity discovery (unchanged): rules / project `AGENTS.md` / project
   *     skills read it, not the worker's own cwd — after a rebind the cwd is a
   *     bare tree without `.iknow`; absent → falls back to cwd (unbound case:
   *     both equal, bytes unchanged).
   *   - Bash fence read whitelist: createWorkerRuntime passes it (absent →
   *     `mainCheckoutOf(sandboxRoot)`) to registry → bash factory → per-call
   *     createFsPolicy contract-read roots whenever the fence taskRoot
   *     (sandboxRoot) is a task-worktree shape (whenever provided it always
   *     joins; fail-loud is the policy layer's job). The production build-engine
   *     spawn site unconditionally injects `sessionRoots.projectIdentityRoot`
   *     (IKNOW_PRODUCT_ROOT wire), the same value the main-chain registry gets
   *     (build-engine isolationEnabled tier).
   */
  readonly projectIdentityRoot?: string;
  /**
   * ADR-0092: fs-isolation-tier holder (per-call snapshot) threaded to the
   * worker's bash factory. Holder absent → global tier (V1 baseline).
   * homeRoot is not a separate seam: the assembly layer derives it from the
   * already-resolved `userHome` here (opts.userHome ?? homedir()), same source
   * as settings / persona / state.
   *
   * At the production entry the holder is built by `fsModeOptionFromEnv(process.env)`
   * from the parent-written `IKNOW_FS_MODE` (see runSubagentWorker) — the worker
   * is a separate process and cannot see the parent's holder object, so the tier
   * crosses the boundary as a value and the holder is rebuilt in-process.
   */
  readonly fsMode?: import("../sandbox/fs-mode.js").FsModeContext;
  /**
   * In-process rebuilt holder for the worktree-on-mutate switch: the production
   * entry builds it via `worktreeGateOptionFromEnv(process.env)` from the
   * parent-written `IKNOW_WORKTREE_GATE_ON` ("1"/"0"). The worker has no gate
   * executor; this holder only feeds the bash factory's UNBOUND_FENCE decision.
   * Key absent / invalid → key absent → bash factory has no holder → never
   * emits the segment (legacy parent process, bytes unchanged).
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * ADR-0119 / specs/yolo-mode.md: yolo holder (per-call snapshot), passed to
   * the worker's bash factory. Holder absent → the fence is present (V1
   * baseline).
   *
   * The production entry's holder is built by `yoloOptionFromEnv(process.env)`
   * from the parent-written `IKNOW_YOLO` — the same env wire as `fsMode`, the
   * same "rebuild the holder in this process after the value crosses the
   * boundary" shape. The worker exposes no `/yolo` command face, so there is no
   * second in-place-flip entry; the holder shape is kept for the bash factory's
   * existing opt contract.
   */
  readonly yolo?: YoloContext;
  /**
   * Seam copy of envelope.role (passed through by runSubagentWorker).
   * The worker queries the catalog at assembly time for the body and injects
   * the persona segment; default / unknown → V1 baseline (no persona segment,
   * no extra deny injection).
   */
  readonly role?: string;
  /**
   * Explicit bash-mode override (takes priority over role derivation).
   * Default → the worker calls resolveBashMode(role) at assembly time:
   * role "explore" → "readonly", everything else → "any". This seam stays for
   * tests and future cross-stage injection (e.g. dispatching a readonly worker
   * directly without reading the catalog). Catalog routing remains the spawn
   * tool's job; the registry only passes through and never reads the catalog.
   */
  readonly bashMode?: "any" | "readonly";
  /**
   * ADR-0071: worker content-trace anchor passed through by
   * envelope.traceFilePath (the parent session has already created
   * `<parent session folder>/subagents/agent-<taskId>.jsonl` for this taskId).
   * When present, the worker's file-mode lands on that path with
   * conversationId=taskId, replacing the retired fake `randomUUID()` scope.
   * Absent → falls back to IKNOW_TRACE_OUT / defaultTraceDir (byte-stable).
   */
  readonly traceFilePath?: string;
  /**
   * Companion to traceFilePath — this worker's taskId (locked at parent spawn).
   * The production assembly (runSubagentWorker via the manager envelope) always
   * passes the `traceFilePath + taskId` pair together; both keys present is the
   * precondition for file-mode assembly. When traceFilePath is absent this field
   * is ignored (legacy IKNOW_TRACE_OUT fallback).
   *
   * The same taskId also feeds a second consumer:
   *
   // (ADR-0084)
   * `LoopEngineDeps.conversationId` — bucketing the worker's last-read ledger
   * by worker identity (the subagent's own empty bucket). Trace-unrelated
   * callers (test seams / assembly that only cares about the ledger) may pass
   * this field alone; absent → no id; a non-empty override fails closed.
   */
  readonly taskId?: string;
  /**
   * Explicit worker fence `/tmp` pad. Absent + `traceFilePath` present →
   * `<dirname(traceFilePath)>/fence-tmp` (nested `subagents/<taskId>/`).
   */
  readonly tmpDir?: string;
  /**
   * ADR-0085: parent-session ledger anchor (passed through by envelope.todoLedger).
   * `projectDir` = the parent session's project dir (same value as
   * `TodoWriteToolDeps.todoDir`); `conversationId` = the parent session id.
   * Present → the worker registry assembles todo_write sharing the parent's
   * single ledger (read / update allowed; `add` is typed-rejected by the tool
   * itself — adding is parent-only and the worker's permission layer is
   * no-ask, so it cannot backstop that). Absent (old wire / cross-version
   * resume) → todo_write is not assembled; tool surface byte-stable.
   */
  readonly todoLedger?: {
    readonly projectDir: string;
    readonly conversationId: string;
  };
  /**
   * The parent session's full model-index snapshot as of spawn time (passed
   * through by envelope.skillIndexSnapshot).
   *
   * Present (including empty array) → the worker's `<available_skills>` frozen
   * table uses it as the **sole source** — names the parent has already loaded
   * are not in the worker's scan, so a rescan cannot recover them; and parent
   * and worker may have different skill roots (plugin roots vary with reload /
   * working directory), so a by-name lookup would drop entries. Hence entries
   * are projected by name + description directly (rendering still goes through
   * `skillsSegment`, SSOT unchanged).
   * Absent (old wire / cross-version resume / direct assembly) → falls back to
   * the worker's own independent rescan (`createSkillScanner`, byte-identical
   * to before).
   */
  readonly skillIndexSnapshot?: readonly SkillIndexSnapshotEntry[];
}

/**
 * The single decision point for the worker's index surface — if the parent
 * snapshot is present use it, otherwise the worker's own catalog (legacy
 * behavior, byte-for-byte unchanged).
 *
 * Both paths produce `SkillSummary[]`; rendering stays with `skillsSegment`
 * (identity-layer SSOT) — the worker keeps no second renderer and never
 * pre-renders the segment (segment position / ordering / empty-list sentence
 * are all decided by that one function).
 *
 * Frozen-table discipline: the snapshot path projects once at assembly time
 * and freezes (the snapshot is a value that cannot change inside the worker
 * process; same idea as the git-snapshot seam — byte-stable between two
 * evaluations is a precondition of the KV-cache contract). The catalog path
 * keeps the existing shape (read on demand — the set itself was fixed at
 * assembly time).
 *
 * Snapshot entries carry the **parent's** name + description: parent and
 * worker may have different skill roots (plugin roots vary with reload /
 * working directory), and a by-name lookup in the worker catalog would drop
 * entries — the requirement is "complete", so entries are projected directly
 * (that name may have no loadable body in the worker; see the
 * CreateWorkerDepsOptions.skillIndexSnapshot comment).
 */
function systemSkillsGetter(opts: {
  readonly snapshot: readonly SkillIndexSnapshotEntry[] | undefined;
  readonly catalog: SkillCatalogFaces;
}): () => ReadonlyArray<SkillSummary> {
  if (opts.snapshot === undefined) {
    return () =>
      opts.catalog.available().map((entry) => ({
        name: entry.name,
        description: entry.description ?? "",
        ...(entry.disabled ? { disabled: true } : {}),
      }));
  }
  // Projection carries only name / description — no `disabled`: the model
  // index surface never contains disabled entries, so "disabled true" is not
  // a legal input in the snapshot (the envelope schema rejects the key too).
  const frozen: ReadonlyArray<SkillSummary> = Object.freeze(
    opts.snapshot.map((entry) =>
      Object.freeze({
        name: entry.name,
        ...(entry.description !== undefined
          ? { description: entry.description }
          : {}),
      })
    )
  );
  return () => frozen;
}

/**
 * ADR-0092: worker-side fs-tier read point — the tier literal written
 * by the parent via `IKNOW_FS_MODE` → the `fsMode` holder for `createWorkerDeps`.
 *
 * The worker is a separate process: no parent holder object can be shared, so
 * the tier crosses the process boundary as a value and the worker builds a new
 * holder seeded with that value. This matches the semantics "the tier is
 * constant within the worker process" — the worker exposes no `/config` face,
 * so there is no second in-place flip entry; the holder shape is kept only for
 * the bash factory's existing opt contract (handler per-call `get()`), not for
 * runtime flipping.
 *
 * Normalization goes through `parseFsModeFlag` (value-domain SSOT, same as the
 * settings segment / `/config`) instead of re-writing literal comparison in
 * the worker: case and surrounding whitespace fold by the same rule.
 * Missing / invalid → **key absent** (no explicit `global`) — same
 * spread-guard style as `workspaceRoot` / `productRoot`, so "absent" has only
 * one downstream interpretation and the legacy path (old parent not writing
 * the key) stays byte-identical.
 */
export function fsModeOptionFromEnv(
  env: Readonly<Record<string, string | undefined>>
): { readonly fsMode?: FsModeContext } {
  const mode = parseFsModeFlag(env[FS_MODE_ENV_KEY]);
  return mode !== undefined ? { fsMode: createFsModeContext(mode) } : {};
}

/**
 * Same discipline as `fsModeOptionFromEnv` for rebuilding the switch across
 * the process boundary — the value domain is just "1"/"0"; invalid → key
 * absent (downstream spread-guard drops it, same as an unwired channel),
 * never guessing the parent's intent inside the worker.
 */
export function worktreeGateOptionFromEnv(
  env: Readonly<Record<string, string | undefined>>
): {
  readonly worktreeOnMutate?: WorktreeGateReader;
} {
  const token = env[WORKTREE_GATE_ON_ENV_KEY];
  if (token !== "1" && token !== "0") return {};
  const on = token === "1";
  return { worktreeOnMutate: Object.freeze({ get: () => on }) };
}

/**
 * `IKNOW_YOLO` (written by the parent) → the worker bash factory's `yolo`
 * holder.
 *
 * Same shape as `fsModeOptionFromEnv` (the value crosses the boundary, then the
 * holder is rebuilt in this process). The parent normalizes the key when its
 * holder is wired (`"1"` / `"0"` both written, and an ambient inherited value is
 * scrubbed — see `buildSubAgentChildEnv` in `spawn.ts`); either way this reader
 * stays fail-closed: only a `parseYoloFlag` hit produces a holder, `"0"` /
 * absent / garbage → **empty object** (fence present, the pre-wire shape).
 */
export function yoloOptionFromEnv(
  env: Readonly<Record<string, string | undefined>>
): { readonly yolo?: YoloContext } {
  return parseYoloFlag(env[YOLO_ENV_KEY])
    ? { yolo: createYoloContext(true) }
    : {};
}

function resolveWorkerFenceTmp(
  opts: Pick<CreateWorkerDepsOptions, "tmpDir" | "traceFilePath">
): string | undefined {
  if (opts.tmpDir !== undefined && opts.tmpDir.trim().length > 0) {
    return opts.tmpDir;
  }
  if (
    opts.traceFilePath !== undefined &&
    opts.traceFilePath.trim().length > 0
  ) {
    return workerFenceTmpBesideRecord(opts.traceFilePath);
  }
  return undefined;
}

/**
 * ADR-0085: worker-side ledger registration seam — when the parent
 * ledger anchor (passed via envelope `todoLedger`) is present, `todo_write`
 * joins the worker's tool surface attached to the **same** todos.md as the
 * parent; `canAdd:false` makes the tool itself typed-reject `add` (read /
 * update stay available). Absent → not assembled (old wire byte-stable; the
 * worker tool surface contains no todo_write).
 *
 * Same source as the main loop registry: `todoDir` is exactly the value the
 * parent registry got; the worker does not re-derive it (path-segment
 * sanitizing belongs to `resolveConversationTodoPath`).
 */
function todoLedgerRegistryOpts(
  ledger:
    | {
        readonly projectDir: string;
        readonly conversationId: string;
      }
    | undefined
): {
  todoDir?: string;
  todoActor?: { conversationId: string; canAdd: false };
} {
  if (ledger === undefined) return {};
  return {
    todoDir: ledger.projectDir,
    todoActor: { conversationId: ledger.conversationId, canAdd: false },
  };
}

/**
 * The worker child's Anthropic client. Header pass-through matches
 * build-engine's `createAdapterFromEnv` — when `env.llm.headers` has values it
 * becomes the SDK `defaultHeaders`; absent → **the key is not passed**
 * (conditional spread), so client options stay byte-identical (no explicit
 * `undefined` / `{}` leaking in).
 *
 * A named mount point rather than inline: the assembly function already exceeds
 * the S5 complexity threshold, so new branches must land in a new function
 * (the ratchet only allows flat/down), and this is the single-responsibility
 * "env → client" boundary anyway.
 */
function createWorkerAnthropicClient(
  env: IknowEnv,
  route?: SubagentModelEnv
): Anthropic {
  // A resolved worker route supplies the whole transport triple — when it is
  // present but carries no headers, defaultHeaders stays unset rather than
  // borrowing the main-session headers (which would mix two providers).
  const headers = route === undefined ? env.llm.headers : route.headers;
  return new Anthropic({
    apiKey: route?.apiKey ?? env.llm.apiKey,
    baseURL: route?.baseUrl ?? env.llm.baseUrl,
    ...(headers !== undefined ? { defaultHeaders: headers } : {}),
  });
}

/**
 * Assemble the worker process's LoopEngineDeps. Real path:
 *   - adapter = createRealAnthropicAdapter (same params as build-engine);
 *   - registry = createDefaultAciRegistry (no subagentManager → no spawn_subagent);
 *   - executor = createAciExecutor (permission middleware + fail-closed askUser);
 *   - system = createIknowSystemResolver (surface "ask" → no BOOTSTRAP);
 *   - trace = createJsonlTraceService (same shape as cli.ts; tests cover noop);
 *   - compress passes env.compress through (same shape as build-engine).
 *
 * The worker child is task-shaped (bounded scope), so no MCP manager / memory
 * layer is assembled — see each assembly point's diff-vs-build-engine comment.
 * Since phase 2, LSP notifier / warmup are assembled in lockstep with
 * build-engine (SSOT: LspCtx.directory ≡ sandboxRoot).
 */
export async function createWorkerDeps(
  opts: CreateWorkerDepsOptions
): Promise<LoopEngineDeps> {
  return (await createWorkerRuntime(opts)).deps;
}

/**
 * Observability floor: the full assembly output of `createWorkerDeps`.
 *
 * `createWorkerDeps` exposes only `deps` (the existing seam — every current
 * caller is unchanged); the production entry `runSubagentWorker` goes through
 * this function and additionally gets the ACI catalog — fileRefs needs to
 * derive tool names from `aci.category === "write"`, while `LoopEngineDeps`
 * only carries the ACI-metadata-free `registry`. The catalog is not stuffed
 * into deps: `LoopEngineDeps` is loop-engine's contract surface, and a
 * worker-only field would pollute it.
 */
export async function createWorkerRuntime(
  opts: CreateWorkerDepsOptions
): Promise<{
  readonly deps: LoopEngineDeps;
  readonly catalog: AciCatalog;
}> {
  const { env, sandboxRoot } = opts;
  const userHome = opts.userHome ?? homedir();
  // The user-agents dir is scanned with the worker's own userHome (the
  // userHome test seam also isolates ~/.iknow/agents). Memoization lives
  // inside user-catalog — at most one scan per process.
  const agentCatalog = createMergedCatalogResolver({ home: userHome });
  const cwd = opts.cwd ?? process.cwd();
  // Identity-discovery root. Parent session passed nothing (unbound / old
  // wire) → fall back to cwd, same value as today.
  const projectIdentityRoot = opts.projectIdentityRoot ?? cwd;
  // ADR-0037: identity contract read root for the worker bash fence.
  // The worker process has no isolationEnabled signal (neither settings nor
  // isolationHost is present), but its fence taskRoot = sandboxRoot (frozen at
  // spawn; the registry has no liveTaskRoot). The main chain's "load the
  // identity root only after rebind" predicate reduces here to: sandboxRoot is
  // a task-worktree shape — same source as the build-engine spawn-site check
  // feeding sessionRoot (taskWorktreeOwnerOf, the same function in
  // build-engine.ts):
  //   - OFF / unbound (sandboxRoot = main checkout): don't pass — .git sits
  //     inside cwd, no read channel is missing (the rationale in
  //     ADR-0037), bytes same as today, never wider than the main chain;
  //   - ON + bound (sandboxRoot = task worktree): pass the parent session's
  //     verbatim sessionRoots.projectIdentityRoot (delivered over the
  //     IKNOW_PRODUCT_ROOT wire), the same value the main-chain ON-tier
  //     registry gets — fixing the broken worktree repo discovery (git status
  //     exit 128, measured in the inventory pass).
  // Value fallback mainCheckoutOf(sandboxRoot): the same pure path derivation
  // build-engine's sessionRoots use (mainCheckoutOf(opts.projectIdentityRoot ??
  // cwd)) — no new state source; if the fallback path is absent on disk, the
  // policy contract root fails loud (ADR-0037).
  const identityFenceRoot = isTaskWorktreePath(sandboxRoot)
    ? (opts.projectIdentityRoot ?? mainCheckoutOf(sandboxRoot))
    : undefined;
  const defaultTraceDir = resolve(
    opts.workspaceRoot ?? cwd,
    DEFAULT_WORKER_TRACE_DIR
  );

  // Task-shaped subagent: fail-closed askUser (no interaction; insufficient
  // permission = immediate denial, at parity with the main assembly). The
  // subagent focuses on execution and never re-prompts the operator y/N.
  const askUser = createNoAskUser();

  const workerRoute = env.subagent?.model;
  const adapter =
    opts.model ??
    withTransportRetry(
      createRealAnthropicAdapter({
        // A resolved `settings.subagent.model` route supplies the wire model and
        // the provider triple (client); absent → the main-session llm transport.
        // maxTokens / thinking stay the MAIN llm values even when the route
        // differs (ADR-0093 host-level sampling).
        client: createWorkerAnthropicClient(env, workerRoute),
        model: wireModelFromRoute(workerRoute?.model ?? env.llm.model),
        maxTokens: env.llm.maxOutputTokens,
        temperature: env.llm.temperature,
        thinking: buildThinkingParams(env.llm),
        stream: env.llm.stream === "on",
      }),
      { translate: translateAnthropicTransportFault }
    );

  // Skill index: the worker scans independently (simpler communication, reuses
  // the parent's assembly shape); the scanner has internal try/catch + warn,
  // degrades on missing dirs, and never blocks assembly.
  // Plugin skills are likewise resolved by the worker itself (same source as
  // the parent assembly = same plugin-root resolution + same disabled filter).
  // Merged-catalog plugin agents self-resolve via createMergedCatalogResolver()
  // — no worker injection needed.
  const workerSettings = loadIknowSettings({
    cwd: projectIdentityRoot,
    home: userHome,
  });
  // The "resolve roots → scan → disabled filter (→ plugin catalog)" chain goes
  // through roots.ts's shared assembly helper (same source as build-engine);
  // the worker no longer rewrites it — the disabled-filter branch count stays
  // inside the helper.
  const { catalog: pluginCatalog, enabled: enabledInstallations } =
    await resolvePluginCatalog({
      roots: resolvePluginRoots({
        userHome,
        settings: workerSettings,
      }),
      plugins: workerSettings.plugins,
    });
  // hooksEntries is the plugin hooks file source (see the matching assembly
  // comment in build-engine); worker and parent engine read the same plugin
  // resolution (same source, same disabled set).
  const pluginSkillDirs: PluginSkillDir[] = enabledInstallations.map((p) => ({
    dir: join(p.root, "skills"),
    plugin: p.name,
  }));
  const skillCatalog =
    opts.skillCatalog ??
    createSkillCatalog(
      await createSkillScanner({
        userHome,
        projectIdentityRoot,
        env: process.env,
        // Empty array = no plugin skills (the scanner defaults to empty), no conditional spread needed.
        pluginSkillDirs,
      }).scan()
    );

  // Independent registry: no dependency on the parent's registry. The worker
  // child has no spawn_subagent — registry.ts is not given a
  // subagentManager, so that tool is absent from factories.
  // bashMode and the catalog deny both derive from the same capability
  // resolver; explicit opts.bashMode only keeps the existing test/future
  // injection seam and never changes the catalog deny.
  const isJudge = opts.role === "judge";
  const capabilities = isJudge
    ? { bashMode: "any" as const, disallowedTools: opts.disallowedTools }
    : resolveSubagentCapabilities({
        role: opts.role,
        parentDisallowedTools: opts.disallowedTools,
        // Same source as persona/constraints: merged builtin + user agents catalog.
        catalog: agentCatalog,
      });
  if (capabilities.catalogError !== undefined) {
    log(`role '${opts.role}' not in catalog; bashMode fallback to 'any'`);
  }
  const bashMode: BashMode = opts.bashMode ?? capabilities.bashMode;
  // Worker assembles LSP notifier + warmup in lockstep with build-engine (same
  // seam). SSOT: LspCtx.directory ≡ sandboxRoot.
  // lsp idleTimeoutMs uses the constant default (10min), not settings.lsp (the
  // worker only reads the settings.hooks segment at the user-hook assembly
  // below); timeout/wait still use tool-layer constants.
  // Warmup does not start at assembly time; it is lazily armed through the
  // deps.registry view (first language-server tool-name resolution) — see the
  // withLazyLspWarmup call below.
  const lspCtx = {
    directory: sandboxRoot,
    idleTimeoutMs: DEFAULT_LSP_IDLE_TIMEOUT_MS,
  };
  const lspNotifier = createLspNotifier(lspCtx);
  const workerFenceTmp = resolveWorkerFenceTmp(opts);
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    skillCatalog,
    onEdit: (file) => lspNotifier.invalidate(file),
    lspCtx,
    ...(capabilities.disallowedTools !== undefined
      ? { disallowedTools: capabilities.disallowedTools }
      : {}),
    // ADR-0019: per-root state anchor spread-guard — absent →
    // registry falls back to sandboxRoot (legacy shape byte-identical).
    // Threaded to read_file's extraReadRoots; bash no longer consumes it
    // (ADR-0092 global mode has no per-root mount and no policy predicate).
    ...(opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
    // ADR-0037: conditional identity contract read root (predicate in
    // identityFenceRoot) — the registry spread-guard routes it into the bash
    // factory → per-call createFsPolicy read whitelist; read_file / grep / glob
    // get the same read-only pass-through, matching the main chain's
    // isolationEnabled ON-tier registry. Absent → not passed, byte-identical
    // to the main chain OFF tier.
    ...(identityFenceRoot !== undefined
      ? { projectIdentityRoot: identityFenceRoot }
      : {}),
    // ADR-0092: fs isolation-tier holder + homeRoot threaded to the worker bash
    // factory — same shape as the build-engine main chain. Holder absent →
    // V1 global baseline. homeRoot reuses the userHome resolved at this layer
    // (opts.userHome test seam ?? homedir(), see above) — the bash factory does
    // not call `homedir()` again — same as the main chain: the test seam must
    // be able to steer the fence source.
    fsMode: opts.fsMode,
    ...yoloHolderSpread(opts.yolo),
    homeRoot: userHome,
    // Switch holder threaded to the worker bash factory (absent = no segment).
    ...(opts.worktreeOnMutate !== undefined
      ? { worktreeOnMutate: opts.worktreeOnMutate }
      : {}),
    ...(bashMode !== undefined ? { bashMode } : {}),
    ...(workerFenceTmp !== undefined ? { tmpDir: workerFenceTmp } : {}),
    ...todoLedgerRegistryOpts(opts.todoLedger),
  });

  const baseExecutor = createExecutor(reg.inner);
  // Worker permission parity: the worker is the subagent face of the same
  // (ADR-0084)
  // session, so project permission rules must share the main chain's source —
  // otherwise a command denied on the main chain could detour through the
  // worker. Read root = `projectIdentityRoot` (same value as the user-hook
  // settings read root above; the worker has no sessionRoots, and the identity
  // root arrives over the IKNOW_PRODUCT_ROOT wire / falls back to cwd when
  // absent); fail-loud rethrows as-is (typed ProjectSettingsError), which the
  // worker process top level (cli.ts) turns into stderr + exit 2 — never
  // silently downgrading to "no project rules". No project rules = undefined,
  // dropped by `createPermissionPolicy`'s spread-guard (same shape as key
  // absent), so no extra conditional branch here.
  // ADR-0090: declarative-rule compile anchor = sandboxRoot (same as
  // build-engine); knownToolNames comes from the worker's built-in registry
  // (no dynamic MCP pieces) — load-time warnings for deny/ask on unknown tool
  // names, but rules are still compiled.
  const policy = createPermissionPolicy({
    project: resolveProjectPermissionSource({
      projectIdentityRoot,
      workRoot: sandboxRoot,
      knownToolNames: new Set(reg.inner.list().map((def) => def.name)),
    }),
  });
  const settingsHooks = createSettingsHookContribution({
    hooks: loadIknowSettings({
      cwd: projectIdentityRoot,
      home: userHome,
    }).hooks,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    onError: (e) => process.stderr.write(`[worker ${e.phase}] ${e.message}\n`),
  });
  // Plugin hooks file source — same catalog as the parent engine. Chain order settings → plugin.
  const pluginHooksOpts: Parameters<typeof createPluginHooksFromCatalog>[0] = {
    entries: pluginCatalog.hooksEntries,
    installations: enabledInstallations,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    onError: (e) => process.stderr.write(`[worker ${e.phase}] ${e.message}\n`),
  };
  const pluginHooks = createPluginHooksFromCatalog(pluginHooksOpts);
  // The combinator skips undefined slots (unconfigured sources); the worker has
  // no TUI post, so a plugin Post, if present, forms its own chain. All absent →
  // undefined → the postToolUse field is absent entirely (same shape as the
  // executor's `?? no-op`, so the conditional spread can be omitted).
  const postToolUse = composePostHooks([settingsHooks.post, pluginHooks.post]);
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
    hooks: {
      preToolUse: composePreHooks([settingsHooks.pre, pluginHooks.pre]),
      postToolUse,
    },
  });

  // surface "ask" → shouldIncludeBootstrap false (no BOOTSTRAP segment); the
  // worker injects only static AGENTS.md / rules and does not enable the memory
  // library. The skills segment is injected as usual (when the skill tool is
  // present, the model should know the available skills).
  // Judge workers must not inherit the full iknow soul / assistant voice.
  // Catalog lookup is skipped so "unknown role"
  // fallback does not re-attach the iknow base.
  // The worker gets the same git snapshot as the parent agent.
  // At assembly time the worker synchronously takes one
  // createGitSnapshotProvider (with the stable projectIdentityRoot as cwd);
  // the result is frozen in the closure → byte-constant within the worker
  // process, injected into the resolver's `git` seam → sharing the same git
  // block text with the parent agent. Degenerate states (not a git repo / git
  // unavailable / cwd unresolvable) → undefined → segment absent, no
  // assembly error.
  const baseSystem = isJudge
    ? async () => undefined
    : (opts.system ??
      createIknowSystemResolver({
        cwd,
        projectIdentityRoot,
        userHome,
        surface: "ask",
        memoryEnabled: false,
        staticInstructions: opts.role !== "explore",
        // Index surface = the parent session's as-of snapshot (when present) or
        // the worker's own catalog rescan (absent, existing behavior byte-for-byte
        // unchanged). Decision point: systemSkillsGetter.
        skills: systemSkillsGetter({
          snapshot: opts.skillIndexSnapshot,
          catalog: skillCatalog,
        }),
        git: createGitSnapshotProvider({ cwd: projectIdentityRoot }),
      }));

  // Persona + constraints injection (additive segments, never touching
  // IKNOW_ASSEMBLY_ORDER). Order base < persona < constraints; both default
  // away → base passthrough, V1 baseline strictly byte-stable.
  // ADR-0112: envelope.systemPrompt (addendum) no longer enters system — the
  // assembly layer has no consumer for it; at runtime the worker routes it
  // through priorMessagesFromEnvelope into user/untrusted.
  //
  // role absent → general-purpose persona; unknown id → no persona injected
  // (defense-in-depth): the worker catches AgentCatalogLookupError at assembly
  // time and explicitly takes the fallback; the envelope-role and
  // tool-constraints unit tests lock this path.
  const personaText = isJudge
    ? undefined
    : resolvePersonaBody(opts.role, agentCatalog);
  const constraintsText = isJudge
    ? undefined
    : resolveConstraintsText(opts.role, agentCatalog);
  const system =
    personaText !== undefined || constraintsText !== undefined
      ? withRoleExtras(baseSystem, personaText, constraintsText)
      : baseSystem;

  const deps: LoopEngineDeps = {
    adapter,
    executor,
    // Worker uses the same seam — no warmup at assembly time; the first
    // language-server tool-name resolution arms it (sharing lsp/warmup.ts's
    // view with build-engine).
    registry: withLazyLspWarmup(reg.inner, lspCtx),
    // settings fallback is already merged inside loadIknowEnv; envelope.maxTurns
    // is overridden with priority by runWorkerOnce.
    maxTurns: env.llm.maxTurns,
    detectToolLoop: env.loop?.detectToolLoop !== false,
    timeoutMs: env.llm.timeoutMs,
    ...(env.llm.idleTimeoutMs !== undefined
      ? { modelIdleTimeoutMs: env.llm.idleTimeoutMs }
      : {}),
    ...(env.llm.hardCapMs !== undefined
      ? { modelHardCapMs: env.llm.hardCapMs }
      : {}),
    system,
    promptTools: reg.visibleSchemas,
    // The subagent is an **independent** conversation — this value
    // (ADR-0084)
    // gives it **its own** empty bucket (the ledger buckets by conversationId),
    // not the parent session's id, and sharing no entries with the parent.
    // "Subagent gets a fresh empty conversation table" means an **empty bucket**,
    // not **bucket absent**: `ledgerFor(undefined) === undefined` would leave a
    // just-succeeded `read_file` in the worker with nowhere to book its read,
    // and the same-turn read-modify-write `write_file` would then be **forever**
    // denied (unrecoverable) — that is a wiring miss, not a contract.
    //
    // Semantic relation: the trace branch below also uses `opts.taskId` as its
    // conversationId (the task identity the manager locks at spawn), so the two
    // consumer faces point at the same identity and cannot drift.
    //
    // Absent (legacy envelope / cross-version resume / test not passing it) →
    // undefined, and **no fallback id is minted**: a per-process fake id is a
    // backdoor for unread overwrites (more dangerous than denial).
    // read / whitelisted bash still run without an id.
    //
    // Minimality: the other conversationId consumers (backgroundManager /
    // todoDir / graphAssembly / subagentManager) are none of them in the worker
    // registry, and `resolveSessionFenceTmp`'s `projectDir` is absent — the
    // worker's `/tmp` pad is still decided only by `tmpDir` (workerFenceTmp) or
    // the mkdtemp fallback.
    ...(opts.taskId !== undefined ? { conversationId: opts.taskId } : {}),
    // ADR-0071 retired the `./trace/` cwd-relative
    // fallback — the main-session trace anchor goes through the session folder
    // (same source as resolveServeDataDir()). The worker inherits the parent's
    // (ADR-0001)
    // env, so IKNOW_TRACE_OUT is read once more here to keep the resolution
    // order consistent (same shape as cli.ts resolveTraceRoot). When
    // traceFilePath is present it takes priority (see the trace assembly branch
    // below).
    //
    // ADR-0071: when opts.traceFilePath is
    // present (passed through by envelope.traceFilePath; the parent manager has
    // already created `<parent session folder>/subagents/agent-<taskId>.jsonl`
    // for this taskId), the worker lands file-mode directly on that path with
    // conversationId=taskId.
    //
    // `filePath` is JsonlTraceOptions' directory-mode key (directory +
    // conversationId derive <dir>/<convId>.jsonl); feeding it a file path makes
    // the factory treat the target file as a directory → the nested
    // <filePath>/<taskId>.jsonl never exists → silently zero-line writes. The
    // fix: use `traceFilePath` (the file-mode key), and `conversationId` must
    // == opts.taskId. taskId absent → fail loud at assembly; no more fake
    // `randomUUID()` scopes (the retired fake scope; the pack pairing
    // contract is hard-coded).
    //
    // Absent → IKNOW_TRACE_OUT / defaultTraceDir fallback (legacy envelope /
    // cross-version resume / test not passing it, byte-stable).
    trace:
      opts.trace ??
      (opts.traceFilePath !== undefined
        ? (() => {
            if (opts.taskId === undefined) {
              throw new Error(
                "createWorkerDeps: traceFilePath 必须在场时 taskId 也在场(file-mode 配对)"
              );
            }
            return createJsonlTraceService({
              traceFilePath: opts.traceFilePath,
              conversationId: opts.taskId,
            });
          })()
        : createJsonlTraceService({
            filePath: process.env.IKNOW_TRACE_OUT ?? defaultTraceDir,
            conversationId: randomUUID(),
          })),
    compress: {
      contextWindow: env.compress.contextWindow,
      thresholdTokens: env.compress.thresholdTokens,
    },
  };
  // Test seam: opts.maxTurns overrides the env default. LoopEngineDeps.maxTurns
  // is readonly, so a new object is required (invariant: return new deps rather
  // than mutate, matching runWorkerOnce's { ...deps, maxTurns } shape).
  return {
    deps:
      opts.maxTurns !== undefined ? { ...deps, maxTurns: opts.maxTurns } : deps,
    catalog: reg.catalog,
  };
}

/**
 * Derivation source for envelope observability fields (the observability floor).
 *
 * `writeToolNames` absent → no fileRefs derived. Deliberately no hardcoded
 * fallback list inside the worker: the only true value is the ACI catalog's
 * `category:"write"` (see file-refs.ts), and the assembly path
 * (runSubagentWorker) is responsible for passing it in.
 */
export interface EnvelopeObservabilityOpts {
  readonly writeToolNames?: ReadonlySet<string>;
}

/**
 * Observability floor: derive the envelope's two observability fields from RunResult.
 *
 * `stop_reason` is always filled (run() always has a stopReason); `fileRefs`
 * lands only when the caller supplies the write-tool name set (derived from the
 * ACI catalog's `category:"write"`) and there really are write paths — Postel:
 * no derivation source / no writes → no key, bit-compatible with V1.
 */
function observabilityFields(
  result: import("../model-adapter/types.js").RunResult,
  opts?: EnvelopeObservabilityOpts
): Pick<SubAgentEnvelope, "stop_reason" | "fileRefs"> {
  const refs =
    opts?.writeToolNames !== undefined
      ? deriveFileRefs(result.messages, opts.writeToolNames)
      : [];
  return {
    stop_reason: result.stopReason,
    ...(refs.length > 0 ? { fileRefs: refs } : {}),
  };
}

/**
 * Derive SubAgentEnvelope (status ok) from a run() result.
 *
 * result field = finalText ?? "" (condensed result); summary shares the same
 * source (V1 has no separate summary segment — same truth value as finalText,
 * guaranteeing the parent's drain never gets an empty summary).
 * usage passes through RunResult.lastUsage (field absent = no successful model call).
 * Also appends stop_reason (always filled) and fileRefs (filled when there are writes).
 *
 * Exported as a test seam — verifies envelope derivation directly without the
 * full loop-engine assembly (that unit test uses createStubModel + all deps).
 */
export function toOkEnvelope(
  result: import("../model-adapter/types.js").RunResult,
  opts?: EnvelopeObservabilityOpts
): SubAgentEnvelope {
  const text = result.finalText ?? "";
  return {
    status: "ok",
    summary: text,
    result: text,
    ...(result.lastUsage !== null ? { usage: result.lastUsage } : {}),
    ...observabilityFields(result, opts),
  };
}

/** Failure-path envelope (reason enum of five values: crashed/maxTurnsExceeded/
 *  timeout/protocolError/modelTransient — the fifth value was added by an
 *  explicit revision to the frozen vocabulary via ADR-0111,
 *  carrying "transient model-stream/transport failure with a cause").
 *  Exported as a test seam — verifies each of the five reasons' envelope shape.
 *  (additive): the second param summary is optional — on SIGTERM graceful
 *  shutdown it carries the worker's self-run epilogue round's stop_summary
 *  text; when omitted the behavior is bit-identical to the old signature
 *  (empty string), not breaking existing callers.
 *  (additive): the third param extras carries stop_reason / fileRefs — only the
 *  failure paths derived from run()'s return value (protocolError /
 *  emptyFinalResponse / fused / SIGTERM shutdown) have these two real values;
 *  throw paths (MaxTurnsExceeded / ProtocolError throw) have no RunResult, so
 *  the fields are absent. */
export function toFailedEnvelope(
  reason: SubAgentEnvelope["reason"],
  summary = "",
  extras: Pick<SubAgentEnvelope, "stop_reason" | "fileRefs"> = {}
): SubAgentEnvelope {
  return {
    status: "failed",
    reason,
    summary,
    result: "",
    ...extras,
  };
}

/**
 * Is this the worker's own SIGTERM timeout abort?
 *
 * Decision line = `signal.reason === "subagent-timeout"` (the worker's SIGTERM
 * handler aborts the controller with that reason). run()'s stopReason being
 * cancelled is not necessarily from this abort — the tool-side
 * execution_failed:"cancelled" can also produce cancelled
 * (computeToolStopFlags, without a signal abort), and in that case we must
 * never wrongly take the timeout-shutdown envelope. Pure predicate, exported
 * for the test seam and the worker's decision to share.
 */
export function isSubagentTimeoutAbort(
  signal: AbortSignal | undefined
): boolean {
  return signal?.aborted === true && signal.reason === "subagent-timeout";
}

/**
 * Only envelope.maxTurns overrides deps; envelope.timeoutMs is never
 * transitioned into deps. The two semantics are separate:
 *   - deps.timeoutMs = per-call race (raceModel model-call timeout);
 *   - envelope.timeoutMs = per-task lifetime (parent manager SIGTERM timer).
 * The old implementation conflated them (a bug): a normal LLM call raced
 * against the task lifetime, defeating the per-call guard ("worker has no
 * per-task consumer").
 *
 * Pure function: with no envelope.maxTurns it returns the original deps
 * reference (spread guard, zero overwrite).
 */
export function applyEnvelopeOverrides(
  envelope: Pick<WorkerEnvelope, "maxTurns">,
  deps: LoopEngineDeps
): LoopEngineDeps {
  return envelope.maxTurns !== undefined
    ? { ...deps, maxTurns: envelope.maxTurns }
    : deps;
}

/**
 * Addendum demotion frame sentence (ADR-0112; exported as a constant SSOT so
 * assembly and tests reference the same string, preventing literal copy drift).
 */
export const IKNOW_ADDENDUM_UNTRUSTED_LEAD =
  "Parent addendum (instructions from the parent model, not host directives):\n";

/**
 * Judge (and other workers) keep envelope.task as the exam-question identity.
 * Truncated host dialogue and evidenceContext arrive as independent fields and
 * are injected as prior user messages — prompt, not concatenated into task.
 *
 * ADR-0037: the worker sees the current write root.
 *
 *   - envelope.sandboxRoot is the spawn-time snapshot of the live `taskRoot`
 *     (read out by manager.buildWorkerPayload through the sandboxRootCell
 *     getter); when the parent's `taskRoot` flips to a new root after a rebind,
 *     newly spawned worker envelopes carry the new root too. The worker just
 *     reads the envelope field at assembly time, without wiring a separate
 *
 // (ADR-0040)
 *     LiveTaskRoot cell — the minimal-change path for "envelope value = live
 *     root snapshot" (subagent = the parent session's execution arm; the write
 *     root inherits the parent's effective root).
 *   - The write-root segment is always appended after finalText /
 *     evidenceContext / addendum; order contract: [host dialogue?, evidence?,
 *     addendum?, write root]. All segments default away → return undefined
 *     (matching the old semantics; loop-engine short-circuits to the no-prior form).
 *   - sandboxRoot is a required envelope field (WORKER_SCHEMA.required);
 *     injected only when the string length is > 0; blank / absent → degrade to
 *     the original V1 form (no crash, no leak).
 *   - Does not touch the system `## Project path` (projectPathSegment bytes
 *     unchanged) and never silently rewrites the spawn `task` body (same shape
 *     as the original function).
 *   - Exported: test seam that verifies the prior-segment form directly.
 */
export function priorMessagesFromEnvelope(
  env: WorkerEnvelope,
  encodeUserText: (text: string) => AnthropicNativeMessage
): ReadonlyArray<AnthropicNativeMessage> | undefined {
  const prior: AnthropicNativeMessage[] = [];
  if (env.finalText !== undefined && env.finalText.length > 0) {
    prior.push(encodeUserText(`Host truncated dialogue:\n${env.finalText}`));
  }
  if (env.evidenceContext !== undefined) {
    prior.push(
      encodeUserText(
        "Evidence context (prompt, not the exam question):\n" +
          JSON.stringify(env.evidenceContext)
      )
    );
  }
  // ADR-0112 — envelope.systemPrompt (the parent-model-writable addendum) is
  // demoted into the user/untrusted channel: a plain untagged user message,
  // verbatim — escaping for the official frame syntax is the outbound
  // projection's job, so no re-escaping and no invented tags here. Empty string
  // = typed skip (same shape as finalText's empty arm; no empty frame sentence).
  // Position: after evidence, before the write-root segment — the instruction
  // segment sits adjacent to task while upholding the "write-root segment is
  // always last" byte contract.
  if (env.systemPrompt !== undefined && env.systemPrompt.length > 0) {
    prior.push(
      encodeUserText(IKNOW_ADDENDUM_UNTRUSTED_LEAD + env.systemPrompt)
    );
  }
  // The current write-root segment is driven by the envelope's
  // situation enum.
  //   - old envelope (no writeSituation field) → typed skip, no write-root
  //     segment, no fallback to the old wording (better silent than wrong);
  //   - writeSituation = "no_writable_root" → the ③-state disclosure (does not
  //     embed sandboxRoot, does not name the tree-creation tool);
  //   - writeSituation = "writable_main" / "writable_tree" → the ①/② wording is
  //     byte-identical to before (hard constraint: prefix cache and the
  //     skill-load-write-root guard).
  // Order contract: [host dialogue?, evidence?, addendum?, write root] — the
  // write-root segment is always last (ADR-0112 inserted the addendum segment
  // between evidence and the write-root segment); on a typed skip that slot is
  // filtered from the extras array and the order is preserved.
  // Rendering SSOT = writeRootSegment (skill/body.ts), the same function shared
  // with the skill body trailer (createSkillBody) — no second copy of the long
  // sentence in the worker source (skill-load-write-root contract 1).
  if (env.writeSituation !== undefined) {
    const segment = writeRootSegment(env.writeSituation, env.sandboxRoot);
    if (segment !== null) {
      prior.push(encodeUserText(segment));
    }
  }
  return prior.length > 0 ? prior : undefined;
}

/**
 * Worker transcript IO seam (harness-side contract surface).
 *
 // (ADR-0102)
 *
 * Gate B (tests/harness/public-exports.test.ts) forbids src/harness executable
 * faces from importing session-api — the worker ledger's codec lives in
 * session-api/store/worker-transcript, and the production implementation is
 * injected at the cli entry (the sole `runSubagentWorker` caller); the worker
 * kernel sees only this narrow interface. not_found folds into `absent` (legal
 * state: a new worker having no ledger ≠ error); real faults (io / parse /
 * schema) rethrow as-is — callers must not read a corrupt ledger as "no ledger".
 */
export interface WorkerTranscriptIO {
  readonly loadMessages: () => Promise<
    | {
        readonly status: "present";
        readonly messages: ReadonlyArray<AnthropicNativeMessage>;
      }
    | { readonly status: "absent" }
  >;
  readonly appendMessages: (
    events: ReadonlyArray<AnthropicNativeMessage>,
    thinkingMs?: number
  ) => Promise<void>;
}

/**
 * Build one ledger's IO from the envelope landing point (cli-injected shape;
 * tests pass a closure directly). `cwd` = the working root for the batch header
 * (envelope.sandboxRoot snapshot); the implementation consumes it only when
 * creating the ledger for the first batch.
 */
export type WorkerTranscriptIOFactory = (loc: {
  readonly transcriptPath: string;
  readonly taskId: string;
  readonly cwd: string;
}) => WorkerTranscriptIO;

/**
 * Transcript wiring decision point (one await completes "read ledger → fix
 *
 // (ADR-0102)
 * prefix → write seed batch"). Returns undefined = not wired (old envelope with
 * no transcriptPath / production entry injected no IO); the caller takes the
 * pre-change byte-exact old path.
 *
 * Two-state prefix:
 *   - absent (new worker) → the envelope prior segment is the prefix, seed batch
 *     = [prior segment?, task] written once (loop-engine's commit point covers
 *     only run-phase new messages; the initial user/prior bypasses commit, so
 *     the seed is added here);
 *
 // (ADR-0102)
 *   - present (continue arm) → the on-disk head-chain projection is the
 *     prefix, seed batch = this round's new user sentence only (continue does
 *     not replay the prior segment; the write-situation disclosure etc. is
 *     already on the ledger).
 * Real faults thrown by IO (io / parse / schema) rethrow **as-is** — a corrupt
 * ledger must not be read as "no ledger"; a commit failure follows the
 * loop-engine contract, wrapped as MessageCommitError to abort the run.
 */
async function wireWorkerTranscript(opts: {
  readonly env: WorkerEnvelope;
  readonly deps: LoopEngineDeps;
  readonly ioFactory: WorkerTranscriptIOFactory | undefined;
  readonly segments: ReadonlyArray<AnthropicNativeMessage>;
}): Promise<
  | {
      readonly deps: LoopEngineDeps;
      readonly priorMessages: ReadonlyArray<AnthropicNativeMessage> | undefined;
    }
  | undefined
> {
  const transcriptPath = opts.env.transcriptPath;
  if (transcriptPath === undefined || transcriptPath.length === 0) {
    return undefined;
  }
  if (opts.ioFactory === undefined) {
    // Missing assembly wiring (direct test call / old cli): the ledger is not
    // written, the task runs anyway — same as the old form, but leave one stderr
    // line so "should have written but didn't" is not silently lost.
    log(
      "envelope carries transcriptPath but no transcript IO injected; worker transcript disabled"
    );
    return undefined;
  }
  const io = opts.ioFactory({
    transcriptPath,
    taskId: opts.env.taskId ?? "",
    cwd: opts.env.sandboxRoot,
  });
  const encode = opts.deps.adapter.encodeUserText;
  const taskEvent = encode(opts.env.task);
  const baseCommit = opts.deps.commitMessages;
  const deps: LoopEngineDeps = {
    ...opts.deps,
    commitMessages: async (events, thinkingMs) => {
      await io.appendMessages(events, thinkingMs);
      if (baseCommit !== undefined) await baseCommit(events, thinkingMs);
    },
  };
  const loaded = await io.loadMessages();
  if (loaded.status === "present") {
    await io.appendMessages([taskEvent]);
    return { deps, priorMessages: loaded.messages };
  }
  const seed =
    opts.segments.length > 0 ? [...opts.segments, taskEvent] : [taskEvent];
  await io.appendMessages(seed);
  return {
    deps,
    priorMessages: opts.segments.length > 0 ? opts.segments : undefined,
  };
}

/**
 * ADR-0111 invariant (b) — worker escape-throw type → failed envelope reason
 * mapping SSOT (runWorkerOnce's escape catch and the runSubagentWorker/cli last
 * line of defense share it, no fork). The subclass arm
 * (ModelStreamIncompleteError) precedes the generic ProtocolError arm
 * (loop's branch-order convention).
 * undefined = non-structured failure class (the call site decides rethrow or crashed).
 */
function escapeFailureReason(
  err: unknown
): SubAgentEnvelope["reason"] | undefined {
  if (err instanceof MaxTurnsExceeded) return "maxTurnsExceeded";
  if (err instanceof ModelStreamIncompleteError) return "modelTransient";
  if (err instanceof ProtocolError) return "protocolError";
  return undefined;
}

/**
 * protocolError/emptyFinalResponse convergence derivation arm (ADR-0111):
 * RunResult.apiError present ⇔ transient model-stream/transport
 * failure with a cause (the loop's only convergence mount point is
 * transportApiErrorOf) → modelTransient; absent = genuine protocol corruption →
 * keep protocolError.
 */
function stopFailureEnvelope(
  result: import("../model-adapter/types.js").RunResult,
  observability: EnvelopeObservabilityOpts
): SubAgentEnvelope {
  return toFailedEnvelope(
    result.apiError !== undefined ? "modelTransient" : "protocolError",
    "",
    observabilityFields(result, observability)
  );
}

/** Inputs the stopReason → envelope mapping needs beyond the RunResult. */
export type StopEnvelopeContext = {
  /** Live-at-settle hang fingerprint from the run()'s bookkeeping tap
   *  (stream-hang-detect T4, see runWorkerOnce's tap comment). */
  readonly sawInvisibleStallResend: boolean;
  readonly observability: EnvelopeObservabilityOpts;
};

/**
 * stopReason → envelope derivation chain (test seam, exported for direct
 * unit coverage of the T4 branch without driving a whole run()): pure mapping
 * of a normally-returned RunResult onto the failed/ok envelope, side effects
 * limited to the stderr `log` lines. The cancelled-by-SIGTERM path is NOT
 * here — it needs the caller's controller and the async epilogue round.
 */
export function mapStopReasonToEnvelope(
  result: import("../model-adapter/types.js").RunResult,
  ctx: StopEnvelopeContext
): SubAgentEnvelope {
  if (result.stopReason === "fused") {
    log(`run() stopReason=fused`);
    return toFailedEnvelope(
      "protocolError",
      "fused",
      observabilityFields(result, ctx.observability)
    );
  }
  if (
    result.stopReason === "protocolError" ||
    result.stopReason === "emptyFinalResponse"
  ) {
    log(`run() stopReason=${result.stopReason}`);
    return stopFailureEnvelope(result, ctx.observability);
  }
  if (result.stopReason === "nonSuccessStop") {
    // EXIT: supplier non-success stop must not report ok
    log(`run() stopReason=nonSuccessStop`);
    return toFailedEnvelope(
      "protocolError",
      "nonSuccessStop (e.g. truncation)",
      observabilityFields(result, ctx.observability)
    );
  }
  if (result.stopReason === "timeout") {
    // stream-hang-detect T4: a timeout stop preceded by invisible-stall
    // resends means the shared clock-retry budget was spent on upstream
    // silence — ADR-0111 "transient model-stream/transport failure", so
    // modelTransient (subagent-continuable), not the lifetime-timeout
    // label. Without any resend the stop is a plain per-call race expiry
    // and keeps its existing attribution (nonsuccess-stop-mapping pin).
    if (ctx.sawInvisibleStallResend) {
      log(`run() stopReason=timeout (stalled-stream budget exhausted)`);
      return toFailedEnvelope(
        "modelTransient",
        "stream stalled; invisible-clock resend budget exhausted",
        observabilityFields(result, ctx.observability)
      );
    }
    // EXIT: per-call race timeout must not report ok
    log(`run() stopReason=timeout`);
    return toFailedEnvelope(
      "timeout",
      "per-call model timeout",
      observabilityFields(result, ctx.observability)
    );
  }
  return toOkEnvelope(result, ctx.observability);
}

/**
 * Test seam (exported for tests only): envelope → run → truncateEnvelopeResult.
 *
 * Splits out readStdin → parseWorkerEnvelope → run → derive envelope → truncate,
 * so unit tests can call runWorkerOnce({ workerEnvelope, deps }) directly with
 * stub deps injected, without spawning a real worker child (avoids depending on
 * a real LLM key).
 *
 * Failure paths (exit-code semantics codified in ADR-0111 invariant (b)):
 *   - parseWorkerEnvelope throws ProtocolError → not handled here (the caller
 *     runSubagentWorker rethrows it as-is — exit 2 belongs solely to this
 *     envelope-protocol crash path);
 *   - run() throws MaxTurnsExceeded → status:failed, reason:maxTurnsExceeded
 *
 // (ADR-0011)
 *     (maxTurns over limit = throw; worker emits a failed envelope);
 *   - run() throws ModelStreamIncompleteError → status:failed, reason:modelTransient
 *     (ADR-0111: the subclass arm precedes the generic
 *     ProtocolError arm; the escape-defense arm outside the loop's convergence face);
 *   - run() throws ProtocolError → status:failed, reason:protocolError
 *     (harness model-protocol error, not envelope protocol — distinct from exit 2);
 *   - run() returns normally with stopReason=protocolError and RunResult.apiError
 *     present → reason:modelTransient, absent → protocolError (ADR-0111,
 *     invariant: apiError present ⇔ transient model-stream/transport failure with a cause);
 *   - run() returns normally with stopReason=timeout preceded by the loop's
 *     invisible-stall resends (transport_retry detail=invisible_timeout —
 *     the shared clock-retry budget spent on an open-but-silent stream,
 *     stream-hang-detect T4) → reason:modelTransient; without any such resend
 *     it stays a per-call race expiry → reason:timeout. The fingerprint is
 *     live-at-settle only: the tap clears it on any model-output progress
 *     after the resend (visible delta / successful call's post_call beat), so
 *     an earlier turn's resend never reattributes a later turn's plain
 *     timeout (see mapStopReasonToEnvelope);
 *   - other run() errors → throw (runSubagentWorker's run-phase convergence →
 *     best-effort failed envelope + exit 1, no longer misusing exit 2).
 *
 * SIGTERM graceful shutdown ("run epilogueSummary one round on the catch side"):
 *   - process receives SIGTERM (parent manager timeout fires) → the handler
 *     registered in the synchronous prologue aborts the controller with reason
 *     "subagent-timeout" → raceModel callerAbort → run() returns stopReason="cancelled";
 *   - the epilogueSummary inside run() skips directly because the signal is
 *     already aborted ("if (opts.signal?.aborted) return") — so after run()
 *     returns the worker runs its own epilogue round with an **un-aborted new
 *     signal** (reason:"timeout"), capturing the stop_summary text into
 *     envelope.summary so the parent's drain gets real progress (rather than
 *     the generic "timeout after <n>ms");
 *   - the summary round is best-effort: failure / timeout / throw → summary
 *     falls back to empty string, the envelope is written as usual, never blocks;
 *   - non-SIGTERM paths (ordinary cancelled / protocolError / ok) bytes unchanged.
 */
export async function runWorkerOnce(opts: {
  readonly workerEnvelope: WorkerEnvelope;
  readonly deps: LoopEngineDeps;
  /**
   * Write-class tool names derived from the ACI catalog (the fileRefs
   * derivation source). On the production path runSubagentWorker computes it
   * from createWorkerRuntime's catalog; absent → no fileRefs derived (stop_reason
   * unaffected, always filled).
   */
  readonly writeToolNames?: ReadonlySet<string>;
  /**
   * Worker transcript IO injection (production passes the real seam from cli
   *
   // (ADR-0102)
   * through runSubagentWorker; tests inject a closure directly). When
   * envelope.transcriptPath is absent this param is not consumed — behavior is
   * byte-identical to before.
   */
  readonly transcriptIo?: WorkerTranscriptIOFactory;
}): Promise<SubAgentEnvelope> {
  const { workerEnvelope: env, deps } = opts;
  const observability: EnvelopeObservabilityOpts =
    opts.writeToolNames !== undefined
      ? { writeToolNames: opts.writeToolNames }
      : {};
  // Only apply the maxTurns override; timeoutMs does not enter deps (per-call semantics).
  const baseRunDeps = applyEnvelopeOverrides(env, deps);
  // SIGTERM → abort("subagent-timeout"). The worker is driven by the parent
  // manager's per-timeout timer; receiving SIGTERM = task lifetime elapsed, so
  // take graceful shutdown rather than immediate exit.
  const controller = new AbortController();
  const onSigterm = (): void => controller.abort("subagent-timeout");
  process.once("SIGTERM", onSigterm);
  // stream-hang-detect T4: the hang fingerprint, live only for the run's
  // latest model-call face. Set on an invisible-stall resend and CLEARED by
  // any model-output progress after it (a visible delta round, or the
  // post_call usage beat of a successful call): the idle machine only
  // resends zero-delta attempts, so progress past a resend means that
  // resend's call already settled — a later timeout must not inherit it
  // (turn1 resends-then-succeeds + turn2 plain race expiry stays "timeout").
  let sawInvisibleStallResend = false;
  const observeStreamEvent = (event: HarnessStreamEvent): void => {
    if (event.type === "transport_retry") {
      if (event.detail === TRANSPORT_RETRY_DETAIL_INVISIBLE_TIMEOUT) {
        sawInvisibleStallResend = true;
      }
      return;
    }
    if (
      resetsModelIdle(event) ||
      (event.type === "context_usage" && event.phase === "post_call")
    ) {
      sawInvisibleStallResend = false;
    }
  };
  try {
    // Pass the signal through at runtime. onStream is only a bookkeeping tap
    // (hostStreamPresent=false → no #1079 probe cost): the worker has no
    // display consumer for hot-path events like text_delta, and when the
    // signal is already aborted run() does not run its internal epilogue and
    // won't emit stop_summary — summary capture happens only in the self-run
    // epilogue round below (runTimeoutEpilogue). What the tap exists for:
    // stream-hang-detect T4 — the loop's shared clock-retry machine emits
    // transport_retry(detail=invisible_timeout) on every stall resend, the
    // only hang fingerprint observable here (RunResult just carries
    // stopReason=timeout), so the timeout branch can tell "upstream stream
    // stalled through the whole budget" from a plain per-call timeout stop.
    const envelopePrior = priorMessagesFromEnvelope(
      env,
      baseRunDeps.adapter.encodeUserText
    );
    // Worker ledger wiring (absent = zero change).
    // (ADR-0102)
    const wired = await wireWorkerTranscript({
      env,
      deps: baseRunDeps,
      ioFactory: opts.transcriptIo,
      segments: envelopePrior ?? [],
    });
    const runDeps = wired?.deps ?? baseRunDeps;
    const priorMessages = wired ? wired.priorMessages : envelopePrior;
    const { result } = await run(env.task, runDeps, controller.signal, {
      ...(priorMessages !== undefined ? { priorMessages } : {}),
      onStream: observeStreamEvent,
      hostStreamPresent: false,
    });
    // run() returning normally ≠ success: harness protocol-layer errors / empty
    // final response return via stopReason (no throw), but the worker must mark
    // failed — the parent's drain receiving ok with a protocolError stopReason
    // would misjudge the subagent as successful. stopReason → envelope lives
    // in mapStopReasonToEnvelope (T4 branch directly unit-testable there).
    // Timeout epilogue: stopReason=cancelled and genuinely this worker's SIGTERM
    // abort (signal.reason === "subagent-timeout"; tool-side cancelled is not mislabeled).
    if (
      result.stopReason === "cancelled" &&
      isSubagentTimeoutAbort(controller.signal)
    ) {
      const summary = await runTimeoutEpilogue(runDeps, result.messages);
      log(
        `run() cancelled by SIGTERM (subagent-timeout); epilogue summary=${
          summary ? `${summary.length} chars` : "<empty>"
        }`
      );
      return truncateEnvelopeResult(
        toFailedEnvelope(
          "timeout",
          summary.length > 0 ? summary : "",
          observabilityFields(result, observability)
        )
      );
    }
    return truncateEnvelopeResult(
      mapStopReasonToEnvelope(result, {
        sawInvisibleStallResend,
        observability,
      })
    );
  } catch (err) {
    // Escaped-throw type → reason mapping goes through SSOT (escapeFailureReason).
    // Errors reaching the loop's normal step path are caught there and never hit
    // this branch; this catch only serves escapes outside the loop's containment
    // (e.g. this kind of error thrown from the epilogue / worker finalizer calls).
    // Unknown escapes rethrow for runSubagentWorker's run-phase containment
    // (best-effort failed envelope + exit 1, ADR-0111 invariant (b)).
    const reason = escapeFailureReason(err);
    if (reason === undefined) throw err;
    log(`run() escape ${reason}: ${errorMessage(err)}`);
    return truncateEnvelopeResult(toFailedEnvelope(reason));
  } finally {
    // Remove the SIGTERM listener as soon as the task ends (success or not),
    // so no stale listener survives the worker's finalization phase
    // (runSubagentWorker then calls process.exit(0)).
    process.removeListener("SIGTERM", onSigterm);
  }
}

/**
 * Worker-side SIGTERM timeout epilogue: run one best-effort summary round.
 *
 * When run() returns cancelled with this worker's own timeout abort, run()
 * internally skips the summary (its signal is already aborted, epilogueSummary
 * returns immediately). Here we call epilogueSummary once with a fresh
 * **non-aborted** controller (reason:"timeout"):
 *   - result.messages must be passed explicitly (on cancelled it already
 *     contains the authoritative history with appendSystemInterrupt, see the
 *     stop branch in run()); the summary round reads only that as input;
 *   - capture the stop_summary event text and return it; summary failure /
 *     timeout / signal interruption again → return empty string (the envelope
 *     is still written; never mask the original stop reason).
 * The 15s summary timeout is owned by loop-engine's runSummaryWithTimeout —
 * no second layer of timing here.
 */
async function runTimeoutEpilogue(
  deps: LoopEngineDeps,
  messages: ReadonlyArray<
    import("../model-adapter/types.js").AnthropicNativeMessage
  >
): Promise<string> {
  let summary = "";
  const epilogueController = new AbortController();
  try {
    await epilogueSummary({
      deps,
      messages,
      reason: "timeout",
      signal: epilogueController.signal,
      onStream: (event: HarnessStreamEvent) => {
        if (event.type === "stop_summary") {
          summary = event.text;
        }
      },
    });
  } catch {
    // Summary failure must never block: return empty string, the writer side
    // still writes the timeout envelope.
    return "";
  }
  return summary;
}

/** Read all stdin bytes once (worker protocol: single envelope, read to EOF). */
function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8"))
    );
    process.stdin.on("error", (err) => reject(err));
  });
}

/**
 * ADR-0111 invariant (b) — SSOT for deriving a failed envelope from a run-phase
 * escape (runSubagentWorker's containment and cli.ts's last-resort defense use
 * the same criteria, no fork). Structured escapes go through
 * escapeFailureReason; everything else is crashed (a process ending in error =
 * ADR-0111's narrowed "process-level abnormal death" vocabulary; the parent
 * already marks exit≠0 as crashed, so the envelope derivation does not conflict).
 */
export function runEscapeEnvelope(err: unknown): SubAgentEnvelope {
  const reason = escapeFailureReason(err);
  if (reason !== undefined) return toFailedEnvelope(reason);
  return toFailedEnvelope(
    "crashed",
    `subagent worker run-phase error: ${errorMessage(err)}`
  );
}

/**
 * Escape-error rendering (stderr diagnostics surface): real Errors keep their
 * stack; plain-object typed errors go through the errorMessage SSOT instead of
 * collapsing into `[object Object]` (typed-error catch contract).
 */
export function renderWorkerError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return errorMessage(err);
}

/**
 * ADR-0111 invariant (b) — worker exit-code semantics constants (single named
 * source, consumed by cli.ts; full semantics live in the runSubagentWorker doc,
 * not restated here):
 *   - OK(0): an envelope was written to stdout (true for both ok and failed —
 *     structured failures are attributed by reason);
 *   - RUN_PHASE(1): run-phase escape → best-effort failed envelope + exit 1;
 *   - ENVELOPE_PROTOCOL(2): envelope protocol errors only (parseWorkerEnvelope
 *     ProtocolError, no envelope writable; dedicated code for protocol-level
 *     crashes).
 */
export const WORKER_EXIT_OK = 0;
export const WORKER_EXIT_RUN_PHASE = 1;
export const WORKER_EXIT_ENVELOPE_PROTOCOL = 2;

/**
 * Worker process main entry (cli.ts dispatch):
 *   read all stdin once → parseWorkerEnvelope → createWorkerDeps →
 *   runWorkerOnce → stdout newline-JSON → exit 0.
 *
 * Exit-code semantics (ADR-0111 invariant (b)):
 *   - **exit 2 = envelope protocol errors only** — ProtocolError thrown by
 *     parseWorkerEnvelope (stdin JSON parse failure / missing WorkerEnvelope
 *     fields) propagates as-is with no envelope to write; the caller cli.ts
 *     catches it → `[subagent-worker] fatal` + exit 2. After parse inside this
 *     function there remains no ProtocolError escape path (the run phase is
 *     contained).
 *   - run-phase escapes (assembly / finalization / typed escapes outside the
 *     loop's containment) → best-effort failed envelope on stdout + exit 1,
 *     never reusing 2.
 *   - exit 0 + failed envelope = structured failure derived by run()
 *     (reason ∈ the five-value enum, ADR-0111); the parent attributes from the
 *     envelope.
 */
export async function runSubagentWorker(
  transcriptIo?: WorkerTranscriptIOFactory
): Promise<void> {
  const input = await readStdin();
  const workerEnvelope = parseWorkerEnvelope(input);
  const phase = await runWorkerPhase(workerEnvelope, transcriptIo);
  // Single stdout wire: success and run-phase escapes share one write point;
  // the exit code is decided by the phase containment.
  process.stdout.write(JSON.stringify(phase.envelope) + "\n");
  process.exit(phase.exitCode);
}

/** The full run phase after parse: errors are always contained as
 *  (envelope, exitCode), never rethrown. */
async function runWorkerPhase(
  workerEnvelope: WorkerEnvelope,
  transcriptIo?: WorkerTranscriptIOFactory
): Promise<{
  readonly envelope: SubAgentEnvelope;
  readonly exitCode: number;
}> {
  try {
    return {
      envelope: await assembleAndRunWorker(workerEnvelope, transcriptIo),
      exitCode: WORKER_EXIT_OK,
    };
  } catch (err) {
    // Run-phase escape: diagnostics go to stderr (stdout is the single envelope
    // protocol wire); still write the envelope, exit 1.
    process.stderr.write(
      `[subagent-worker] run-phase error: ${renderWorkerError(err)}\n`
    );
    return {
      envelope: truncateEnvelopeResult(runEscapeEnvelope(err)),
      exitCode: WORKER_EXIT_RUN_PHASE,
    };
  }
}

/** Assembly → runWorkerOnce (the envelope is the process-level form of the return value). */
async function assembleAndRunWorker(
  workerEnvelope: WorkerEnvelope,
  transcriptIo?: WorkerTranscriptIOFactory
): Promise<SubAgentEnvelope> {
  const env = loadIknowEnv();
  const { deps, catalog } = await createWorkerRuntime({
    env,
    sandboxRoot: workerEnvelope.sandboxRoot,
    disallowedTools: workerEnvelope.disallowedTools,
    // envelope.role is threaded to the createWorkerDeps seam — when absent,
    // the key is omitted (V1 baseline, byte-stable). ADR-0112: envelope.systemPrompt
    // is no longer passed through as an addendum — the worker reads the envelope
    // directly at runtime, going through priorMessagesFromEnvelope's
    // user/untrusted channel, never into system.
    ...(workerEnvelope.role !== undefined ? { role: workerEnvelope.role } : {}),
    // ADR-0019: the worker inherits the parent env SSOT — when the spawning
    // parent set IKNOW_WORKSPACE_ROOT, the worker's fs-policy fence protects
    // `.iknow` by the same root (same shape as build-engine). Conditional
    // resolution: with neither flag nor env, don't resolve, keeping the
    // sandboxRoot fallback (legacy bytes unchanged).
    ...(env.workspaceRoot !== undefined
      ? {
          workspaceRoot: resolveWorkspaceRoot({
            cwd: process.cwd(),
            env: { [WORKSPACE_ROOT_ENV_KEY]: env.workspaceRoot },
          }),
        }
      : {}),
    // The project identity root the parent session passes down via
    // IKNOW_PRODUCT_ROOT (ADR-0037). `env.productRoot` is the env-var-side
    // name (the wire is unchanged); the in-process option surface is called
    // `projectIdentityRoot`. Absent (un-rebound / old wire) → not passed →
    // createWorkerRuntime falls back to cwd.
    ...(env.productRoot !== undefined
      ? { projectIdentityRoot: env.productRoot }
      : {}),
    // ADR-0092: the fs isolation tier written over by the parent via
    // IKNOW_FS_MODE → the worker's bash-factory holder. Absent / invalid →
    // key absent = global tier (bash handler entry falls back by default),
    // legacy parents (not writing the key) keep bytes unchanged.
    ...fsModeOptionFromEnv(process.env),
    // Parent process IKNOW_WORKTREE_GATE_ON → this process's holder (absent =
    // no segment emitted) for the worktree-on-mutate switch.
    ...worktreeGateOptionFromEnv(process.env),
    // ADR-0119: parent's IKNOW_YOLO → this worker's bash-factory holder. "0" /
    // absent (off / legacy parent) → empty spread = fence present.
    ...yoloOptionFromEnv(process.env),
    // ADR-0071: the parent manager already created
    // `<parent session folder>/subagents/agent-<taskId>.jsonl` for this taskId
    // at spawn time and threads traceFilePath + taskId through the envelope —
    // the worker writes that path directly in file-mode, replacing the retired
    // fake-scope `randomUUID()`. Absent (legacy envelope / cross-version
    // resume) → the IKNOW_TRACE_OUT fallback (byte-stable).
    ...(workerEnvelope.traceFilePath !== undefined &&
    workerEnvelope.taskId !== undefined
      ? {
          traceFilePath: workerEnvelope.traceFilePath,
          taskId: workerEnvelope.taskId,
        }
      : {}),
    // ADR-0085: parent-session ledger anchor — the parent manager computes it
    // into the envelope at spawn (projectDir shares its source with the main
    // loop registry's todoDir; conversationId = the parent session id). The
    // worker hangs its todo_write off the parent ledger (read / update; adds
    // are typed-rejected by the tool). Absent (old wire / cross-version
    // resume) → not passed, the worker's tool surface keeps the legacy form.
    ...(workerEnvelope.todoLedger !== undefined
      ? { todoLedger: workerEnvelope.todoLedger }
      : {}),
    // The parent session's full model-index snapshot — present (including an
    // empty array) → the worker's `<available_skills>` frozen table takes it
    // as its sole source; absent (old wire / cross-version resume) → fall back
    // to the worker's own independent rescan (byte-stable). An empty array is
    // deliberately not folded into absence: it is the definite fact that "the
    // parent truly has no model index", see the envelope field comment.
    ...(workerEnvelope.skillIndexSnapshot !== undefined
      ? { skillIndexSnapshot: workerEnvelope.skillIndexSnapshot }
      : {}),
  });
  // Observation floor for fileRefs: derived from the ACI catalog actually
  // assembled for this worker, taking the tools with category:"write" (the
  // real tool surface after def-list trimming).
  return runWorkerOnce({
    workerEnvelope,
    deps,
    writeToolNames: writeToolNamesFrom(catalog),
    transcriptIo,
  });
}
