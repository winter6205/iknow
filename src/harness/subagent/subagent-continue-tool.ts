/**
 * `subagent_continue` ACI tool — hand one more message to a dead worker and
 *
 // (ADR-0102)
 * continue its dialogue: input is this session's `task_id` plus the next
 * `message`. All gates live inside `manager.resumeTask` (process lifetime /
 * transcript accounting / concurrency cap); this tool only validates inputs,
 * filters ownership (cross-conversation refusals, same gate as
 * subagent_stop), and maps typed rejections (SubAgentResumeError kind →
 * model-visible ToolExecutionError). The tool never re-derives lifetime —
 * two checks would drift.
 *
 * Resume = a new worker process behind the same external handle: the worker
 * transcript's rewind head is consumed by the present arm on the worker side
 * (transcript on disk → it becomes prior context, the new message seeds this
 * turn); this tool does not move dialogue history. Identity and capability
 * fields carry over from the original def — no subagent_type / model inputs;
 * the original catalog role simply runs again.
 *
 * **The wait contract matches spawn**: omitted `wait` = foreground, the call
 *
 // (ADR-0102)
 * returns the projected envelope; `wait:false` = background {task_id} plus a
 * mailbox wake. The foreground arm reuses spawn's attribution helpers
 * (parameterized label), so wall-clock / abort / buffer-routing semantics
 * stay identical across both arms.
 *
 * **DI shape** and the append-only position contract are the same as
 * subagent_stop (see the tail comment in registry.ts).
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentDefinition } from "./role.js";
import type { SubAgentEnvelope } from "./envelope.js";
import type { SubAgentManager } from "./manager.js";
import {
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentResumeError,
  SubAgentWaitTimeoutError,
} from "./manager.js";
import { ToolExecutionError } from "../errors.js";
import {
  assertSubagentOwnership,
  findSubagentTask,
} from "./subagent-tool-shared.js";
import {
  envelopeFromWaitTimeout,
  foregroundDrainExclusion,
  projectEnvelopeOrThrow,
  throwAbortAttribution,
} from "./spawn-subagent-tool.js";

export interface SubAgentContinueToolDeps {
  readonly manager: SubAgentManager;
}

const LABEL = "subagent_continue";

/**
 * SubAgentResumeError kind → model-visible message, rendered as
 * `${kind} — ${remedy}`: the kind stays visible on the surface (typed-error
 * catch contract) and every refusal names a way out — running points back to
 * stop-then-continue (mid-turn injection is not authorized); no_transcript
 * means the old worker has no accounting on disk, so a fresh spawn is the
 * path; not_found is a call-site error; missing_task is the manager's
 * direct-API empty-task fallback (input validation here already blocks
 * empty messages, so hitting it signals a call-site defect).
 * Module-level: handler cyclomatic-complexity ratchet (same precedent as
 * spawn's foregroundDrainExclusion).
 */
function resumeRefusalMessage(err: SubAgentResumeError): string {
  switch (err.kind) {
    case "running":
      return `${LABEL}: ${err.kind} — task ${err.taskId} is still running; to correct its course, use subagent_stop first, then continue once it reaches a terminal state`;
    case "no_transcript":
      return `${LABEL}: ${err.kind} — task ${err.taskId} has no worker transcript on disk, so its dialogue cannot be replayed; dispatch a fresh spawn_subagent with the full context instead`;
    case "missing_task":
      return `${LABEL}: ${err.kind} — the resume request carried no task text; retry with a non-empty message`;
    case "not_found":
      return `${LABEL}: ${err.kind} — no task ${err.taskId} is known to this session's sub-agent manager`;
  }
}

/**
 * Ownership gate (same one subagent_stop passes; shared logic in
 * subagent-tool-shared.ts): cross-conversation refusals, checked before any
 * resume. Unknown ids are deliberately not blocked here — they flow to
 * manager.resumeTask and come back as not_found, because lifetime /
 * transcript / quota truth is judged in exactly one place (re-checking in
 * the tool would drift).
 */
function assertOwnership(
  manager: SubAgentManager,
  taskId: string,
  ctx: ToolExecutionContext | undefined
): void {
  const info = findSubagentTask(manager, taskId);
  if (info !== undefined) {
    assertSubagentOwnership(info, ctx, LABEL);
  }
}

/**
 * Resume arm: manager gates (lifetime / transcript / concurrency cap) plus
 * typed-rejection mapping. Module-level for the handler complexity ratchet
 * (spawn's foregroundDrainExclusion precedent).
 */
function resumeDeadWorker(
  manager: SubAgentManager,
  taskId: string,
  next: SubAgentDefinition
): { readonly taskId: string } {
  const resume = manager.resumeTask;
  if (resume === undefined) {
    // wiring gap (poll-only fake manager): fail explicitly rather than
    // silently degrading into a spawn.
    throw new ToolExecutionError(
      `${LABEL}: this session's sub-agent manager does not support resume`
    );
  }
  try {
    return resume(taskId, next);
  } catch (err) {
    if (err instanceof SubAgentResumeError) {
      throw new ToolExecutionError(resumeRefusalMessage(err));
    }
    // concurrency cap shares its source with spawn: pass the capacity
    // attribution through to the model so it lowers parallelism.
    if (err instanceof SubAgentCapacityError) {
      throw new ToolExecutionError(err.message);
    }
    throw err;
  }
}

/**
 * Foreground arm — same shape as spawn's: waitFor defaults to the manager's
 * three-layer chain (def.timeoutMs is the original worker's lifetime, not
 * re-interpreted here); abort / wall-clock / buffer routing reuse spawn's
 * attribution helpers (parameterized label) so both arms keep identical
 * terminal semantics.
 */
async function awaitForegroundHandoff(
  manager: SubAgentManager,
  taskId: string,
  ctx: ToolExecutionContext | undefined
): Promise<SubAgentEnvelope> {
  try {
    const envelope = await manager.waitFor(taskId, undefined, ctx?.signal);
    return projectEnvelopeOrThrow(envelope, taskId, LABEL);
  } catch (err) {
    if (err instanceof SubAgentAbortError) {
      throwAbortAttribution(err, ctx, LABEL);
    }
    if (ctx?.signal?.aborted) {
      throw new ToolExecutionError(`${LABEL}: cancelled by caller abort`);
    }
    if (err instanceof SubAgentWaitTimeoutError) {
      return envelopeFromWaitTimeout(
        manager.queryBuffer(taskId),
        taskId,
        LABEL
      );
    }
    throw err;
  }
}

/**
 * Input validation + `wait` default resolution (omitted = foreground, same
 * contract as spawn). Shape is already ajv-strict-validated; the guard here
 * covers direct handler calls (same compile-input shape as spawn_subagent /
 * subagent_stop).
 */
function readContinueInputs(obj: Record<string, unknown>): {
  readonly taskId: string;
  readonly message: string;
  readonly wait: boolean;
} {
  const taskId = obj.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new ToolExecutionError(`${LABEL}: missing or invalid \`task_id\``);
  }
  const message = obj.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new ToolExecutionError(`${LABEL}: missing or invalid \`message\``);
  }
  return { taskId, message, wait: obj.wait !== false };
}

/**
 * This hop's def: only turn and delivery-channel fields; identity /
 * capability fields carry over from the original def in the manager (see
 * resumeDefinition). No conversationId — ownership is part of identity.
 */
function continueTurnFields(
  message: string,
  ctx: ToolExecutionContext | undefined,
  wait: boolean
): SubAgentDefinition {
  return {
    task: message,
    ...(ctx?.turnId !== undefined ? { parentTurnId: ctx.turnId } : {}),
    ...(ctx?.parentThinking !== undefined
      ? { parentThinking: ctx.parentThinking }
      : {}),
    ...(ctx?.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
    ...foregroundDrainExclusion(wait),
  };
}

export function createSubAgentContinueTool(
  deps: SubAgentContinueToolDeps
): AciToolDef {
  return Object.freeze({
    name: "subagent_continue",
    description:
      "Hand one more message to a sub-agent whose process is dead and continue its dialogue: pass the `task_id` from spawn_subagent plus the next `message`. The gate is process lifetime — a worker that reached any terminal state (completed, failed, or stopped) resumes with a fresh process that loads its worker transcript as prior context and runs the original subagent type and capabilities; the external handle stays the same task_id. While a worker is still running, use subagent_stop first — corrections arrive between turns, by stop then continue. A worker without a transcript on disk (dispatched before transcript accounting existed) gets a structured refusal — send it a fresh spawn_subagent instead. Default `wait:true` — the call blocks until the resumed run finishes and returns the parent-visible short handoff (summary, changed paths, status, stop_reason when available). Pass `wait:false` for fire-and-forget: returns {task_id} immediately and terminal completion wakes the host through the mailbox. Unknown task_id and tasks belonging to another conversation are refused with a structured error. Continuations share the same concurrency cap as spawn_subagent.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "The task_id returned by spawn_subagent for a dead worker of this session (completed, failed, or stopped).",
        },
        message: {
          type: "string",
          description:
            "The next sentence for the worker — appended to its transcript history as a user turn, then the fresh process runs with it as the task.",
        },
        wait: {
          type: "boolean",
          description:
            "When true (default), block until the resumed run finishes and return the parent-visible short handoff. When false, return {task_id} immediately; terminal completion wakes a silent run through the host mailbox/subscription.",
        },
      },
      required: ["task_id", "message"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // same category as spawn_subagent: long-running but never touches the filesystem
      lazy: false, // resident prompt: continue is the symmetric counterpart of dispatch (same rationale as stop)
      timeoutTier: "unbounded", // foreground lifetime = manager per-task clock; ACI runs no timer (same as spawn)
      isConcurrencySafe: true, // continues of different task_ids may run in parallel in one turn (same contract as spawn)
      interruptBehavior: "cancel", // foreground entry; ctx.signal abort → waitFor rejects → attributed as cancelled
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      const obj = (input ?? {}) as Record<string, unknown>;
      const { taskId, message, wait } = readContinueInputs(obj);
      assertOwnership(deps.manager, taskId, ctx);
      const next = continueTurnFields(message, ctx, wait);
      const resumed = resumeDeadWorker(deps.manager, taskId, next);
      // background arm mirrors spawn's wait:false: return {task_id} at once; the terminal state arrives via mailbox.
      if (!wait) {
        return JSON.stringify({ task_id: resumed.taskId });
      }
      return awaitForegroundHandoff(deps.manager, resumed.taskId, ctx);
    },
  });
}
