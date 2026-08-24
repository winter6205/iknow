/**
 * #672 T3: 本 run 工具环检测（调用键 + 结果键，周期 k=1..5，重复 R=5，停滞才 trip）。
 * 无法正规化（含不规则 MCP 形状）→ fail-open。
 */

import type { ToolExecutionResult } from "./tools/types.js";

export const LOOP_DETECT_REPEAT = 5;
export const LOOP_DETECT_MAX_PERIOD = 5;

export const LOOP_DETECTED_TEXT =
  "LOOP_DETECTED: tool-call loop stalled (period repeated R=5 with no result progress). Change the approach.";

export type ToolLoopEvent = {
  readonly callKey: string;
  readonly resultKey: string;
  readonly normalizable: boolean;
  /** 同一 tool phase（一次 runToolPhase）共享 id；单波并行不算跨周期重复。 */
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
    // EXIT: 循环结构 / 不可序列化 → 调用键无法正规化，上层 fail-open。
    return null;
  }
}

function okPayloadText(
  result: Extract<ToolExecutionResult, { kind: "ok" }>
): string {
  return result.payload
    .map((b) =>
      b.type === "text" && "text" in b ? String(b.text) : JSON.stringify(b)
    )
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
    // EXIT: payload 不是 JSON → 不加 exit code 后缀，仍用原文做结果键。
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
