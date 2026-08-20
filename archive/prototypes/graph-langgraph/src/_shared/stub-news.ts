/**
 * Stub 新闻源（proto 专用替身）。
 *
 * 生产里这里是真实 fetch 外部源；原型里用确定性 stub 保证 e2e 可断言：
 * 同一 input 永远产出同一组文章，且 `await delay()` 让节点看起来像真实
 * 异步 IO（langgraph 并行 fan-out 时能看到并发）。
 *
 * 结构与 iknow tests/harness/stubs/stub-model.ts 同风格——替身不进生产装配。
 */
import type { NewsArticle } from "./models.js";

const SAMPLE_HEADLINES = [
  {
    source: "stub-ai-news",
    headline: "Claude 5 family 发布：Fable 与 Mythos 分层",
    summary:
      "Anthropic 发布新一代 Claude，默认模型分层覆盖研发与安全审查场景。",
    tags: ["model", "anthropic"],
  },
  {
    source: "stub-ai-news",
    headline: "LangGraph 1.4 引入原生条件边执行追踪",
    summary: "流程图状态机新增运行时 trace 与 per-node 错误处理。",
    tags: ["langgraph", "orchestration"],
  },
  {
    source: "stub-ai-news",
    headline: "MCP 客户端规范进入候选草案阶段",
    summary: "模型上下文协议更新，工具发现与生命周期管理更贴近 AGENTS 标准。",
    tags: ["mcp", "tooling"],
  },
  {
    source: "stub-ai-news",
    headline: "开源社区再现万亿参数 MoE 训练",
    summary: "多家实验室公开了新一轮稀疏模型训练细节与成本对比。",
    tags: ["model", "training"],
  },
] as const;

/** 读入时可注入 seed，让 e2e 能区分"同 pipeline 不同数据"的两次运行。 */
export interface FetchOptions {
  readonly seed?: string;
  /** 每个文章的模拟 IO 延迟（ms）。默认 5ms，fan-out 测试可调大观察并发。 */
  readonly delayMs?: number;
}

/**
 * 模拟"今日 AI 新闻"抓取：取固定头条，若给了 seed 则在 headline 前加
 * `[seed]` 前缀——纯函数 + 延迟，确定性且可断言。
 */
export async function fetchTodayAiNews(
  opts: FetchOptions = {}
): Promise<readonly NewsArticle[]> {
  const { seed, delayMs = 5 } = opts;
  await new Promise((r) => setTimeout(r, delayMs));
  return SAMPLE_HEADLINES.map((h, i) => ({
    id: `art-${i + 1}`,
    source: h.source,
    headline: seed ? `[${seed}] ${h.headline}` : h.headline,
    summary: h.summary,
    tags: h.tags,
  }));
}

/** 按主题过滤：只留至少命中一个给定 tag 的条目（纯函数，便于单测）。 */
export function filterByTags(
  articles: readonly NewsArticle[],
  keepTags: readonly string[]
): readonly NewsArticle[] {
  const want = new Set(keepTags);
  return articles.filter((a) => a.tags.some((t) => want.has(t)));
}
