/**
 * `subagent_stop` ACI tool — the parent model's control plane for stopping a
 *
 // (ADR-0101)
 * worker, symmetric with the operator's Ctrl+X. Input is a `task_id` visible
 * to this session (from the spawn receipt / handoff envelope / mailbox
 * notice); internally it uses the existing `manager.abortTask` — the same
 * path that first settles in-flight waitFor, then SIGTERM with a 5s SIGKILL
 * fallback (attribution unchanged). Scope matches `bash_stop`: only workers
 * spawned by this session; cross-conversation tasks are rejected with a typed
 * error (ownership check precedes any signal).
 *
 * Idempotent semantics: already terminal / not found → a **structured
 * explanation** (a `status` discriminator inside an ok tool_result), never a
 * thrown "task failed" illusion — stopping an already-delivered worker is not
 * an error. running / starting → abortTask initiates the abort; the terminal
 * state is queried via `subagent_result` (failed carries the attribution).
 *
 * **DI shape**: the factory takes `manager`; `createDefaultAciRegistry`
 *
 // (ADR-0101)
 * instantiates it when `subagentManager` opts is provided and omits it
 * otherwise (same gating condition as spawn_subagent / subagent_result).
 *
 * **append-only**: `name` maps one-to-one to the tail of
 * `ACI_TOOLSET_NAMES`, never reordering existing entries.
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentManager } from "./manager.js";
import { ToolExecutionError } from "../errors.js";
import {
  assertSubagentOwnership,
  findSubagentTask,
} from "./subagent-tool-shared.js";

export interface SubAgentStopToolDeps {
  readonly manager: SubAgentManager;
}

export function createSubAgentStopTool(deps: SubAgentStopToolDeps): AciToolDef {
  return Object.freeze({
    name: "subagent_stop",
    description:
      "Terminate a sub-agent this session spawned: pass the `task_id` from spawn_subagent's receipt or handoff. Runs the same kill path as the operator's Ctrl+X (SIGTERM to the worker, SIGKILL fallback after a grace period); the terminal state stays queryable with subagent_result (a stopped worker reports `failed` with its attribution). Use it to correct course: stop a running worker, then re-dispatch with a sharper task. Stopping a task that already reached a terminal state or an unknown id returns a structured note instead of a failure; tasks belonging to another conversation are rejected. Returns one JSON envelope with task_id and status.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "The task_id returned by spawn_subagent for a worker this session is running.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    aci: {
      category: "write", // killing a running process has side effects (same default-ask as bash_stop)
      lazy: false, // resident prompt: stopping a worker is the symmetric counterpart of dispatch
      timeoutTier: "default", // sync entry: abortTask does not await the terminal state
      isConcurrencySafe: false, // aborts are not interleaved with other calls
      interruptBehavior: "block", // synchronous handler (same as bash_stop)
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // shape is already ajv-strict-validated; the guard here covers direct
      // handler calls (same compile-input shape as spawn_subagent / bash_stop).
      const obj = (input ?? {}) as Record<string, unknown>;
      const taskId = obj.task_id;
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new ToolExecutionError(
          "subagent_stop: missing or invalid `task_id`"
        );
      }
      const info = findSubagentTask(deps.manager, taskId);
      if (info === undefined) {
        // structured note: an unknown id is not a stop failure, just no such task (idempotent semantics).
        // (ADR-0101)
        return JSON.stringify({
          task_id: taskId,
          status: "not_found",
          note: "no such task in this manager (unknown or already expired)",
        });
      }
      assertSubagentOwnership(info, ctx, "subagent_stop");
      if (info.state === "completed" || info.state === "failed") {
        return JSON.stringify({
          task_id: taskId,
          status: "already_terminal",
          state: info.state,
        });
      }
      const dispatched = deps.manager.abortTask(taskId);
      if (!dispatched) {
        // race between starting/running and the terminal state: abortTask
        // returns false for an already-terminal task; re-query once and
        // report per idempotent semantics, never fake "stopped".
        const latest = findSubagentTask(deps.manager, taskId);
        if (latest === undefined) {
          // the task left the ledger entirely between the two lookups (TTL
          // eviction): the true terminal state is unknowable, so return the
          // structured not_found instead of fabricating a state.
          return JSON.stringify({
            task_id: taskId,
            status: "not_found",
            note: "task disappeared between lookup and abort (evicted from the manager before any signal)",
          });
        }
        return JSON.stringify({
          task_id: taskId,
          status: "already_terminal",
          state: latest.state,
        });
      }
      return JSON.stringify({ task_id: taskId, status: "stopped" });
    },
  });
}
