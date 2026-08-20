/**
 * 今日 AI 新闻 digest 的纯逻辑（可与 graph 分离单测）。
 *
 * 设计意图：这些函数就是 langgraph 各节点函数内部会调用的可测单元——
 * 节点函数只做 `({ state }) => ({ filtered: filter(...) })` 的薄包装，
 * 真正逻辑沉淀在这里。langgraph 的节点签名是 `(state, config?) => Partial<State>`，
 * 所以"节点 == 纯函数 + 包装"成立，原型里把这些函数直接 lift 进真代码最省事。
 */
import type {
  ArticleSummary,
  NewsArticle,
  NewsDigest,
} from "../_shared/models.js";

/** 摘要文章：生成一段要点（纯函数，e2e 可断言内容来自原 headline）。 */
export function summarizeArticle(a: NewsArticle): ArticleSummary {
  return {
    articleId: a.id,
    headline: a.headline,
    keyPoints: [a.summary],
  };
}

/** 排序：按"是否命中编排类 tag"加分 → 稳定排序（纯函数）。 */
export function rankByRelevance(
  items: readonly ArticleSummary[]
): readonly ArticleSummary[] {
  const score = (s: ArticleSummary): number =>
    /langgraph|orchestration|mcp/i.test(s.headline) ? 1 : 0;
  return [...items].sort(
    (a, b) => score(b) - score(a) || a.headline.localeCompare(b.headline)
  );
}

/** 组装 digest 正文（纯函数）。 */
export function composeDigest(
  intro: string,
  ranked: readonly ArticleSummary[]
): NewsDigest {
  return {
    intro,
    rankedItems: ranked,
    outro: `今日共收录 ${ranked.length} 条要点。`,
  };
}

/** 编辑器评审：命中硬伤模式 → 需要修订（纯函数）。 */
export function reviewDigest(
  digest: NewsDigest,
  revision: number
): { verdict: "accept" | "revise"; issues: readonly string[] } {
  const issues: string[] = [];
  if (!digest.intro.trim()) {
    issues.push("digest 缺少引言");
  }
  if (digest.rankedItems.length === 0) {
    issues.push("digest 没有正文条目");
  }
  if (revision >= 3) {
    issues.push("修订超过上限，强制接受");
  }
  return { verdict: issues.length === 0 ? "accept" : "revise", issues };
}
