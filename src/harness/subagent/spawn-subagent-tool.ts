/**
 * spawn_subagent ACI tool.
 *
 * Foreground spawn is the default (ADR-0014): `wait:true` blocks the handler
 * on `manager.waitFor(taskId, undefined, ctx.signal)` until the sub-agent
 * reaches a terminal state, then returns the parent-visible short handoff
 * (summary / changed paths / status / stop_reason) as the tool result. The
 * default timeout comes from the manager's three-layer chain
 * (`def.timeoutMs ?? taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`), the same source
 * the spawn timer uses, so the two stay aligned. Independent tasks may be
 * dispatched as several spawn_subagent calls in one turn (each call blocks
 * its own wait; the executor is concurrency-safe). `wait:false` returns
 * `{task_id}` immediately — the async arm, where the host mailbox/subscribe
 * path wakes a silent run on terminal completion and `subagent_result` stays
 * available for explicit queries.
 *
 * `subagent_type` routes the sub-agent through the agent catalog: the value
 * resolves to a catalog id stored in `def.role` and later injected as the
 * worker's persona. Default is `general-purpose`; the schema enum is derived
 * from the catalog at assembly time (never a hardcoded literal), so unknown
 * values fail fast in ajv.
 *
 * Dependency injection: the factory takes `manager` plus an optional
 * `catalog` (defaults to the internal merged resolver). The assembly layer
 * (`createDefaultAciRegistry`) instantiates the tool only when a
 * sub-agent manager is configured — same conditional shape as `memoryDir` /
 * `skillCatalog`.
 *
 * Append-only: `name` pairs one-to-one with the tail of
 * `ACI_TOOLSET_NAMES`; existing tools are never reordered.
 *
 * Error shapes:
 *   - input validation failure → synchronous `ToolExecutionError`
 *     (executor → execution_failed);
 *   - `title` missing / blank / longer than `SPAWN_TITLE_MAX_LENGTH` after
 *     trim → `ToolExecutionError`
 *     raised before the capacity and sandbox checks, so no worker starts;
 *   - `background:true` rejected in v1 → `ToolExecutionError`;
 *   - concurrency over capacity (`SubAgentCapacityError` from
 *     manager.spawn) → `ToolExecutionError` carrying capacity + active/limit;
 *   - `ctx.signal` abort → waitFor rejects with SubAgentAbortError →
 *     `ToolExecutionError` → the executor, seeing `signal.aborted === true`,
 *     normalizes it to `execution_failed: "cancelled"` (caller-side cancel).
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentDefinition } from "./role.js";
import type { QueryBufferResult, SubAgentManager } from "./manager.js";
import {
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentWaitTimeoutError,
} from "./manager.js";
import type {
  SubagentCapacityHolder,
  SubagentCapacityValue,
} from "./manager.js";
import type { SubAgentEnvelope } from "./envelope.js";
import { projectParentVisibleEnvelope } from "./envelope.js";
import { ToolExecutionError, SubAgentSandboxRootError } from "../errors.js";
import type { AgentCatalogResolver } from "./catalog.js";
import { createMergedCatalogResolver } from "./user-catalog.js";
import { resolveSubagentCapabilities } from "./capability.js";
import type { WorktreeGateReader } from "../isolation/worktree-gate.js";

/**
 * The dispatch lesson is one SSOT string: the tool description embeds it
 * verbatim and the guards read this same constant, so a guard reds when a
 * discipline clause (or the whole lesson) is dropped without pinning the
 * wording of any single clause.
 *
 * Clauses: start with an `explore` sub-agent before dispatching any work that
 * writes; keep the operator concurrency discipline — an explicit numeric
 * ceiling plus the concurrent/workers vocabulary, below the enforced cap;
 * build the isolation tree via `create-worktree` before dispatching mutating
 * work; check the skill catalog before improvising a procedure.
 */
export const SPAWN_DISPATCH_ISOLATION_CLAUSE =
  "when the task mutates files under isolation, run `create-worktree` first so the workers land in the isolated tree; ";

export const SPAWN_DISPATCH_LESSON =
  "\n\nDispatch lesson: start with an `explore` sub-agent before dispatching any work that writes; " +
  "keep at most 3 sub-agents in flight for operator workflows (a working discipline, not the enforced cap); " +
  SPAWN_DISPATCH_ISOLATION_CLAUSE +
  "check the skill catalog before improvising a procedure.";

/**
 * Mechanical form of the lesson's concurrency-discipline clause: a numeric
 * ceiling followed, in the same clause, by the concurrent/workers vocabulary.
 * Digit and spelled-out numerals both count, and the noun may be `workers`,
 * `sub-agents`, or `in flight` — the invariant is "the ceiling is written
 * out", not one phrasing of it. The window after the ceiling is bounded so an
 * unrelated lone digit elsewhere in the lesson cannot satisfy the clause.
 */
export const SPAWN_DISPATCH_LESSON_CONCURRENCY_PATTERN =
  /\b(?:at most|up to|no more than|max(?:imum)?(?: of)?)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b[^.;]{0,60}\b(?:concurrent(?:ly)?|in flight|workers?|sub-?agents?)\b/i;

/**
 * Dependency injection: `manager` owns the sub-agent lifecycle / state
 * machine / buffer / shutdown chain on the parent side. This tool consumes
 * the synchronous `spawn(def)` entry and the foreground-blocking
 * `waitFor(taskId, timeoutMs, signal)` entry; draining belongs to the host
 * and is never exposed to the agent.
 *
 * `catalog` is an optional seam: when absent the tool uses the internal
 * merged resolver (builtin + `~/.iknow/agents/` user roles, with both list
 * and get views). Production assembly in `registry.ts` deliberately does not
 * inject one — routing stays inside this factory so registry.ts remains the
 * tool surface only. Tests can inject a fake resolver to verify the factory
 * really uses `deps.catalog`.
 */
export interface SpawnSubAgentToolDeps {
  readonly manager: SubAgentManager;
  /**
   * Agent catalog resolver (list + get views). Optional — defaults to the
   * merged catalog (`createMergedCatalogResolver`). list() feeds the schema
   * enum and the prose list; get(id) feeds per-id validation in the handler.
   */
  readonly catalog?: AgentCatalogResolver;
  /**
   * Concurrency-cap holder keeping the "N workers" clause in the description
   *
   // (ADR-0096)
   * and SubAgentCapacityError on one source (both read `holder.get()` live,
   * so a gate change reaches the model immediately). The manager already
   * holds this holder for the spawn gate; this field is the description-layer
   * mirror preventing drift between description and receipt numbers. When
   * absent the tool falls back to `manager.getCapacity()` (the equivalent
   * getter), byte-identical to the older static description.
   */
  readonly capacityHolder?: SubagentCapacityHolder;
  /**
   * Live isolation switch. When present and `get()` is false, the dispatch
   * lesson omits the create-worktree clause. Absent → full lesson (tests /
   * holder-less assembly stay byte-identical).
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
}

/**
 * When the sub-agent's wall clock expires, the parent-visible tool result
 * kind must not be ok.
 *
 * Timeout is the only exception: crashed / maxTurnsExceeded / protocolError
 * are still "the task outcome is data" and travel as an ok envelope; an
 * expired wall clock has no readable terminal handoff, so only throwing
 * `execution_failed` lets the model tell "stuck at the wall clock" apart
 * from "finished but failed". envelope.status is already "failed" — what the
 * rule constrains is the result kind.
 *
 * The message must never be exactly `"cancelled"` —
 * `computeToolStopFlags` (loop-engine.ts) still treats
 * `execution_failed && message === "cancelled"` as whole-turn cancellation,
 * so colliding with that literal would escalate one sub-task's wall clock
 *
 // (ADR-0091)
 * into a turn-level stop cause. The `"timeout"` label is no longer live for
 * turn-stop attribution (it only attributes this one result), but we still
 * avoid it so downstream attribution keyed on labels cannot misread it as a
 * clock signal.
 */
/**
 * ADR-0102 — label parameterization: if a foreground continue's timeout were
 * still attributed to "spawn_subagent:", the model would read one resumed run
 * as one new dispatch. The default label keeps the spawn arm's wording
 * byte-identical; the continue tool passes its own label.
 */
export function throwWallClockTimeout(
  taskId: string,
  detail: string,
  label = "spawn_subagent"
): never {
  const suffix = detail.length > 0 ? ` (${detail})` : "";
  throw new ToolExecutionError(
    `${label}: task ${taskId} hit its wall-clock timeout${suffix}; ` +
      `the sub-agent has no completed result to hand back`
  );
}

/**
 * `SubAgentAbortError` → parent-visible `ToolExecutionError`.
 *
 * The two abort sources must stay distinguishable:
 *   - **caller-side abort** (Ctrl+C / `/quit`): ctx.signal is already
 *     aborted, so the executor's `buildFailureResult` subsequently normalizes
 *     the message to strict `"cancelled"` (whole-turn cancellation consumed
 *     by loop-engine) — the caller text is kept here only so the attribution
 *     source is not lost;
 *   - **operator kill** (TUI Ctrl+X → `manager.abortTask`): ctx.signal was
 *     **not** aborted, the executor does not normalize, and the message
 *     surfaces verbatim — so this text is all the attribution the model can
 *     see. Reusing the caller-side "caller aborted" wording would make a kill
 *     read as a caller cancel; reusing the wall-clock wording would collide
 *     with the timeout attribution.
 *
 * What both share: never exactly `"cancelled"` — colliding with that literal
 * would escalate one sub-task's outcome into whole-turn cancellation (the
 * result-label branch in `computeToolStopFlags`).
 *
 * Lives outside the handler: the whole attribution decision (including the
 * `ctx?.signal` read) must not add to the handler's cyclomatic complexity
 * (hard lint ratchet: the handler sits at its baseline and any new branch
 * reads as regression).
 */
export function throwAbortAttribution(
  err: SubAgentAbortError,
  ctx: ToolExecutionContext | undefined,
  label = "spawn_subagent"
): never {
  if (ctx?.signal?.aborted === true) {
    throw new ToolExecutionError(
      `${label}: cancelled (caller aborted while waiting for task ${err.taskId})`
    );
  }
  throw new ToolExecutionError(
    `${label}: cancelled (the operator killed task ${err.taskId}; ` +
      `it returned no completed result)`
  );
}

/** Envelope already carrying a timeout terminal state → must not be ok (see throwWallClockTimeout). */
export function assertNotWallClockTimeout(
  env: SubAgentEnvelope,
  taskId: string,
  label = "spawn_subagent"
): void {
  if (env.status === "failed" && env.reason === "timeout") {
    throwWallClockTimeout(taskId, env.summary, label);
  }
}

/** Parent-visible projection + wall-clock timeout gate (the single exit for handing a terminal envelope to the model). */
export function projectEnvelopeOrThrow(
  env: SubAgentEnvelope,
  taskId: string,
  label = "spawn_subagent"
): SubAgentEnvelope {
  const projected = projectParentVisibleEnvelope(env);
  assertNotWallClockTimeout(projected, taskId, label);
  return projected;
}

/**
 * After waitFor rejects with a wall-clock error, dispatch by queryBuffer.
 * SubAgentWaitTimeoutError is reused for unknown task / shutdown-cleared map
 * / failed-without-envelope / a real wall clock, so it cannot be uniformly
 * synthesized into a timeout.
 */
export function envelopeFromWaitTimeout(
  buffer: QueryBufferResult,
  taskId: string,
  label = "spawn_subagent"
): SubAgentEnvelope {
  // EXIT: not_found — the task never existed or shutdown cleared the map; to the model this is a call error, not timeout data.
  if (buffer.status === "not_found") {
    throw new ToolExecutionError(
      `${label}: task ${taskId} not found after wait timeout`
    );
  }
  // EXIT: running — wall clock expired but the worker has no terminal state (real wall clock; must not be ok).
  if (buffer.status === "running") {
    throwWallClockTimeout(
      taskId,
      "worker still running when the wait expired",
      label
    );
  }
  if (buffer.status === "failed") {
    // EXIT: buffer is already a failure projection (includes protocolError / crashed / timeout envelope).
    if ("result" in buffer && typeof buffer.result === "string") {
      return projectEnvelopeOrThrow(buffer, taskId, label);
    }
    if (buffer.reason === "timeout") {
      throwWallClockTimeout(taskId, buffer.summary, label);
    }
    return {
      status: "failed",
      reason: buffer.reason,
      summary: buffer.summary,
      result: buffer.summary,
    };
  }
  // EXIT: completed ok envelope already in buffer (terminal envelopes with status=failed also land here,
  // dispatched by reason through the timeout gate).
  return projectEnvelopeOrThrow(buffer, taskId, label);
}

/**
 * Terminal-channel mutual exclusion for the foreground arm: while `wait:true`
 * blocks the handler in waitFor, this very tool_result owns the envelope's
 * delivery — if the host drain or a mailbox silent-wake also fired, the same
 * handoff would enter the parent messages twice (rendered as a duplicate user
 * message). So foreground tasks are always excluded from host drain; only the
 * `wait:false` async arm needs those two channels, and the field is omitted
 * entirely otherwise (Postel).
 *
 * The rationale lives at module level rather than in the handler's def
 * literal:
 *   - the bit deserves a named meaning — `excludeFromHostDrain` is
 *     "delivery channel" semantics (see the `SubagentInfo.foreground` header
 *     note), not "still running"; spread inline into the def literal it would
 *     degrade to an anonymous boolean whose wiring point cannot explain it;
 *   - the handler's cyclomatic complexity is a per-function ratchet
 *     (`lint:s5` compares against HEAD for the same function): the handler is
 *     this file's ArrowFunctionExpression and inlining this ternary would
 *     push it from its baseline of 41 to 42, reading as a regression.
 */
export function foregroundDrainExclusion(wait: boolean): {
  readonly excludeFromHostDrain?: boolean;
} {
  return wait ? { excludeFromHostDrain: true } : {};
}

/**
 * Ceiling for the operator-facing `title` (spec subagent-card-title SC1):
 * JavaScript string length measured after trim, because the card renders one
 * clipped line. Exported so the boundary tests read the number from here
 * instead of restating it.
 */
export const SPAWN_TITLE_MAX_LENGTH = 80;

/**
 * Validate the required `title` input, throwing `ToolExecutionError` on every
 * reject the spec names (missing / non-string / empty after trim / longer than
 * SPAWN_TITLE_MAX_LENGTH after trim). The handler calls it before the capacity
 * and sandbox checks, so a bad title never leaves a worker running. Lives at
 * module level because the handler sits at its s5-complexity ratchet baseline.
 *
 * Returns the trimmed label for the spawn record; the tool itself never
 * rewrites `tool_use.input`.
 */
function assertValidSpawnTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (title.length === 0 || title.length > SPAWN_TITLE_MAX_LENGTH) {
    throw new ToolExecutionError(
      "spawn_subagent: missing or invalid `title` (a short operator-facing " +
        `label, 1-${SPAWN_TITLE_MAX_LENGTH} characters after trim)`
    );
  }
  return title;
}

export function createSpawnSubAgentTool(
  deps: SpawnSubAgentToolDeps
): AciToolDef {
  // Catalog resolver closure: factory default = merged catalog (builtin +
  // ~/.iknow/agents/ user roles, memoized; list + get views). registry.ts
  // passes no catalog and the factory backstops — routing stays out of the
  // tool-surface layer. enum + prose list derive from the merged list at
  // assembly time, so user-role files show up in the tool surface right
  // after process start.
  const catalog: AgentCatalogResolver =
    deps.catalog ?? createMergedCatalogResolver();
  const catalogIds = catalog.list().map((e) => e.id);
  const proseLines = catalog
    .list()
    .map((e) => `- ${e.id}: ${e.description}`)
    .join("\n");
  // The description's N and SubAgentCapacityError share one source: read
  // (ADR-0096)
  // holder.get() live so the receipt number and the description never drift.
  // A gate change reaches the model on its next tool-description fetch, no
  // restart. When the holder is absent, fall back to `manager.getCapacity()`
  // — the manager holds the same holder copy, so gate values are equivalent;
  // the only holder-less case is a directly constructed manager (test
  // harnesses), and the fallback matches the older static description
  // byte-for-byte.
  const readCapacity = (): SubagentCapacityValue => {
    if (deps.capacityHolder !== undefined) return deps.capacityHolder.get();
    return deps.manager.getCapacity();
  };
  // Description assembled from two spliced templates: fixed prefix + cap
  // clause. The splice closure re-reads the holder each time, so the model
  // sees the current N when it reads the description.
  const descriptionPrefix = `Delegate a self-contained task when it needs multi-step exploration, independent verification, or parallelizable work. Omit \`subagent_type\` and the sub-agent runs as \`general-purpose\` — the writable, full-tool-surface default; \`explore\` is the read-only type, request it explicitly. Keep every task self-contained. Default \`wait:true\` — the call blocks until the sub-agent finishes and returns the parent-visible short handoff with summary, changed paths, status, and stop_reason when available (timeout 2 hours default; override via \`timeoutMs\`). Issue multiple \`spawn_subagent\` calls in one turn only for independent tasks. Pass \`wait:false\` for fire-and-forget: returns \`{task_id}\` immediately. In chat/tui/serve, terminal completion wakes the host through the mailbox/subscribe path and starts a silent run; this is the primary completion path. Use \`subagent_result\` only for an explicit status query. `;
  const descriptionCatalog =
    `\n\nAvailable subagent types (set \`subagent_type\` to route):\n` +
    proseLines;
  const capClause = (cap: SubagentCapacityValue): string => {
    if (cap === "unlimited") {
      return "Concurrency cap is unlimited in this session; the OS / memory budget is still the practical limit. When a spawn would clearly overload the host, reduce parallelism.";
    }
    return `At most ${cap} workers run simultaneously in this session; when at capacity, reduce concurrency and retry after a worker completes — requests are rejected rather than queued.`;
  };
  const dispatchLesson = (): string => {
    if (
      deps.worktreeOnMutate !== undefined &&
      deps.worktreeOnMutate.get() !== true
    ) {
      return SPAWN_DISPATCH_LESSON.replace(SPAWN_DISPATCH_ISOLATION_CLAUSE, "");
    }
    return SPAWN_DISPATCH_LESSON;
  };
  return Object.freeze({
    name: "spawn_subagent",
    get description(): string {
      const cap = readCapacity();
      return (
        descriptionPrefix +
        capClause(cap) +
        descriptionCatalog +
        dispatchLesson()
      );
    },
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The assignment the worker receives: what it must do, on its own, from context it can read.",
        },
        title: {
          type: "string",
          // No schema `maxLength` on purpose: the ceiling is measured after
          // trim, and a schema bound would reject a padded-but-short title as
          // an input-validation failure before the handler can tell.
          description: `Short title for the operator, a few words (up to ${SPAWN_TITLE_MAX_LENGTH} characters after trim) — the label the spawn card shows. The task body stays in \`task\`.`,
        },
        subagent_type: {
          type: "string",
          // enum = catalog ids (derived from the live resolver at assembly
          // time, never a hardcoded literal). ajv fail-fast rejects unknown
          // ids; a typed error reaching the handler path is converted to
          // ToolExecutionError by the defensive contract.
          enum: catalogIds,
          description:
            "Optional (#556 T3): route the sub-agent through one of the available subagent types listed above. Omit it and the sub-agent runs as `general-purpose` — the writable, full-tool-surface default. `explore` is the read-only type: ask for it explicitly when the task only reads.",
        },
        systemPrompt: {
          type: "string",
          // ADR-0112: the addendum is downgraded out of system — this
          // field now travels to the sub-agent as an untrusted user-channel
          // message, no longer a system-section override, so the description
          // must say so plainly.
          description:
            "Optional guidance from the parent, delivered to the sub-agent as a user-channel message alongside the task. The sub-agent's `system` is host-assembled and stays in force; this adds framing, not a replacement constitution.",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Denylist (priority over default). Defaults to ['spawn_subagent'].",
        },
        background: {
          type: "boolean",
          description:
            "Reserved v2 flag — v1 rejects this. Leave undefined or false. Passing true returns ToolExecutionError immediately.",
        },
        wait: {
          type: "boolean",
          description:
            "When true (default), block until the sub-agent finishes and return the parent-visible short handoff (summary, changed paths, status, and stop_reason when available). When false, return {task_id} immediately; in chat/tui/serve, terminal completion wakes a silent run through the host mailbox/subscription. Use subagent_result only for an explicit status query.",
        },
        maxTurns: {
          type: "integer",
          minimum: 1,
          description:
            "Optional: per-sub-agent turn cap; inherits from settings if absent.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description:
            "Optional: per-sub-agent wallclock; default 2 hours if absent.",
        },
        sandboxRoot: {
          type: "string",
          description:
            "Optional (#357 T1): restrict the sub-agent to this directory. Must be a path inside the parent sandbox root (realpath-resolved, symlinks must point inside parent). Out-of-range or non-existent paths are rejected before any spawn occurs.",
        },
      },
      required: ["task", "title"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // classified read-only: long-running but never mutates the filesystem
      lazy: false, // resident in the prompt: spawning is a core capability, discovery makes no sense
      timeoutTier: "unbounded", // wait:true lifetime = manager per-task clock; ACI adds no timer (a 30min tier would abort before the 2h PER_TASK clock)
      isConcurrencySafe: true, // parallel spawn_subagent calls are legal (distinct task_ids)
      interruptBehavior: "cancel", // foreground entry; ctx.signal abort → waitFor rejects → ToolExecutionError → execution_failed:cancelled
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // ajv strict has already validated the shape (compiled at
      // createAciRegistry assembly). Runtime defense on top: null / array /
      // string outside the schema should never reach here.
      const obj = (input ?? {}) as Record<string, unknown>;
      const task = obj.task;
      if (typeof task !== "string" || task.length === 0) {
        throw new ToolExecutionError(
          "spawn_subagent: missing or invalid `task`"
        );
      }
      // Required on the same defensive contract as `task` (a direct or
      // programmatic call bypasses ajv).
      const title = assertValidSpawnTitle(obj.title);
      // v1 rejects background:true.
      if (obj.background === true) {
        throw new ToolExecutionError("background:true not implemented in v1");
      }
      // Defaults resolve inside the handler (the ACI schema expresses no
      // defaults). Absent = foreground.
      const wait = obj.wait !== false;
      // subagent_type → role resolution (additive):
      //   - absent (undefined) → catalog.get("general-purpose") (default role)
      //   - known id → written into def.role (catalog id, forwarded to
      //     envelope.role → the worker assembly queries the catalog for the
      //     body and injects the persona section)
      //   - unknown id → already rejected by the ajv enum at the executor
      //     entry; the catch here is defense (ajv gap / direct handler call)
      //     → converted to ToolExecutionError (never silently swallowed)
      // Capture the catalog entry to merge disallowedTools — otherwise the
      // `explore` role's [edit_file, write_file] never reaches the wire and
      // the worker tool surface still carries those two tools.
      const subagentType = obj.subagent_type;
      if (subagentType !== undefined && typeof subagentType !== "string") {
        // ajv strict already rejects; this is defense
        throw new ToolExecutionError(
          "spawn_subagent: subagent_type must be a string"
        );
      }
      const requestedRole = subagentType ?? "general-purpose";
      // Union (Set-dedup) of catalog entry.disallowedTools and the parent's
      // obj.disallowedTools:
      //   - both absent → undefined (baseline, def.disallowedTools omitted);
      //   - catalog only → apply the catalog deny (e.g. explore →
      //     [edit_file, write_file]);
      //   - parent only → apply the parent deny (original behavior);
      //   - both → union: the parent can ADD denies but cannot subtract the
      //     catalog default.
      const parentDisallowed = Array.isArray(obj.disallowedTools)
        ? (obj.disallowedTools as ReadonlyArray<string>)
        : undefined;
      let capabilities: ReturnType<typeof resolveSubagentCapabilities>;
      try {
        capabilities = resolveSubagentCapabilities({
          role: requestedRole,
          parentDisallowedTools: parentDisallowed,
          catalog,
        });
      } catch (err) {
        // Preserve the pre-extraction policy: an invalid custom catalog is
        // converted for an explicit type, while the default-role lookup
        // remains a direct typed catalog failure.
        if (subagentType === undefined) throw err;
        throw new ToolExecutionError(
          `spawn_subagent: unknown subagent_type '${subagentType}'`
        );
      }
      if (capabilities.catalogError !== undefined) {
        if (subagentType === undefined) throw capabilities.catalogError;
        throw new ToolExecutionError(
          `spawn_subagent: unknown subagent_type '${subagentType}'`
        );
      }
      const resolvedRole =
        subagentType === undefined
          ? (capabilities.catalogRole ?? requestedRole)
          : requestedRole;
      const mergedDisallowed = capabilities.disallowedTools;
      // Assemble the SubAgentDefinition: optional fields pass through,
      // missing fields are omitted from def entirely (the manager applies its
      // own default-deny / default maxTurns etc. per SubAgentDefinition).
      // `task` must be forwarded into def — omitting it made
      // buildWorkerPayload read `def.task ?? ""` and every sub-agent ran an
      // empty task.
      // timeoutMs is omitted field-and-all when absent — never fill in a
      // per-call constant here. The manager's three-layer chain
      // `def.timeoutMs ?? env.subagent.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`
      // must let the middle layer (the settings-configurable taskTimeoutMs)
      // take effect when the model gives no explicit timeout; hardcoding a
      // constant here would turn that layer into dead code at the
      // consumption point.
      const def: SubAgentDefinition = {
        task,
        title,
        // terminal notices must be attributable to the session that
        // spawned the worker so a TUI session cannot wake another one.
        ...(ctx?.conversationId !== undefined
          ? { conversationId: ctx.conversationId }
          : {}),
        // Owning turn — the manager copies it into the subagent_spawn /
        // _state_change / _stop records. When ctx lacks turnId (worker / ask /
        // direct handler call) the field is omitted entirely; Postel, no
        // empty values.
        ...(ctx?.turnId !== undefined ? { parentTurnId: ctx.turnId } : {}),
        ...(ctx?.parentThinking !== undefined
          ? { parentThinking: ctx.parentThinking }
          : {}),
        // ADR-0071: reverse lookup to the parent loop's originating tool call
        // — the executor has put call.id (Anthropic tool_use_id) into
        // ctx.toolUseId and the manager copies it into the .meta.json
        // toolUseId field. Absent (ask / direct handler call / test
        // injection) → field omitted.
        ...(ctx?.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
        // resolved catalog role (the default also resolves to general-purpose)
        ...(resolvedRole !== undefined ? { role: resolvedRole } : {}),
        ...(typeof obj.systemPrompt === "string"
          ? { systemPrompt: obj.systemPrompt }
          : {}),
        // union of catalog entry.disallowedTools and the parent's, written
        // after merge; both absent → field omitted (byte-stable baseline).
        ...(mergedDisallowed !== undefined
          ? { disallowedTools: mergedDisallowed }
          : {}),
        ...(typeof obj.maxTurns === "number" ? { maxTurns: obj.maxTurns } : {}),
        ...(typeof obj.timeoutMs === "number"
          ? { timeoutMs: obj.timeoutMs }
          : {}),
        // pass sandboxRoot through; manager.buildWorkerPayload validates
        // prefix-of-parent at a single point.
        ...(typeof obj.sandboxRoot === "string"
          ? { sandboxRoot: obj.sandboxRoot }
          : {}),
        // Foreground-arm terminal-channel exclusion — see the
        // foregroundDrainExclusion header note.
        ...foregroundDrainExclusion(wait),
      };
      let taskId: string;
      try {
        taskId = deps.manager.spawn(def).taskId;
      } catch (err) {
        // sandboxRoot out of range / nonexistent → ToolExecutionError (message is model-facing).
        if (err instanceof SubAgentSandboxRootError) {
          throw new ToolExecutionError(err.message);
        }
        // capacity → ToolExecutionError (message carries capacity + active/limit).
        if (err instanceof SubAgentCapacityError) {
          throw new ToolExecutionError(err.message);
        }
        // Fallback: fakes / external code throwing an Error with capacity wording — still attributed.
        if (err instanceof Error && /capacity/i.test(err.message)) {
          throw new ToolExecutionError(err.message);
        }
        throw err;
      }
      // wait:false async arm: return {task_id} immediately, no waiting.
      if (!wait) {
        return JSON.stringify({ task_id: taskId });
      }
      try {
        // Foreground arm: waitFor defaults through the manager's three-layer
        // chain (def.timeoutMs ?? env.subagent.taskTimeoutMs ?? 7200s). def
        // carries timeoutMs only when the model set it explicitly (absent is
        // omitted), so passing undefined here lets the spawn timer and
        // waitFor share one effectiveTaskTimeoutMs chain — when the middle
        // taskTimeoutMs takes effect, the two align by construction.
        const envelope = await deps.manager.waitFor(
          taskId,
          undefined,
          ctx?.signal
        );
        // Success tool_result = envelope (reuses the executor's 20000-char
        // truncation). Failure envelopes that are not timeouts still return
        // as ok data (crashed / maxTurnsExceeded / protocolError are task
        // outcomes; the model reads summary/reason). Terminal envelopes with
        // reason=timeout (manager per-task timer / worker SIGTERM wrap-up)
        // instead throw ToolExecutionError → non-ok (projectEnvelopeOrThrow).
        return projectEnvelopeOrThrow(envelope, taskId);
      } catch (err) {
        // Abort attribution: caller-side abort (executor then normalizes to
        // strict "cancelled") vs operator kill (verbatim pass-through) get
        // different texts — see the throwAbortAttribution header note.
        if (err instanceof SubAgentAbortError) {
          throwAbortAttribution(err, ctx);
        }
        // concurrent: when a caller/ACI abort races the wait poll, the abort
        // wins — never synthesize a timeout envelope from WaitTimeoutError.
        if (ctx?.signal?.aborted) {
          throw new ToolExecutionError(
            "spawn_subagent: cancelled by caller abort"
          );
        }
        if (err instanceof SubAgentWaitTimeoutError) {
          return envelopeFromWaitTimeout(
            deps.manager.queryBuffer(taskId),
            taskId
          );
        }
        throw err;
      }
    },
  });
}
