/**
 * ACI toolset assembly layer — single source of truth for which tools exist
 * and how env is injected, shared by every harness entry (CLI `ask` /
 * `chat` / `serve`, TUI `iknow tui`). Without it toolsets drift apart
 * (historical lesson: a hand-written file-tool list in `src/tui/deps.ts`
 * forgot to register web_fetch / web_search).
 *
 * This module only decides "which tools + env passthrough"; it does not
 * replace `createAciRegistry` (which owns the protocol registry and the
 * lazy-load catalog).
 *
 * **Append-only**: never reorder (the policy byName keyspace and ADR-0006
 * require stable ordering). Web-family tools follow the historical order
 * from build-engine.ts; memory_recall / memory_save (conditional: omitted
 * without memoryDir) come after them; `tool_search` is appended last.
 */
import type { IknowEnv } from "../../../config/env.js";
import { createAciRegistry, type AciRegistry } from "../aci-registry.js";
import type { AciToolDef } from "../types.js";
import { createBashTool } from "./bash.js";
import type { SecretRegistry } from "../../secret-roundtrip/index.js";
import { createReadFileTool } from "./read-file.js";
import { createReadImageTool } from "./read-image.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createEditFileTool } from "./edit-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createMemoryRecallTool } from "../../memory/tools/recall.js";
import { createMemorySaveTool } from "../../memory/tools/save.js";
import { createToolSearchTool } from "./tool-search.js";
import { createSymbolQueryToolSet } from "./symbol.js";
import { createSymbolMutateToolSet } from "./symbol-mutate.js";
import type { LspCtx } from "../../lsp/types.js";
import type { FsModeContext } from "../../sandbox/fs-mode.js";
import { createSkillTool } from "./skill.js";
import { createSpawnSubAgentTool } from "../../subagent/spawn-subagent-tool.js";
import { createSubAgentResultTool } from "../../subagent/subagent-result-tool.js";
import { createSubAgentStopTool } from "../../subagent/subagent-stop-tool.js";
import { createSubAgentContinueTool } from "../../subagent/subagent-continue-tool.js";
import { createRunGraphTool } from "../../graph/run-graph-tool.js";
import type { LiveGraphLedgerHost } from "../../graph/ledger.js";
import {
  createLastReadLedgerHost,
  type LastReadLedgerHost,
} from "../last-read-ledger.js";
import type { SubAgentManager } from "../../subagent/manager.js";
import type { SubagentCapacityHolder } from "../../subagent/manager.js";
import type { WorktreeGateReader } from "../../isolation/worktree-gate.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import type { McpManager } from "../../mcp/manager.js";
import type { AgentCatalogResolver } from "../../subagent/catalog.js";
import { createListMcpResourcesTool } from "./list-mcp-resources.js";
import { createReadMcpResourceTool } from "./read-mcp-resource.js";
import { createBashOutputTool } from "./bash-output.js";
import { createBashStopTool } from "./bash-stop.js";
import { buildWorkerToolSurface } from "../../subagent/role.js";
import { RegistryConstructionError, ToolExecutionError } from "../../errors.js";
import type { SkillCatalog } from "../../skill/catalog.js";
import { createTodoWriteTool, type TodoWriteActor } from "./todo-write.js";
import { createQueryTraceTool } from "./query-trace.js";
import { createListSessionsTool } from "./list-sessions.js";
import { createGetRecordTool } from "./get-record.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import {
  createCreateWorktreeTool,
  type CreateWorktreeProvisionFn,
} from "./create-worktree.js";
import {
  createEnterWorktreeTool,
  type WorktreeEnterToolDeps,
} from "./enter-worktree.js";
import {
  createExitWorktreeTool,
  type WorktreeExitToolDeps,
} from "./exit-worktree.js";
import {
  createListWorktreesTool,
  type ListWorktreesToolDeps,
} from "./list-worktrees.js";
import {
  createRemoveWorktreeTool,
  type RemoveWorktreeToolDeps,
} from "./remove-worktree.js";
import { join } from "node:path";

/**
 * Naming constants for the production tools an LLM agent calls — naming
 * SSOT, not a test fixture. Exporting it splits two layers:
 *   - Assembly: `createDefaultAciRegistry()` wires the factories and returns
 *     the AciRegistry; production entries (build-engine / TUI) only talk to
 *     the factory.
 *   - Naming: this list is the authoritative declaration of the iknow
 *     toolset. Tests consume it to pin the set, and future diagnostics /
 *     tool_search-style hooks look tools up by name.
 *
 * "Consumed by test assertions" ≠ "test tool" — this is the naming
 * authority; tests are just one of its consumers.
 *
 * **Gate 3 (SSOT append-only discipline)**: `createDefaultAciRegistry`
 * derives its assembly from this list; any divergence between the factory
 * keys and the list (length / order / membership) throws
 * `RegistryConstructionError` at assembly time. Adding a tool to the
 * factories without appending it here (or vice versa, or reordering) fails
 * immediately instead of lurking until runtime. memory_recall /
 * memory_save are conditional (they vanish together with memoryDir); Gate 3
 * mirror-filters `toolsetNames` accordingly (see the factory tail comment).
 */
export const ACI_TOOLSET_NAMES = Object.freeze([
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
  "memory_recall", // conditional: omitted when memoryDir is absent
  "memory_save", // conditional: same as memory_recall
  "tool_search", // lazy-discovery entry point
  // skill tool, append-only. One tool, conditional (absent without
  // skillCatalog — same shape as memoryDir: Gate 3 mirror-filters
  // toolsetNames, see the factory tail comment).
  // `skill_search` was removed (ADR-0046): the `<available_skills>` index
  // already lists name + description, and `skill({name})` brings back the
  // body directly, so the direct-call path needs no second search step.
  "skill", // direct skill body fetch by name
  // spawn_subagent, append-only. Conditional (absent without
  // subagentManager — same shape as skillCatalog / memoryDir: Gate 3
  // mirror-filters toolsetNames, see the factory tail comment).
  "spawn_subagent", // parent agent dispatches a subagent (returns task_id async)
  // subagent_result, append-only. Conditional (absent without
  // subagentManager — same gate shape as spawn_subagent).
  "subagent_result", // parent polls subagent state (not_found/running/completed/failed)
  // Session-ledger / MCP / background additions, append-only (all three
  // conditional — Gate 3 mirror-filters toolsetNames, see factory tail):
  //   - todo_write: absent without todoDir — the ask surface does not pass
  //     it (oneshot surfaces strip it); worker assembly passes the parent's
  //     todoDir with todoActor{canAdd:false} (ADR-0085: worker shares the
  //     parent ledger — read/update allowed; `add` is rejected inside the
  //     tool handler, not by hiding the tool).
  //   - list_mcp_resources / read_mcp_resource: absent without mcpManager —
  //     ask inlet parts + task workers.
  // MCP resources are read-only and off on the default ask surface,
  // aligned with the web_fetch / web_search precedent (ask gates side
  // effects, not content review). The list tool is iknow-authored and
  // transparent, honestly labelled read-only (unlike the conservative
  // write default for dynamic mcp__* tools).
  "todo_write", // session-scoped todo ledger (host injects todoDir)
  "list_mcp_resources", // list resources exposed by MCP servers (aggregated; optional server + cursor)
  "read_mcp_resource", // read one resource's content (server + uri required)
  // bash_output / bash_stop, append-only — the model-facing pair for
  // bash background:true. Both conditional (absent without
  // backgroundManager — ask inlet parts; bash itself stays resident, its
  // parameter-level capability is a runtime handler decision; Gate 3
  // mirror-filters toolsetNames, see factory tail).
  "bash_output", // tail of a background task's log + status/exit_code (read-only, allow by default)
  "bash_stop", // kill a background task's process group (SIGTERM→2s→SIGKILL; write, ask by default)
  // run_graph, append-only. Conditional (registered only when graphAssembly
  // AND subagentManager are both present — ask / worker / entries without
  // the overlay all lack them; Gate 3 mirror-filters toolsetNames, see
  // factory tail).
  // Registering ≠ visible: when this round's graph snapshot is off, the
  // assembly layer filters it out of promptTools, and the handler also
  // exits (ADR-0030 — the overlay is a runtime-flippable switch while the
  // registry is frozen at construction, so only this pairing aligns them).
  "run_graph", // parent declares a DAG; host orchestrates waves + foreground spawns
  "query_trace", // trace read-side projection and record drill-down
  // create-worktree ACI tool, append-only. Conditional (absent without the
  // worktreeProvision host seam — hub-less inlets / worker assembly).
  // ADR-0037 (amended 2026-09-11) revoked "tool present ⇔ switch ON":
  // switch OFF no longer unregisters the tool. Gate 3 mirror-filters
  // toolsetNames, see factory tail. The name must match the gate hint
  // constant `CREATE_WORKTREE_TOOL_HINT` ("create-worktree ACI tool")
  // verbatim — a blocked mutate's message must point at a tool that
  // really exists. ADR-0082 renamed it: the registered name drops `-task`
  // (position kept, still append-only).
  "create-worktree",
  // enter-worktree, append-only. Conditional (absent without the
  // worktreeEnter host seam — TUI wires provision only / worker assembly /
  // hub-less inlets; Gate 3 mirror-filters toolsetNames). The tool takes
  // only the owner conversationId; the target path is derived from the
  // SSOT `taskWorktreePath`, never from a free-form path.
  "enter-worktree",
  // exit-worktree, append-only. Conditional (absent without the
  // worktreeExit host seam — same shape as worktreeEnter). The tool takes
  // no parameters; the main-repo root is derived by the host from the
  // tree itself (git common dir), and the tree is kept, not deleted.
  "exit-worktree",
  // Symbol-query toolset, append-only. Coexists with the 10 coordinate
  // `lsp_*` tools from the older layer until the coordinate surface is
  // removed from the model face; this batch asks by symbol identity
  // (`{ file, symbol_path }`) — row/column decoding is sealed in
  // symbol-resolver.ts. Appended at the tail rather than inserted after
  // lsp_* — the append-only discipline of this file (policy byName
  // keyspace and ADR-0006 stability) forbids reordering.
  "find_symbol", // find symbols workspace-wide by name/pattern (empty query rejected by schema)
  "find_declaration", // declaration/definition
  "find_referencing_symbols", // references (including the declaration)
  "find_implementations", // interface/abstract members → concrete implementations
  "get_symbols_overview", // single-file outline (entry point for symbol_path)
  "get_hover", // type/signature/docs
  "get_diagnostics_for_file", // file diagnostics (`file` and `files` are mutually exclusive)
  "prepare_call_hierarchy", // call-graph items
  "list_incoming_calls", // callers
  "list_outgoing_calls", // callees
  // Symbol-mutation toolset, append-only (resident, category=write). Code
  // changes by symbol identity (`{ file, symbol_path }`); row/column
  // decoding is sealed in symbol-resolver.ts. category="write": after a
  // write, onEdit → lspNotifier fires textDocument/didChange through the
  // same chain as edit_file. edit_file stays — for text patches that are
  // not a single symbol.
  // The array itself is the source of truth for the tool count; no
  // hardcoded totals live here.
  "rename_symbol", // rename a symbol project-wide (textDocument/rename + applyEdit)
  "replace_symbol_body", // replace a definition body (range = node.range: signature + body)
  "insert_before_symbol", // insert before a symbol definition (at range.start)
  "insert_after_symbol", // insert after a symbol definition (at range.end)
  "safe_delete_symbol", // delete only when unreferenced; else typed failure + reference list
  // Trace read-side catalog axis (which sessions exist), append-only,
  // orthogonal to query_trace's row axis; resident (same door as
  // query_trace — no host seam to condition on).
  //
  // Position is a contract, not style: Gate 3 compares factory keys against
  // this list by length + order + membership, so the matching factory must
  // be the **last key** of the `factories` literal (after the
  // symbolMutateTools spread). Several downstream tests pin mid-array
  // indices, so inserting before them breaks red — tail-append is the only
  // safe edit.
  "list_sessions",
  // Trace read-side content axis (a character window inside one record),
  // append-only, orthogonal to the catalog and row axes; resident (same
  // door as query_trace / list_sessions — no host seam to condition on).
  //
  // Still tail-append only: mid-array insertion collides with the
  // index-pinned downstream assertions above.
  "get_record",
  // task-worktree-lifecycle: discovery and explicit cleanup are appended after
  // the existing ACI surface. Both host seams are independently conditional.
  "list-worktrees",
  "remove-worktree",
  // subagent_stop, append-only (ADR-0101). Conditional on the same seam as
  // spawn_subagent / subagent_result (subagentManager; Gate 3
  // mirror-filters toolsetNames). The parent model's stop lever is the
  // symmetric arm of the operator's Ctrl+X.
  "subagent_stop",
  // subagent_continue, append-only (ADR-0102). Same condition
  // (subagentManager); revives a dead worker only when its ledger exists,
  // the gate sits in manager.resumeTask, and the wait contract matches
  // spawn's.
  "subagent_continue",
  // read_image, append-only. Resident (no host seam to condition on —
  // same door as read_file / grep / glob). Images inside the fence are
  // read by magic number into SDK image blocks and are NOT booked into
  // the last-read ledger (ADR-0084 keeps the write-gate admission surface
  // unchanged).
  "read_image",
] as const);

/**
 * Factory input: consumes only env.web fields (endpoint overrides + egress
 * proxy) plus the sandbox root. Deliberately not the full IknowEnv, so LLM
 * keys and other sensitive fields cannot leak into tool scope by mistake.
 */
export interface CreateDefaultAciRegistryOptions {
  readonly env: Pick<IknowEnv, "web">;
  /** Soft sandbox root (process.cwd() or an explicit caller path; fs tools reject escapes against it). */
  readonly sandboxRoot: string;
  /** Memory base dir. When absent, memory_recall / memory_save are not registered. */
  readonly memoryDir?: string;
  /** Skill index catalog. When absent, skill is not registered (after
   *  skill_search was removed, only the one skill tool remains). */
  readonly skillCatalog?: SkillCatalog;
  /** Local subagent lifecycle manager for the parent agent. When absent,
   *  spawn_subagent is not registered (ask-inlet parts scenario;
   *  chat/tui/serve build it per-surface in build-engine). */
  readonly subagentManager?: SubAgentManager;
  /** ADR-0096: capacity-value holder — passed to the tool factory paired
   *  with subagentManager; the description getter reads the holder live,
   *  falling back to manager.getCapacity() when absent. */
  readonly subagentCapacityHolder?: SubagentCapacityHolder;
  /**
   * spawn_subagent defaults to `createMergedCatalogResolver()` (same source
   * as capability resolution), and that default path is ledger-aware — it
   * loads plugin agents from the local `<home>/.iknow/plugins` ledger.
   * Tests / hub-less entries that want to decouple from installed plugins
   * inject an explicit resolver (description guards and ask-assembly paths
   * consume this seam). The production build-engine path deliberately does
   * **not** inject one, sharing the resolver with capability resolution.
   */
  readonly agentCatalog?: AgentCatalogResolver;
  /** MCP resource channel manager. When absent, list_mcp_resources /
   *  read_mcp_resource are not registered (ask-inlet parts + task workers;
   *  chat/tui/serve build it per-surface in build-engine). Same shape as
   *  subagentManager / skillCatalog / memoryDir: Gate 3 mirror-filters
   *  toolsetNames, see the factory tail comment. */
  readonly mcpManager?: McpManager;
  /** onEdit seam: callback after edit_file writes successfully (assembly wires the LSP notifier). */
  readonly onEdit?: (file: string) => void;
  /**
   * Full LspCtx passed through to the symbol toolset (symbol.ts /
   * symbol-resolver.ts / symbol-mutate.ts take this ctx when consuming the
   * lsp.ts SSOT internally — the old 10 `lsp_*` coordinate tools have
   * retired from the model face, so this field serves only symbol tools).
   * Falls back to `{ directory: sandboxRoot }` when absent. build-engine /
   * worker must pass the same object as the notifier/warmup path, otherwise
   * settings.lsp (timeout / wait / idle / disabledServers) never reaches
   * the symbol-tool path.
   */
  readonly lspCtx?: LspCtx;
  /** ADR-0019 (T4): per-root state anchor. Threaded into read_file so its
   *  `extraReadRoots` admit `<workspaceRoot>/.iknow` at parity with the home
   *  profile (the agent's per-root persona state). ADR-0092 global mode: not a
   *  bind root; bash no longer threads it (no predicate, no per-root mount).
   *  Defaults to `sandboxRoot` (legacy shape) when absent. */
  readonly workspaceRoot?: string;
  /** ADR-0037: project identity root — the stable read-only root handed to
   *  `read_file` / `grep` / `glob` when the session isolation switch is ON.
   *  Tools re-require at call time that the live `taskRoot` is a task
   *  worktree, so a same-run rebind takes effect while the OFF tier still
   *  gains no extra read root. **Not** threaded to bash / write / edit —
   *  writes must not escape the sandbox. Absent / equal to sandboxRoot →
   *  no extra read root. */
  readonly projectIdentityRoot?: string;
  /** Per-engine secret registry. Threaded to the bash factory — the handler
   *  restores placeholders to real values before execution (see the restore
   *  section in bash.ts). Absent → bash commands pass through verbatim
   *  (byte-identical behavior, backward compatible). */
  readonly secretRegistry?: SecretRegistry;
  /** Deny-list: permissive def-list trimming at assembly
   *  (buildWorkerToolSurface semantics) — absent / undefined / empty array
   *  means no trimming, backward compatible. Composes orthogonally with the
   *  existing conditional assembly (memoryDir / skillCatalog /
   *  subagentManager); Gate 3 mirror-filtering keeps toolsetNames and the
   *  factory key set consistent. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** ADR-0085: session-scoped todos.md directory. Host injects: build-engine
   *  resolves it from session/conversationId (one per conversation). Absent →
   *  todo_write is not registered (same shape as memoryDir; ask-inlet parts).
   *
   *  Worker assembly also injects this — a worker shares the parent
   *  session's ledger (read / update), paired with `todoActor` to express
   *  "only the parent may add". */
  readonly todoDir?: string;
  /** ADR-0085: todo_write caller capabilities (actor). conversationId is the
   *  fallback source for `ctx.conversationId` (the worker-process executor
   *  does not synthesize that ctx field); with `canAdd:false` the tool's
   *  `add` rejects typed inside the handler.
   *  Absent → behavior byte-identical to before (canAdd treated as true,
   *  only ctx.conversationId consulted). */
  readonly todoActor?: TodoWriteActor;
  /**
   * Current-identity fence `/tmp` pad. Worker assembly points this at
   * `subagents/<taskId>/fence-tmp`. Absent → bash/write keep the existing
   * session/fallback resolve.
   */
  readonly tmpDir?: string;
  /** Background task manager. When present it is threaded to the bash
   *  factory — the `background: true` branch becomes usable (handler goes
   *  through manager.spawn and returns task_id immediately). Absent →
   *  bash's background:true throws ToolExecutionError (fail-fast). Same
   *  shape as subagentManager / skillCatalog: pass-through only, no
   *  conditional tool naming — bash is resident, and its parameter-level
   *  capability is a runtime handler decision. */
  readonly backgroundManager?: BackgroundTaskManager;
  /** bash mode, explicitly passed through by worker.ts — with "readonly" the
   *  bash handler runs validateReadonlyCommand and tightens the fence with
   *  cwdReadonly:true (double gate). The registry only forwards it and does
   *  not read the catalog (catalog routing belongs to the spawn-subagent-tool
   *  factory). Default → bash is byte-identical to V1. */
  readonly bashMode?: "any" | "readonly";
  /** ADR-0030: this round's graph assembly snapshot (read side of
   *  `GraphAssembly`). `run_graph` enters the registry only when this and
   *  `subagentManager` are both present; absent (ask / worker / entries
   *  without the overlay) → not assembled. Tool **visibility** is decided
   *  by the snapshot — the assembly layer filters promptTools accordingly,
   *  see build-engine. */
  readonly graphAssembly?: { readonly enabled: () => boolean };
  /**
   * ADR-0047: live-graph ledger host — lives as long as the session
   * runtime (the host owns / destroys it); ledger authority sits in
   * harness/graph. Absent → the `run_graph` handler keeps no ledger
   * (zero behavior change from V1).
   */
  readonly liveGraphLedger?: LiveGraphLedgerHost;
  /**
   * ADR-0084: optional seam for the last-read ledger host
   * (`conversationId → set of canonical paths`). If not passed, the
   * registry builds its own (default wiring: the write gate is live).
   * Injecting the same instance lets old reads survive across registries
   * (rebind rebuilds / hub cachedDeps reuse) — current production does not
   * inject, so a per-root rebuilt registry starts from an empty table (the
   * lifetime rule). The ledger affects exactly one gate — whether a
   * non-empty write_file needs a prior read — and absent behavior matches
   * pre-ADR-0084 (no rejection), so it is not a Gate 3 conditional-assembly
   * switch.
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /** Trace directory for the read-only query_trace tool. */
  readonly traceDir?: string;
  /**
   * ADR-0037 (amended 2026-08-30): worktree isolation host provision
   * seam (session-api hub, threaded by build-engine). Present → the
   * `create-worktree` ACI tool enters the registry; absent (switch
   * OFF, worker assembly, hub-less inlets) → excluded via the Gate 3 mirror
   * filter, keeping OFF byte-identical to today's tool surface.
   */
  readonly worktreeProvision?: CreateWorktreeProvisionFn;
  /**
   * ADR-0037 (amended 2026-08-30): explicit-enter host seam. Present →
   * the `enter-worktree` ACI tool enters the registry; absent (TUI
   * provision-only wiring, worker assembly, hub-less inlets) → excluded via
   * the Gate 3 mirror filter.
   */
  readonly worktreeEnter?: WorktreeEnterToolDeps["worktreeEnter"];
  /**
   * ADR-0037 (amended 2026-08-30): symmetric-exit host seam. Present →
   * the `exit-worktree` ACI tool enters the registry; absent (TUI
   * provision-only wiring, worker assembly, hub-less inlets) → excluded via
   * the Gate 3 mirror filter.
   */
  readonly worktreeExit?: WorktreeExitToolDeps["worktreeExit"];
  /**
   * Task-worktree discovery seam. Present → list-worktrees enters the
   * registry; absent → the worker / OFF / hub-less surfaces omit it.
   */
  readonly worktreeList?: ListWorktreesToolDeps["worktreeList"];
  /**
   * Explicit task-worktree removal seam. Present → remove-worktree enters
   * the registry; absent → the tool is excluded by the Gate 3 mirror.
   */
  readonly worktreeRemove?: RemoveWorktreeToolDeps["worktreeRemove"];
  /**
   * Live `taskRoot` cell. When
   * provided, `write_file` / `edit_file` factories receive the cell and the
   * handler reads the snapshot at call time — `worktree rebind` in the same
   * run reaches them. When absent (legacy / one-shot callers), factories
   * receive `sandboxRoot` as a string — existing tests and behavior stay
   * byte-identical. The cell only carries the live `taskRoot` (stable
   * roots stay frozen), so this field is intentionally narrow.
   */
  readonly liveTaskRoot?: LiveTaskRoot;
  /**
   * Worktree-isolation tier flag, read once at `buildHarnessEngine` startup
   * (same source as arming the gate). Since ADR-0079, `skill()` body
   * assembly no longer consumes it (skill bodies carry no write-root
   * trailer; createSkillTool takes only the catalog). Kept for future
   * isolation-tier consumers. Absent → no consumer affected.
   */
  readonly isolationOn?: boolean;
  /**
   * ADR-0092: fs isolation-mode holder — threaded to the bash factory and
   * read per call via `get()` (same batch-snapshot discipline as
   * `liveTaskRoot`). Present → the bash fence layers `--ro-bind <home>` and
   * the other tiers on top; absent → global mode (V1 baseline). build-engine
   * resolves `resolveFsIsolationMode(settings)` once at assembly and
   * installs it into the holder.
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0092: workspace-tier home ro-bind source, a host absolute path.
   * Default: the build-engine assembly layer derives it from `userHome`
   * (tests may inject).
   */
  readonly homeRoot?: string;
  /**
   * worktree-on-mutate live-switch holder (read-only view) — threaded to
   * the bash factory; the handler entry reads it once at the same vintage
   * as waveRoot. Gate ON ∧ waveRoot is the main checkout → foreground /
   * background fences add the UNBOUND_FENCE physical ro-bind segment;
   * absent → the segment is never emitted (V1 baseline byte-identical).
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * ADR-0097: egress allow-list policy factory — threaded to the bash
   * factory (`createBashTool({ egressPolicyFactory })`). Production:
   * build-engine constructs it via `createEgressPolicyFactory({ settings })`.
   * Absent → this assembly has no egress data plane → inside the bash
   * handler `policyInput === undefined` → no session starts and the fence
   * stays fully offline (`--unshare-net` always on, a legal fail-closed
   * state). Worker / hub-less inlets do not pass it — consistent with
   * "non-interactive entries only use preset configuration".
   */
  readonly egressPolicyFactory?: () =>
    import("../../sandbox/egress/session.js").EgressPolicyInput | undefined;
  /**
   * ADR-0097: first-domain approval ask inlet — threaded to the bash
   * factory, where the factory closure wraps it into an
   * `EgressApprovalGate` (per-session allowed/denied sets + in-flight
   * coalescing). Default (no interactive inlet) → the gate fails closed:
   * an unseen domain is recorded directly as a `no-approval-inlet`
   * violation. Production: build-engine adapts the existing `AskUser` into
   * `(host) => Promise<boolean>` (see the askApproval assembly note in
   * bash.ts).
   */
  readonly askApproval?: import("../../sandbox/egress/approval.js").AskApproval;
}

/**
 * Default tool-registry factory — SSOT. Absent memoryDir drops the memory
 * pair from the set; present memoryDir adds memory_recall + memory_save.
 *
 * **Assembly-time fail-fast**:
 *   - invalid proxyUrl (non-http/https / contains credentials) →
 *     `createDefaultGuardDeps` inside `createWebFetchTool` /
 *     `createWebSearchTool` throws ToolExecutionError synchronously,
 *     matching build-engine.ts's existing behavior.
 *   - **Gate 3 (SSOT append-only discipline)**: divergence between
 *     `ACI_TOOLSET_NAMES` and the `factories` record keys below (length /
 *     order / membership) throws `RegistryConstructionError` synchronously.
 *     The derived-from-map shape gives the gate teeth: adding a tool to one
 *     side only fails at assembly time, never lurking until runtime. memory
 *     conditioning: when memoryDir is absent, toolsetNames strips
 *     memory_recall / memory_save before the Gate 3 comparison, matching
 *     the factories key set.
 *
 * **Return value**: `AciRegistry` (protocol layer `inner` + permission /
 * lazy-load catalog), directly consumable by `createExecutor` and
 * `createAciExecutor`.
 *
 * **tool_search self-reference**: `tool_search` needs the fully assembled
 * registry, but holding it directly would be a self-reference cycle — so
 * its deps take a lazy `getRegistry: () => AciRegistry` closure resolved
 * from `assembled.reg` after assembly completes. Calling before assembly
 * throws ToolExecutionError (fail-fast).
 */
/**
 * The 10 coordinate `lsp_*` AciToolDefs from `lsp.ts`
 * (`createLspToolSet`) have retired from the model face. `lsp.ts` remains
 * an internal SSOT: `LSP_ACI_META` / `renderNoServer` / `extractCallHierarchyItems` /
 * `getClientForWorkspaceDetailed` / `compileValidator` / `stringifyResult` /
 * `createRequestCancellation` / `timeoutError` / `isLspFailureSentinel` /
 * `makeOperationTool` / `makeDiagnosticsTool` / `makeCallHierarchyCallTool`
 * are imported directly by symbol-resolver / symbol-mutate, no longer
 * reaching the model face through a `...lspTools(lspCtx)` spread in the
 * factories map.
 *
 * Internal-SSOT coverage tests (`tests/harness/aci/lsp.test.ts` etc.) still
 * call `createLspToolSet` directly against the AciToolDef shape — see the
 * SSOT note at the top of lsp.ts. `createDefaultAciRegistry` no longer
 * exposes any path that pulls lsp_* into the model face.
 */

/**
 * Expand the symbol-query toolset into a factories record (10 tools:
 * find_symbol / find_declaration / find_referencing_symbols /
 * find_implementations / get_symbols_overview / get_hover /
 * get_diagnostics_for_file / prepare_call_hierarchy / list_incoming_calls /
 * list_outgoing_calls). They share one lspCtx: the retired `lsp_*` set and
 * this batch consume the same lsp.ts internal SSOT, and only the symbol
 * tools are visible on the model face.
 */
function symbolQueryTools(ctx: LspCtx): Record<string, () => AciToolDef> {
  const tools = createSymbolQueryToolSet(ctx);
  const map: Record<string, () => AciToolDef> = {};
  for (const t of tools) {
    map[t.name] = () => t;
  }
  return map;
}

/**
 * Expand the symbol-mutation toolset into a factories record (5 tools:
 * rename_symbol / replace_symbol_body / insert_before_symbol /
 * insert_after_symbol / safe_delete_symbol). Same shape as
 * symbolQueryTools: the factory returns the frozen AciToolDef list, keyed
 * by the names in ACI_TOOLSET_NAMES, sharing one lspCtx. `onEdit` is
 * threaded from the registry's opts — after a write it triggers
 * lspNotifier.invalidate(file) through the same seam as edit_file.
 */
function symbolMutateTools(
  ctx: LspCtx,
  onEdit: ((file: string) => void) | undefined
): Record<string, () => AciToolDef> {
  const tools = createSymbolMutateToolSet({ ctx, onEdit });
  const map: Record<string, () => AciToolDef> = {};
  for (const t of tools) {
    map[t.name] = () => t;
  }
  return map;
}

/**
 * ADR-0084: resolution point for the last-read ledger host. An injector
 * wins (a host seam shared across registries); otherwise the registry
 * builds its own — the gate's default wiring lives in this layer, so
 * assembly callers never need to know it exists (and there is no fourth
 * "must remember to pass" inlet). Current production takes the self-build
 * branch: each per-root rebuilt registry starts from an empty table.
 */
function resolveLastReadLedger(
  opts: CreateDefaultAciRegistryOptions
): LastReadLedgerHost {
  return opts.lastReadLedger ?? createLastReadLedgerHost();
}

export function createDefaultAciRegistry(
  opts: CreateDefaultAciRegistryOptions
): AciRegistry {
  const { env, sandboxRoot } = opts;
  const onEdit = opts.onEdit;
  const proxyUrl = env.web.proxy;
  const searchUrl = env.web.searchUrl;
  const memoryDir = opts.memoryDir;
  const skillCatalog = opts.skillCatalog;
  const subagentManager = opts.subagentManager;
  const mcpManager = opts.mcpManager;
  const secretRegistry = opts.secretRegistry;
  const disallowedTools = opts.disallowedTools;
  const backgroundManager = opts.backgroundManager;
  const graphAssembly = opts.graphAssembly;
  const liveGraphLedger = opts.liveGraphLedger;
  // ADR-0084: last-read ledger. Injection absent → the registry builds its
  // own (default wiring: write_file's gate is live for every registry
  // assembly entry). Carrying old reads across registries (rebind rebuilds /
  // hub cachedDeps reuse) would need the assembly layer to inject the same
  // instance; current production does not.
  const lastReadLedger = resolveLastReadLedger(opts);
  // bashMode is explicitly threaded to createBashTool. The registry does not
  // read the catalog — the spawn-subagent-tool factory is the true owner of
  // catalog routing.
  const bashMode = opts.bashMode;
  // ADR-0019 (T4): per-root state anchor. Threaded to read_file so its
  // `extraReadRoots` admit `<workspaceRoot>/.iknow` at parity with the home
  // profile. ADR-0092 global mode: bash no longer reads it. Falls back to
  // sandboxRoot when absent (legacy shape) so existing callers without
  // per-root state stay byte-identical.
  const workspaceRoot = opts.workspaceRoot ?? sandboxRoot;
  // Switch for todo_write's conditional assembly. Host-injected; build-engine
  // resolves a session-level directory when surface !== "ask" and threads it;
  // ask does not pass it → the tool is not registered (oneshot surfaces
  // strip it). Worker assembly threads the same parent-session root via
  // `todoLedger` (ADR-0085: shared ledger; `add` is rejected typed by the
  // tool handler, the tool itself stays on the worker surface). Gate 3
  // mirror-filter below.
  const todoDir = opts.todoDir;
  // ADR-0085: todo_write actor capability bits (parent vs worker) —
  // pass-through only; the Gate 3 switch still keys on todoDir alone
  // (tool names / counts do not drift with the actor).
  const todoActor = opts.todoActor;
  // create-worktree: conditional assembly switch (host provision seam).
  // build-engine threads it when the hub injects the host seam, decoupled
  // from isolationEnabled (ADR-0037 amended 2026-09-11: the tool registers
  // even when the switch is OFF); worker / ask / hub-less inlets do not pass
  // it → create-worktree stays out of the registry. Gate 3 mirror-filter
  // below.
  const worktreeProvision = opts.worktreeProvision;
  // enter-worktree: conditional assembly switch (host enter seam).
  // build-engine threads it when the host injects the enter seam; TUI
  // (provision only) / worker / hub-less inlets do not → the tool stays out
  // of the registry. Gate 3 mirror-filter below.
  const worktreeEnter = opts.worktreeEnter;
  // exit-worktree: conditional assembly switch (host exit seam). Same shape
  // as worktreeEnter: TUI (provision only) / worker / hub-less inlets do not
  // pass it → not registered.
  const worktreeExit = opts.worktreeExit;
  const worktreeList = opts.worktreeList;
  const worktreeRemove = opts.worktreeRemove;

  // holder: lazy dereference point for tool_search's self-reference (the
  // closure returns undefined before assembly completes; tool-search.ts's
  // resolveRegistry then throws ToolExecutionError as the fallback).
  const assembled: { reg?: AciRegistry } = {};

  // The coordinate surface and the symbol surface share one LspCtx — two
  // tool sets on one client/cancel/timeout chain; forking ctx would put
  // settings.lsp into a half-effective state.
  // Prefer the assembly layer's single lspCtx; fall back to sandboxRoot-only.
  const lspCtx: LspCtx = opts.lspCtx ?? { directory: sandboxRoot };

  // The read-side tools (query_trace / list_sessions / get_record) must
  // resolve to the same directory, or listed sessions would not be
  // queryable; hence the three-state fallback appears exactly once here.
  // Kept as a closure so read timing matches pre-merge behavior verbatim
  // (each factory dereferences at its own call, i.e. registry construction).
  const traceReadDir = () =>
    opts.traceDir ??
    process.env.IKNOW_TRACE_OUT ??
    join(workspaceRoot, "trace");

  // append-only: order matches build-engine.ts's existing policy (the
  // policy byName keyspace). Absent memoryDir → memory_recall / memory_save
  // are dropped from factories (the memoryEnabled=false ask path; see the
  // conditional construction in build-engine.ts). Absent skillCatalog →
  // skill is dropped from factories (only the one skill tool remains after
  // skill_search was removed; see ADR-0046).
  // Key order must match ACI_TOOLSET_NAMES item by item (Gate 3): memory_*
  // before tool_search, skill at the tail.
  const factories: Record<string, () => AciToolDef> = {
    bash: () =>
      createBashTool(sandboxRoot, {
        secretRegistry,
        ...(backgroundManager ? { backgroundManager } : {}),
        // bashMode pass-through — readonly mode triggers the validator +
        // the fence's cwdReadonly.
        ...(bashMode !== undefined ? { bashMode } : {}),
        // Thread the live taskRoot cell. Gate unwipped ⇒ cell initial value
        // = sandboxRoot; the handler reads the waveRoot once via
        // cell.read() and the foreground fence + background spawn share that
        // value. Absent liveTaskRoot → fall back to sandboxRoot (legacy
        // parity, byte-identical to V1).
        ...(opts.liveTaskRoot !== undefined
          ? { liveTaskRoot: opts.liveTaskRoot }
          : {}),
        // todoDir is the session project dir; bash resolves
        // `<sessionFolder>/fence-tmp` per conversationId (ADR-0074).
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        // worker identity pad (nested under subagents/<taskId>/).
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
        // ADR-0084: successful whitelisted single-file reads are booked in
        // (bash is one of the two admission sources).
        lastReadLedger,
        // ADR-0092: fs isolation-mode holder + homeRoot pass-through.
        // Holder present → bash handler reads `get()` once per call; absent →
        // global mode (V1 baseline). homeRoot is derived from userHome by the
        // assembly layer.
        ...(opts.fsMode !== undefined ? { fsMode: opts.fsMode } : {}),
        ...(opts.homeRoot !== undefined ? { homeRoot: opts.homeRoot } : {}),
        // UNBOUND_FENCE holder pass-through (absent = segment never emitted).
        ...(opts.worktreeOnMutate !== undefined
          ? { worktreeOnMutate: opts.worktreeOnMutate }
          : {}),
        // ADR-0097: egress data plane + approval ask surface. Both are
        // injected by the assembly layer (build-engine); absent = no seam →
        // fully offline / no ask surface → fail-closed, consistent with the
        // "non-interactive = deny" semantics of worker / hub-less inlets.
        ...(opts.egressPolicyFactory !== undefined
          ? { egressPolicyFactory: opts.egressPolicyFactory }
          : {}),
        ...(opts.askApproval !== undefined
          ? { askApproval: opts.askApproval }
          : {}),
      }),
    // Read-path tool factories take `liveTaskRoot ?? sandboxRoot` instead of
    // the frozen sandboxRoot (cell absent / never rebound → fall back to
    // sandboxRoot, byte-identical to the pre-rebind shape). The factory
    // handler reads the cell once per call to get a snapshot, same vintage
    // as read_file's extraReadRoots. glob / grep read per call likewise.
    //
    // The formerly-dead projectIdentityRoot seam is now genuinely consumed:
    // read-file.ts admits it into extraReadRoots (ADR-0037: identity-root
    // read-through). This layer still passes it via a spread guard, and
    // after rebind the identity-root files stay reachable (same vintage).
    read_file: () =>
      createReadFileTool(opts.liveTaskRoot ?? sandboxRoot, {
        workspaceRoot,
        ...(opts.projectIdentityRoot !== undefined
          ? { projectIdentityRoot: opts.projectIdentityRoot }
          : {}),
        ...(opts.projectIdentityRoot !== undefined
          ? { allowProjectIdentityRoot: true }
          : {}),
        // ADR-0092: the read surface shares the same session tmp identity as
        // write/edit (pass-through shape identical to write_file / edit_file
        // below).
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
        // ADR-0084: successful reads (including empty files and truncated
        // pages) are booked in — the admission source for the write gate.
        lastReadLedger,
      }),
    grep: () =>
      createGrepTool(opts.liveTaskRoot ?? sandboxRoot, {
        ...(opts.projectIdentityRoot !== undefined
          ? { projectIdentityRoot: opts.projectIdentityRoot }
          : {}),
        allowProjectIdentityRoot: opts.projectIdentityRoot !== undefined,
      }),
    glob: () =>
      createGlobTool(opts.liveTaskRoot ?? sandboxRoot, {
        ...(opts.projectIdentityRoot !== undefined
          ? { projectIdentityRoot: opts.projectIdentityRoot }
          : {}),
        allowProjectIdentityRoot: opts.projectIdentityRoot !== undefined,
      }),
    // write_file / edit_file read the live taskRoot. Gate unwipped ⇒ cell
    // initial value = sandboxRoot, byte-identical to today; the handler
    // reads the cell once and resolve + write within the same handler share
    // that snapshot.
    edit_file: () =>
      createEditFileTool(opts.liveTaskRoot ?? sandboxRoot, {
        onEdit,
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
      }),
    write_file: () =>
      createWriteFileTool(opts.liveTaskRoot ?? sandboxRoot, {
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
        // ADR-0084: non-empty overwrite consults the last-read table (the
        // write gate added by this slice).
        lastReadLedger,
      }),
    web_fetch: () =>
      createWebFetchTool({
        proxyUrl,
        backend: env.web.searchBackend,
        exaApiKey: env.web.exaApiKey,
        tavilyApiKey: env.web.tavilyApiKey,
        braveApiKey: env.web.braveApiKey,
      }),
    // Thread searchBackend + the three vendor keys to web_search. The env
    // loader has already resolved EXA_API_KEY / TAVILY_API_KEY /
    // BRAVE_API_KEY through expandPlaceholders (empty / "yes" / failed
    // placeholder → undefined); the handler's assertBackendConfig turns the
    // three states into fail-closed outcomes (missing_key /
    // backend_unset_with_key / default bing) — this layer only passes
    // through, no second validation. searchBackend lands in the closed set
    // after schema rejection (a loader typed-error fails buildHarnessEngine
    // assembly before reaching here), so pass-through suffices.
    web_search: () =>
      createWebSearchTool({
        envSearchUrl: searchUrl,
        proxyUrl,
        backend: env.web.searchBackend,
        exaApiKey: env.web.exaApiKey,
        tavilyApiKey: env.web.tavilyApiKey,
        braveApiKey: env.web.braveApiKey,
      }),
    ...(memoryDir
      ? {
          memory_recall: () => createMemoryRecallTool({ memoryDir }),
          memory_save: () => createMemorySaveTool({ memoryDir }),
        }
      : {}),
    tool_search: () =>
      createToolSearchTool({
        getRegistry: () => {
          const r = assembled.reg;
          if (!r) {
            throw new ToolExecutionError("tool_search: registry not assembled");
          }
          return r;
        },
      }),
    // The coordinate-surface lsp_* tools are removed from the model face;
    // the client / cancel / timeout / sentinel / diagnostics / call-hierarchy
    // SSOT layer implemented in lsp.ts is consumed by symbol.ts /
    // symbol-resolver.ts / symbol-mutate.ts instead, and the model surface
    // is taken over by the symbol tools (find_* / get_* / *_calls + the 5
    // mutation tools). nearestRoot boundaries and settings.lsp / idle /
    // disabledServers semantics live in the single lspCtx shared by the
    // symbol tools.
    // skill tool (conditional assembly: absent without skillCatalog).
    // skill_search was removed (ADR-0046): the `<available_skills>` index
    // section already gives name + description, and the direct
    // `skill({name})` call needs no second search step.
    ...(skillCatalog
      ? {
          // ADR-0079 — skill bodies no longer carry the write-root trailer:
          // createSkillTool does not consume liveTaskRoot / isolationOn;
          // the authoritative path for write-situation disclosure moved to
          // the worker prior (subagent/worker.ts) and the chat-session
          // rebind notification (chat-session.ts), sharing one
          // writeRootSegment helper.
          skill: () => createSkillTool({ catalog: skillCatalog }),
        }
      : {}),
    // spawn_subagent (conditional assembly: absent without subagentManager —
    // ask inlet parts; same shape as skillCatalog / memoryDir).
    // opts.agentCatalog is threaded to the spawn factory (default: the
    // createMergedCatalogResolver() path, same source as capability
    // resolution).
    // ADR-0096: opts.subagentCapacityHolder is threaded in sync (minimal
    // injection — not part of the Gate 3 mirror filter, same condition as
    // subagentManager). Absent semantics: the spawn factory falls back to
    // `manager.getCapacity()` (the manager itself holds the same gate value;
    // see readCapacity in spawn-subagent-tool.ts) — the gate value's single
    // truth sits on the manager/holder chain, and this conditional
    // pass-through is just a runtime preference for "read the holder live
    // when one exists"; both paths produce an equivalent description N.
    ...(subagentManager
      ? {
          spawn_subagent: () =>
            createSpawnSubAgentTool({
              manager: subagentManager,
              ...(opts.agentCatalog !== undefined
                ? { catalog: opts.agentCatalog }
                : {}),
              ...(opts.subagentCapacityHolder !== undefined
                ? { capacityHolder: opts.subagentCapacityHolder }
                : {}),
            }),
        }
      : {}),
    // subagent_result (conditional assembly: absent without subagentManager,
    // same shape as spawn_subagent; Gate 3 mirror filter below).
    ...(subagentManager
      ? {
          subagent_result: () =>
            createSubAgentResultTool({ manager: subagentManager }),
        }
      : {}),
    // todo_write (conditional assembly: absent without todoDir — on the ask
    // surface build-engine does not pass todoDir (oneshot stripping); Gate 3
    // mirror filter below).
    // ADR-0085: worker assembly also passes todoDir + todoActor{canAdd:false}
    // — the tool stays present (the model can read `add`'s typed rejection
    // reason), and the actor seam carries the parent session id + capability
    // bits.
    ...(todoDir
      ? {
          todo_write: () =>
            createTodoWriteTool({
              todoDir,
              ...(todoActor !== undefined ? { actor: todoActor } : {}),
            }),
        }
      : {}),
    // MCP resources tools (conditional assembly: absent without mcpManager —
    // ask inlet parts + task workers; same shape as subagentManager /
    // skillCatalog / memoryDir; Gate 3 mirror filter below).
    // list / read both dereference the manager lazily via getManager; if
    // mcpManager is absent at assembly time the tools never enter the
    // registry (the handler is never routed to).
    ...(mcpManager
      ? {
          list_mcp_resources: () =>
            createListMcpResourcesTool({
              getManager: () => mcpManager,
            }),
          read_mcp_resource: () =>
            createReadMcpResourceTool({
              getManager: () => mcpManager,
            }),
        }
      : {}),
    // bash_output / bash_stop (conditional assembly: absent without
    // backgroundManager — ask inlet parts; the resident bash tool is not in
    // this class, its background:true parameter capability is a runtime
    // handler decision. Gate 3 mirror filter below).
    ...(backgroundManager
      ? {
          bash_output: () => createBashOutputTool({ backgroundManager }),
          bash_stop: () => createBashStopTool({ backgroundManager }),
        }
      : {}),
    // `run_graph` registers permanently — graph mode on/off is decided only
    // by the handler-level isEnabled gate (rejection surfaces as
    // ToolExecutionError at runtime). When `subagentManager` is absent the
    // same conditional skips assembly (the orchestration substrate is
    // indispensable; same shape as spawn_subagent).
    //
    // ADR-0047: the live-graph ledger threads through as a host seam;
    // absent → the tool handler keeps no ledger (zero behavior change from V1).
    ...(subagentManager
      ? {
          run_graph: () =>
            createRunGraphTool({
              manager: subagentManager,
              isEnabled: graphAssembly
                ? () => graphAssembly.enabled()
                : undefined,
              ...(liveGraphLedger ? { ledger: liveGraphLedger } : {}),
            }),
        }
      : {}),
    query_trace: () => createQueryTraceTool(traceReadDir()),
    // create-worktree (conditional assembly: absent without the
    // worktreeProvision host seam). The handler closure binds this engine's
    // sandboxRoot = the session's current root; tree creation + rebind side
    // effects are all delegated to the host provision seam (session-api hub).
    ...(worktreeProvision
      ? {
          "create-worktree": () =>
            createCreateWorktreeTool({
              provision: worktreeProvision,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // enter-worktree (conditional assembly: absent without the worktreeEnter
    // host seam). The handler closure binds this engine's sandboxRoot = the
    // session's current root (main repo); tree validation + rebind side
    // effects are all delegated to the host enter seam.
    ...(worktreeEnter
      ? {
          "enter-worktree": () =>
            createEnterWorktreeTool({
              worktreeEnter,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // exit-worktree (conditional assembly: absent without the worktreeExit
    // host seam). The handler closure binds this engine's sandboxRoot = the
    // session's current task tree; rebinding to the main-repo root while
    // keeping the tree is delegated entirely to the host exit seam.
    ...(worktreeExit
      ? {
          "exit-worktree": () =>
            createExitWorktreeTool({
              worktreeExit,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // Symbol-query toolset (resident — the symbol primary path is the
    // default). Shares one lspCtx with the symbol-mutation tools; key order
    // must match the last 10 entries of ACI_TOOLSET_NAMES item by item
    // (Gate 3).
    ...symbolQueryTools(lspCtx),
    // Symbol-mutation toolset (resident, category=write). Shares one lspCtx
    // with the symbol-query tools; onEdit comes from the registry's
    // opts.onEdit (build-engine injects lspNotifier.invalidate at assembly)
    // — after a write, textDocument/didChange fires through the same chain
    // as edit_file. Key order must match the last 5 entries of
    // ACI_TOOLSET_NAMES item by item (Gate 3).
    ...symbolMutateTools(lspCtx, onEdit),
    // This key used to be the literal's last key — Gate 3 compares factory
    // key order against ACI_TOOLSET_NAMES (same tail item in the list). The
    // directory comes from traceReadDir(), same source as query_trace, so
    // listed sessions are actually queryable.
    list_sessions: () => createListSessionsTool(traceReadDir()),
    // Now this is the literal's last key (same Gate 3 contract). All three
    // axes share the directory resolved by traceReadDir(), so the
    // conversation_id that get_record names is one list_sessions produced.
    get_record: () => createGetRecordTool(traceReadDir()),
    // task-worktree-lifecycle: host-only discovery/cleanup tools remain at the
    // append-only tail so existing tool positions stay stable.
    ...(worktreeList
      ? {
          "list-worktrees": () =>
            createListWorktreesTool({
              worktreeList,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    ...(worktreeRemove
      ? {
          "remove-worktree": () =>
            createRemoveWorktreeTool({
              worktreeRemove,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // subagent_stop (ADR-0101): this key used to be the factories literal's
    // last key (Gate 3 ordering contract; see the tail comment on
    // ACI_TOOLSET_NAMES). Conditional on the same seam as spawn_subagent /
    // subagent_result (absent subagentManager → the tool stays out).
    ...(subagentManager
      ? {
          subagent_stop: () =>
            createSubAgentStopTool({ manager: subagentManager }),
          // subagent_continue (ADR-0102): used to be the literal's last key.
          // Same condition, tail-appended.
          subagent_continue: () =>
            createSubAgentContinueTool({ manager: subagentManager }),
        }
      : {}),
    // read_image: now the literal's last key (Gate 3 ordering contract; see
    // the tail comment on ACI_TOOLSET_NAMES). Resident, no absence
    // condition; root attaches the same way as read_file —
    // `liveTaskRoot ?? sandboxRoot`, handler reads the cell once for a
    // snapshot (same vintage). Does not wire lastReadLedger — reading images
    // is not booked into the ledger.
    read_image: () => createReadImageTool(opts.liveTaskRoot ?? sandboxRoot),
  };

  // Gate 3 check: factory keys must strictly match ACI_TOOLSET_NAMES
  // (length + order + membership). Absent memoryDir means
  // memory_recall/memory_save are not assembled, absent skillCatalog means
  // skill is not assembled, etc., so the comparison list must first strip
  // those conditional keys. Any divergence fails at assembly time, never
  // surviving to runtime.
  // Deny-list: denied names merge into `excluded` (stripped on the
  // toolsetNames side) and the factory keys are filtered from the same
  // source → Gate 3 mirrors both sides consistently (same mechanism as the
  // memoryDir conditioning).
  const denySet = new Set(disallowedTools ?? []);
  const factoryNames = Object.keys(factories).filter((n) => !denySet.has(n));
  const excluded: ReadonlyArray<string> = [
    ...(memoryDir ? [] : ["memory_recall", "memory_save"]),
    ...(skillCatalog ? [] : ["skill"]),
    ...(subagentManager ? [] : ["spawn_subagent", "subagent_result"]),
    // subagent_stop / subagent_continue share the spawn / result condition
    // (tail-append order = the tail of ACI_TOOLSET_NAMES).
    ...(subagentManager ? [] : ["subagent_stop", "subagent_continue"]),
    ...(todoDir ? [] : ["todo_write"]),
    ...(mcpManager ? [] : ["list_mcp_resources", "read_mcp_resource"]),
    ...(backgroundManager ? [] : ["bash_output", "bash_stop"]),
    // run_graph is permanently registered now, so only the subagentManager
    // condition remains (absent graphAssembly no longer excludes it — the
    // handler's isEnabled defaults to off, but run_graph stays in the
    // registry).
    ...(subagentManager ? [] : ["run_graph"]),
    // Absent host seam (worker / hub-less inlet) → the tree-creation tool
    // stays out of the registry. Switch OFF is not in this class (ADR-0037
    // amended 2026-09-11: the tool surface is constant; only the gate
    // follows the switch).
    // Absent enter seam (TUI provision-only / worker / hub-less inlet) →
    // the enter tool stays out.
    ...(worktreeProvision ? [] : ["create-worktree"]),
    ...(worktreeEnter ? [] : ["enter-worktree"]),
    ...(worktreeExit ? [] : ["exit-worktree"]),
    ...(worktreeList ? [] : ["list-worktrees"]),
    ...(worktreeRemove ? [] : ["remove-worktree"]),
    ...(disallowedTools ?? []),
  ];
  const toolsetNames = (ACI_TOOLSET_NAMES as ReadonlyArray<string>).filter(
    (n) => !excluded.includes(n)
  );
  if (
    factoryNames.length !== toolsetNames.length ||
    factoryNames.some((n, i) => n !== toolsetNames[i])
  ) {
    throw new RegistryConstructionError(
      `ACI_TOOLSET_NAMES / factories diverge: have=[${factoryNames.join(",")}] want=[${toolsetNames.join(",")}]`
    );
  }

  const tools = toolsetNames.map((n) => factories[n]!());
  // Def-list trimming at construction (guarantees both the inner and
  // visibleSchemas surfaces retain only the allowed items).
  // buildWorkerToolSurface's permissive mode merges the default deny [spawn_subagent]
  // + the user deny; the default deny is legal redundancy on the worker
  // assembly path (absent subagentManager → spawn_subagent is not in tools).
  // Call it only when disallowedTools is non-empty — the existing
  // build-engine.ts call site (subagentManager present, no disallowedTools)
  // would have its spawn_subagent wrongly stripped in permissive mode if
  // buildWorkerToolSurface were called unconditionally, breaking backward
  // compatibility. Gate 3's `excluded` has already removed denied names from
  // toolsetNames, so buildWorkerToolSurface here is an idempotent backstop
  // of the dual mechanism (a second assertion on the actual surface).
  const finalTools =
    disallowedTools !== undefined && disallowedTools.length > 0
      ? buildWorkerToolSurface(tools, disallowedTools)
      : tools;
  const reg = createAciRegistry(finalTools);
  assembled.reg = reg;
  return reg;
}
