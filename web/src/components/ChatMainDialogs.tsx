/**
 * Inline dialogs / error blocks for the ChatApp main area.
 *
 * Extracts the inline ErrorBlock / McpPanel / RewindPicker /
 * MessageList set (~75 lines of JSX) into this component so ChatApp's main
 * file stays ≤200 lines.
 *
 * WorkspacePicker no longer renders in the main area — it is a popover
 * anchored at the ChatHeader WorkspaceChip's top-right (ChatHeader takes a
 * `workspacePopover` slot injected by App). The main area keeps only
 * MessageList + inline error / dialog blocks (McpPanel / RewindPicker /
 * PermissionDialog / StateBlock) — no more layout that squeezes the chat box.
 *
 * Behaviour contract: 100% equivalent to the original inline JSX in ChatApp.
 */
import type { ReactNode } from "react";
import { McpPanel } from "./McpPanel";
import { MessageList } from "./MessageList";
import { RewindPicker } from "./RewindPicker";
import { StateBlock } from "./StateBlock";
import type { McpServerStatus, McpTool } from "../api/types";
import type { useSessionChat } from "../hooks/useSessionChat";
import type { WebRewindTarget } from "../lib/rewind-targets";
import * as api from "../api/client";

type ChatApi = ReturnType<typeof useSessionChat>;

export function ChatMainDialogs({
  chat,
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
}: {
  chat: ChatApi;
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
      <MessageList
        messages={chat.messages}
        sending={chat.phase === "sending"}
      />
    </>
  );
}

/**
 * MCP reload side-effect helper (supplies the reloadMcp closure).
 * ChatApp provides chat / setMcpServers / setMcpTools / setMcpReloading;
 * returns a stable callback usable as onReload.
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
