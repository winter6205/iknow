/**
 * `subagent_result` ACI tool — after `spawn_subagent` hands back a
 * `task_id`, poll the SubAgentManager's four-state buffer: not_found /
 * running / completed / failed (parent-visible short handoff centered on
 * summary / paths / status / stop_reason). Like spawn, synchronous and
 * non-blocking (≤10ms): returns the serialized `manager.queryBuffer(taskId)`
 * directly, no sleep / no await — polling cadence is the model's choice (a
 * completed result is also host-drained into the next turn's user message;
 * this tool is the active pull surface).
 *
 * **DI shape**: the factory takes `manager`; `createDefaultAciRegistry`
 * instantiates it when the `subagentManager` opts is provided and omits it
 * otherwise (same gating condition as spawn_subagent).
 *
 * **append-only**: `name` maps one-to-one to the tail of
 * `ACI_TOOLSET_NAMES`, right after spawn_subagent, never reordering
 * existing entries.
 *
 * Error shape: validation failures throw `ToolExecutionError` synchronously;
 * aci-executor wraps it into an `execution_failed` result for the model.
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentManager } from "./manager.js";
import type { PadQueryResult } from "./pad-inspect.js";
import { projectParentVisibleEnvelope } from "./envelope.js";
import { ToolExecutionError } from "../errors.js";

/**
 * Dependency injection: `manager` owns the parent-side sub-agent lifecycle
 * / state machine / buffer / shutdown chain. This tool consumes only the
 * synchronous four-state `queryBuffer(taskId)` query; waitFor / drain stay
 * host-owned (never exposed to the agent).
 */
export interface SubAgentResultToolDeps {
  readonly manager: SubAgentManager;
}

function serializePoll(
  result: ReturnType<SubAgentManager["queryBuffer"]>
): object {
  if (
    result.status === "ok" ||
    (result.status === "failed" &&
      "result" in result &&
      typeof result.result === "string")
  ) {
    return projectParentVisibleEnvelope(result);
  }
  return result;
}

function parseTmpPath(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ToolExecutionError("subagent_result: invalid `tmp_path`");
  }
  return raw.length > 0 ? raw : undefined;
}

/**
 * Continuation offset for a paged pad read: a non-negative integer code-unit
 * index into the decoded file, or undefined for the decorated first window.
 * Validated here (not only by the schema) because the handler is a public
 * boundary; a negative or fractional offset throws rather than silently
 * falling back to page 0.
 */
function parsePadOffset(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    // EXIT: typed throw → aci-executor `execution_failed`; never a silent
    // fallback to page 0 (a model that lost its cursor must see it lost).
    throw new ToolExecutionError(
      "subagent_result: `offset` must be a non-negative integer"
    );
  }
  return raw;
}

function serializePadOrPoll(
  result: ReturnType<SubAgentManager["queryBuffer"]>,
  pad: PadQueryResult,
  tmpPath: string | undefined
): string {
  if (pad.status === "not_found") {
    return JSON.stringify({ status: "not_found" });
  }
  if (pad.status === "rejected") {
    return JSON.stringify({ status: "rejected", reason: pad.reason });
  }
  if (pad.status === "read") {
    return JSON.stringify({
      status: "ok",
      tmp_path: tmpPath,
      content: pad.content,
      truncated: pad.truncated,
      ...(pad.eof !== undefined ? { eof: pad.eof } : {}),
      ...(pad.next_offset !== undefined
        ? { next_offset: pad.next_offset }
        : {}),
    });
  }
  return JSON.stringify({
    ...serializePoll(result),
    tmp_names: pad.names,
  });
}

export function createSubAgentResultTool(
  deps: SubAgentResultToolDeps
): AciToolDef {
  return Object.freeze({
    name: "subagent_result",
    description:
      "Poll a sub-agent that was spawned with wait:false (or re-check after a wait:true completion); sync non-blocking, call again later to re-poll. Returns one JSON object whose parent-visible short handoff centers on `status`, `summary`, changed paths (`fileRefs`), and `stop_reason` when available: `status` ∈ `not_found` (no such task — unknown or expired id) / `running` / `completed` / `failed` (failed reports `reason` and `summary`). With only `task_id`, also lists top-level names on that worker's fence `/tmp` pad (`tmp_names`). Optional relative `tmp_path` reads one pad file; a file longer than the window returns a first page with `truncated` and, when paging, `eof` plus `next_offset` — pass that back as `offset` to fetch the next bounded page. `..` or pad escape is a typed reject.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task_id returned by spawn_subagent.",
        },
        tmp_path: {
          type: "string",
          description:
            "Optional path relative to that worker's fence /tmp pad. Omit to list top-level names; pass to read one file.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Continuation offset (code-unit index) for a paged pad read; pass a prior page's `next_offset` to fetch the next bounded page. Omit for the decorated first window.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // pure buffer read, no side effects
      isConcurrencySafe: true, // polling several task_ids in parallel is legal
      interruptBehavior: "cancel", // sync entry; on abort just drop the query
      timeoutTier: "fast", // synchronous buffer lookup is very fast (≤10ms)
      lazy: false, // resident prompt: polling is a core capability, discovery makes no sense
    } as const,
    handler: (input: unknown, _ctx?: ToolExecutionContext) => {
      // shape is already ajv-strict-validated (compiled at registry
      // assembly); this runtime guard catches null / array / bare-string
      // input that should never reach the handler.
      const obj = (input ?? {}) as Record<string, unknown>;
      const taskId = obj.task_id;
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new ToolExecutionError(
          "subagent_result: missing or invalid `task_id`"
        );
      }
      const tmpPath = parseTmpPath(obj.tmp_path);
      const offset = parsePadOffset(obj.offset);
      // sync and non-blocking: queryBuffer + queryPad only (no waitFor / drain).
      const result = deps.manager.queryBuffer(taskId);
      if (result.status === "not_found") {
        return JSON.stringify({ status: "not_found" });
      }
      const queryPad = deps.manager.queryPad;
      if (queryPad !== undefined) {
        return serializePadOrPoll(
          result,
          queryPad(taskId, tmpPath, offset),
          tmpPath
        );
      }
      return JSON.stringify(serializePoll(result));
    },
  });
}
