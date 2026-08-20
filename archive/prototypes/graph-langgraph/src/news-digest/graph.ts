/**
 * 今日 AI 新闻 digest —— langgraph 多节点 pipeline 原型（Proto A）。
 *
 * 被验证的设计问题：
 *   1. langgraph 能否承担"多图节点各领一职"的今日新闻管线？
 *   2. 并行 fan-out（summarize）是否用 `Send` 原生表达，而不用手写并行器？
 *   3. 条件边 + reducer（editorRevision）能否表达"评审不通过 → 回环修订"，
 *      且修订有上限？
 * 三个子问题在 v1（PR #110 手写 topo/scheduler/skillCheckGate）都要自研，
 * 这里全部是 langgraph 内建原语。
 *
 * 节点职责（align 用户的"多图节点承担对应任务"）：
 *   fetch_feeds → filter_articles → summarize_articles(并行 Send)
 *   → rank_articles → compose_digest → editor_review → [revise|end]
 *
 * graph 语义：每轮 `invoke` 的输入是完整 `GraphState`（见 _shared/models），
 * 节点返回 `Partial<GraphState>` 增量，reducer 字段（editorRevision）只做
 * `lastValue`（保留最新值），其余字段"覆盖"。这就是 PR #110 proto-types.ts
 * 想表达的"图状态即节点间唯一契约"——langgraph 1.x 的 Annotation.Root 原生支持。
 */
import {
  Annotation,
  Command,
  END,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type {
  ArticleSummary,
  GraphState,
  NewsArticle,
  NewsDigest,
} from "../_shared/models.js";
import { filterByTags, fetchTodayAiNews } from "../_shared/stub-news.js";
import {
  composeDigest,
  rankByRelevance,
  reviewDigest,
  summarizeArticle,
} from "./logic.js";

/** 单个 fan-out 摘要任务的载荷（Send 第二参数）。 */
interface SummarizeArticlePayload {
  readonly article: NewsArticle;
}

/** 共享 state schema：图结构由 reducer 声明，与 GraphState 类型对齐。 */
const StateAnnotation = Annotation.Root({
  fetched: Annotation<readonly NewsArticle[] | undefined>(),
  filtered: Annotation<readonly NewsArticle[] | undefined>(),
  // 并行 fan-out 的汇点必须是 append reducer：summarize 节点每个 Send 返回
  // 一条摘要，LastValue 会互相覆盖只留最后一条（原型里的关键陷阱）。
  summaries: Annotation<readonly ArticleSummary[]>({
    reducer: (left, right) => [...(left ?? []), ...(right ?? [])],
    default: () => [],
  }),
  ranked: Annotation<readonly ArticleSummary[] | undefined>(),
  digest: Annotation<NewsDigest | undefined>(),
  editorRevision: Annotation<number>({ reducer: (_a, b) => b }),
  seed: Annotation<string | undefined>(),
  pipeline: Annotation<"news-digest" | "research-writer" | undefined>(),
});

type NewsDigestState = typeof StateAnnotation.State;

// ---- 节点实现（薄包装，真实逻辑见 ./logic.ts） ----

const fetchFeeds = async (state: NewsDigestState) => {
  const articles = await fetchTodayAiNews({ seed: state.seed });
  return { fetched: articles };
};

const filterArticles = (state: NewsDigestState) => ({
  filtered: filterByTags(state.fetched ?? [], [
    "model",
    "langgraph",
    "mcp",
    "tooling",
  ]),
});

/** 并行摘要：`Send` 让 langgraph 对每条文章并行执行本节点。 */
const summarizeArticleNode = async (payload: SummarizeArticlePayload) => {
  // 每个 Send 载荷对应一次独立的节点调用，结果按 Send 返回累加。
  const summary = await Promise.resolve(summarizeArticle(payload.article));
  return { summaries: [summary] };
};

/** fan-out 路由：对每条文章发一个并行任务。 */
function fanOutSummarize(state: NewsDigestState): Send[] {
  return (state.filtered ?? []).map(
    (article) => new Send("summarize_articles", { article })
  );
}

const rankArticles = (state: NewsDigestState) => ({
  ranked: rankByRelevance(state.summaries ?? []),
});

const composeDigestNode = (state: NewsDigestState) => ({
  digest: composeDigest(
    `今日 AI 摘要（${(state.ranked ?? []).length} 条）：`,
    state.ranked ?? []
  ),
});

const editorReview = (state: NewsDigestState) => {
  const revision = (state.editorRevision ?? 0) + 1;
  const digest = state.digest ?? { intro: "", rankedItems: [], outro: "" };
  const { verdict } = reviewDigest(digest, revision);
  if (verdict === "accept") {
    return new Command({ update: { editorRevision: revision }, goto: END });
  }
  // 修订：回到 rank 阶段重跑；editorRevision 由 lastValue reducer 累加。
  return new Command({
    update: { editorRevision: revision, digest: undefined },
    goto: "rank_articles",
  });
};

export function buildNewsDigestGraph() {
  return (
    new StateGraph(StateAnnotation)
      .addNode("fetch_feeds", fetchFeeds)
      .addNode("filter_articles", filterArticles)
      .addNode("summarize_articles", summarizeArticleNode)
      .addNode("rank_articles", rankArticles)
      .addNode("compose_digest", composeDigestNode)
      .addNode("editor_review", editorReview)
      .addEdge(START, "fetch_feeds")
      .addEdge("fetch_feeds", "filter_articles")
      // fan-out：filter_articles → [summarize_articles x N] → rank_articles
      .addConditionalEdges("filter_articles", fanOutSummarize, [
        "summarize_articles",
      ])
      .addEdge("summarize_articles", "rank_articles")
      .addEdge("rank_articles", "compose_digest")
      .addEdge("compose_digest", "editor_review")
      .compile()
  );
}

/** 编译并执行一次完整 digest 流程，返回终态（e2e / demo 共用）。 */
export async function runNewsDigest(
  input: { readonly seed?: string } = {}
): Promise<GraphState> {
  const graph = buildNewsDigestGraph();
  const result = await graph.invoke({
    seed: input.seed,
    pipeline: "news-digest",
  });
  return result as unknown as GraphState;
}
