import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MessageList } from "./components/MessageList";
import { SessionSidebar } from "./components/SessionSidebar";
import { StateBlock } from "./components/StateBlock";
import { useSessionChat } from "./hooks/useSessionChat";
import {
  loadThinkingSettings,
  saveThinkingSettings,
  toWireOverride,
  type ThinkingSettings,
} from "./lib/thinking-settings";

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
  // T5: 思考开关 + 强度（localStorage 持久化，每次发送随请求下发 override）。
  const [thinkingSettings, setThinkingSettings] = useState<ThinkingSettings>(
    () => loadThinkingSettings()
  );
  const handleThinkingChange = useCallback((next: ThinkingSettings) => {
    setThinkingSettings(next);
    saveThinkingSettings(next);
  }, []);
  // Bumped after lifecycle events (newSession / setConversation to a non-cached
  // id) so the sidebar re-fetches the list and the new entry shows up without
  // the user clicking refresh.
  const [sidebarSignal, setSidebarSignal] = useState(0);
  const bumpSidebar = useCallback(() => setSidebarSignal((n) => n + 1), []);

  // Composer 只发文本；thinking override 在 App 层按当前设置合成后透传。
  const handleSend = useCallback(
    (text: string) => chat.sendMessage(text, toWireOverride(thinkingSettings)),
    [chat, thinkingSettings]
  );

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
          <MessageList
            messages={chat.messages}
            sending={chat.phase === "sending"}
          />
        </>
      }
      footer={
        <>
          <Composer
            disabled={!chat.session || chat.phase === "loading"}
            sending={chat.phase === "sending"}
            thinkingSettings={thinkingSettings}
            onThinkingChange={handleThinkingChange}
            onSend={handleSend}
          />
        </>
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
