/**
 * #128 verify 分类器 (子代理 LLM 判官) 纯函数模块。
 *
 * Spec: specs/128-verify-classifier.md + specs/449-verify-evidence-first-loop.md。
 * 职责单一: 判官 JSON 解析 + 降级规则 + 宿主侧截断 (spawn/装配在 verify-loop 侧)。
 *
 * 关键契约 (spec A4 / SC4 / SC5 / A8 / SC8 + #449b B7 SC7):
 *  - 四态: pass / fail / abort / unverified (B7 判官扩第 4 态);
 *  - pass + 空 evidence → 静默降级 abort (reason 补"证据缺失");
 *  - schema 残缺 / kind 非法 / 非对象 → abort (transport/schema 错, fail-open 语义);
 *  - unverified: 判官读完证据认为不足、拒绝猜 PASS/FAIL —— reason 必填非空,
 *    evidence 可选缺省 (可能没跑命令所以无 evidence; 与 abort 同款可选纪律);
 *    unverified 缺/空 reason → abort 降级 (对齐 pass/fail 的 reason 必填纪律);
 *  - 判官输出宿主侧 truncateByCodePoint 至 2000 chars (prompt 不写长度, A8)。
 */
import { truncateByCodePoint } from "../sandbox/index.js";
import type { ClassifierCheck, ClassifierResult } from "./types.ts";

/** 宿主侧判官输出截断上限 (A8, 对齐 ADR-0006 精神)。 */
export const CLASSIFIER_OUTPUT_LIMIT = 2000;

/** 宿主侧截断: 按代码点截到 CLASSIFIER_OUTPUT_LIMIT, 不切 surrogate pair。 */
export function truncateClassifierOutput(text: string): string {
  return truncateByCodePoint(text, CLASSIFIER_OUTPUT_LIMIT);
}

/** 降级说明: pass 空 evidence 或 fail 空 evidence 时补的理由前缀。 */
const DEGRADE_REASON = "证据缺失（pass/fail 必须带非空 evidence）";

/** 判定单个 evidence 项是否 shape 合法。 */
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
 * 解析判官 JSON → 四态 ClassifierResult (#449b B7 SC7: 扩 unverified 第 4 态)。
 *
 * 非法输入 (JSON 解析失败 / 非对象 / kind 非法 / shape 残缺 / pass|fail 空
 * evidence / unverified 缺 reason) 一律收敛为 `{kind:"abort", reason}`
 * (SC5: schema 错 → fail-open 到 unstable 的上游消费方)。
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

  // B7: unverified = 判官读完证据仍不足、拒绝猜 PASS/FAIL (SC7 第 4 态)。
  // evidence 允许缺省 (可能没跑命令所以无 evidence, 与 abort 同款可选纪律);
  // 若判官额外附了 evidence 也原样接受。reason 必填纪律已由上方统一检查保证。
  if (o.kind === "unverified") {
    return { kind: "unverified", reason: o.reason };
  }

  // pass / fail 共同契约: evidence 必为数组且全项 shape 合法, 非空。
  if (!Array.isArray(o.evidence) || !o.evidence.every(isClassifierCheck)) {
    return aborted("分类器输出 evidence 缺失或非法 (schema 错)");
  }
  if (o.evidence.length === 0) {
    // 降级规则 (A4 末尾): pass/fail 空 evidence → abort。
    return aborted(`${DEGRADE_REASON}: ${o.reason}`);
  }

  if (o.kind === "pass") {
    // pass 不允许 missing 字段 (missing 仅 fail 承载)。
    if (o.missing !== undefined) {
      return aborted("分类器输出 pass 携带 missing 字段 (schema 错)");
    }
    return {
      kind: "pass",
      reason: o.reason,
      evidence: o.evidence as ClassifierCheck[],
    };
  }

  // fail: missing 允许缺省(视为空数组)。
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
