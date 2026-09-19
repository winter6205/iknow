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

/** 官方帧开/闭标签字面（ADR-0112 T2：出站投影 TAG 转义名册由此常量拼装；
 *  三条通知常量以 OPEN_TAG 开头 / CLOSE_TAG 结尾，形态由下方锁测试钉住）。 */
export const GRAPH_MODE_OPEN_TAG = "<graph_mode>";
export const GRAPH_MODE_CLOSE_TAG = "</graph_mode>";

/**
 * 人读过滤谓词（specs/tui-human-display.md D8 / SC7）：三条 graph 现势通知
 * 都是 host 注入的机器可读信封，不是操作员键的输入 —— TUI 不得画成 ❯ 气泡。
 * 与 `isAgentStatusText`（`src/harness/agent-status.ts`）同纪律同形态：
 * 生产者本家声明谓词，消费侧（TUI / CLI）共用，避免消费侧各自重写前缀。
 *
 * 形态 = 整条 user message 以 `<graph_mode>` 开头（三常量皆以此为界，
 * 模型侧 grep 同款）。前导空白容忍（与 agent_status 一致）。
 */
export function isGraphModeText(text: string): boolean {
  return text.trimStart().startsWith(GRAPH_MODE_OPEN_TAG);
}

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

/**
 * ADR-0081 — 「开着图」本轮短现势（SSOT）。每个 `run()` 一次，不是每次调模型。
 *
 *  用途：holder 仍 on 时，本 `run()` 在 messages 尾追加这一行一次——
 *  让模型在工具 description（常驻、不随模式增删）之外，本轮能读到
 *  一句短现势。短句不替代长 ON/OFF（切换提示仍只在翻转那一拍一次），
 *  也不进 system / run_graph 回执 / <agent_status>。
 *
 *  与长 ON 的区别：
 *   - 短句不带完整编排说明书，只点名两个工具的语义差
 *     （有相互依赖的拆分用 run_graph、活图可含标明失败回边；单发任务
 *     用 spawn_subagent）。模型收到短句后会知道图仍开着、本轮该选
 *     哪把工具。
 *   - 文本明显短于长 ON，便于 session 内字节恒定（KV cache 尾部追加
 *     兼容 + 模型 grep 形态），无 per-turn 插值。
 *   - 出现节奏 = 每个 `run()` 一次，不是每次调模型；长 ON/OFF = 翻转
 *     一拍一次（开图含编排指引、关图含关闭提示）。
 *
 *  实现侧由 loop-engine 的 `appendGraphModePresence` seam 在调模型前
 *  按 `assembly.enabled()` 决定是否追加：seam 缺席 / enabled() === false /
 *  当拍刚贴过长 ON / 本 run 已结算 → 零追加；其余按追加缝记录进
 *  pendingInjected（#888）。
 */
export const IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION =
  "<graph_mode>Graph mode is still on. Prefer run_graph when the work splits into pieces with dependencies between them (declare the whole shape in one call — it's a live graph, not a single spawn, and may include marked failure edges); use spawn_subagent for a single task or for several independent tasks.</graph_mode>";
