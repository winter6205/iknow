/**
 * serve-workspace T7a — SessionSidebar 的 ChatApp 侧 props 装配容器。
 *
 * review fix M6: 从 ChatApp 抽出 SessionSidebar 的 props 装配，把 ~12 行
 * inline JSX + 各 handler 引用从 ChatApp 主文件挪到本容器，ChatApp 只接
 * 装配后的 side。
 *
 * 行为契约: 与原 ChatApp 内 `<SessionSidebar ... />` 100% 等价；只换载体。
 */
import { SessionSidebar } from "./SessionSidebar";
import type { useSessionChat } from "../hooks/useSessionChat";
import type { useWorkspace } from "../hooks/useWorkspace";

type ChatApi = ReturnType<typeof useSessionChat>;
type WsApi = ReturnType<typeof useWorkspace>;

export function ChatSidebarContainer({
  chat,
  ws,
  collapsed,
  setCollapsed,
  sidebarSignal,
  onSelect,
  onNewSession,
  onCreateInWorkspace,
}: {
  chat: ChatApi;
  ws: WsApi;
  collapsed: boolean;
  setCollapsed: (updater: (c: boolean) => boolean) => void;
  sidebarSignal: number;
  onSelect: (id: string) => Promise<void>;
  onNewSession: () => Promise<void>;
  onCreateInWorkspace: (root: string) => Promise<void>;
}) {
  return (
    <SessionSidebar
      currentConversationId={chat.session?.conversation_id ?? null}
      onSelect={onSelect}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      onNewSession={onNewSession}
      onCreateInWorkspace={onCreateInWorkspace}
      refreshSignal={sidebarSignal}
      currentBoundRoot={ws.root}
    />
  );
}
