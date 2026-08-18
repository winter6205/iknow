/** @jsxImportSource @opentui/react */
/**
 * src/tui/list-view.tsx
 *
 * #343 T4（自 archive/tui-ink/src/list-view.tsx 迁移 ink → OpenTUI，语义不变）：
 * 会话列表视图（Q4a/Q4b 裁决）：
 *  - 列内容 = title（首条 user 前 80 字符，#120 SSOT；#467 改名自 summary）
 *    + 相对时间 + 运行指示；数据源 = SessionStore.list() 的 title 字段，不做
 *    per-id 重读（SC 13）；
 *  - updatedAt 降序（store.list() 已排序）；
 *  - 首行 `+ 新建会话` 伪条目：Enter = /new 等价（Q4b）；
 *  - ↑↓ 选择，Enter 打开，Esc 返回聊天视图（Q3 列表纯导航；本视图内追加
 *    搜索输入，见下）；
 *  - 删除入口不暴露（D1 安全边界）。
 *  - running-bg 会话行内静态 `[运行中]` 暗色标记（与前台 spinner 区分）。
 *
 * —— 会话超限修复（2026-08-09，迁移后保留）——
 *   1. 顶部搜索框：直接键入即过滤（按 title / lastFinalText 子串匹配，
 *      不区分大小写；清空 = 全量）。
 *   2. 视口窗口：只渲染 `rows` 预算内的行（顶部搜索框 + 表头 + 行数预算），
 *      超出部分不渲染，杜绝整帧溢出。
 *   3. 行级滚动：↑↓ 移到视口边缘则翻页（k9s 风格）；PgUp/PgDn/Home/End
 *      直接翻页/跳顶/跳底。搜索词变化时 clamp 滚动到安全范围。
 *
 * 键输入：OpenTUI `useKeyboard`（KeyEvent.name 判别）替代 ink `useInput`。
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type KeyEvent } from "@opentui/core";
import type { SessionListEntry } from "../session-api/store/session-store.js";
import { tuiPalette } from "./theme.js";
import { clipOneLine } from "./tool-summary.js";

export interface TuiListEntry extends SessionListEntry {
  /** 该会话当前在 TUI 内是否 running-bg（列表行静态标记用）。 */
  readonly runningBg: boolean;
}

/** 相对时间（updatedAt → 「3 分钟前」风格，无 emoji）。 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = Math.max(0, now.getTime() - then);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(then).toISOString().slice(0, 10);
}

export interface ListViewProps {
  readonly entries: ReadonlyArray<TuiListEntry>;
  readonly cols: number;
  /** 列表视口可用行数（顶部搜索框 + 表头 + 行数预算；由 app 传入，避免
   *   ListView 自己量终端）。缺省 16（单测无 rows 环境）。 */
  readonly rows?: number;
  /** 选中首行伪条目或某个会话 Enter → 传 index（0 = 新建）。 */
  readonly onOpen: (index: number) => void;
  readonly onBack: () => void;
}

/** 行内容匹配（搜索过滤谓词）：title / lastFinalText 子串，不区分大小写。
 *  exported 供单测直接断言。 */
export function listEntryMatches(
  entry: SessionListEntry,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.title.toLowerCase().includes(q) ||
    entry.lastFinalText.toLowerCase().includes(q)
  );
}

/** 过滤控制字符（原 components.tsx stripNonPrintable 的私迁移：components.tsx
 *  属 T6 共享文件，T4 不动它 —— 仅本视图自用）。 */
function stripNonPrintable(input: string): string {
  return [...input]
    .filter((c) => c.charCodeAt(0) >= 32 || c === "\t")
    .filter((c) => c !== "\x7f")
    .join("");
}

export function ListView(props: ListViewProps): ReactNode {
  const pal = tuiPalette;
  // 行账 SSOT（#268 同类帧高溢出防线）：整帧渲染行数必须 ≤ rowsBudget。
  //  搜索框 1 行 + 表头 2 行（标题 + marginBottom 空行） + 滚动指示预留 2
  // （↑/↓ 各 1） = 固定 chrome 5 行。视口行数 = 预算 - 5，最坏情况（双指示
  // 全显）= 1+2+viewHeight+2 = rowsBudget 恰好贴边，永不溢出。指示行预留在
  // 预算内而非动态收缩视口：滚动时视口高度恒定，不出现内容跳变。
  const rowsBudget = Math.max(6, props.rows ?? 16);
  const viewHeight = Math.max(1, rowsBudget - 5);
  // 搜索输入（本视图内第二输入框；Esc 清空搜索而非直接返回，二次 Esc 返回
  // 聊天视图——与「纯导航」的原意保持一致，搜索是列表的辅助能力）。
  const [query, setQuery] = useState("");
  // 光标 + 视口顶合并为单一原子状态：OpenTUI 快速连键会在同一渲染批内派发
  // 多个 KeyEvent，分离 state 的函数式更新会互读旧快照、丢失边缘滚动步长；
  // 原子对象在批内逐步复合仍正确（序列键语义与归档版一致）。
  // 首行伪条目占 index 0；光标初始在伪条目上（新建是高频动作）。
  // scrollTop = 视口顶部行的全局 index（0 = 伪条目）。scroll 0 时伪条目固定可见。
  const [nav, setNav] = useState({ cursor: 0, scrollTop: 0 });
  const cursor = nav.cursor;
  const scrollTop = nav.scrollTop;

  // 过滤后的有效条目（伪条目恒在 index 0）。
  const filtered = useMemo(
    () => props.entries.filter((e) => listEntryMatches(e, query)),
    [props.entries, query]
  );
  const total = filtered.length + 1; // index 0 = 伪条目

  // 搜索结果变化 → 光标与滚动都 clamp 回安全范围（总行数变化时防越界）。
  useEffect(() => {
    const maxScroll = Math.max(0, total - viewHeight);
    setNav((v) => ({
      cursor: Math.min(v.cursor, total - 1),
      scrollTop: Math.min(v.scrollTop, maxScroll),
    }));
  }, [total, viewHeight]);

  useKeyboard((e: KeyEvent) => {
    // 导航键优先匹配；可打印字符 / backspace 走搜索输入。
    if (e.ctrl || e.meta) return;
    if (e.name === "return") {
      props.onOpen(cursor);
      return;
    }
    if (e.name === "escape") {
      if (query.length > 0) {
        setQuery("");
        return;
      }
      props.onBack();
      return;
    }
    if (e.name === "up") {
      setNav((v) => {
        const next = v.cursor - 1;
        if (next < 0) return v; // 已在顶 → no-op
        // 出了视口上缘 → 视口上移一行
        const scrollTopNext =
          next < v.scrollTop ? v.scrollTop - 1 : v.scrollTop;
        return { cursor: next, scrollTop: scrollTopNext };
      });
      return;
    }
    if (e.name === "down") {
      setNav((v) => {
        const next = v.cursor + 1;
        if (next >= total) return v; // 已在底 → no-op
        // 出了视口下缘 → 视口下移一行
        const scrollTopNext =
          next >= v.scrollTop + viewHeight ? v.scrollTop + 1 : v.scrollTop;
        return { cursor: next, scrollTop: scrollTopNext };
      });
      return;
    }
    if (e.name === "pageup") {
      setNav((v) => ({
        ...v,
        scrollTop: Math.max(0, v.scrollTop - viewHeight),
      }));
      return;
    }
    if (e.name === "pagedown") {
      setNav((v) => ({
        ...v,
        scrollTop: Math.min(
          Math.max(0, total - viewHeight),
          v.scrollTop + viewHeight
        ),
      }));
      return;
    }
    if (e.name === "home") {
      setNav({ cursor: 0, scrollTop: 0 });
      return;
    }
    if (e.name === "end") {
      const maxScroll = Math.max(0, total - viewHeight);
      setNav({ cursor: total - 1, scrollTop: maxScroll });
      return;
    }
    if (e.name === "backspace" || e.name === "delete") {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    // 可打印字符 → 追加到搜索词（箭头 / 功能键 name 长度 > 1，过滤后为空）。
    const printable = stripNonPrintable(
      typeof e.name === "string" ? e.name : e.sequence
    );
    if (printable.length > 0) setQuery((q) => q + printable);
  });

  const summaryWidth = Math.max(10, props.cols - 24);
  const renderSummary = (s: string): string => clipOneLine(s, summaryWidth);

  // 视口切片：只渲染 [scrollTop, scrollTop+viewHeight) 的全局行。
  const visible: number[] = [];
  for (let i = scrollTop; i < scrollTop + viewHeight && i < total; i++) {
    visible.push(i);
  }
  const atTop = scrollTop === 0;
  const atBottom = scrollTop + viewHeight >= total;

  const rows: ReactNode[] = [];
  visible.forEach((i) => {
    const selected = i === cursor;
    const marker = selected ? ">" : " ";
    if (i === 0) {
      rows.push(
        <text key="new" fg={selected ? pal.accent : pal.dim}>
          {marker} + 新建会话
        </text>
      );
      return;
    }
    const entry = filtered[i - 1];
    if (!entry) return;
    const time = relativeTime(entry.updatedAt);
    rows.push(
      <text key={entry.conversation_id} fg={selected ? pal.accent : pal.text}>
        {marker} {renderSummary(entry.title || "(空)")}
        <span fg={pal.dim}> {time}</span>
        {entry.runningBg ? <span fg={pal.dim}> [运行中]</span> : ""}
      </text>
    );
  });

  return (
    <box flexDirection="column">
      {/* 搜索框：占 1 行；键入即过滤，内容为空显示占位提示。 */}
      <text fg={pal.dim}>
        ❯ 搜索会话{" "}
        <span fg={query.length > 0 ? pal.text : pal.dim}>
          {query.length > 0 ? query : "（直接输入过滤，Esc 清空）"}
        </span>
      </text>
      <box flexDirection="row" marginBottom={1}>
        <text fg={pal.text} attributes={TextAttributes.BOLD}>
          会话列表
        </text>
        <text fg={pal.dim}> ↑↓ 选择 · Enter 打开 · Esc 返回 · 键入搜索</text>
      </box>
      {!atTop && <text fg={pal.dim}>↑ 更多（{scrollTop}）…</text>}
      {rows}
      {!atBottom && <text fg={pal.dim}>↓ 更多…</text>}
      {filtered.length === 0 && (
        <box marginTop={1}>
          <text fg={pal.dim}>
            {query.length > 0
              ? "无匹配会话；Esc 清空搜索"
              : "本项目暂无会话；Enter 新建"}
          </text>
        </box>
      )}
    </box>
  );
}
