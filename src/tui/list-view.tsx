/**
 * src/tui/list-view.tsx
 *
 * #146 会话列表视图（Q4a/Q4b 裁决）：
 *  - 列内容 = summary（首条 user 前 80 字符，#120 SSOT）+ 相对时间 + 运行指示；
 *    数据源 = SessionStore.list() 的 summary 字段，不做 per-id 重读（SC 13）；
 *  - updatedAt 降序（store.list() 已排序）；
 *  - 首行 `+ 新建会话` 伪条目：Enter = /new 等价（Q4b）；
 *  - ↑↓ 选择，Enter 打开，Esc 返回聊天视图（Q3 列表纯导航，无第二输入框）；
 *  - 删除入口不暴露（D1 安全边界）。
 *  - running-bg 会话行内静态 `[运行中]` 暗色标记（与前台 spinner 区分）。
 */
import { useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionListEntry } from "../session-api/store/session-store.js";
import { tuiPalette } from "./theme.js";
import { clipOneLine } from "./text.js";

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
  /** 选中首行伪条目或某个会话 Enter → 传 index（0 = 新建）。 */
  readonly onOpen: (index: number) => void;
  readonly onBack: () => void;
}

export function ListView(props: ListViewProps): ReactElement {
  const pal = tuiPalette;
  // 首行伪条目占 index 0；光标初始在伪条目上（新建是高频动作）。
  const [cursor, setCursor] = useState(0);
  const rows = props.entries.length + 1;

  useInput((_input, key) => {
    if (key.upArrow) setCursor((c) => (c - 1 + rows) % rows);
    else if (key.downArrow) setCursor((c) => (c + 1) % rows);
    else if (key.return) props.onOpen(cursor);
    else if (key.escape) props.onBack();
  });

  const summaryWidth = Math.max(10, props.cols - 24);
  const renderSummary = (s: string): string => clipOneLine(s, summaryWidth);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={pal.text} bold>
          会话列表
        </Text>
        <Text color={pal.dim}> ↑↓ 选择 · Enter 打开 · Esc 返回</Text>
      </Box>
      {Array.from({ length: rows }).map((_, i) => {
        const selected = i === cursor;
        const marker = selected ? ">" : " ";
        if (i === 0) {
          return (
            <Box key="new">
              <Text color={selected ? pal.accent : pal.dim}>
                {marker} + 新建会话
              </Text>
            </Box>
          );
        }
        const entry = props.entries[i - 1];
        if (!entry) return null;
        const time = relativeTime(entry.updatedAt);
        return (
          <Box key={entry.conversation_id}>
            <Text color={selected ? pal.accent : pal.text}>
              {marker} {renderSummary(entry.summary || "(空)")}
            </Text>
            <Text color={pal.dim}> {time}</Text>
            {entry.runningBg && <Text color={pal.dim}> [运行中]</Text>}
          </Box>
        );
      })}
      {props.entries.length === 0 && (
        <Box marginTop={1}>
          <Text color={pal.dim}>本项目暂无会话；Enter 新建</Text>
        </Box>
      )}
    </Box>
  );
}
