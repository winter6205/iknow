/** @jsxImportSource @opentui/react */
/**
 * src/tui/mcp-view.tsx
 *
 * MCP server board (the /mcp entry). Follows the list-view.tsx shape — pure
 * functions + `useKeyboard` (↑↓ Enter Esc navigation) + viewport slicing
 * (k9s-style row scrolling).
 *
 * List mode (mode="list"):
 *  - row = `> server · state · tool-count · source(user|project)`;
 *  - state colors: connected green / failed red / pending amber / disabled gray;
 *  - ↑↓ selects a row, Enter opens detail, `r` triggers reload (with a reloading
 *    hint), Esc returns to chat; detail mode also answers `r` (reload is a
 *    server-level operation); the reloading hint shares the bottom line in both modes;
 *  - empty state: a hint telling the user to configure .iknow/mcp.json and
 *    reload via /mcp, plus the reload hint.
 *
 * Detail mode (mode="detail"):
 *  - header = `server · state` + tool list `tool · description` (the
 *    `mcp__<server>__` prefix is stripped to avoid redundant full names);
 *  - the back entry leads the list; Esc / Enter return to the list (Esc again → chat);
 *  - `r` reloads (same as list mode, a server-level operation);
 *  - cursor is always 0 (a single-server detail cursor is inert, kept for
 *    future multi-server detail switching).
 *
 * reload semantics: `r` → onReload + `reloading=true`; cleared ~200ms after
 * onReload settles (a UI feedback window so a very fast reload still shows).
 *
 * Viewport row budget (conservative): title 1 + marginBottom 1 + header 1 +
 * rows N + bottom reload status 1 + hint 1 — fixed chrome reservation; excess
 * scrolls, currently simple truncation + ↑↓.
 */
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type KeyEvent } from "@opentui/core";
import type { McpServerStatus } from "../harness/mcp/manager.js";
import type { AciToolDef } from "../harness/aci/types.js";
import { tuiPalette } from "./theme.js";
import { clipOneLine, visualWidth } from "./tool-summary.js";

/** Flattened MCP tool entries (server recovered from `mcp__<server>__<tool>`). */
export interface McpToolEntry {
  readonly server: string;
  readonly tool: AciToolDef;
}

export interface McpViewProps {
  readonly statuses: readonly McpServerStatus[];
  readonly tools: ReadonlyArray<McpToolEntry>;
  readonly cols: number;
  /** Usable viewport rows (title + header + row budget; default 12 so unit tests need no rows env). */
  readonly rows?: number;
  readonly onReload: () => void | Promise<void>;
  readonly onBack: () => void;
}

/** state → semantic color (connected green / failed red / pending amber /
 *  disabled gray). Exported for direct unit-test assertions. */
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
  // Row-account SSOT (same list-view discipline, prevents whole-frame overflow):
  //  title 1 + marginBottom 1 + header 1 + bottom reload status 1 = 4 fixed chrome rows.
  const rowsBudget = Math.max(6, props.rows ?? 12);
  const viewHeight = Math.max(1, rowsBudget - 4);

  const [mode, setMode] = useState<"list" | "detail">("list");
  // List navigation (atomic state: rapid keypresses within one render batch never read each other's stale snapshot).
  const [nav, setNav] = useState({ cursor: 0, scrollTop: 0 });
  const [reloading, setReloading] = useState(false);

  // Per-server tool counts (shown inline in list rows; one full pass, then filtered by server).
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
      // Short delay gives UI feedback (~200ms), so the loading hint stays visible even for an instant reload.
      setTimeout(() => setReloading(false), 200);
    };
    try {
      void Promise.resolve(props.onReload()).then(finish, finish);
    } catch {
      finish();
    }
  }, [reloading, props.onReload]);

  useKeyboard((e: KeyEvent) => {
    // Yield modified-key combos (Ctrl/Meta are taken by the app layer / system).
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
      // Single-server detail: Enter / ↑↓ are inert, returning to the list is
      // enough; `r` is a server-level operation independent of detail content, so both modes reload.
      if (e.name === "return") {
        setMode("list");
        return;
      }
      if (e.name === "r" || e.name === "R") {
        handleReload();
      }
      return;
    }
    // List mode
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

  // ── List mode render ─────────────────────────────────────────────
  if (mode === "list") {
    const total = props.statuses.length;
    // Viewport slicing: render only server rows in [scrollTop, scrollTop+viewHeight).
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
      // Row prefix + server name + colored state + tool count + source marker.
      const prefix = clipOneLine(
        `${marker} ${status.name}`,
        Math.max(4, maxLineWidth - 8)
      );
      // On failed, the error first line renders next to the state (clipOneLine
      // truncation, pal.dim + pal.error colors). The error-column budget yields to
      // name truncation (the maxLineWidth - 8 logic): the remainder is found by
      // "visual width of the non-error part" (including the ` · ` separator); no
      // room left (name fill the row) → skip, so a row never overflows.
      const stateText = ` · ${status.state}`;
      const dimText = ` · ${count} 工具 · ${status.source}`;
      const errorBudget =
        status.state === "failed" && status.error
          ? maxLineWidth - visualWidth(`${prefix}${stateText}${dimText}`) - 3
          : 0;
      const errorLine =
        errorBudget > 0 ? clipOneLine(status.error ?? "", errorBudget) : "";
      rows.push(
        <text
          key={status.name}
          fg={rowFg}
          attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {prefix}
          <span fg={stateColor}>{stateText}</span>
          <span fg={pal.dim}>{dimText}</span>
          {errorLine.length > 0 && <span fg={pal.dim}> · </span>}
          {errorLine.length > 0 && <span fg={pal.error}>{errorLine}</span>}
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

  // ── Detail mode render ─────────────────────────────────────────────
  const selected = props.statuses[nav.cursor];
  const detailTools = selected
    ? props.tools.filter((t) => t.server === selected.name)
    : [];
  // The back entry is always at index 0; tool rows start from index 1, truncated to the viewport.
  // Tool names drop the `mcp__<server>__` prefix (the server is already explicit in the
  // header, no redundant full name); an empty description falls back to the placeholder, same basis as list mode.
  const toolRows: ReactNode[] = [];
  const maxToolRows = viewHeight - 1; // reserve 1 row for the back entry
  toolRows.push(
    <text key="back" fg={pal.dim}>
      ← 返回
    </text>
  );
  const shownTools = detailTools.slice(0, maxToolRows);
  for (const t of shownTools) {
    const toolName = t.tool.name.split("__").slice(2).join("__");
    const desc = t.tool.description.length > 0 ? t.tool.description : "(空)";
    toolRows.push(
      <text key={t.tool.name} fg={pal.text}>
        {clipOneLine(`${toolName} · ${desc}`, maxLineWidth)}
      </text>
    );
  }
  // Tool count exceeds the viewport → trailing hint for the hidden remainder (row account and truncation share one source, no overflow).
  const hiddenTools = detailTools.length - shownTools.length;
  if (hiddenTools > 0) {
    toolRows.push(
      <text key="more" fg={pal.dim}>
        … {hiddenTools} more tools
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
      {/* failed + error → multi-line error under the header (split on \n, per-line
          clipOneLine, pal.error color), placed before the tool rows; non-failed → no render. */}
      {selected?.state === "failed" &&
        selected.error &&
        selected.error.split("\n").map((line, i) => (
          <text key={`mcp-err-${i}`} fg={pal.error}>
            {clipOneLine(line, maxLineWidth)}
          </text>
        ))}
      {toolRows}
      {footerLine !== undefined && (
        <box marginTop={1}>
          <text fg={pal.dim}>{footerLine}</text>
        </box>
      )}
    </box>
  );
}
