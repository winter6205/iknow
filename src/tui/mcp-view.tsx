/** @jsxImportSource @opentui/react */
/**
 * src/tui/mcp-view.tsx
 *
 * #361 Phase D：MCP 服务看板（/mcp 入口）。参考 list-view.tsx 形态——纯函数 +
 * `useKeyboard`（↑↓ Enter Esc 导航）+ 视口切片（k9s 风格行级滚动）。
 *
 * 列表模式（mode="list"）：
 *  - 行 = `> server · state · 工具数 · source(user|project)`；
 *  - state 着色：connected 绿 / failed 红 / pending 暗黄 / disabled 灰；
 *  - ↑↓ 选行，Enter 进入 detail，`r` 触发 reload（带 reloading 提示），
 *    Esc 返回 chat；
 *  - 空状态：`无 MCP 服务。.iknow/mcp.json 配置后 /mcp 重载` + reload 提示。
 *
 * 详情模式（mode="detail"）：
 *  - header = `server · state` + 工具列表 `mcp__server__tool · description`；
 *  - 首条 `← 返回`；Esc / Enter 返回列表（Esc 再按回 chat）；
 *  - cursor 恒 0（单 server 详情游标不活跃，留作未来多 server detail 切换）。
 *
 * reload 语义：`r` → onReload + `reloading=true`；onReload 完成后延迟 ~200ms
 * 清位（给 UI 反馈窗口，避免 reload 极快时闪一下不可见）。
 *
 * 视口行账（保守）：标题 1 + marginBottom 1 + 表头 1 + 行 N + 底部 reload
 * 状态 1 + 提示 1。固定 chrome 预留；超出滚动，本期简单截断 + ↑↓。
 */
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type KeyEvent } from "@opentui/core";
import type { McpServerStatus } from "../harness/mcp/manager.js";
import type { AciToolDef } from "../harness/aci/types.js";
import { tuiPalette } from "./theme.js";
import { clipOneLine } from "./tool-summary.js";

/** 平铺的 MCP 工具条目（server 反解自 `mcp__<server>__<tool>`）。 */
export interface McpToolEntry {
  readonly server: string;
  readonly tool: AciToolDef;
}

export interface McpViewProps {
  readonly statuses: readonly McpServerStatus[];
  readonly tools: ReadonlyArray<McpToolEntry>;
  readonly cols: number;
  /** 视口可用行数（标题 + 表头 + 行数预算；缺省 12 供单测无 rows 环境）。 */
  readonly rows?: number;
  readonly onReload: () => void | Promise<void>;
  readonly onBack: () => void;
}

/** state → 语义色（connected 绿 / failed 红 / pending 暗黄 / disabled 灰）。
 *  exported 供单测直接断言。 */
export function mcpStateColor(
  pal: typeof tuiPalette,
  state: McpServerStatus["state"]
): string {
  switch (state) {
    case "connected":
      return pal.add;
    case "failed":
      return pal.error;
    case "pending":
      return pal.running;
    case "disabled":
      return pal.dim;
  }
}

export function McpView(props: McpViewProps): ReactNode {
  const pal = tuiPalette;
  // 行账 SSOT（同 list-view 纪律，防整帧溢出）：
  //  标题 1 + marginBottom 1 + 表头 1 + 底部 reload 状态 1 = 固定 chrome 4 行。
  const rowsBudget = Math.max(6, props.rows ?? 12);
  const viewHeight = Math.max(1, rowsBudget - 4);

  const [mode, setMode] = useState<"list" | "detail">("list");
  // 列表导航（原子 state：快速连键同一渲染批内不互读旧快照）。
  const [nav, setNav] = useState({ cursor: 0, scrollTop: 0 });
  const [reloading, setReloading] = useState(false);

  // 每 server 工具数（列表行内展示；全量拉一次后按 server 过滤）。
  const toolCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of props.tools) {
      map.set(t.server, (map.get(t.server) ?? 0) + 1);
    }
    return map;
  }, [props.tools]);

  const handleReload = useCallback(() => {
    if (reloading) return;
    setReloading(true);
    const finish = (): void => {
      // 短延迟给 UI 反馈（~200ms），reload 极快时也可见 loading 提示。
      setTimeout(() => setReloading(false), 200);
    };
    try {
      void Promise.resolve(props.onReload()).then(finish, finish);
    } catch {
      finish();
    }
  }, [reloading, props.onReload]);

  useKeyboard((e: KeyEvent) => {
    // 让出修饰键组合（Ctrl/Meta 由 app 层 / 系统接管）。
    if (e.ctrl || e.meta) return;
    if (e.name === "escape") {
      if (mode === "detail") {
        setMode("list");
      } else {
        props.onBack();
      }
      return;
    }
    if (mode === "detail") {
      // 单 server 详情：Enter / ↑↓ 均不活跃，返回列表即可。
      if (e.name === "return") {
        setMode("list");
      }
      return;
    }
    // 列表模式
    if (e.name === "return") {
      if (props.statuses.length > 0) {
        setMode("detail");
      }
      return;
    }
    if (e.name === "r" || e.name === "R") {
      handleReload();
      return;
    }
    if (e.name === "up") {
      setNav((v) => {
        const next = v.cursor - 1;
        if (next < 0) return v;
        const scrollTopNext =
          next < v.scrollTop ? v.scrollTop - 1 : v.scrollTop;
        return { cursor: next, scrollTop: scrollTopNext };
      });
      return;
    }
    if (e.name === "down") {
      setNav((v) => {
        const next = v.cursor + 1;
        if (next >= props.statuses.length) return v;
        const scrollTopNext =
          next >= v.scrollTop + viewHeight ? v.scrollTop + 1 : v.scrollTop;
        return { cursor: next, scrollTop: scrollTopNext };
      });
      return;
    }
  });

  const maxLineWidth = Math.max(10, props.cols);
  const footerLine = reloading
    ? "reload in progress…"
    : props.statuses.length === 0
      ? "按 r 重载 · Esc 返回"
      : undefined;

  // ── 列表模式渲染 ─────────────────────────────────────────────
  if (mode === "list") {
    const total = props.statuses.length;
    // 视口切片：只渲染 [scrollTop, scrollTop+viewHeight) 的 server 行。
    const rows: ReactNode[] = [];
    for (
      let i = nav.scrollTop;
      i < nav.scrollTop + viewHeight && i < total;
      i++
    ) {
      const status = props.statuses[i];
      if (!status) continue;
      const selected = i === nav.cursor;
      const marker = selected ? ">" : " ";
      const count = toolCounts.get(status.name) ?? 0;
      const stateColor = mcpStateColor(pal, status.state);
      const rowFg = selected ? pal.accent : pal.text;
      // 行前缀 + server 名 + state 着色 + 工具数 + source 标记。
      const prefix = clipOneLine(
        `${marker} ${status.name}`,
        Math.max(4, maxLineWidth - 8)
      );
      rows.push(
        <text
          key={status.name}
          fg={rowFg}
          attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {prefix}
          <span fg={stateColor}> · {status.state}</span>
          <span fg={pal.dim}>
            {" "}
            · {count} 工具 · {status.source}
          </span>
        </text>
      );
    }
    return (
      <box flexDirection="column">
        <box flexDirection="row" marginBottom={1}>
          <text fg={pal.text} attributes={TextAttributes.BOLD}>
            MCP 服务看板
          </text>
          <text fg={pal.dim}> ↑↓ 选择 · Enter 详情 · r 重载 · Esc 返回</text>
        </box>
        {rows}
        {total === 0 && (
          <box marginTop={1}>
            <text fg={pal.dim}>
              无 MCP 服务。.iknow/mcp.json 配置后 /mcp 重载
            </text>
          </box>
        )}
        {footerLine !== undefined && (
          <box marginTop={1}>
            <text fg={pal.dim}>{footerLine}</text>
          </box>
        )}
      </box>
    );
  }

  // ── 详情模式渲染 ─────────────────────────────────────────────
  const selected = props.statuses[nav.cursor];
  const detailTools = selected
    ? props.tools.filter((t) => t.server === selected.name)
    : [];
  // 首条 `← 返回` 恒在 index 0；工具行从 index 1 起，简单截断到视口。
  const toolRows: ReactNode[] = [];
  const maxToolRows = viewHeight - 1; // 预留 ← 返回 1 行
  toolRows.push(
    <text key="back" fg={pal.dim}>
      ← 返回
    </text>
  );
  for (let i = 0; i < detailTools.length && i < maxToolRows; i++) {
    const t = detailTools[i]!;
    toolRows.push(
      <text key={t.tool.name} fg={pal.text}>
        {clipOneLine(`${t.tool.name} · ${t.tool.description}`, maxLineWidth)}
      </text>
    );
  }
  const stateColor = selected ? mcpStateColor(pal, selected.state) : pal.dim;
  return (
    <box flexDirection="column">
      <box flexDirection="row" marginBottom={1}>
        <text fg={pal.text} attributes={TextAttributes.BOLD}>
          {selected ? clipOneLine(selected.name, maxLineWidth - 8) : "MCP 详情"}
        </text>
        {selected && <text fg={stateColor}> · {selected.state}</text>}
        <text fg={pal.dim}> Esc 返回列表 · 再按回 chat</text>
      </box>
      {toolRows}
      {footerLine !== undefined && (
        <box marginTop={1}>
          <text fg={pal.dim}>{footerLine}</text>
        </box>
      )}
    </box>
  );
}
