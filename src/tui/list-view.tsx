/** @jsxImportSource @opentui/react */
/**
 * src/tui/list-view.tsx
 *
 * Session list view:
 *  - column content = title (first 80 chars of the first user message, the
 *    SessionStore SSOT) + relative time + running indicator; data source =
 *    the title field from SessionStore.list(), with no per-id re-read;
 *  - updatedAt descending (store.list() is already sorted);
 *  - the first row `+ 新建会话` is a pseudo-entry: Enter ≡ /new;
 *  - ↑↓ select, Enter opens, Esc returns to the chat view (the list is pure
 *    navigation; the in-view search input is described below);
 *  - no delete entry is exposed (safety boundary).
 *  - running-bg sessions get a static dim `[运行中]` inline marker
 *    (distinct from the foreground spinner).
 *
 * Overflow fixes for large session counts:
 *   1. Top search box: typing filters immediately (case-insensitive substring
 *      on title / lastFinalText; clearing = full list).
 *   2. Viewport window: only rows within the `rows` budget render (search box
 *      + header + row budget); the rest is not rendered, so the frame can
 *      never overflow wholesale.
 *   3. Row-level scrolling: ↑↓ at a viewport edge pages (k9s style);
 *      PgUp/PgDn/Home/End page or jump directly. Scroll is clamped to the
 *      safe range when the query changes.
 *
 * Key input: OpenTUI `useKeyboard` (discriminated on KeyEvent.name).
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type KeyEvent } from "@opentui/core";
import type { SessionListEntry } from "../session-api/store/session-store.js";
import { tuiPalette } from "./theme.js";
import { clipOneLine } from "./tool-summary.js";

export interface TuiListEntry extends SessionListEntry {
  /** Whether this session is currently running-bg inside the TUI (for the static list-row marker). */
  readonly runningBg: boolean;
}

/** Relative time (updatedAt → "3 分钟前" style, no emoji). */
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
  /** Usable rows for the list viewport (top search box + header + row budget;
   *  passed by the app so ListView never measures the terminal). Defaults to
   *  16 (unit-test environments without rows). */
  readonly rows?: number;
  /** Enter on the pseudo-entry or a session row → index passed up (0 = new session). */
  readonly onOpen: (index: number) => void;
  readonly onBack: () => void;
}

/** Row-content match (search filter predicate): case-insensitive substring on title / lastFinalText.
 *  Exported so unit tests can assert it directly. */
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

/** Strip control characters (a private copy of components.tsx's
 *  stripNonPrintable: components.tsx is a shared file this task must not
 *  touch — used only by this view). */
function stripNonPrintable(input: string): string {
  return [...input]
    .filter((c) => c.charCodeAt(0) >= 32 || c === "\t")
    .filter((c) => c !== "\x7f")
    .join("");
}

export function ListView(props: ListViewProps): ReactNode {
  const pal = tuiPalette;
  // Row-accounting SSOT (defence against frame-height overflow): total
  // rendered rows must be ≤ rowsBudget. Search box 1 row + header 2 rows
  // (title + marginBottom blank) + 2 reserved for scroll indicators (↑/↓ one
  // each) = 5 fixed chrome rows. Viewport rows = budget - 5, so the worst
  // case (both indicators shown) = 1+2+viewHeight+2 = rowsBudget exactly at
  // the edge, never overflowing. Indicator rows are reserved inside the
  // budget instead of dynamically shrinking the viewport: viewport height
  // stays constant while scrolling, so content never jumps.
  const rowsBudget = Math.max(6, props.rows ?? 16);
  const viewHeight = Math.max(1, rowsBudget - 5);
  // Search input (this view's second input surface; Esc clears the search
  // instead of returning directly, a second Esc returns to the chat view —
  // keeping the "pure navigation" intent, search being an auxiliary list capability).
  const [query, setQuery] = useState("");
  // Cursor + viewport top merged into one atomic state: on rapid key repeats
  // OpenTUI dispatches multiple KeyEvents within one render batch, and
  // separate functional state updates would read each other's stale
  // snapshots and lose edge-scroll steps; an atomic object composes correctly
  // step by step within the batch.
  // The first-row pseudo-entry takes index 0; the cursor starts on it (new session is the frequent action).
  // scrollTop = global index of the viewport's top row (0 = pseudo-entry). At scroll 0 the pseudo-entry is always visible.
  const [nav, setNav] = useState({ cursor: 0, scrollTop: 0 });
  const cursor = nav.cursor;
  const scrollTop = nav.scrollTop;

  // Filtered effective entries (pseudo-entry always at index 0).
  const filtered = useMemo(
    () => props.entries.filter((e) => listEntryMatches(e, query)),
    [props.entries, query]
  );
  const total = filtered.length + 1; // index 0 = pseudo-entry

  // Search results change → clamp both cursor and scroll back into the safe range (guards against total row-count changes).
  useEffect(() => {
    const maxScroll = Math.max(0, total - viewHeight);
    setNav((v) => ({
      cursor: Math.min(v.cursor, total - 1),
      scrollTop: Math.min(v.scrollTop, maxScroll),
    }));
  }, [total, viewHeight]);

  useKeyboard((e: KeyEvent) => {
    // Navigation keys match first; printable chars / backspace go to the search input.
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
        if (next < 0) return v; // already at top → no-op
        // Left the viewport's top edge → shift viewport up one row
        const scrollTopNext =
          next < v.scrollTop ? v.scrollTop - 1 : v.scrollTop;
        return { cursor: next, scrollTop: scrollTopNext };
      });
      return;
    }
    if (e.name === "down") {
      setNav((v) => {
        const next = v.cursor + 1;
        if (next >= total) return v; // already at bottom → no-op
        // Left the viewport's bottom edge → shift viewport down one row
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
    // Printable char → append to the search query (arrow / function keys have name length > 1, filtering to empty).
    const printable = stripNonPrintable(
      typeof e.name === "string" ? e.name : e.sequence
    );
    if (printable.length > 0) setQuery((q) => q + printable);
  });

  const summaryWidth = Math.max(10, props.cols - 24);
  const renderSummary = (s: string): string => clipOneLine(s, summaryWidth);

  // Viewport slice: render only the global rows in [scrollTop, scrollTop+viewHeight).
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
        {marker} {renderSummary(entry.title || "(未命名)")}
        <span fg={pal.dim}> {time}</span>
        {entry.runningBg ? <span fg={pal.dim}> [运行中]</span> : ""}
      </text>
    );
  });

  return (
    <box flexDirection="column">
      {/* Search box: occupies 1 row; typing filters immediately, and a placeholder hint shows when empty. */}
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
