/**
 * graph-langgraph-prototypes demo —— 一条命令跑通两个 langgraph 原型。
 *
 * 运行：`npm run graph:langgraph-demo`
 *
 * 设计意图：这是"轻量 TUI/CLI"的最小形态——每跑完一个节点就打印该节点的
 * state 增量（langgraph streamMode:"updates" 天然逐节点产出），让用户直观
 * 看到多图节点各自承担任务、状态沿边流动。壳层是 throwaway，节点逻辑在
 * news-digest/ 与 research-writer/ 的 logic.ts 里可单独 lift。
 */
import { buildNewsDigestGraph, runNewsDigest } from "./news-digest/graph.js";
import {
  buildResearchWriterGraph,
  runResearchWriter,
} from "./research-writer/graph.js";

async function streamAndPrint(
  title: string,
  build: () =>
    | ReturnType<typeof buildNewsDigestGraph>
    | ReturnType<typeof buildResearchWriterGraph>,
  input: Record<string, unknown>
): Promise<void> {
  console.log(`\n=== ${title} ===`);
  const graph = build();
  const stream = await graph.stream(input, { streamMode: "updates" });
  for await (const event of stream) {
    for (const [node, update] of Object.entries(
      event as Record<string, unknown>
    )) {
      console.log(`  → ${node}: ${JSON.stringify(update)}`);
    }
  }
}

async function main(): Promise<void> {
  await streamAndPrint(
    "今日 AI 新闻 digest（langgraph 多节点 pipeline）",
    buildNewsDigestGraph,
    { pipeline: "news-digest", seed: "demo" }
  );

  await streamAndPrint(
    "研究-写作 supervisor（langgraph 条件分支 + 写后评审）",
    buildResearchWriterGraph,
    { pipeline: "research-writer" }
  );

  const digest = await runNewsDigest({ seed: "demo" });
  console.log("\n=== 终态 ===");
  console.log("news-digest digest.intro:", digest.digest?.intro);
  console.log("news-digest ranked items:", digest.ranked?.length);

  const rw = await runResearchWriter();
  console.log("research-writer researchNotes:", rw.researchNotes?.length);
  console.log("research-writer revisionCount:", rw.revisionCount);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
