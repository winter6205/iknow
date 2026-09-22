/** @jsxImportSource @opentui/react */
/**
 * src/tui/rewind-picker.tsx
 *
 * L3 anchor picker. An anchor = a user message on the current head chain;
 * after confirming, head points to that message's parent (back to before it
 * was sent). The old chain is kept; the picker does not list skipped
 * branches by default. The confirm step is where transcript rewind and
 * workspace restore (ADR-0121) split apart: three actions, one Enter.
 */
import type { SessionFileV1 } from "../session-api/store/schema.js";
import {
  buildRewindTargetsFromLog,
  parseSessionJsonl,
  sessionFileToJsonl,
  type LedgerRewindTarget,
} from "../session-api/store/index.js";
import type {
  RewindCodeRestoreResult,
  RewindCodeRestoreSkip,
} from "../session-api/contract.js";
import {
  selectModalRows,
  type ModalKeyEvent,
  type SelectModalContent,
  type SelectOption,
} from "./modal.js";

export type RewindTarget = LedgerRewindTarget;

/** Linear SessionFile projection (no skipped branches). When the TUI opens the
 *  picker it follows the store's current head chain. */
export function buildRewindTargets(
  file: SessionFileV1
): ReadonlyArray<RewindTarget> {
  return buildRewindTargetsFromLog(parseSessionJsonl(sessionFileToJsonl(file)));
}

/** Confirm row: transcript head movement and workspace restore are separately
 *  choosable (ADR-0121), so the two positive rows differ only in `restoreCode`.
 *  The flag rides on the row instead of being re-derived from an index in the
 *  reducer, and cancel is the only row that never rewinds. */
type RewindConfirmOption = SelectOption & { readonly restoreCode: boolean };

const CANCEL_VALUE = "cancel";

export const REWIND_CONFIRM_OPTIONS: ReadonlyArray<RewindConfirmOption> =
  Object.freeze([
    Object.freeze({
      value: "restore_code",
      label: "回退对话并恢复代码",
      description: "被放弃回合写过的文件回到改前字节",
      restoreCode: true,
    }),
    Object.freeze({
      value: "transcript_only",
      label: "仅回退对话",
      description: "工作区文件保持现状",
      restoreCode: false,
    }),
    Object.freeze({
      value: CANCEL_VALUE,
      label: "取消",
      description: "不做任何改动，关闭回退选择",
      restoreCode: false,
    }),
  ]);

function confirmContent(anchor: RewindTarget | undefined): SelectModalContent {
  return {
    title: "确认回退？",
    description:
      anchor === undefined
        ? ""
        : `恢复到 ［${anchorTextForConfirm(anchor)}］ 之前：当前可见历史不含这句。账本中的事件仍保留。`,
    options: REWIND_CONFIRM_OPTIONS,
    hint: "↑↓ 选择操作 · Enter 执行 · Esc 关闭",
  };
}

export function rewindPickerContent(
  targets: ReadonlyArray<RewindTarget>,
  selectedIndex: number,
  confirming: boolean
): SelectModalContent {
  if (confirming) {
    return confirmContent(targets[selectedIndex]);
  }
  return {
    title: "回退到更早的回合",
    description:
      "选择一条用户消息；回退后从这句重新开始。账本旧链保留，面板只列当前可见历史。",
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

/** `anchorIndex` is the anchor whose text the confirm description quotes;
 *  `rowIndex` is the row the modal highlights — the anchor row while selecting,
 *  an action row while confirming (the caller owns which list is on screen). */
export function rewindModalRows(
  targets: ReadonlyArray<RewindTarget>,
  cols: number,
  anchorIndex: number,
  confirming: boolean,
  rowIndex: number
): number {
  return selectModalRows(
    rewindPickerContent(targets, anchorIndex, confirming),
    cols,
    rowIndex
  );
}

export type RewindKeyAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "confirm" }
  | {
      readonly type: "execute";
      readonly head: string | null;
      readonly restoreCode: boolean;
    }
  | { readonly type: "cancel" }
  | { readonly type: "ignore" };

/** Enter inside the confirm modal: the highlighted row decides whether the
 *  rewind happens and whether code goes back with it. Cancel needs no anchor;
 *  a positive row without one (list raced to empty) does nothing. */
function reduceConfirmEnter(
  confirmIndex: number,
  anchor: RewindTarget | undefined
): RewindKeyAction {
  const option = REWIND_CONFIRM_OPTIONS[confirmIndex];
  if (option === undefined) return { type: "ignore" };
  if (option.value === CANCEL_VALUE) return { type: "cancel" };
  return anchor !== undefined
    ? { type: "execute", head: anchor.head, restoreCode: option.restoreCode }
    : { type: "ignore" };
}

function reduceConfirmingKey(
  key: ModalKeyEvent["key"],
  confirmIndex: number,
  anchor: RewindTarget | undefined
): RewindKeyAction {
  const last = REWIND_CONFIRM_OPTIONS.length - 1;
  if (key.upArrow) {
    return { type: "move", index: Math.max(0, confirmIndex - 1) };
  }
  if (key.downArrow) {
    return { type: "move", index: Math.min(last, confirmIndex + 1) };
  }
  if (key.return) return reduceConfirmEnter(confirmIndex, anchor);
  return { type: "ignore" };
}

export function reduceRewindKey(
  event: ModalKeyEvent,
  opts: {
    readonly targets: ReadonlyArray<RewindTarget>;
    readonly selectedIndex: number;
    readonly confirming: boolean;
    /** Row inside `REWIND_CONFIRM_OPTIONS`; only read while confirming. */
    readonly confirmIndex: number;
  }
): RewindKeyAction {
  const { targets, selectedIndex, confirming, confirmIndex } = opts;
  const { key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.escape) return { type: "cancel" };
  if (confirming) {
    return reduceConfirmingKey(key, confirmIndex, targets[selectedIndex]);
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

/** Why the restore guard left a path alone — the operator tells their own later
 *  edit (drift) apart from a moved worktree (root_identity) from here. */
const SKIP_REASON_LABELS: Readonly<
  Record<RewindCodeRestoreSkip["reason"], string>
> = {
  drift: "文件已被后续改动",
  root_identity: "工作区根已变化",
};

function joinedSkippedPaths(
  skipped: ReadonlyArray<RewindCodeRestoreSkip>,
  reason: RewindCodeRestoreSkip["reason"]
): string | undefined {
  const paths = skipped
    .filter((entry) => entry.reason === reason)
    .map((entry) => entry.relPath);
  return paths.length > 0 ? paths.join("、") : undefined;
}

/** What a restore-code rewind actually did to the workspace, as notice lines
 *  (ADR-0121): restored count plus every refused path and its reason. A report
 *  with nothing restored and nothing skipped is a real outcome — the abandoned
 *  segment simply carried no preimages — so it still says so. */
export function codeRestoreNoticeLines(
  report: RewindCodeRestoreResult
): ReadonlyArray<string> {
  const skipLine = (reason: RewindCodeRestoreSkip["reason"]): string[] => {
    const paths = joinedSkippedPaths(report.skipped, reason);
    return paths === undefined
      ? []
      : [`未恢复（${SKIP_REASON_LABELS[reason]}）：${paths}`];
  };
  return [
    report.restored.length > 0
      ? `代码恢复：写回 ${report.restored.length} 个文件。`
      : "代码恢复：被放弃的回合没有可写回的前像。",
    ...skipLine("drift"),
    ...skipLine("root_identity"),
  ];
}
