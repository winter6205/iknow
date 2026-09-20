/**
 * ChatApp-side props assembly container for SessionSidebar.
 *
 * Moves the ~12 lines of SessionSidebar props wiring (inline
 * JSX + handler references) out of ChatApp's main file; ChatApp receives only
 * the assembled side.
 *
 * `currentBoundRoot` is no longer passed through —
 * groupSessionsByWorkspace no longer needs the picker's current root; the
 * `ws` param was removed with it (its only use was reading ws.root).
 *
 * Behaviour contract: 100% equivalent to the original `<SessionSidebar ... />`
 * in ChatApp; only the carrier changed.
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
