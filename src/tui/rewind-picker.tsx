/** @jsxImportSource @opentui/react */
/**
 * src/tui/rewind-picker.tsx
 *
 * T6 (checkpoint-rewind): L3 锚点选择器。复用 modal.tsx 的 SelectModal /
 * ModalHost 渲染槽 + 行账 SSOT；宿主（app.tsx）持有选中索引 / 确认态状态，
 * 键路由走纯函数 `reduceRewindKey`（与权限 modal 的 reduceModalKey 同构）。
 *
 * 数据模型（spec RewindTarget）：
 *   - 锚点 = 0-based turn 索引 ∈ [1, turnCount−1]；keepTurns = 锚点 turn 索引
 *     （传给 rewindFile 的落点）。当前 turn（索引 == turnCount）不列出——
 *     回退到"此刻所在位置"是 no-op（fallback 规则 3）。
 *   - keepTurns=0 「回到会话起点」作为独立首条目（fallback 规则 4，破坏面
 *     最大，与其余锚点共用同一确认 gate）。
 *   - 与 file.checkpoints 按 turnIndex 合取 interruptedAt：命中快照的锚点显示
 *     中断时间戳，否则 ""——纯 conversation 回退，无 code 轴 / 文件恢复。
 *
 * 确认 gate（spec OQ1，选形态 a）：选中锚点 Enter → 进入确认行（Enter 确认
 * 执行 / Esc 返回选择），不新增第二层 modal，单行提示即确认面。
 */
import type { SessionFileV1 } from "../session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../harness/model-adapter/types.js";
import { splitTurns } from "../session-api/store/index.js";
import {
  selectModalRows,
  type ModalKeyEvent,
  type SelectModalContent,
} from "./modal.js";

/** 一个回退落点（spec RewindTarget 字段语义）。 */
export interface RewindTarget {
  readonly keepTurns: number;
  readonly userMessageText: string;
  readonly anchorTurnIndex: number;
  readonly anchoredAt: string;
}

/**
 * 从会话文件投影合法回退锚点。空会话 / 无完成 turn（splitTurns ≤ 1）→ 空数组
 * （L0 空态由宿主提示，零 store IO）。有 turn 时首条目 = 「回到会话起点」
 * （keepTurns 0）；随后按 0-based turn 索引 1..total-1 投影（keepTurns = 索引）。
 */
export function buildRewindTargets(
  file: SessionFileV1
): ReadonlyArray<RewindTarget> {
  const slices = splitTurns(file.messages);
  const total = slices.length;
  const targets: RewindTarget[] = [];
  if (total === 0) return targets;
  targets.push({
    keepTurns: 0,
    userMessageText: "回到会话起点",
    anchorTurnIndex: 0,
    anchoredAt: "",
  });
  for (let i = 1; i < total; i++) {
    const slice = slices[i]!;
    targets.push({
      keepTurns: i,
      userMessageText: firstUserText(file.messages[slice.start]),
      anchorTurnIndex: i,
      anchoredAt: anchoredAtFor(file, i),
    });
  }
  return targets;
}

/** 锚点用户消息首个 text block（trim + 截 80，同 extractSummary 语义）。 */
function firstUserText(msg: AnthropicNativeMessage): string {
  const block = msg.content.find((b) => b.type === "text");
  return block !== undefined && block.type === "text"
    ? block.text.trim().slice(0, 80)
    : "";
}

/** 与 file.checkpoints 按 turnIndex 合取 interruptedAt（无快照 → ""）。 */
function anchoredAtFor(file: SessionFileV1, turnIndex: number): string {
  const record = (file.checkpoints ?? []).find(
    (c) => c.turnIndex === turnIndex
  );
  return record?.interruptedAt ?? "";
}

/** ISO → "YYYY-MM-DD HH:mm"（展示用；非法 / 空 → ""）。 */
function fmtAnchored(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * 选择器 / 确认行的 SelectModalContent（渲染与行账单一来源）。确认态选项
 * 为展示性 [确认回退 / 取消]——实际键路由由 reduceRewindKey 直接 Enter 执行 /
 * Esc 返回，不依赖选项选中索引。
 */
export function rewindPickerContent(
  targets: ReadonlyArray<RewindTarget>,
  selectedIndex: number,
  confirming: boolean
): SelectModalContent {
  if (confirming) {
    const t = targets[selectedIndex];
    const keep = t?.keepTurns ?? 0;
    const desc =
      t === undefined
        ? ""
        : keep === 0
          ? "将清空全部消息与检查点，会话回到起点。磁盘真截断，不可恢复。"
          : `将截断会话到第 ${keep} 轮边界：保留前 ${keep} 轮，之后的消息与检查点全部移除（不可恢复）。`;
    return {
      title: "确认回退？",
      description: desc,
      options: [
        { value: "execute", label: "确认回退" },
        { value: "cancel", label: "取消" },
      ],
      hint: "Enter 确认回退 · Esc 返回",
    };
  }
  return {
    title: "回退到更早的回合",
    description: "选择回退锚点；回退后会话被磁盘截断（不可恢复）。",
    options: targets.map((t) => {
      const time = t.anchoredAt !== "" ? ` · ${fmtAnchored(t.anchoredAt)}` : "";
      const label =
        t.keepTurns === 0 ? "回到会话起点" : `保留前 ${t.keepTurns} 轮`;
      const text = (t.userMessageText || "(无文本)").slice(0, 40);
      return { value: String(t.keepTurns), label, description: text + time };
    }),
    hint: "↑↓ 选择锚点 · Enter 确认 · Esc 关闭",
  };
}

/** 选择器占行（chrome 行账入账用；确认态选中索引固定在首选项）。 */
export function rewindModalRows(
  targets: ReadonlyArray<RewindTarget>,
  cols: number,
  selectedIndex: number,
  confirming: boolean
): number {
  const content = rewindPickerContent(targets, selectedIndex, confirming);
  return selectModalRows(content, cols, confirming ? 0 : selectedIndex);
}

/** 键路由决策结果。 */
export type RewindKeyAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "confirm" }
  | { readonly type: "execute"; readonly keepTurns: number }
  | { readonly type: "cancel" }
  | { readonly type: "ignore" };

/**
 * 选择器键路由纯函数（宿主 useKeyboard 消费）：
 *  - 选择态：↑/↓ clamp 移动；Enter → confirm（进入确认行）；Esc → cancel（关）；
 *  - 确认态：Enter → execute（回退执行）；Esc → cancel（返回选择）；
 *  - ctrl/meta 组合键 → ignore。
 */
export function reduceRewindKey(
  event: ModalKeyEvent,
  opts: {
    readonly targets: ReadonlyArray<RewindTarget>;
    readonly selectedIndex: number;
    readonly confirming: boolean;
  }
): RewindKeyAction {
  const { targets, selectedIndex, confirming } = opts;
  const { key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.escape) return { type: "cancel" };
  if (confirming) {
    if (key.return) {
      const t = targets[selectedIndex];
      return t !== undefined
        ? { type: "execute", keepTurns: t.keepTurns }
        : { type: "ignore" };
    }
    return { type: "ignore" };
  }
  if (key.upArrow) {
    return { type: "move", index: Math.max(0, selectedIndex - 1) };
  }
  if (key.downArrow) {
    return {
      type: "move",
      index: Math.min(targets.length - 1, selectedIndex + 1),
    };
  }
  if (key.return) {
    const t = targets[selectedIndex];
    return t !== undefined ? { type: "confirm" } : { type: "ignore" };
  }
  return { type: "ignore" };
}
