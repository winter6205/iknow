/** @jsxImportSource @opentui/react */
/**
 * src/tui/rewind-picker.tsx
 *
 * L3 锚点选择器。#624：锚点 = JSONL 用户消息；确认后把 head 指到该 turn
 * 的结束事件（null = 首条之前）。旧链保留，确认文案不再声称截断。
 */
import type { SessionFileV1 } from "../session-api/store/schema.js";
import {
  buildRewindTargetsFromLog,
  parseSessionJsonl,
  sessionFileToJsonl,
  type LedgerRewindTarget,
} from "../session-api/store/index.js";
import {
  selectModalRows,
  type ModalKeyEvent,
  type SelectModalContent,
} from "./modal.js";

export type RewindTarget = LedgerRewindTarget;

/** 线性 SessionFile 投影（无跳过分支）。TUI 打开 picker 时走 store 全量账本。 */
export function buildRewindTargets(
  file: SessionFileV1
): ReadonlyArray<RewindTarget> {
  return buildRewindTargetsFromLog(parseSessionJsonl(sessionFileToJsonl(file)));
}

export function rewindPickerContent(
  targets: ReadonlyArray<RewindTarget>,
  selectedIndex: number,
  confirming: boolean
): SelectModalContent {
  if (confirming) {
    const t = targets[selectedIndex];
    const desc =
      t === undefined
        ? ""
        : t.head === null
          ? "恢复到 ［首条用户消息］ 之前：当前可见历史清空。账本中的事件仍保留，可再选中回退。"
          : `将当前头指到 ［${anchorTextForConfirm(t)}］：发给模型的是这句往回的祖先链。其后回复仍在账本中，可再 rewind。`;
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
    description: "选择一条用户消息；回退后改的是头指针，旧链留在同一账本。",
    options: targets.map((t, i) => {
      const time = t.anchoredAt !== "" ? ` · ${fmtAnchored(t.anchoredAt)}` : "";
      const text = (t.userMessageText || "(无文本)").slice(0, 40);
      return {
        value: t.head ?? `before-first-${i}`,
        label: text,
        description: time,
      };
    }),
    hint: "↑↓ 选择锚点 · Enter 确认 · Esc 关闭",
  };
}

function anchorTextForConfirm(t: RewindTarget): string {
  if (t.head === null) return t.userMessageText || "首条用户消息";
  return t.userMessageText || "(无文本)";
}

function fmtAnchored(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export function rewindModalRows(
  targets: ReadonlyArray<RewindTarget>,
  cols: number,
  selectedIndex: number,
  confirming: boolean
): number {
  const content = rewindPickerContent(targets, selectedIndex, confirming);
  return selectModalRows(content, cols, confirming ? 0 : selectedIndex);
}

export type RewindKeyAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "confirm" }
  | { readonly type: "execute"; readonly head: string | null }
  | { readonly type: "cancel" }
  | { readonly type: "ignore" };

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
        ? { type: "execute", head: t.head }
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
