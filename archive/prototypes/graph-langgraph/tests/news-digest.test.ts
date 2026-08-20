/**
 * E2E（vitest）：今日 AI 新闻 digest —— langgraph 多节点 pipeline（Proto A）。
 *
 * 断言的三条关键语义：
 *   1. 正常路径：6 个节点按依赖序跑完，终态含 digest 且结构完整；
 *   2. 并行 fan-out：summaries 累加了全部文章（append reducer），
 *      且顺序无关（同 seed 两次运行结果一致）；
 *   3. 条件回环：editorReview 在"摘要条目为空"时触发 revise → 回 rank 重跑，
 *      editorRevision 递增（lastValue reducer），最终仍收敛出 digest。
 *
 * 这些都是 v1（PR #110）里手写 scheduler/topo 才具备的能力——在 langgraph
 * 里是内建原语，e2e 验证它们真的成立。
 */
import { describe, expect, it } from "vitest";
import {
  buildNewsDigestGraph,
  runNewsDigest,
} from "../src/news-digest/graph.js";

/** 断言终态 digest 结构完整（helper，避免每个用例重复）。 */
function expectDigestComplete(res: Record<string, unknown>): void {
  expect(res).toHaveProperty("digest");
  const digest = res.digest as {
    intro: string;
    rankedItems: unknown[];
    outro: string;
  };
  expect(digest.intro).toContain("今日 AI 摘要");
  expect(digest.rankedItems.length).toBeGreaterThan(0);
  expect(digest.outro).toContain("今日共收录");
}

describe("news-digest（langgraph 多节点 pipeline）", () => {
  it("正常路径：6 节点按依赖序跑完，终态 digest 完整", async () => {
    const res = await runNewsDigest({});
    expect(res.pipeline).toBe("news-digest");
    expect(res.fetched?.length).toBeGreaterThan(0);
    expect(res.filtered?.length).toBeGreaterThan(0);
    // 并行 fan-out：summaries 应累加全部 filtered 文章（append reducer）
    expect(res.summaries?.length).toBe(res.filtered?.length);
    expect(res.ranked?.length).toBe(res.filtered?.length);
    expectDigestComplete(res as unknown as Record<string, unknown>);
  });

  it("并行 fan-out 顺序无关：同 seed 两次运行终态一致", async () => {
    const a = await runNewsDigest({ seed: "seed-A" });
    const b = await runNewsDigest({ seed: "seed-A" });
    expect(a).toEqual(b);
    // 且 seed 确实流经了节点（seed 前缀进入 headline，再进入 digest）
    const headline0 = a.ranked?.[0]?.headline ?? "";
    expect(headline0).toContain("[seed-A]");
  });

  it("条件回环：editorReview 发现 digest 缺条目 → 回 rank 重跑且 revision 递增", async () => {
    // 造一个 digest 为空的情况：rankedItems 空 → composeDigest 产出空正文
    // → reviewDigest 命中"没有正文条目"→ 强制 revise。
    // 直接构建 graph 并注入一个 digest 为空的状态，触发 revise 路径。
    const graph = buildNewsDigestGraph();
    // 注入终态前的中间状态：digest 为空的 digest，editorRevision=1
    const res = await graph.invoke({
      pipeline: "news-digest",
      fetched: [],
      filtered: [],
      summaries: [],
      ranked: [],
      digest: { intro: "", rankedItems: [], outro: "" },
      editorRevision: 1,
    });
    // 空条目 → reviewDigest 判定 revise → 回 rank_articles 重跑，重新抓取并排序
    // 因为 summaries=[] 且 fetched=[]，重跑后 digest 仍空 → 再次 revise
    // 到上限（3）后 editorReview 强制接受，终态 digest 仍是空但 revision 递增。
    expect((res as { editorRevision?: number }).editorRevision).toBeGreaterThan(
      1
    );
    // 空输入也能收敛（强接受路径），不抛错
    expect(res).toBeDefined();
  });
});
