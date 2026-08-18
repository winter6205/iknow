import type { McpServerStatus, McpTool } from "../api/types";

export type McpPanelProps = {
  readonly servers: readonly McpServerStatus[];
  readonly tools: readonly McpTool[];
  readonly reloading: boolean;
  readonly onReload: () => void;
  readonly onClose: () => void;
};

export function McpPanel(props: McpPanelProps) {
  return (
    <div className="border-b border-ink-3/30 bg-surface px-3 py-2 text-[12px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-ink">MCP</span>
        <div className="flex gap-2">
          <button
            type="button"
            className="text-accent"
            onClick={props.onReload}
            disabled={props.reloading}
          >
            {props.reloading ? "重载中…" : "重载"}
          </button>
          <button type="button" className="text-ink-3" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
      {props.servers.length === 0 ? (
        <p className="text-ink-3">无 MCP 服务。.iknow/mcp.json 配置后重载。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {props.servers.map((s) => (
            <li key={s.name} className="font-mono text-ink">
              {s.name} · {s.state} · {s.source}
              {s.error ? ` · ${s.error}` : ""}
            </li>
          ))}
        </ul>
      )}
      {props.tools.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5 text-ink-3">
          {props.tools.map((t) => (
            <li key={t.name} className="truncate font-mono">
              {t.server} · {t.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
