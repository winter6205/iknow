/**
 * Assembly helper for the verify classifier seam.
 *
 * Factory honoring process isolation and the judge schema contract: given a
 * SubAgentManager → produce a RunClassifierFn that verify-loop can wire
 * directly. The judge inherits the worker model route (ADR-0122); there is no
 * classifier model slot.
 *
 * Production entry points:
 *  - src/session-api/hub.ts (serve);
 *  - src/cli/chat-session.ts (chat/ask TTY);
 * plus the real-LLM smoke script reusing the same factory.
 *
 * No SubAgentManager (ask form) → returns undefined; the caller simply omits
 * runClassifier and gets the transparently-disabled semantics back (backward
 * compatible).
 *
 * Inside the factory, the spawn → waitFor protocol is adapted to
 * ClassifierEnvelope (status:"ok" / "failed"), matching verify-loop's
 * RunClassifierFn seam one-to-one.
 */
import type { SubAgentManager } from "../subagent/manager.js";
import type { ClassifierEnvelope, RunClassifierFn } from "./verify-loop.js";
import { ACI_TOOLSET_NAMES } from "../aci/tools/registry.js";

/**
 * Judge allow-list baseline (fail-closed).
 *
 * Judge semantics = "local read-only only": whitelist = read_file / grep / glob.
 *
 * Why allow-list instead of deny-by-category:
 *   - `aci.category="write"` covers only edit_file/write_file; bash (execute)
 *     and web_* (network reads) would each need extra rules;
 *   - allow-list matches the "local read-only only" semantics exactly;
 *   - fail-closed: when ACI gains new tools the judge does not get them by
 *     default — granting requires editing this constant explicitly (plus an
 *     operator decision), never runtime configuration.
 */
const JUDGE_ALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** Judge role: subagent LLM judge (schema-contract prompt). */
const JUDGE_ROLE: SubAgentDefinitionShape = {
  role: "judge",
  systemPrompt:
    "You are a strict task-completion judge. Given a task, evaluate whether " +
    "the work is actually done. Output ONLY a JSON object with exactly one of " +
    "these shapes:\n" +
    '{"kind":"pass","reason":"<one-line>","evidence":[{"command":"<what you ' +
    'verified>","result":"pass"}]}\n' +
    '{"kind":"fail","reason":"<one-line>","missing":["<item>"],"evidence":[' +
    '{"command":"<what you verified>","result":"fail"}]}\n' +
    '{"kind":"abort","reason":"<one-line>"}\n' +
    "Rules: pass and fail MUST include at least one evidence item; never emit " +
    'pass with empty evidence. If you cannot determine completion, use "abort".',
  excludeFromHostDrain: true,
  // deny = full ACI tool surface − allow-list baseline (fail-closed derivation).
  // Formula = ACI_TOOLSET_NAMES minus JUDGE_ALLOWED_TOOLS; anything not
  // whitelisted is denied. Typed as ReadonlyArray<string> to match
  // SubAgentDefinition.disallowedTools (as const is incompatible across the
  // readonly-tuple/derived-array union). The derived set automatically tracks
  // append-only growth at the tail: tools like list_sessions land in deny as
  // soon as they appear — that is the expected fail-closed behavior, not a
  // regression (the judge only needs read_file/grep/glob; even directory
  // tools require an explicit whitelist edit plus an operator decision).
  disallowedTools: (ACI_TOOLSET_NAMES as ReadonlyArray<string>).filter(
    (n) => !JUDGE_ALLOWED_TOOLS.includes(n)
  ),
  maxTurns: 2,
};

/**
 * Field shape of JUDGE_ROLE: role / system prompt / tool deny set / maxTurns.
 * Not reusing SubAgentDefinition (its task / timeoutMs / sandboxRoot
 * fields are all optional and injected from external opts).
 */
interface SubAgentDefinitionShape {
  readonly role: "judge";
  readonly systemPrompt: string;
  readonly disallowedTools: ReadonlyArray<string>;
  readonly maxTurns: number;
  readonly excludeFromHostDrain: true;
}

export interface CreateRunClassifierOpts {
  readonly manager: SubAgentManager;
  /** Per-round timeout (ms). Default 120_000. */
  readonly timeoutMs?: number;
}

/**
 * Adapt SubAgentManager into a RunClassifierFn:
 *   spawn judge worker → waitFor → converge SubAgentEnvelope to ClassifierEnvelope.
 *
 * Returns undefined when manager is undefined (ask form; callers naturally
 * take the transparently-disabled branch, no special if needed).
 */
export function createRunClassifierFromManager(
  opts: CreateRunClassifierOpts
): RunClassifierFn {
  const { manager, timeoutMs = 120_000 } = opts;
  return async ({
    task,
    summary,
    finalText,
    signal,
    cwd,
    evidenceContext,
  }): Promise<ClassifierEnvelope> => {
    // finalText / evidenceContext are independent spawn fields.
    // They must not be concatenated into def.task (exam question = goal.text).
    // The judge def no longer passes sandboxRoot explicitly (it used to pin
    // sandboxRoot = process.cwd()). Since the manager validates prefix-of-parent
    // against the parent sandboxRoot at a single point, an explicit
    // sandboxRoot (serve path) makes cwd ≠ parent root and every judge spawn
    // is rejected, silently degrading to a crashed envelope. Omitting the
    // field takes the inheritance path: envelope.sandboxRoot = manager parent
    // sandboxRoot (judge shares the parent's working scope — the correct
    // anchor for reading evidence files). The cwd parameter stays in the
    // RunClassifierFn signature (verify-loop contract) but is not consumed here.
    void cwd;
    const def = {
      ...JUDGE_ROLE,
      // Exam question = goal.text only; evidenceContext is a separate spawn field.
      task,
      timeoutMs,
      ...(finalText !== null && finalText !== "" ? { finalText } : {}),
      ...(evidenceContext !== undefined ? { evidenceContext } : {}),
    };
    let taskId: string;
    try {
      ({ taskId } = manager.spawn(def));
    } catch (err) {
      return {
        status: "failed",
        result: "",
        summary,
        reason: "crashed",
      };
    }
    try {
      const envelope = await manager.waitFor(taskId, timeoutMs, signal);
      if (envelope.status === "ok") {
        return { status: "ok", result: envelope.result, summary };
      }
      // Failed transport: pass reason through (crashed/timeout/protocolError/maxTurnsExceeded).
      return {
        status: "failed",
        result: "",
        summary,
        ...(envelope.reason !== undefined ? { reason: envelope.reason } : {}),
      };
    } catch (err) {
      // AbortSignal fired or waitFor timed out → transport error (→ unstable).
      const reason =
        err instanceof Error && err.name === "SubAgentWaitTimeoutError"
          ? "timeout"
          : "crashed";
      return { status: "failed", result: "", summary, reason };
    }
  };
}
