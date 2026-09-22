/**
 * Subagent role — SubAgentDefinition + deny-list assembly trimming.
 *
 * SubAgentDefinition is the typed form of a subagent role declaration
 * (isomorphic to envelope.ts's systemPrompt / disallowedTools /
 * maxTurns / timeoutMs fields), assembled by the manager layer from user
 * config and sealed into the worker envelope.
 *
 * Deny-list trimming splits into two layers of semantics:
 *   - applyRoleDenyList: strict mode, fail-fast on out-of-range. If any
 *     denied tool name is absent from available → throw
 *     RegistryConstructionError (guards typos in user deny names).
 *   - buildWorkerToolSurface: lenient mode. Items in merged (default deny +
 *     user deny) that available lacks are silently skipped. Reason: the
 *     default deny contains spawn_subagent, while the worker process
 *     toolset never has it at assembly time (createDefaultAciRegistry
 *     without subagentManager) — the default deny is redundant protection
 *     declaring deny intent rather than a real removal target; strict mode
 *     would misfire on every worker assembly.
 *
 * Return values are always frozen, guarding against accidental mutation
 * downstream (worker internals / envelope serialization path).
 */
import { RegistryConstructionError } from "../errors.js";
import { mergeDisallowedTools } from "./capability.js";

export interface SubAgentDefinition {
  readonly systemPrompt?: string;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  /**
   * Subagent task text (WorkerEnvelope.task is required; optional in this
   * local definition for compat). The spawn_subagent tool is responsible
   * for writing def.task (an earlier omission left children with task:"").
   * manager.buildWorkerPayload falls back with def.task ?? "".
   */
  readonly task?: string;
  /**
   * Subagent soft sandbox root (WorkerEnvelope.sandboxRoot is required).
   * Not collected directly by the spawn_subagent tool — the manager fills
   * it from the parent cwd at assembly time; optional locally with an
   * empty-string fallback.
   */
  readonly sandboxRoot?: string;
  /**
   * Catalog persona id → WorkerEnvelope.role → injected into the worker.
   * Copied onto WorkerEnvelope. Orthogonal to excludeFromHostDrain.
   */
  readonly role?: string;
  /**
   * Parent-only: trace turn id of the turn that spawned this subagent. The
   * manager copies it into the `parentTurnId` of subagent_spawn /
   * _state_change / _stop records, so `?parent_turn_id=` retrieves every
   * subagent dispatched by one turn in a single query.
   * Not copied onto WorkerEnvelope — the child needs no, and should not know,
   * parent-side turn identity.
   */
  readonly parentTurnId?: string;
  /**
   * Parent-only: conversation that owns this worker. Used to keep terminal
   * wakeups and host drains scoped to one interactive session.
   */
  readonly conversationId?: string;
  /**
   * Parent-only: skip host-drain (wait:false wakeup channel).
   * Judge / wait:true consumers already await waitFor; leaking their
   * envelope into the next user turn would paint it as a user message.
   * Not copied onto WorkerEnvelope.
   */
  readonly excludeFromHostDrain?: boolean;
  /**
   * Host truncated dialogue for the judge. Copied onto WorkerEnvelope.
   * Independent of `task` (exam question stays identity).
   */
  readonly finalText?: string;
  /**
   * Evidence prompt for the judge (not the exam question). Copied onto
   * WorkerEnvelope as an independent field; never concatenated into `task`.
   */
  readonly evidenceContext?: object;
  /**
   * ADR-0071 (.meta.json):
   * Tool_use id of the call that spawned this subagent (= spawn_subagent's
   * tool_use_id). Persisted once at spawn into the per-agent `.meta.json`
   * `toolUseId` field, to reverse-lookup the subagent record back to that
   * parent-loop tool call; absent → meta key omitted (Postel).
   * Parent-only: not copied onto WorkerEnvelope (the child needs no, and
   * should not know, this).
   */
  readonly toolUseId?: string;
  /**
   * ADR-0071 (.meta.json):
   * Subagent nesting depth. 1 = dispatched directly by the parent agent;
   * 2+ = grandchild spawned inside a subagent (v1 forbids nested dispatch,
   * so currently always 1; seam kept for the future).
   * Absent → meta key omitted (Postel).
   * Parent-only: not copied onto WorkerEnvelope.
   */
  readonly spawnDepth?: number;
}

/** Default deny-list: subagents must not spawn further subagents (recursion-explosion guard). Frozen. */
export const DEFAULT_DISALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "spawn_subagent",
]);

/**
 * Strict-mode deny-list trimming (fail-fast).
 *
 * - deny empty / undefined → available returned as-is (frozen).
 * - denied name present in available → removed.
 * - denied name absent from available → throw RegistryConstructionError
 *   (`disallowed_tools contains unknown tool: <name>`), guarding typos in
 *   user deny names.
 *
 * Returns frozen.
 */
export function applyRoleDenyList<T extends { readonly name: string }>(
  available: ReadonlyArray<T>,
  disallowed: ReadonlyArray<string> | undefined
): ReadonlyArray<T> {
  if (disallowed === undefined || disallowed.length === 0) {
    return Object.freeze([...available]);
  }
  const disallowedSet = new Set(disallowed);
  const availableNames = new Set(available.map((t) => t.name));
  for (const name of disallowedSet) {
    if (!availableNames.has(name)) {
      throw new RegistryConstructionError(
        `disallowed_tools contains unknown tool: ${name}`
      );
    }
  }
  return Object.freeze(available.filter((t) => !disallowedSet.has(t.name)));
}

/**
 * Lenient tool-surface assembly: merge the default deny-list with the user
 * deny-list (user priority + Set dedup), then remove denied items that
 * available contains.
 *
 * Key difference vs applyRoleDenyList: merged items absent from available
 * (typically the default deny's spawn_subagent — never in the worker toolset
 * at assembly time) are silently skipped, no throw. A user denying an
 * unknown tool name is likewise skipped silently (lenient surface); the
 * worker-side registry validation is the backstop.
 *
 * Returns frozen.
 */
export function buildWorkerToolSurface<T extends { readonly name: string }>(
  available: ReadonlyArray<T>,
  userDisallowed?: ReadonlyArray<string>
): ReadonlyArray<T> {
  const merged = mergeDisallowedTools(
    DEFAULT_DISALLOWED_TOOLS,
    userDisallowed
  )!;
  if (merged.length === 0) {
    return Object.freeze([...available]);
  }
  const denySet = new Set(merged);
  const availableNames = new Set(available.map((t) => t.name));
  // Lenient: merged items absent from available are skipped (the default
  // deny's spawn_subagent is already gone from available at worker assembly
  // — legitimate redundancy).
  return Object.freeze(
    available.filter(
      (t) => !(denySet.has(t.name) && availableNames.has(t.name))
    )
  );
}
