/**
 * graph-langgraph-prototypes —— langgraph 流程编排原型（v2，对比 PR #110 的手写编排）。
 *
 * 纯数据类型：被两个原型（news-digest / research-writer）与 e2e 测试共用。
 * 放在独立模块以便节点逻辑可以当作纯函数单测，graph 只是把这些函数粘起来。
 *
 * 设计点：所有节点共享同一个 `GraphState` 形状（PR #110 的 proto-types.ts 同款
 * 思路——"图状态即节点间唯一契约"），字段全部可选，节点只 update 自己负责的
 * 槽位。这是 langgraph 的 Annotation.Root 天然支持的形态，也是 e2e 断言状态
 * diff 的基础。
 */

// NodeMessage slot 被删除：原设计通用消息追踪，但实际两个 pipeline 的 append 都
// 走各自专门槽位（summaries / researchNotes），通用消息槽既无写入也无断言。
// 后续如要通用消息通道，应作为 prototype 的明确 seam（独立 AppendReducer 配置），
// 而非 dummy 占位字段（避免 Speculative Generality，Fowler）。

/** 一条新闻条目（今日 AI 新闻原型的中间数据）。 */
export interface NewsArticle {
  readonly id: string;
  readonly source: string;
  readonly headline: string;
  readonly summary: string;
  readonly tags: readonly string[];
}

/** 一篇已生成的文章摘要。 */
export interface ArticleSummary {
  readonly articleId: string;
  readonly headline: string;
  readonly keyPoints: readonly string[];
}

/** 今日 AI 新闻 digest 的最终产物。 */
export interface NewsDigest {
  readonly intro: string;
  readonly rankedItems: readonly ArticleSummary[];
  readonly outro: string;
}

/** 研究-写作原型的阶段产物。 */
export interface ResearchNote {
  readonly id: string;
  readonly claim: string;
  readonly evidence: readonly string[];
}

export interface Draft {
  readonly text: string;
}

export interface Critique {
  readonly issues: readonly string[];
  readonly verdict: "pass" | "revise";
}

/**
 * 图全局状态。
 *
 * 节点契约：每类节点只写自己的槽位（news digest 阶段 / research 阶段），
 * 不触碰其他槽位。`pipeline` 槽位仅 demo/tests 注入，用于区分跑的是哪条
 * pipeline——帮助 e2e 在共享状态形状下各自断言。
 */
export interface GraphState {
  readonly seed?: string;
  readonly pipeline?: "news-digest" | "research-writer";

  /** 今日 AI 新闻 pipeline */
  readonly fetched?: readonly NewsArticle[];
  readonly filtered?: readonly NewsArticle[];
  readonly summaries?: readonly ArticleSummary[];
  readonly ranked?: readonly ArticleSummary[];
  readonly digest?: NewsDigest;
  readonly editorRevision?: number;

  /** 研究-写作 pipeline */
  readonly researchNotes?: readonly ResearchNote[];
  readonly draft?: string;
  readonly critique?: Critique;
  readonly revisionCount?: number;
}
