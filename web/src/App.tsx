import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "./components/AppShell";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { ContextUsageStrip } from "./components/ContextUsageStrip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MessageList } from "./components/MessageList";
import { SessionSidebar } from "./components/SessionSidebar";
import { StateBlock } from "./components/StateBlock";
import { useSessionChat } from "./hooks/useSessionChat";
import { useAsksPolling } from "./hooks/useAsksPolling";
import { PermissionDialog } from "./components/PermissionDialog";
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

  // 压缩按钮反馈：working 时按钮显示「压缩中…」；完成后短暂显示结果提示。
  const [compacting, setCompacting] = useState(false);
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  const compactNoticeTimer = useRef<number | null>(null);

  const handleCompact = useCallback(async () => {
    if (compacting) return;
    setCompacting(true);
    setCompactNotice(null);
    try {
      const didCompact = await chat.compact();
      setCompactNotice(didCompact ? "已压缩上下文" : "上下文未达压缩阈值");
    } catch (e) {
      setCompactNotice(
        `压缩失败：${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setCompacting(false);
      // 提示停留 3s 后自动消失。
      if (compactNoticeTimer.current !== null) {
        window.clearTimeout(compactNoticeTimer.current);
      }
      compactNoticeTimer.current = window.setTimeout(() => {
        setCompactNotice(null);
        compactNoticeTimer.current = null;
      }, 3000);
    }
  }, [compacting, chat]);

  // Composer 只发文本；thinking override 在 App 层按当前设置合成后透传。
  const handleSend = useCallback(
    (text: string) => chat.sendMessage(text, toWireOverride(thinkingSettings)),
    [chat, thinkingSettings]
  );

  // Permission polling is only active while a turn is in flight AND we have a
  // session id. When the dialog appears, it sits at the top of the message
  // stream (decided by the ChatView composition order — rendered above the
  // list so users cannot miss it).
  const conversationId = chat.session?.conversation_id ?? null;
  const isSending = chat.phase === "sending";
  const askPolling = useAsksPolling(conversationId, isSending);
  const permissionDialog =
    askPolling.pendingAsk && conversationId ? (
      <PermissionDialog
        ask={askPolling.pendingAsk}
        conversationId={conversationId}
        onDecide={askPolling.decide}
        pollError={askPolling.pollError}
      />
    ) : null;

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
          {permissionDialog}
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
          {/* 上下文用量条：输入框下方（用户 2026-08-07 反馈：放输入框下方）。
              右侧压缩按钮：手动触发 compactSession（后端幂等，低于阈值 no-op）。 */}
          <ContextUsageStrip
            usage={chat.lastAnswer?.lastUsage ?? null}
            contextWindow={chat.contextWindow}
            sending={chat.phase === "sending"}
            onCompact={handleCompact}
            compacting={compacting}
            compactDisabled={!chat.session}
          />
          {compactNotice ? (
            <p
              role="status"
              aria-live="polite"
              className="mx-auto w-full max-w-[var(--chat-max)] px-4 pb-1 pt-0 text-center font-mono text-[10px] text-ink-3"
            >
              {compactNotice}
            </p>
          ) : null}
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
