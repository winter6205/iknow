/**
 * Per-run tool-loop detection (call key + result key, periods k=1..5,
 * repetition R=5; trips only on a stall). Anything that cannot be
 * normalized (including irregular MCP shapes) → fail-open.
 */

import { createHash } from "node:crypto";

import type { ToolExecutionResult } from "./tools/types.js";

export const LOOP_DETECT_REPEAT = 5;
export const LOOP_DETECT_MAX_PERIOD = 5;

export const LOOP_DETECTED_TEXT =
  "LOOP_DETECTED: tool-call loop stalled (period repeated R=5 with no result progress). Change the approach.";

export type ToolLoopEvent = {
  readonly callKey: string;
  readonly resultKey: string;
  readonly normalizable: boolean;
  /** Shared id for one tool phase (a single runToolPhase); parallel calls within one wave do not count as cross-period repeats. */
  readonly phaseId: number;
};

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) {
    out[k] = sortKeys(rec[k]);
  }
  return out;
}

function canonicalJson(value: unknown): string | null {
  try {
    return JSON.stringify(sortKeys(value));
  } catch {
    // EXIT: cyclic / non-serializable → call key unnormalizable, upper layer fails open.
    return null;
  }
}

/**
 * Contract: resultKey never absorbs pixel bodies — a successful `read_image`
 * payload carries a ≤1.4MB base64 image block (downcast by the executor into
 * AnthropicContentBlock[]), and serializing whole blocks would accumulate
 * across all events for the run. base64 image blocks are fingerprinted by
 * content hash (same bytes → same resultKey, loop-equality semantics
 * unchanged); other non-text blocks keep the existing JSON.stringify path.
 */
function imageFingerprint(b: unknown): string | null {
  if (b === null || typeof b !== "object") return null;
  const block = b as Record<string, unknown>;
  if (block.type !== "image") return null;
  const source = block.source;
  if (source === null || typeof source !== "object") return null;
  const src = source as Record<string, unknown>;
  if (src.type !== "base64" || typeof src.data !== "string") return null;
  const hash = createHash("sha256").update(src.data, "utf8").digest("hex");
  return `image:${String(src.media_type)}:${hash}`;
}

function okPayloadText(
  result: Extract<ToolExecutionResult, { kind: "ok" }>
): string {
  return result.payload
    .map((b) => {
      if (b.type === "text" && "text" in b) return String(b.text);
      return imageFingerprint(b) ?? JSON.stringify(b);
    })
    .join("\n");
}

function resultKeyFrom(result: ToolExecutionResult): string | null {
  if (result.kind === "execution_failed") {
    return `execution_failed:${result.message}`;
  }
  if (result.kind === "validation_failed") {
    return `validation_failed:${result.message}`;
  }
  if (result.kind === "tool_not_found") {
    return `tool_not_found:${result.toolName}`;
  }
  const text = okPayloadText(result);
  let extra = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const code = rec.code ?? rec.exit_code ?? rec.exitCode;
      if (typeof code === "number") extra = `:code=${code}`;
    }
  } catch {
    // EXIT: payload is not JSON → skip the exit-code suffix, still use the raw text as the result key.
    extra = "";
  }
  const body = canonicalJson(text);
  if (body === null) return null;
  return `ok${extra}:${body}`;
}

export function toolLoopEventFromCall(
  name: string,
  input: unknown,
  result: ToolExecutionResult,
  phaseId: number
): ToolLoopEvent {
  const callBody = canonicalJson({ name, input });
  const resultKey = resultKeyFrom(result);
  if (callBody === null || resultKey === null) {
    return {
      callKey: name,
      resultKey: "unnormalizable",
      normalizable: false,
      phaseId,
    };
  }
  return {
    callKey: callBody,
    resultKey,
    normalizable: true,
    phaseId,
  };
}

function keysMatch(
  a: ToolLoopEvent | undefined,
  b: ToolLoopEvent | undefined
): boolean {
  if (a === undefined || b === undefined) return false;
  return a.callKey === b.callKey && a.resultKey === b.resultKey;
}

function windowRepeatsPeriod(
  window: ReadonlyArray<ToolLoopEvent>,
  periodLen: number
): boolean {
  const period = window.slice(0, periodLen);
  for (let r = 1; r < LOOP_DETECT_REPEAT; r += 1) {
    const chunk = window.slice(r * periodLen, (r + 1) * periodLen);
    for (let i = 0; i < periodLen; i += 1) {
      if (!keysMatch(period[i], chunk[i])) return false;
    }
  }
  return true;
}

export function isStalledToolLoop(
  events: ReadonlyArray<ToolLoopEvent>
): boolean {
  const n = events.length;
  for (let k = 1; k <= LOOP_DETECT_MAX_PERIOD; k += 1) {
    const need = k * LOOP_DETECT_REPEAT;
    if (n < need) continue;
    const window = events.slice(n - need);
    if (window.some((e) => !e.normalizable)) continue;
    const phaseCount = new Set(window.map((e) => e.phaseId)).size;
    if (phaseCount < LOOP_DETECT_REPEAT) continue;
    if (windowRepeatsPeriod(window, k)) return true;
  }
  return false;
}
