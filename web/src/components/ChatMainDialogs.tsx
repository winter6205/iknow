/**
 * serve-workspace T7a — ChatApp 主区域 inline 对话框 / 错误块。
 *
 * review fix M6: 把 ChatApp 主区域 inline 的 ErrorBlock / McpPanel /
 * RewindPicker / WorkspacePicker / MessageList 集合 (~75 行 JSX) 抽到本
 * 组件，让 ChatApp 主文件收敛到 ≤ 200 行。
 *
 * 行为契约: 与原 ChatApp 内 inline JSX 100% 等价。
 */
import type { ReactNode } from "react";
import { McpPanel } from "./McpPanel";
import { MessageList } from "./MessageList";
import { RewindPicker } from "./RewindPicker";
import { StateBlock } from "./StateBlock";
import { WorkspacePicker } from "./WorkspacePicker";
import type { McpServerStatus, McpTool } from "../api/types";
import type { useSessionChat } from "../hooks/useSessionChat";
import type { useWorkspace } from "../hooks/useWorkspace";
import type { WebRewindTarget } from "../lib/rewind-targets";
import * as api from "../api/client";

type ChatApi = ReturnType<typeof useSessionChat>;
type WsApi = ReturnType<typeof useWorkspace>;

export function ChatMainDialogs({
  chat,
  ws,
  permissionDialog,
  mcpOpen,
  mcpServers,
  mcpTools,
  mcpReloading,
  reloadMcp,
  closeMcp,
  rewindTargets,
  rewindIndex,
  selectRewind,
  confirmRewind,
  closeRewind,
  workspaceOpen,
  closeWorkspace,
}: {
  chat: ChatApi;
  ws: WsApi;
  permissionDialog: ReactNode;
  mcpOpen: boolean;
  mcpServers: ReadonlyArray<McpServerStatus>;
  mcpTools: ReadonlyArray<McpTool>;
  mcpReloading: boolean;
  reloadMcp: () => void;
  closeMcp: () => void;
  rewindTargets: ReadonlyArray<WebRewindTarget> | undefined;
  rewindIndex: number;
  selectRewind: (n: number) => void;
  confirmRewind: () => void;
  closeRewind: () => void;
  workspaceOpen: boolean;
  closeWorkspace: () => void;
}) {
  return (
    <>
      {chat.error ? (
        <StateBlock
          kind="error"
          title="请求失败"
          detail={chat.error}
          onRetry={chat.session ? chat.clearError : chat.retryBootstrap}
          retryLabel={chat.session ? "关闭错误" : "重试"}
        />
      ) : null}
      {permissionDialog}
      {mcpOpen ? (
        <McpPanel
          servers={mcpServers}
          tools={mcpTools}
          reloading={mcpReloading}
          onReload={reloadMcp}
          onClose={closeMcp}
        />
      ) : null}
      {rewindTargets !== undefined ? (
        <RewindPicker
          targets={rewindTargets}
          selectedIndex={rewindIndex}
          confirming={true}
          onSelect={selectRewind}
          onConfirm={confirmRewind}
          onClose={closeRewind}
        />
      ) : null}
      {workspaceOpen ? (
        <WorkspacePicker
          recents={ws.recents}
          currentRoot={ws.root}
          onBind={ws.bind}
          onClose={closeWorkspace}
          onNotice={chat.pushNotice}
          onBrowseSubdirs={ws.browseSubdirs}
        />
      ) : null}
      <MessageList
        messages={chat.messages}
        sending={chat.phase === "sending"}
      />
    </>
  );
}

/**
 * MCP 重载 + reload 副作用 helper（注入 reloadMcp 闭包）。
 * 由 ChatApp 提供 chat / setMcpServers / setMcpTools / setMcpReloading，
 * 返回一个可作 onReload 用的稳定 callback。
 */
export function useMcpReload({
  chat,
  setMcpServers,
  setMcpTools,
  setMcpReloading,
}: {
  chat: ChatApi;
  setMcpServers: (servers: ReadonlyArray<McpServerStatus>) => void;
  setMcpTools: (tools: ReadonlyArray<McpTool>) => void;
  setMcpReloading: (loading: boolean) => void;
}): () => void {
  return () => {
    void (async () => {
      setMcpReloading(true);
      try {
        const st = await api.reloadMcp();
        const tools = await api.listMcpTools();
        setMcpServers(st.servers);
        setMcpTools(tools.tools);
      } catch (e) {
        chat.pushNotice(
          `MCP 重载失败：${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setMcpReloading(false);
      }
    })();
  };
}
