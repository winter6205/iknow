/**
 * bash_stop ACI tool — the model-facing surface for background tasks.
 *
 * Terminates a task spawned via `bash(background: true)`. manager.stop
 * implements host-side kill(-pgid): SIGTERM → 2s grace → SIGKILL; stopping
 * an already-terminal task is an idempotent success (a legal state — no
 * throw, no second signal; kill_race semantics settled with the tool).
 *
 * Permission: category "write" → default ask. Terminating a background task
 * has side effects (killing a live long-running service / build), so the
 * model's call needs user confirmation — same write→ask shape as todo_write.
 *
 * Description: positively-framed guidance only (when to use / which tools
 * to pair with), no negative prohibitions.
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import { renderTaskError } from "../../background/registry.js";
import type { BackgroundTaskError } from "../../background/registry.js";

export interface CreateBashStopToolOptions {
  readonly backgroundManager: BackgroundTaskManager;
}

interface BashStopInput {
  readonly task_id?: unknown;
}

/**
 * Factory: createBashStopTool(deps) — the bash_stop tool.
 *
 * The returned AciToolDef satisfies:
 *   - name === "bash_stop"
 *   - inputSchema: { task_id required }, additionalProperties:false
 *   - aci metadata: write / NOT concurrency-safe / block / default tier
 *   - handler emits JSON `{task_id, status:"stopped"}`; an empty task_id
 *     passes through to the manager → empty_task_id typed error (no
 *     interception). manager.stop throws task_not_found for unknown ids →
 *     rendered as `${kind}: ${context}`.
 */
export function createBashStopTool(
  opts: CreateBashStopToolOptions
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileStopInput(input);
    try {
      // ADR-0021: pass ctx.conversationId to the manager for scope
      // filtering. Stopping another conversation's task →
      // task_not_in_scope (the manager is the authority).
      await opts.backgroundManager.stop(parsed.task_id, ctx?.conversationId);
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      // Typed-error catch contract: discriminate `kind`, then render via
      // renderTaskError as `${kind}: ${context}` — never [object Object].
      // The manager throws plain objects (the BackgroundTaskError
      // discriminated union), not Error instances, so renderTaskError is
      // the contract path.
      throw new ToolExecutionError(
        `bash_stop: ${renderTaskError(err as BackgroundTaskError)}`
      );
    }
    return JSON.stringify({ task_id: parsed.task_id, status: "stopped" });
  };

  return Object.freeze({
    name: "bash_stop",
    description:
      'Terminate a background bash task previously spawned with bash(background: true); sends SIGTERM to the process group, escalates to SIGKILL after a 2-second grace period, and releases the registry slot. Use as the stop step of a start-verify-stop service loop: once bash_output confirms the server has served its purpose (or a build finished, or the task is stuck), call bash_stop to terminate the process group and free the port / bound resources. Accepts the task_id returned by bash(background: true); stopping an already-finished task succeeds silently. Returns one JSON envelope with task_id and status="stopped".',
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Background task id returned by bash(background: true); the process group is terminated and the busy state at the task registry is released.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "write" as const,
      isConcurrencySafe: false,
      interruptBehavior: "block" as const,
      timeoutTier: "default" as const,
    },
  });
}

/**
 * Input compile + strict validation: task_id is required and must be a
 * string (empty string allowed → the manager's empty_task_id typed error
 * passes through; non-object / missing task_id / wrong type →
 * ToolExecutionError as this layer's own defense beyond the schema).
 */
function compileStopInput(input: unknown): {
  readonly task_id: string;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[bash_stop] input must be an object");
  }
  const raw = input as BashStopInput;
  if (typeof raw.task_id !== "string") {
    throw new ToolExecutionError(
      "[bash_stop] task_id is required and must be a string"
    );
  }
  return { task_id: raw.task_id };
}
