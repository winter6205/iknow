/**
 * serve-workspace T7a — SessionSidebar 的 ChatApp 侧 props 装配容器 (T7b 精简)。
 *
 * review fix M6: 从 ChatApp 抽出 SessionSidebar 的 props 装配，把 ~12 行
 * inline JSX + 各 handler 引用从 ChatApp 主文件挪到本容器，ChatApp 只接
 * 装配后的 side。
 *
 * T7b review fix M2: `currentBoundRoot` 不再透传 — groupSessionsByWorkspace
 * 不再需要 picker 当前根。同步移除 `ws` 入参（原唯一用途就是读 ws.root）。
 *
 * 行为契约: 与原 ChatApp 内 `<SessionSidebar ... />` 100% 等价；只换载体。
 */
import { SessionSidebar } from "./SessionSidebar";
import type { useSessionChat } from "../hooks/useSessionChat";

type ChatApi = ReturnType<typeof useSessionChat>;

export function ChatSidebarContainer({
  chat,
  collapsed,
  setCollapsed,
  sidebarSignal,
  onSelect,
  onNewSession,
  onCreateInWorkspace,
}: {
  chat: ChatApi;
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
    />
  );
}
