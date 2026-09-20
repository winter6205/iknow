/**
 * Verify classifier (subagent LLM judge) pure-function module.
 *
 * Single responsibility: judge-JSON parsing + downgrade rules + host-side
 * truncation (spawn/assembly live in verify-loop).
 *
 * Key contracts:
 *  - four states: pass / fail / abort / unverified;
 *  - pass + empty evidence → silent downgrade to abort (missing-evidence reason);
 *  - malformed schema / illegal kind / non-object → abort (transport/schema
 *    error, fail-open semantics);
 *  - unverified: judge read the evidence and refuses to guess PASS/FAIL —
 *    reason required non-empty, evidence optional (commands may not have run;
 *    same optional discipline as abort); unverified with missing/empty reason
 *    downgrades to abort (aligned with the pass/fail reason discipline);
 *  - judge output is truncated host-side to 2000 code points (the prompt
 *    states no length limit).
 */
import { truncateByCodePoint } from "../sandbox/index.js";
import type { ClassifierCheck, ClassifierResult } from "./types.ts";

/** Host-side cap for judge output. */
// (ADR-0006)
export const CLASSIFIER_OUTPUT_LIMIT = 2000;

/** Host-side truncation by code point; never splits a surrogate pair. */
export function truncateClassifierOutput(text: string): string {
  return truncateByCodePoint(text, CLASSIFIER_OUTPUT_LIMIT);
}

/** Downgrade note prefix added when pass/fail carries empty evidence. */
const DEGRADE_REASON = "证据缺失（pass/fail 必须带非空 evidence）";

/** Shape check for one evidence item. */
function isClassifierCheck(v: unknown): v is ClassifierCheck {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.command === "string" &&
    (o.output === undefined || typeof o.output === "string") &&
    (o.result === "pass" || o.result === "fail")
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Parse judge JSON → four-state ClassifierResult (including the unverified 4th state).
 *
 * All invalid inputs (JSON parse failure / non-object / illegal kind /
 * malformed shape / pass|fail with empty evidence / unverified without
 * reason) converge to `{kind:"abort", reason}` — schema errors fail-open
 * toward unstable at the upstream consumer.
 */
export function parseClassifierResult(raw: string): ClassifierResult {
  const aborted = (reason: string): ClassifierResult => ({
    kind: "abort",
    reason,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return aborted("分类器输出 JSON 解析失败 (schema 错, 判官输出不可用)");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return aborted("分类器输出非 JSON 对象 (schema 错)");
  }
  const o = parsed as Record<string, unknown>;

  if (
    o.kind !== "pass" &&
    o.kind !== "fail" &&
    o.kind !== "abort" &&
    o.kind !== "unverified"
  ) {
    return aborted(`分类器输出 kind 非法 (${JSON.stringify(o.kind)})`);
  }
  if (typeof o.reason !== "string" || o.reason.length === 0) {
    return aborted("分类器输出缺 reason (schema 错)");
  }

  if (o.kind === "abort") {
    return { kind: "abort", reason: o.reason };
  }

  // unverified = judge read the evidence, found it insufficient, refuses to
  // guess PASS/FAIL (the 4th state). evidence may be absent (no commands run →
  // no evidence; same optional discipline as abort); extra evidence attached
  // anyway is accepted verbatim. The required-reason check above already holds.
  if (o.kind === "unverified") {
    return { kind: "unverified", reason: o.reason };
  }

  // pass / fail shared contract: evidence must be an array, every item
  // shape-valid, non-empty.
  if (!Array.isArray(o.evidence) || !o.evidence.every(isClassifierCheck)) {
    return aborted("分类器输出 evidence 缺失或非法 (schema 错)");
  }
  if (o.evidence.length === 0) {
    // Downgrade rule: pass/fail with empty evidence → abort.
    return aborted(`${DEGRADE_REASON}: ${o.reason}`);
  }

  if (o.kind === "pass") {
    // pass must not carry missing (only fail does).
    if (o.missing !== undefined) {
      return aborted("分类器输出 pass 携带 missing 字段 (schema 错)");
    }
    return {
      kind: "pass",
      reason: o.reason,
      evidence: o.evidence as ClassifierCheck[],
    };
  }

  // fail: missing may be absent (treated as empty array).
  if (o.missing !== undefined && !isStringArray(o.missing)) {
    return aborted("分类器输出 fail missing 非字符串数组 (schema 错)");
  }
  return {
    kind: "fail",
    reason: o.reason,
    missing: (o.missing as string[] | undefined) ?? [],
    evidence: o.evidence as ClassifierCheck[],
  };
}
