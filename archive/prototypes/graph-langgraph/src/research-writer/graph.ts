/**
 * 研究-写作 supervisor —— langgraph 条件分支 + 写后评审原型（Proto B）。
 *
 * 被验证的设计问题：
 *   1. supervisor 节点能否同时负责"派发并行研究任务"与"汇总结论"？
 *   2. 写后评审不通过 → 回 writer 重写（条件边），且修订有上限（2 次）；
 *   3. ADR-0014 的 foreground-sync 语义：writer 必须拿到全部研究结论才开工——
 *      langgraph 的 `Send` fan-out + append reducer 让"派发 → 并行执行 →
 *      汇聚"成为原生表达，无需手写 drain 队列（对比 PR #110 手写 scheduler）。
 *
 * 节点职责（"多图节点承担对应任务"）：
 *   supervisor(派发) → research(并行 Send) → gather(汇聚) → writer → critic
 *     → [revise → 回 writer] | [finalize → END]
 *
 * langgraph 细节（原型实测确认）：
 *   - supervisor 是纯派发：返回 `Send[]` 即可，不写 researchNotes（否则会和
 *     Send 的 append 结果重复累加）。
 *   - gather 透传：等并行 Send 结果经 reducer 注入 state 后，writer 才读得到
 *     全部 3 条 note——这就是"foreground-sync"的图表达：后续节点天然 await
 *     上游的并行结果。
 *   - 条件边 pathMap 用对象形式（`{ research: "research", end: END }`），
 *     数组形式要求 path 返回值恰好是数组元素，`[]`/`END` 都不匹配。
 */
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import type { GraphState, ResearchNote } from "../_shared/models.js";
import { critiqueDraft, draftFromNotes, routeAfterCritique } from "./logic.js";

interface ResearchTopic {
  readonly topic: string;
  readonly noteId: string;
  readonly claim: string;
}

const FOCUS = "LangGraph 多图节点编排是否适合作为 iknow 的流程引擎";

const TOPICS: readonly ResearchTopic[] = [
  {
    topic: "graph vs loop-engine",
    noteId: "note-1",
    claim: "graph 表达并行依赖更直接",
  },
  {
    topic: "foreground-sync",
    noteId: "note-2",
    claim: "前景同步避免 drain 死锁",
  },
  { topic: "内建状态管理", noteId: "note-3", claim: "reducer 避免手写 topo" },
];

/**
 * supervisor：首轮设置 `sent` 标记（表示"已派发"），实际派发完全由条件边
 * path 函数承担（langgraph 官方标准：条件边 path 返回 Send[] 是并行 fan-out
 * 的唯一正确写法，Send 会创建隐式可达边）。后续轮（critic 回环重跑）：
 * `sent` 已 true，条件边 path 会走 gather，不重复派发。
 */
const supervisorNode = (state: ResearchWriterState): { sent: boolean } => {
  // 首轮：sent 保持 false（默认），条件边据此派发 research；
  // 回环（critic 判 revise 重跑本节点）：researchNotes 已汇聚，返回 sent:true
  // 让条件边走 gather（不重复派发）。
  const hasNotes = (state.researchNotes?.length ?? 0) > 0;
  return { sent: hasNotes };
};

/** 单个研究任务：模拟一次独立研究，返回一条 ResearchNote。 */
const researchNode = async (
  topic: ResearchTopic
): Promise<{
  researchNotes: readonly ResearchNote[];
}> => {
  await new Promise((r) => setTimeout(r, 5));
  return {
    researchNotes: [
      {
        id: topic.noteId,
        claim: topic.claim,
        evidence: [`观察自 ${topic.topic}`],
      },
    ],
  };
};

/** gather：汇聚标记——并行 Send 结果已由 reducer 注入 state，这里不再透传
 * （透传会触发 reducer 二次 append，导致 researchNotes 翻倍，见流探针实证）。 */
const gatherNode = (): Record<string, never> => ({});

const writerNode = (state: ResearchWriterState) => {
  const draft = draftFromNotes(state.researchNotes ?? [], FOCUS);
  return { draft: draft.text };
};

const criticNode = (state: ResearchWriterState) => {
  const { verdict, issues } = critiqueDraft({ text: state.draft ?? "" });
  const revisionCount = (state.revisionCount ?? 0) + 1;
  return { critique: { verdict, issues }, revisionCount };
};

/** 条件路由：pass → END；revise 未超限 → writer（纯函数）。 */
const routeAfterCritiqueNode = (state: ResearchWriterState) => {
  const v = routeAfterCritique({
    verdict: state.critique?.verdict ?? "revise",
    revisionCount: state.revisionCount ?? 0,
  });
  return v === "finalize" ? END : "writer";
};

/** 共享 state schema（与 news-digest 对齐的字段风格）。 */
const StateAnnotation = Annotation.Root({
  // 并行 fan-out 的汇点必须是 append reducer（同 news-digest 的坑）。
  researchNotes: Annotation<readonly ResearchNote[]>({
    reducer: (left, right) => [...(left ?? []), ...(right ?? [])],
    default: () => [],
  }),
  sent: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  draft: Annotation<string | undefined>(),
  critique: Annotation<GraphState["critique"]>(),
  revisionCount: Annotation<number>({ reducer: (_a, b) => b }),
  pipeline: Annotation<"news-digest" | "research-writer" | undefined>(),
});

type ResearchWriterState = typeof StateAnnotation.State;

export function buildResearchWriterGraph() {
  return (
    new StateGraph(StateAnnotation)
      .addNode("supervisor", supervisorNode)
      .addNode("research", researchNode)
      .addNode("gather", gatherNode)
      .addNode("writer", writerNode)
      .addNode("critic", criticNode)
      .addEdge(START, "supervisor")
      // 派发：supervisor → research x N → gather（fan-out 汇聚）。
      // 条件边 path 是唯一派发源：首轮（sent=false）返回 Send[] 并行派发
      // research（Send 创建隐式可达边，不需要静态边——静态边会让 research
      // 多跑一次收到 supervisor 返回值，见探针 #6），sent=true 后走 gather
      // （结果已在 state）。
      .addConditionalEdges(
        "supervisor",
        (state: ResearchWriterState) =>
          state.sent ? "gather" : TOPICS.map((t) => new Send("research", t)),
        { gather: "gather", research: "research", [END]: END }
      )
      .addEdge("research", "gather")
      .addEdge("gather", "writer")
      .addEdge("writer", "critic")
      .addConditionalEdges("critic", routeAfterCritiqueNode, {
        writer: "writer",
        [END]: END,
      })
      .compile()
  );
}

/** 编译并执行一次研究-写作流程，返回终态。 */
export async function runResearchWriter(): Promise<GraphState> {
  const graph = buildResearchWriterGraph();
  const result = await graph.invoke({ pipeline: "research-writer" });
  return result as unknown as GraphState;
}
