/**
 * Policy-string → predicate map. Routing is by policy text only (no sample-id).
 */
import { ANSWER_RX, EVAL_MAX_HOPS, GATE_ID, NOTE } from "./lexicon.js";
import type { EvalSample } from "./types.js";
import type { GovernanceStatus } from "../shared/schema.js";

export type PolicyCtx = {
  text: string;
  notes: string[];
  tools: Set<string>;
  hops: number;
  governance_status: GovernanceStatus | undefined;
  source_span_len: number;
  snapshot_id: string;
  sample: EvalSample;
};

/**
 * Evaluate one expected.policies entry against run context.
 * @returns true = pass, false = fail, "unknown" = no matcher for this policy
 */
export function checkPolicy(
  policy: string,
  ctx: PolicyCtx
): boolean | "unknown" {
  const p = policy;

  // Exact global gates already enforced in scorer; treat as covered.
  if (p === GATE_ID.G2_REQUIRED) {
    return Boolean(ctx.snapshot_id);
  }
  if (p === GATE_ID.HOPS_LE_5) {
    return (
      typeof ctx.hops === "number" &&
      Number.isFinite(ctx.hops) &&
      ctx.hops <= EVAL_MAX_HOPS
    );
  }

  if (p.includes("G2") || p.includes("G2必填")) {
    return Boolean(ctx.snapshot_id);
  }

  if (p.includes("空结果") || p.includes("不编造") || p.includes("graceful")) {
    const ok =
      ctx.notes.includes(NOTE.EMPTY_RESULT) ||
      ctx.notes.includes(NOTE.NO_HALLUCINATION) ||
      ANSWER_RX.emptyOk.test(ctx.text);
    const invented = ANSWER_RX.inventedStock.test(ctx.text);
    return ok && !invented;
  }

  if (p.includes("冲突")) {
    return (
      ctx.tools.has("kb_governance") ||
      ctx.governance_status === "conflict" ||
      ANSWER_RX.conflict.test(ctx.text)
    );
  }

  if (p.includes("过期") || p.includes("作废")) {
    return (
      ctx.governance_status === "stale" ||
      ctx.notes.includes(NOTE.DOCUMENT_REVOKED_OR_STALE) ||
      ANSWER_RX.stale.test(ctx.text)
    );
  }

  if (p.includes("权限") || p.includes("越权") || p.includes("边界")) {
    return (
      ctx.notes.includes(NOTE.PERMISSION_DENIED) ||
      ANSWER_RX.denied.test(ctx.text)
    );
  }

  if (p.includes("审批") || p.includes("安全")) {
    return (
      ctx.notes.includes(NOTE.REQUIRE_APPROVAL) ||
      ANSWER_RX.approval.test(ctx.text)
    );
  }

  if (p.includes("降级") || p.includes("超时")) {
    return (
      ctx.notes.some((n) => /timeout|degrad|超时|降级|unverified/i.test(n)) ||
      ctx.governance_status === "stale" ||
      ANSWER_RX.degrade.test(ctx.text)
    );
  }

  if (p.includes("hops") || p.includes("跳数") || p.includes("上限")) {
    // hop budget already checked; multi-dept may also declare max_hops
    return (
      ctx.hops <= EVAL_MAX_HOPS ||
      ctx.notes.includes(NOTE.MAX_HOPS_EXCEEDED) ||
      ANSWER_RX.hopLimit.test(ctx.text)
    );
  }

  // version anchors must be cited via source_span when content is returned
  if (p.includes("版本锚点") || p.includes("source_span")) {
    if (
      ctx.notes.includes(NOTE.EMPTY_RESULT) ||
      ctx.notes.includes(NOTE.PERMISSION_DENIED) ||
      ctx.notes.includes(NOTE.REQUIRE_APPROVAL)
    ) {
      return true;
    }
    return ctx.source_span_len > 0;
  }

  // compile 补编: when compile runs, sources must be marked; no compile → N/A
  if (p.includes("compile") || p.includes("补编")) {
    if (!ctx.tools.has("kb_compile")) return true;
    return ctx.source_span_len > 0 || /来源|溯源|chunk/.test(ctx.text);
  }

  return "unknown";
}
