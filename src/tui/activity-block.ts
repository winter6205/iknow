/**
 * src/tui/activity-block.ts
 *
 * specs/tui-activity-block.md S1/S2–S7/S9/S10 锁句：过程块纯派生。
 *
 * 输入 = messages（已落盘历史）+ live runs（未提交 live 工具状态）
 * + live thinking 在流标记 + thinkingMsAtVisible（每条消息思考时长）。
 * 输出 = 按 assistant 消息追加的 `ActivityBlock[]`，每块一行标题 + 一个
 * 正文槽 + `live` 标记。ChatView / message-blocks.tsx 只消费此列表，不
 * 二次推导过程 chrome。
 *
 * 不变式（spec 锁句）：
 *  - 一条 assistant 消息可拆多块（被正文 / keep / accent / 失败切开），
 *    但每块仍按时间顺序追加，绝不整轮收成一行 stub。
 *  - 思考 + 相邻安静工具 = 焊（中间无正文 / keep / accent / 失败）；
 *    相邻判据看**原始** tool_use 序列（与 `orderedTurnActivitySegments`
 *    共享同一种扫描），不依赖 entries 过滤后的成簇。
 *  - 失败件 = 横切：失败件自己不入块、不占 dim 预览槽；其**两侧**安静
 *    簇被它切开（与 keep / accent 同待遇）。
 *  - keep / accent = 块外实卡（不计数）；它们仍是「隔开」因素。
 *  - 槽同一时刻只归思考流或一行 dim 工具预览（`tool-preview` 的 text
 *    来自 `formatRunningToolLine`，不另造模板串）。
 *  - 思考在流（liveThinking）→ 块标题 = `Thinking…`（用 `formatThinkingLive`），
 *    槽归思考；与最后一段 history welding 时也保留「下一块新思考」不写回。
 *  - 纯函数、无 React / 无 IO / 无 Date.now()；纯模块（注释解释「为什么」，
 *    早退分支 `// EXIT:` 标注，沿仓库惯例）。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import {
  formatToolUseCounts,
  thinkingMsToSeconds,
  type ToolUseCount,
} from "./turn-activity.js";
import { formatThinkingFold, formatThinkingLive } from "./think-fold.js";
import type { LiveToolRun } from "./live-tool-state.js";
import { formatRunningToolLine } from "./live-tool-state.js";
import { settledClassOf } from "./tool-settled.js";

/** 锚点：插入位的 messageIndex + contentBlockIndex。 */
export interface ActivityBlockAnchor {
  readonly messageIndex: number;
  readonly contentBlockIndex: number;
}

/** 正文槽的归属；同一时刻至多一种 kind。 */
export type ActivityBlockSlot =
  | { readonly kind: "thinking" }
  | { readonly kind: "tool-preview"; readonly text: string }
  | { readonly kind: "none" };

/** 过程块：标题 + 锚点 + 槽 + live 标记。 */
export interface ActivityBlock {
  readonly anchor: ActivityBlockAnchor;
  readonly title: string;
  readonly slot: ActivityBlockSlot;
  readonly live: boolean;
}

/** 输入：messages + live runs + 思考时长 + 思考在流标记 + 收类判定解析。 */
export interface ActivityBlockInput {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** 起始下标（含）。NaN / <0 / >=length → 视作 0（与既有 `sliceTurnFrom`
   *  负数一致）；超过末尾 → 历史全舍、live 块仍画在 messages.length。 */
  readonly start?: number;
  readonly thinkingMsAtVisible: (visibleIndex: number) => number;
  readonly liveThinking?: boolean;
  readonly liveRuns?: ReadonlyArray<LiveToolRun>;
  /** 与 ChatView 同款：仅数 `deriveSlot(...).inFoldCount` 为 true 的件；
   *  缺省 = 全部计入（纯函数兜底，与 `orderedTurnActivitySegments`
   *  的 `inFoldCountOf` 缺省同款）。 */
  readonly inFoldCountOf?: (
    call: Readonly<{ id: string; name: string }>
  ) => boolean;
}

/** 默认 inFoldCountOf：未注册名也兜底 retract（与既有 `inFoldCountOf` 缺省一致）。 */
function alwaysInFold(): boolean {
  return true;
}

/** 把 live 工具名转成「首现顺序 + 总数」的 `ToolUseCount[]`（同 `formatToolUseCounts` 口径）。 */
function liveToolCounts(
  liveRuns: ReadonlyArray<LiveToolRun>
): ReadonlyArray<ToolUseCount> {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const run of liveRuns) {
    const name = run.name;
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order.map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

/** 标题段构造：时长段 + 计数段，规则见 spec S2 / S3 锁句。
 *  - 无思考段、无计数 → 空串（不画标题）；
 *  - 仅思考段或仅计数段 → 直接接；
 *  - 双段 → 时长段 + `, ` + 计数段；同一批件多 tool 之间 ` · `。
 *  - 计数段必须先经 `formatToolUseCounts` —— 多名 `· ` 拼接、零数过滤都
 *    走那一个 SSOT，不另起一份硬编码。 */
function buildTitle(
  thinkingSeconds: number,
  hasWeld: boolean,
  verb: "calling" | "called",
  countsText: string
): string {
  const think = thinkingSeconds > 0 ? formatThinkingFold(thinkingSeconds) : "";
  if (think.length === 0 && countsText.length === 0) return "";
  if (think.length === 0) return `${verb} ${countsText}`;
  if (countsText.length === 0) return think;
  // 焊接 → 时长段后接 `, `；非焊接（独立块）→ 只画时长段（计数由分
  // 离的那块承担）。S2 锁句：标题只写「调用方块关联」的工具。
  return hasWeld ? `${think}, ${verb} ${countsText}` : think;
}

/** 安静簇 = retract 且非失败；焊接只判这层。
 *  与「不计数」同源 —— `deriveSlot` 的 `inFoldCount` 已在「失败 / 非收类」
 *  上假，过滤即成「焊入集合」。失败件是 `failed:true`，自然漏出。 */
function isWeldable(
  id: string,
  name: string,
  inFoldCountOf: (call: Readonly<{ id: string; name: string }>) => boolean
): boolean {
  // 必须传真 `id`：ChatView 的 resolver 依赖 `toolResultStatusMap`
  // 按 id 查失败位；空 id 会让真历史件被判成「未配对」而不入簇。
  return inFoldCountOf({ id, name });
}

/** 主函数：纯派生。详见模块头注释。 */
export function deriveActivityBlocks(
  input: ActivityBlockInput
): ReadonlyArray<ActivityBlock> {
  const {
    messages,
    thinkingMsAtVisible,
    liveThinking = false,
    liveRuns = [],
  } = input;

  let start = input.start ?? 0;
  if (!Number.isFinite(start) || start < 0) start = 0;

  const inFoldCountOf = input.inFoldCountOf ?? alwaysInFold;
  const blocks: ActivityBlock[] = [];

  // 处理越界：start >= messages.length → 历史全舍，但 live 块（思考在流 /
  // live 安静工具）仍画在 messages.length（未提交相的虚拟 messageIndex）。
  const historyStart = Math.min(start, messages.length);

  try {
    // 一遍扫描 + 累积计数 + 切开边界识别。每个 block 用「首个块的思考时长」
    // 决定时长段；同消息多次出现 thinking 时只首块带时长（不跨消息求和，与
    // `thinkingMsAtVisible` 的 per-message 含义对齐）。
    const scratch: ScratchState = {
      pending: null,
      blocks,
      drawnThinkingMessageIndices: new Set<number>(),
      thinkingMsAtVisible,
      liveRuns,
    };

    // 工具 use：i 是 messages 内的下标（不是 visible）—— 同一消息可拆
    // 多簇；切点 = 正文 / keep / accent / 失败。
    const startIndex = Math.trunc(historyStart);
    for (let i = startIndex; i < messages.length; i++) {
      scanMessage(i, messages[i], inFoldCountOf, scratch);
    }
  } catch {
    // EXIT: 异常消息形态不画块（与 `orderedTurnActivitySegments` 同款兜底）。
    return [];
  }

  // live 相：未提交的工具 + 思考在流 → 在 `messages.length` 处画独立块
  // （不动历史块计数，spec S5「新消息开新块」+ S11「hideThinking 只跟槽位
  // 主人走」的源头）。块**只**承接 retract 类（与 history `inFoldCountOf`
  // 同源）—— keep / accent / 失败仍由 tail 工具卡（live-tool-preview）
  // 与历史消息块承接，否则会与原 tail 路径双画。
  appendLiveBlocks(blocks, {
    messageIndex: messages.length,
    contentBlockIndex: 0,
    liveRuns,
    liveThinking,
  });

  return blocks;
}

/** 把 live 工具簇与思考在流画在 messages.length 处；纯尾追加。 */
function appendLiveBlocks(
  blocks: ReadonlyArray<ActivityBlock>,
  args: {
    messageIndex: number;
    contentBlockIndex: number;
    liveRuns: ReadonlyArray<LiveToolRun>;
    liveThinking: boolean;
  }
): void {
  const { messageIndex, contentBlockIndex, liveRuns, liveThinking } = args;
  const list = blocks as ActivityBlock[];
  // live 安静簇：仅 retract 类进 unanchored 块。失败 / keep / accent
  // 仍走原 tail / 历史路径，避免双画。判据 = `settledClassOf` 拿工具
  // 名落定后的类（live 阶段没有 statusMap 可查）。
  const retractRuns = liveRuns.filter(
    (run) => run.status !== "failed" && settledClassOf(run.name) === "retract"
  );
  const counts = liveToolCounts(retractRuns);
  if (counts.length > 0) {
    const verb = retractRuns.some((run) => run.status === "running")
      ? "calling"
      : "called";
    const lastRunning = [...retractRuns]
      .reverse()
      .find((run) => run.status === "running");
    list.push({
      anchor: { messageIndex, contentBlockIndex },
      title: `${verb} ${formatToolUseCounts(counts)}`,
      slot:
        lastRunning !== undefined
          ? { kind: "tool-preview", text: formatRunningToolLine(lastRunning) }
          : { kind: "none" },
      live: verb === "calling",
    });
  }
  if (liveThinking) {
    list.push({
      anchor: { messageIndex, contentBlockIndex },
      title: formatThinkingLive(),
      slot: { kind: "thinking" },
      live: true,
    });
  }
}

/** 扫描 scratch：累积 pending + 产出 blocks + per-message thinking 去重集 +
 *  thinkingMs 闭包（让子函数不重复接参）。把扫描状态归一处，避免主函数
 *  cc 膨胀（S5 hard gate）。 */
interface PendingAccumulator {
  readonly messageIndex: number;
  readonly contentBlockIndex: number;
  readonly counts: Map<string, number>;
  readonly order: string[];
  /** 该块覆盖的 tool_use id 集合 —— 与 live run id 配对，用来决定
   *  「焊入簇仍有 running 件 → calling + 预览槽」。 */
  readonly toolUseIds: Set<string>;
  readonly hasWeld: boolean; // 该块是否含可焊的安静件
  readonly weldedThinkingSeconds: number; // 思考段是否进该块（焊成同一标题）
}

interface ScratchState {
  pending: PendingAccumulator | null;
  blocks: ActivityBlock[];
  drawnThinkingMessageIndices: Set<number>;
  thinkingMsAtVisible: (visibleIndex: number) => number;
  liveRuns: ReadonlyArray<LiveToolRun>;
}

/** 单条 assistant 消息扫描（cc 切碎）：跳过非 assistant / 非数组 content；
 *  对每个 content block 调 classifyBlock，最后 flushPending 把累积的 pending
 *  落地。 */
function scanMessage(
  messageIndex: number,
  message: AnthropicNativeMessage | undefined,
  inFoldCountOf: (call: Readonly<{ id: string; name: string }>) => boolean,
  scratch: ScratchState
): void {
  if (message === undefined) return;
  if (message.role !== "assistant") return;
  if (!Array.isArray(message.content)) {
    // EXIT: 非数组 content 无法安全参与有序活动投影。
    return;
  }
  // 同消息去重：多次进入该消息前 flush 上一消息累积的 pending。
  // 这条规则同时承担「正文切开」—— 文本块到达时同样 flush。
  for (const [contentBlockIndex, block] of message.content.entries()) {
    classifyBlock(
      block,
      contentBlockIndex,
      messageIndex,
      inFoldCountOf,
      scratch
    );
  }
  // 消息尾部 → flush。
  flushPending(scratch);
}

/** 单块分类 + 累积（cc 切碎：把分派从主函数里搬出）。正文 / keep / 失败
 *  三类切点在此原地 flush；thinking / tool_use 累积到 scratch.pending。 */
function classifyBlock(
  block: AnthropicNativeMessage["content"][number],
  contentBlockIndex: number,
  messageIndex: number,
  inFoldCountOf: (call: Readonly<{ id: string; name: string }>) => boolean,
  scratch: ScratchState
): void {
  if (block === null || block === undefined) {
    // EXIT: null/undefined 块跳过而非抛错（异常形态容错）。
    return;
  }
  if (block.type === "text") {
    // 正文切点：flush 当前 pending（同消息 / 跨消息均生效）。
    flushPending(scratch);
    return;
  }
  if (block.type === "thinking" || block.type === "redacted_thinking") {
    absorbThinking(messageIndex, contentBlockIndex, scratch);
    return;
  }
  if (block.type !== "tool_use") return;
  if (!isWeldable(block.id, block.name, inFoldCountOf)) {
    // keep / accent / 失败件 → flush 当前 pending 并跳过该件本身。
    flushPending(scratch);
    return;
  }
  absorbToolUse(block, contentBlockIndex, messageIndex, scratch);
}

/** thinking 段：thinkingMs 仍以 per-message 计量，首段贴时长。 */
function absorbThinking(
  messageIndex: number,
  contentBlockIndex: number,
  scratch: ScratchState
): void {
  if (scratch.pending !== null) {
    // 当前已有 pending（说明上一个块在同消息内）→ 不再累计时长。
    return;
  }
  // 不立即 flush —— 等下一段再决定该块标题是否焊入。
  const seconds = thinkingMsToSeconds(
    scratch.thinkingMsAtVisible(messageIndex)
  );
  if (seconds === 0) return;
  if (scratch.drawnThinkingMessageIndices.has(messageIndex)) return;
  scratch.pending = {
    messageIndex,
    contentBlockIndex,
    counts: new Map(),
    order: [],
    toolUseIds: new Set<string>(),
    hasWeld: false,
    weldedThinkingSeconds: seconds,
  };
  scratch.drawnThinkingMessageIndices.add(messageIndex);
}

/** tool_use 焊入件：累积计数并决定是否切新块（跨消息切 / 同消息 weld 升级）。 */
function absorbToolUse(
  block: { id: string; name: string },
  contentBlockIndex: number,
  messageIndex: number,
  scratch: ScratchState
): void {
  if (scratch.pending === null) {
    scratch.pending = createWeldPending(messageIndex, contentBlockIndex);
  } else if (scratch.pending.messageIndex !== messageIndex) {
    // 跨消息 → flush 上一条消息的 pending，新块起算。
    flushPending(scratch);
    scratch.pending = createWeldPending(messageIndex, contentBlockIndex);
  } else if (scratch.pending.weldedThinkingSeconds > 0) {
    // 同消息内焊入 —— thinking 段 + tool_use 共存 = welded。
    scratch.pending = { ...scratch.pending, hasWeld: true };
  }
  const pending = scratch.pending;
  if (!pending.counts.has(block.name)) pending.order.push(block.name);
  pending.counts.set(block.name, (pending.counts.get(block.name) ?? 0) + 1);
  pending.toolUseIds.add(block.id);
}

function createWeldPending(
  messageIndex: number,
  contentBlockIndex: number
): PendingAccumulator {
  return {
    messageIndex,
    contentBlockIndex,
    counts: new Map(),
    order: [],
    toolUseIds: new Set<string>(),
    hasWeld: true,
    weldedThinkingSeconds: 0,
  };
}

/** flush 累积 → 出块（无内容 → 不出块；标题空 → 不出块）。 */
function flushPending(scratch: ScratchState): void {
  const pending = scratch.pending;
  if (pending === null) return;
  const hasCounts = pending.counts.size > 0;
  if (!pending.hasWeld && !hasCounts && pending.weldedThinkingSeconds === 0) {
    // EXIT: 无累积内容（既无焊入件也无 thinking 段计入）→ 不画块。
    scratch.pending = null;
    return;
  }
  const { isStillRunning, lastRunningRun } = resolveLiveRunning(
    pending.toolUseIds,
    scratch.liveRuns
  );
  const title = composePendingTitle(pending, hasCounts, isStillRunning);
  if (title.length === 0) {
    scratch.pending = null;
    return;
  }
  scratch.blocks.push({
    anchor: {
      messageIndex: pending.messageIndex,
      contentBlockIndex: pending.contentBlockIndex,
    },
    title,
    slot:
      lastRunningRun !== undefined
        ? {
            kind: "tool-preview",
            text: formatRunningToolLine(lastRunningRun),
          }
        : { kind: "none" },
    live: isStillRunning,
  });
  scratch.pending = null;
}

/** 解析 pending 对应的 live running 状态（spec S4）：同 id 的 live run
 *  若命中 → 该块仍在演变、预览槽显示最后一件。 */
function resolveLiveRunning(
  toolUseIds: ReadonlySet<string>,
  liveRuns: ReadonlyArray<LiveToolRun>
): { isStillRunning: boolean; lastRunningRun: LiveToolRun | undefined } {
  const liveRunByToolUseId = new Map<string, LiveToolRun>();
  for (const run of liveRuns) {
    if (run.status !== "running") continue;
    if (toolUseIds.has(run.id)) {
      liveRunByToolUseId.set(run.id, run);
    }
  }
  return {
    isStillRunning: liveRunByToolUseId.size > 0,
    lastRunningRun: [...liveRunByToolUseId.values()].pop(),
  };
}

/** 块标题文本合成：thinking 时长段 + 焊入计数 + calling/called verb。 */
function composePendingTitle(
  pending: PendingAccumulator,
  hasCounts: boolean,
  isStillRunning: boolean
): string {
  const verb: "calling" | "called" =
    hasCounts && !isStillRunning ? "called" : "calling";
  return buildTitle(
    pending.weldedThinkingSeconds,
    pending.hasWeld && hasCounts,
    verb,
    hasCounts
      ? formatToolUseCounts(
          pending.order.map((name) => ({
            name,
            count: pending.counts.get(name) ?? 0,
          }))
        )
      : ""
  );
}
