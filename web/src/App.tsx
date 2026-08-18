import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MessageList } from "./components/MessageList";
import { SessionSidebar } from "./components/SessionSidebar";
import { StateBlock } from "./components/StateBlock";
import { useSessionChat } from "./hooks/useSessionChat";
import { useAsksPolling } from "./hooks/useAsksPolling";
import { usePermissionMode } from "./hooks/usePermissionMode";
import { useSubagentsPolling } from "./hooks/useSubagentsPolling";
import { PermissionDialog } from "./components/PermissionDialog";
import { SubagentStatusBar } from "./components/SubagentStatusBar";
import { permissionModeLabel } from "./lib/permission-mode";
import {
  resolveArgCommand,
  slashHelpText,
  type SlashCommandName,
} from "./lib/slash";
import {
  loadThinkingSettings,
  saveThinkingSettings,
  toWireOverride,
  type ThinkingEffort,
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

  // /compact 反馈：working 时防重复触发；结果经 notice 消息进消息流。
  const [compacting, setCompacting] = useState(false);

  const handleCompact = useCallback(async () => {
    if (compacting) return;
    setCompacting(true);
    try {
      const didCompact = await chat.compact();
      // false 的两类成因分开提示：无会话（compact 早退）≠ 未达压缩阈值，
      // 避免会话缺席时误导用户"上下文未达阈值"。
      chat.pushNotice(
        didCompact
          ? "已压缩上下文"
          : chat.session
            ? "上下文未达压缩阈值"
            : "当前无会话可压缩"
      );
    } catch (e) {
      chat.pushNotice(
        `压缩失败：${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setCompacting(false);
    }
  }, [compacting, chat]);

  // Composer 只发文本；thinking override 在 App 层按当前设置合成后透传。
  const handleSend = useCallback(
    (text: string) => chat.sendMessage(text, toWireOverride(thinkingSettings)),
    [chat, thinkingSettings]
  );

  // permission mode（TUI Shift+Tab 的 web 镜像）：状态 + 初始读取在
  // usePermissionMode；notice 反馈留在 App（走 chat.pushNotice）。
  const perm = usePermissionMode();
  const cyclePermMode = useCallback(async () => {
    try {
      const next = await perm.cycle();
      chat.pushNotice(`权限模式：${permissionModeLabel(next)}`);
    } catch (e) {
      chat.pushNotice(
        `模式切换失败：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }, [chat, perm]);

  // Permission polling is only active while a turn is in flight AND we have a
  // session id. When the dialog appears, it sits at the top of the message
  // stream (decided by the ChatView composition order — rendered above the
  // list so users cannot miss it).
  const conversationId = chat.session?.conversation_id ?? null;
  const isSending = chat.phase === "sending";
  const askPolling = useAsksPolling(conversationId, isSending);
  // #358 T8: 子代理状态栏轮询（spec SC8；2.5s 间隔，镜像 useAsksPolling）。
  const subagentPolling = useSubagentsPolling(conversationId);
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

  // slash 命令路由（核心 5 子集；反馈统一走 notice 消息）。
  // 带参命令（thinking/effort）的 arg 归一化 + 值域判定 + 用法文案由
  // lib/slash resolveArgCommand / ARG_COMMAND_SPECS 数据驱动，本处只留
  // 每条命令的生效动作。
  /** 带参命令生效动作：thinking 开关 / effort 档位（值已过词表值域校验）。 */
  const applyArgSetting = (cmd: "thinking" | "effort", value: string) => {
    if (cmd === "thinking") {
      handleThinkingChange({ ...thinkingSettings, enabled: value === "on" });
      chat.pushNotice(value === "on" ? "已开启思考" : "已关闭思考");
      return;
    }
    // effort 仅在 thinking 开启时生效（toWireOverride：!enabled → mode
    // off），故一并置 enabled=true。值已过词表值域校验（ThinkingEffort 子集）。
    handleThinkingChange({ enabled: true, effort: value as ThinkingEffort });
    chat.pushNotice(`思考强度已设为 ${value}`);
  };

  const handleCommand = useCallback(
    (name: SlashCommandName, arg?: string) => {
      switch (name) {
        case "compact":
          // 对齐原压缩按钮语义：sending 中不触发，但不再静默。
          if (chat.phase === "sending") {
            chat.pushNotice("回复生成中，稍后再试");
          } else {
            void handleCompact();
          }
          break;
        case "new":
          void handleNewSession();
          break;
        case "help":
          chat.pushNotice(slashHelpText());
          break;
        case "thinking":
        case "effort": {
          const res = resolveArgCommand(name, arg);
          if (res.ok) applyArgSetting(name, res.value);
          else chat.pushNotice(res.notice);
          break;
        }
      }
    },
    // applyArgSetting 闭包捕获 chat / handleThinkingChange / thinkingSettings，
    // 三者均已在依赖列中。
    [
      chat,
      handleCompact,
      handleNewSession,
      handleThinkingChange,
      thinkingSettings,
    ]
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
          {/* 子代理状态栏（spec #358 SC8）：零子代理 → 组件返回 null，不打扰 idle 会话。 */}
          <SubagentStatusBar subagents={subagentPolling.subagents} />
          <Composer
            disabled={!chat.session || chat.phase === "loading"}
            sending={chat.phase === "sending"}
            thinkingSettings={thinkingSettings}
            onThinkingChange={handleThinkingChange}
            onSend={handleSend}
            onCommand={handleCommand}
            onNotice={chat.pushNotice}
            usage={chat.lastAnswer?.lastUsage ?? null}
            contextWindow={chat.contextWindow}
            model={chat.model}
            permissionModeLabel={
              perm.mode !== null ? permissionModeLabel(perm.mode) : null
            }
            onPermissionModeToggle={() => {
              void cyclePermMode();
            }}
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
