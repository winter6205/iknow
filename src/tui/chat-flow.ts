/**
 * src/tui/chat-flow.ts
 *
 * #298 T5 ACR line-cap 拆分：chat-view.tsx「仅做 JSX 组装」的纯内容流机器
 * （行账 / 窗口数学）抽到这里，chat-view.tsx 行数回到预算内（≤ 300）。
 * 纯函数 + 类型，不依赖 react / ink。
 *
 * 内容：
 *  - `tailSlot`：tail（live 工具 + ask + spinner + 草稿）行账；
 *  - `computeMeasured`：消息 flat 行 + 块坐标 + 末条尾 margin 收口；
 *  - `computeWindow`：朴素滚动窗口数学（startRow/endRow/contentRows）；
 *  - `flatContentLines`：#238 选区文本提取的内容流 flat 拼接。
 */
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  liveToolPreviewRows,
  liveToolPreviewTextLines,
} from "./live-tool-preview.js";
import { messageRender, type BlockRowSpan } from "./message-rows.js";
import { markdownToLines } from "./markdown-lines.js";
import type { TuiSessionState } from "./session-state.js";

/** live 工具行 + ask 行 + spinner 占位也占行；用于总行数估计。 */
export interface TailSlot {
  readonly liveToolRows: number;
  readonly askRow: number; // 0 / 1
  readonly spinnerRow: number; // 0 / 1
  readonly thinkingDraftRows: number;
  readonly draftRows: number;
  /** 实际渲染行数合计（含「后随兄弟」时的 marginBottom）。 */
  readonly total: number;
}

/**
 * tail 行账（精确）：各元素按渲染顺序排布，marginBottom 仅在后随兄弟存在
 * 时计 1（ink 折叠末尾子元素 margin）。draft 行数 = markdownToLines 实测。
 *
 * T3: thinking 草稿排在 answer 草稿之前（与 chat-view JSX 渲染顺序一致）；
 * 折叠态永远 = 1 行摘要（[思考] 思考中…），展开态走 markdownToLines 实测。
 * `thinkingExpanded` 必传 — 调用方从 ChatViewProps 注入，不引入新 React 路径。
 *
 * T5: liveToolRuns 与 liveToolLines 同块渲染（结构化运行状态先, legacy 字符串
 * 后)，行账合并。已完成条目的内容预览行走 liveToolPreviewRows 单源（红绿 diff
 * 折叠后可见行），与 liveToolPreviewBox 渲染逐行一致,防行账漂移。
 */
export function tailSlot(
  liveToolLines: ReadonlyArray<string>,
  askLine: string | undefined,
  running: boolean,
  thinkingDraft: string | undefined,
  draft: string | undefined,
  cols: number,
  thinkingExpanded: boolean,
  liveToolRuns: ReadonlyArray<LiveToolRun> = []
): TailSlot {
  // 结构化运行状态每条目 1 行 + 已完成条目 diff 预览行（与渲染同源）。
  const previewRows = liveToolRuns.reduce(
    (n, run) => n + liveToolPreviewRows(run, cols),
    0
  );
  const liveToolRows = liveToolLines.length + liveToolRuns.length + previewRows;
  const askRow = askLine !== undefined ? 1 : 0;
  const spinnerRow = running ? 1 : 0;
  const hasThinking =
    running && thinkingDraft !== undefined && thinkingDraft.length > 0;
  // 折叠态固定 1 行([思考] 思考中…);展开态走 markdownToLines 实测。
  const thinkingDraftRows = hasThinking
    ? thinkingExpanded
      ? markdownToLines(thinkingDraft!, cols).length
      : 1
    : 0;
  const draftRows =
    draft !== undefined && draft.length > 0
      ? markdownToLines(draft, cols).length
      : 0;
  // 渲染顺序：liveTool → ask → thinkingDraft → draft → spinner。
  const liveToolMargin =
    askRow + thinkingDraftRows + draftRows + spinnerRow > 0 ? 1 : 0;
  const askMargin = thinkingDraftRows + draftRows + spinnerRow > 0 ? 1 : 0;
  const thinkingMargin = draftRows + spinnerRow > 0 ? 1 : 0;
  const draftMargin = spinnerRow > 0 ? 1 : 0;
  const total =
    liveToolRows +
    liveToolMargin +
    askRow +
    askMargin +
    thinkingDraftRows +
    thinkingMargin +
    draftRows +
    draftMargin +
    spinnerRow;
  return {
    liveToolRows,
    askRow,
    spinnerRow,
    thinkingDraftRows,
    draftRows,
    total,
  };
}

/** 一条已测消息及其 flat 物理行 / 块坐标的窗口坐标。 */
export interface Measured {
  readonly message: AnthropicNativeMessage;
  readonly lines: ReadonlyArray<string>;
  readonly blocks: ReadonlyArray<BlockRowSpan>;
  /** 内容行 + self margin + 1（外层 margin）= 非末尾位置渲染高度。 */
  readonly totalRows: number;
  /** 该消息在内容流中的首行行号（0-based；banner 段从 0 起算）。 */
  readonly startRow: number;
}

/**
 * 消息 flat 行 + 块坐标（含 banner 偏移）。末条消息尾 margin 收口：tail 为空
 * 时重测最后一条（pop 末尾 self margin），`lastTrimmed = true` 时全可见路径的
 * MessageBlocks 也要抹掉最后一个块的 marginBottom（同源）。
 */
export function computeMeasured(args: {
  readonly session: TuiSessionState;
  readonly cols: number;
  readonly bannerRows: number;
  readonly tailRows: number;
  readonly thinkingExpanded?: boolean;
}): {
  readonly measured: ReadonlyArray<Measured>;
  readonly messageCursor: number;
  readonly lastTrimmed: boolean;
} {
  const measured: Measured[] = [];
  let messageCursor = 0;
  for (const m of args.session.messages) {
    const mm = messageRender(m, args.cols, {
      thinkingExpanded: args.thinkingExpanded,
    });
    if (mm.totalRows === 0) continue;
    measured.push({
      message: mm.message,
      lines: mm.lines,
      blocks: [...mm.blocks],
      totalRows: mm.totalRows,
      startRow: args.bannerRows + messageCursor,
    });
    messageCursor += mm.totalRows;
  }
  let lastTrimmed = false;
  if (args.tailRows === 0 && measured.length > 0) {
    const lastM = measured[measured.length - 1]!;
    const trimmed = messageRender(lastM.message, args.cols, {
      thinkingExpanded: args.thinkingExpanded,
      omitTrailingSelfMargin: true,
    });
    lastTrimmed = trimmed.totalRows < lastM.totalRows;
    if (lastTrimmed) {
      measured[measured.length - 1] = {
        ...lastM,
        lines: trimmed.lines,
        blocks: [...trimmed.blocks],
        totalRows: trimmed.totalRows,
      };
      messageCursor -= lastM.totalRows - trimmed.totalRows;
    }
  }
  return { measured, messageCursor, lastTrimmed };
}

/**
 * 朴素滚动窗口数学（2026-08-07 定稿：用户「第二种」，去所有折叠/指示器）。
 * 语义：banner + 消息 + tail 是同一内容流。`scrollRows` = 向上翻了多少物理行。
 * 窗口固定高度 = viewport。scroll=0 时窗口底 = 内容底（auto-follow）；
 * scroll>0 时窗口上移 scroll 行。viewport <= 0 → 无限视口（不裁剪）。
 */
export function computeWindow(args: {
  readonly bannerRows: number;
  readonly messageCursor: number;
  readonly tailRows: number;
  readonly scrollRows?: number;
  readonly viewportRows?: number;
}): {
  readonly startRow: number;
  readonly endRow: number;
  readonly contentRows: number;
} {
  const requestedScroll = Math.max(0, args.scrollRows ?? 0);
  const viewport = args.viewportRows ?? 0;
  const unlimited = viewport <= 0;
  const contentRows = args.bannerRows + args.messageCursor + args.tailRows;
  const maxScroll = unlimited
    ? 0
    : Math.max(0, contentRows - Math.max(1, viewport));
  const scroll = Math.min(requestedScroll, maxScroll);
  const endRow = unlimited ? contentRows : contentRows - scroll;
  const startRow = unlimited ? 0 : Math.max(0, endRow - viewport);
  return { startRow, endRow, contentRows };
}

/** margin 占位（与 message-rows.ts MARGIN_LINE 一致）。 */
const MARGIN_LINE_CHAT = " ";

/**
 * #238：把当前 ChatView 内容流（banner + 消息 flat 行 + tail 行）拼成一份
 * flat 字符串数组（行号即内容行号 0-based）。用于 extractSelectionText：
 *  - banner 段占 [0, bannerLines.length)；
 *  - 消息段按 measure 顺序拼接（messageRender.lines 与全可见路径逐行一致）；
 *  - tail 行（liveToolRuns + liveToolLines + ask + thinkingDraft + draft）
 *    按 ChatView JSX 渲染顺序追加（spinner 是 1 行非字符 "<spinner>"，留空）。
 *
 * 调用方必须保证本函数与 ChatView JSX 行账同步；只读 SessionState props，
 * 不接受 props.selection。
 */
export function flatContentLines(args: {
  readonly bannerLines: ReadonlyArray<string>;
  readonly session: TuiSessionState;
  readonly cols: number;
  readonly liveToolLines: ReadonlyArray<string>;
  readonly liveToolRuns: ReadonlyArray<LiveToolRun>;
  readonly askLine: string | undefined;
  readonly draftsMasked: string;
  readonly thinkingDraftMasked: string;
  readonly thinkingExpanded: boolean;
}): ReadonlyArray<string> {
  const running = args.session.runState === "running-fg";
  const tail = tailSlot(
    args.liveToolLines,
    args.askLine,
    running,
    running ? args.thinkingDraftMasked : undefined,
    running ? args.draftsMasked : undefined,
    args.cols,
    args.thinkingExpanded,
    args.liveToolRuns
  );
  const tailTotal = tail.total;
  const out: string[] = [];
  for (const ln of args.bannerLines) out.push(ln);
  // 镜像 ChatView 末条消息尾 margin 收口：tail 为空时最后一条非空消息 pop
  // 末尾 self margin（行账同源，选区坐标映射才不错位）。
  const renders = args.session.messages.map((m) =>
    messageRender(m, args.cols, { thinkingExpanded: args.thinkingExpanded })
  );
  if (tailTotal === 0) {
    for (let i = renders.length - 1; i >= 0; i--) {
      const r = renders[i]!;
      if (r.lines.length === 0) continue;
      renders[i] = messageRender(r.message, args.cols, {
        thinkingExpanded: args.thinkingExpanded,
        omitTrailingSelfMargin: true,
      });
      break;
    }
  }
  for (const mm of renders) {
    for (const ln of mm.lines) out.push(ln);
    if (mm.lines.length > 0) out.push(MARGIN_LINE_CHAT);
  }
  // 目标长度 = banner + 消息行账 + tail.total；tail 的文本行先实推，
  // margin / spinner 占位行由末尾补齐（长度对齐 ChatView contentRows）。
  const target = out.length + tailTotal;
  for (const run of args.liveToolRuns) {
    for (const ln of liveToolPreviewTextLines(run, args.cols)) {
      out.push(ln);
    }
  }
  for (const ln of args.liveToolLines) out.push(ln);
  if (args.askLine !== undefined) out.push(args.askLine);
  if (running && args.thinkingDraftMasked.length > 0) {
    if (args.thinkingExpanded) {
      for (const ln of markdownToLines(args.thinkingDraftMasked, args.cols)) {
        out.push(ln);
      }
    } else {
      out.push("[思考] 思考中…");
    }
  }
  if (running && args.draftsMasked.length > 0) {
    for (const ln of markdownToLines(args.draftsMasked, args.cols)) {
      out.push(ln);
    }
  }
  // tail 与 ChatView tailSlot 行账对齐：spinner 1 行 + 各 margin 行以占位补齐，
  // 保证 flatContentLines 长度 === ChatView 的 contentRows（窗口映射才一致）。
  while (out.length < target) out.push(MARGIN_LINE_CHAT);
  return out;
}
