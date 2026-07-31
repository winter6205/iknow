import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MessageList } from "./components/MessageList";
import { SessionSidebar } from "./components/SessionSidebar";
import { StateBlock } from "./components/StateBlock";
import { useSessionChat } from "./hooks/useSessionChat";

/** Viewport width below which the sidebar starts collapsed (decision #7). */
const NARROW_QUERY = "(max-width: 768px)";

function ChatApp() {
  const chat = useSessionChat();
  // Lazy init from the current viewport so the first paint already reflects
  // the narrow-screen collapsed state (no layout flash). Vite SPA has no SSR,
  // so window is always available here.
  const [collapsed, setCollapsed] = useState(
    () => window.matchMedia(NARROW_QUERY).matches
  );
  // Bumped after lifecycle events (newSession / setConversation to a non-cached
  // id) so the sidebar re-fetches the list and the new entry shows up without
  // the user clicking refresh.
  const [sidebarSignal, setSidebarSignal] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarSignal((n) => n + 1), []);

  // Narrow-screen auto-collapse: track live changes (device rotation, window
  // resize across the breakpoint) after the initial render.
  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setCollapsed(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const header = (
    <ChatHeader phase={chat.phase} healthLabel={chat.healthLabel} />
  );

  // Sidebar lists past conversations and switches the active one. Passes the
  // current id (or null during pre-bootstrap) so the highlight tracks live.
  // refreshSignal is bumped after newSession so the freshly created session
  // appears without a manual refresh click.
  const handleNewSession = useCallback(async () => {
    await chat.newSession();
    bumpSidebar();
  }, [chat, bumpSidebar]);

  const handleSelect = useCallback(
    async (id: string) => {
      await chat.setConversation(id);
      // setConversation may switch to a session not yet in the cached list
      // (e.g. just-created entries still propagating); refresh to be safe.
      bumpSidebar();
    },
    [chat, bumpSidebar]
  );

  const side = (
    <SessionSidebar
      currentConversationId={chat.session?.conversation_id ?? null}
      onSelect={handleSelect}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      onNewSession={handleNewSession}
      refreshSignal={sidebarSignal}
    />
  );

  if (chat.phase === "loading" && !chat.session) {
    return (
      <AppShell
        header={header}
        side={side}
        main={
          <StateBlock
            kind="loading"
            title="正在连接会话服务…"
            detail={chat.healthLabel ?? "检查 /api/v1/health 并创建会话"}
          />
        }
      />
    );
  }

  if (chat.phase === "error" && !chat.session) {
    return (
      <AppShell
        header={header}
        side={side}
        main={
          <StateBlock
            kind="error"
            title="无法启动会话"
            detail={chat.error ?? "未知错误"}
            onRetry={chat.retryBootstrap}
            retryLabel="重新连接"
          />
        }
      />
    );
  }

  return (
    <AppShell
      header={header}
      side={side}
      main={
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
          <MessageList messages={chat.messages} />
        </>
      }
      footer={
        <Composer
          disabled={!chat.session || chat.phase === "loading"}
          sending={chat.phase === "sending"}
          onSend={chat.sendMessage}
        />
      }
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ChatApp />
    </ErrorBoundary>
  );
}
