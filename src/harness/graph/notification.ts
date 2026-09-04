/**
 * ADR-0041 graph 模式切换的人读 + 模型读通知文（SSOT，spec §8）。
 *
 * 翻图落 messages 尾部 —— 翻图在 system 段被撤除后,模型想知道图状态只能
 * 经这条「切换提示」。两条静态文本(模板钉死):
 *
 *  - 开图提示 = 旧 IKNOW_GRAPH_ORCHESTRATION_TEXT 的内容(编排指引并入)+
 *    一句显式 「graph mode is now on」开头。模型读到这一条就能开始用
 *    run_graph,但同 round 的 run() 装配快照还是旧的 —— 这是 ADR-0030
 *    既有行为,不破坏。
 *
 *  - 关图提示 = 一句「graph mode is now off」+ 一句静态指引「use
 *    spawn_subagent」类(说明工具面 run_graph 还在、handler 会拒,所以
 *    走 spawn_subagent 的现成路径)。
 *
 *  模板与 ADR-0028 `<agent_status>` 单行静态形态同款(放 `<graph_mode>...</graph_mode>`
 *  标签内,便于模型 grep 与人类读侧过滤)。文本在会话内字节恒定(无
 *  per-turn 插值)→ 后端被动前缀缓存只接受尾部追加,符合 spec SC5。
 *
 *  切换是否触发的判定由 loop-engine 持有「上一次 graph 快照」比较:
 *  仅当本 round 装配快照与上次不同 → appendMessage;同值 → 零追加。
 *  build-engine 不参与判定(它只 wire 缝,不强加逻辑),loop-engine
 *  闭合。
 */

export type GraphModeChange = "on" | "off";

/** 开图通知（SSOT，loop-engine 唯一来源）。 */
export const IKNOW_GRAPH_MODE_ON_NOTIFICATION =
  "<graph_mode>Graph mode is now on. run_graph is available alongside spawn_subagent — call it when the work splits into pieces that depend on each other. Declare the whole shape in one call: every node gets an `id`, a self-contained `task`, and the `deps` it waits for. Nodes whose deps are all satisfied run in parallel; a node starts only once every node it depends on has finished, and its task arrives with those results appended. If a node fails, the nodes downstream of it come back skipped while unrelated branches keep running, and the call still returns one report covering every node. Read that report and decide what to do next. Keep using spawn_subagent for a single task, or for several tasks with no ordering between them — a graph with no edges buys nothing over parallel spawns.</graph_mode>";

/** 关图通知（SSOT）。 */
export const IKNOW_GRAPH_MODE_OFF_NOTIFICATION =
  "<graph_mode>Graph mode is now off. run_graph is still listed but will reject calls — use spawn_subagent instead (single task, or several tasks in parallel via multiple spawn_subagent calls in one turn).</graph_mode>";

/**
 * 把一次翻图决定映射为单行 user 消息文本(SSOT,文本内容经上两条常量)。
 *
 *  `change === "on"` → 开图提示(含编排指引);
 *  `change === "off"` → 关图提示。
 *
 *  文本格式参考 ADR-0028 status bar 的 `<agent_status>...</agent_status>`
 *  单行静态形态:整段就是一整条 user message,模型读面 = 静态读侧。
 */
export function renderGraphModeChangeNotification(
  change: GraphModeChange
): string {
  return change === "on"
    ? IKNOW_GRAPH_MODE_ON_NOTIFICATION
    : IKNOW_GRAPH_MODE_OFF_NOTIFICATION;
}
