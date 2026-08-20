/**
 * 研究-写作 supervisor 原型的纯逻辑（可与 graph 分离单测）。
 *
 * 设计意图与 news-digest/logic.ts 一致：节点函数做薄包装，逻辑沉淀在这里。
 * 三个函数恰好对应三个"可被 graph 条件编排"的决策点：
 *   1. 研究汇总怎么产出 draft（drafting）
 *   2. critic 怎么给 verdict（critiquing）
 *   3. 路由到"重写 draft"还是"结束"（routing）——这是 langgraph
 *      条件边的核心；PR #110 v1 里用自己手写的 skillCheckGate 做这件事，
 *      langgraph 里 `addConditionalEdges` + `route` 函数是内建的。
 */
import type { Draft, ResearchNote } from "../_shared/models.js";

/** 把研究笔记汇总成一篇草稿（纯函数，模拟 LLM 写稿的确定性替身）。 */
export function draftFromNotes(
  notes: readonly ResearchNote[],
  focus: string
): Draft {
  const body = notes
    .map((n) => `- ${n.claim}（${n.evidence.length} 条证据）`)
    .join("\n");
  return { text: `关于「${focus}」\n${body}` };
}

/** 评审草稿：命中关键词就要求修订（纯函数，模拟 critic LLM 的确定性替身）。 */
export function critiqueDraft(d: Draft): {
  verdict: "pass" | "revise";
  issues: readonly string[];
} {
  const issues: string[] = [];
  if (!/证据/.test(d.text)) issues.push("缺少证据引用");
  if (d.text.split("\n").length < 3) issues.push("篇幅过短");
  return { verdict: issues.length === 0 ? "pass" : "revise", issues };
}

/** 路由决策：pass → 结束；revise 且未超上限 → 重写（纯函数）。 */
export function routeAfterCritique(c: {
  readonly verdict: "pass" | "revise";
  readonly revisionCount: number;
}): "rewrite" | "finalize" {
  if (c.verdict === "pass") return "finalize";
  return c.revisionCount < 2 ? "rewrite" : "finalize";
}
