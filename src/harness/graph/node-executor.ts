/**
 * PROTOTYPE — self-written Graph multi-task orchestration: the
 * NodeExecutor ↔ SubAgentManager adapter.
 *
 * Design: executing a Graph node is reduced to one foreground spawn +
 * waitFor (ADR-0014 foreground default): each node = SubAgentManager.spawn(def)
 * + manager.waitFor(taskId); once the subagent reaches a terminal state,
 * envelope.result becomes the NodeOutcome.
 *
 * Key decisions:
 * - No second concurrency cap. `DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS`
 *   (default 15, configurable) is the project's single authoritative
 *   concurrency capacity; overflow is a typed rejection (SubAgentCapacityError).
 *   The scheduler's try/catch converts it into NodeOutcome
 *   { status:"failed", error }, so findFailedUpstream marks the branch's
 *   successors skipped (fail-fast propagates up the deps chain).
 * - Reuse SubAgentManager's built-in TraceService seam: the manager already
 *   records at spawn/stop/state_change (subagent_spawn /
 *   subagent_state_change / subagent_stop), so the graph layer defines no
 *   recordGraphNodeStart/End of its own — avoids new event-type explosion
 *   (test contract in jsonl.ts:268-326).
 * - No second SessionStore persistence authority: node results flow back
 *   into append-only messages via the spawn_subagent tool_result path
 *   (manager assembly contract).
 *
 * Boundary: depends only on subagent/ (manager / envelope) and
 * trace/types; does not import loop-engine / build-engine / index.ts.
 */

import { randomUUID } from "node:crypto";

import {
  SubAgentCapacityError,
  type SubAgentDefinition,
  type SubAgentManager,
} from "../subagent/manager.js";
import type { SubAgentEnvelope } from "../subagent/envelope.js";
import { safeTrace } from "../trace/safe-trace.js";
import type {
  SubagentStepRecord,
  TraceErrorType,
  TraceService,
} from "../trace/types.js";
import type { NodeContext, NodeExecutor, NodeOutcome } from "./types.js";

/** Per-node mapping to a SubAgentDefinition. */
export interface NodePlan {
  /** Task text handed to the subagent (worker envelope.task is required). */
  readonly task: string;
  /** Optional systemPrompt / disallowedTools / model / maxTurns / timeoutMs / role. */
  readonly def?: Omit<SubAgentDefinition, "task">;
}

/** NodeExecutor factory dependencies: manager + per-node plan. */
export interface SubAgentNodeExecutorOptions {
  readonly manager: SubAgentManager;
  readonly plans: Readonly<Record<string, NodePlan>>;
  /**
   * Caller-side cancellation signal (ACI `ctx.signal`). Passed through to
   * `manager.waitFor` so an interrupted parent turn rejects the foreground
   * wait immediately instead of idling until the per-task wall clock.
   * Absent → unchanged behaviour (waitFor without signal).
   */
  readonly signal?: AbortSignal;
  /** Optional SUBAGENT_STEP write side (graph orchestration dispatch/settle). */
  readonly trace?: TraceService;
  /**
   * Trace turn id of the turn that launched this graph; when given it goes
   * into both the node def (→ the manager's three record kinds) and this
   * executor's `subagent_step`.
   */
  readonly parentTurnId?: string;
}

/** envelope.reason → TraceErrorType (falls back to unknown when unmapped). */
function stepErrorType(reason: SubAgentEnvelope["reason"]): TraceErrorType {
  return reason === "timeout" || reason === "protocolError"
    ? reason
    : "unknown";
}

/**
 * Assemble {id -> NodePlan} + manager into a NodeExecutor.
 *
 * Node execution = manager.spawn(def) + manager.waitFor(taskId):
 *   - spawn throws SubAgentCapacityError → rethrown immediately; the
 *     scheduler's try/catch fails this node, and its dependents are skipped
 *     via findFailedUpstream (fail-fast along deps); independent branches
 *     are unaffected.
 *   - waitFor returns an envelope: status === "ok" → { done, output =
 *     envelope.result }; status === "failed" → { failed, error =
 *     envelope.summary || reason }.
 *   - waitFor throws (timeout / abort / shutdown) → rethrown; the scheduler
 *     likewise records failed.
 *
 * Note: plans must cover every node id in the spec; a missing plan → node
 * failed (error contains "no plan registered for id") — the fast feedback
 * surface for developer-time configuration gaps.
 */
export function createSubAgentNodeExecutor(
  opts: SubAgentNodeExecutorOptions
): NodeExecutor {
  const { manager, plans, signal, trace, parentTurnId } = opts;
  let nextStepIndex = 0;
  const parentTurnFields =
    parentTurnId !== undefined ? { parentTurnId } : ({} as const);

  function emitStep(fields: Omit<SubagentStepRecord, "id" | "origin">): void {
    if (!trace) return;
    void safeTrace(() =>
      trace.recordSubagentStep({
        id: randomUUID(),
        origin: "parent",
        ...parentTurnFields,
        ...fields,
      })
    );
  }

  return async (id: string, _ctx?: NodeContext): Promise<NodeOutcome> => {
    const plan = plans[id];
    if (!plan) {
      return {
        status: "failed",
        error: `no graph-node plan registered for id "${id}"`,
      };
    }
    const def: SubAgentDefinition = {
      ...(plan.def ?? {}),
      excludeFromHostDrain: true,
      ...(parentTurnId !== undefined ? { parentTurnId } : {}),
      task: plan.task,
    };
    const { taskId } = manager.spawn(def);
    const stepIndex = nextStepIndex++;
    const startedAt = new Date().toISOString();
    emitStep({
      taskId,
      stepIndex,
      phase: "dispatch",
      label: id,
      startedAt,
      status: "ok",
      ts: startedAt,
    });
    let envelope: SubAgentEnvelope;
    try {
      envelope = await manager.waitFor(taskId, undefined, signal);
    } catch (err) {
      if (err instanceof SubAgentCapacityError) {
        return {
          status: "failed",
          error: `${err.name}: ${err.message} (active=${err.active})`,
        };
      }
      throw err;
    }
    const endedAt = new Date().toISOString();
    if (envelope.status === "ok") {
      emitStep({
        taskId,
        stepIndex,
        phase: "settle",
        label: id,
        startedAt,
        endedAt,
        status: "ok",
        ts: endedAt,
      });
      return { status: "done", output: envelope.result };
    }
    const reasonText = envelope.reason ? `[${envelope.reason}] ` : "";
    const summary =
      envelope.summary ?? "subagent returned failed without summary";
    emitStep({
      taskId,
      stepIndex,
      phase: "settle",
      label: id,
      startedAt,
      endedAt,
      status: "error",
      error: {
        type: stepErrorType(envelope.reason),
        message: `${reasonText}${summary}`.trim(),
      },
      ts: endedAt,
    });
    return {
      status: "failed",
      error: `${reasonText}${summary}`.trim(),
    };
  };
}
