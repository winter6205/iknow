/**
 * serve-workspace T7a — ChatApp orchestration (review fix M6 slimming)。
 *
 * 历史: 该文件原 549 行, ChatApp 长方法 + 60+ 行 workspace handler 散布。
 * T7a 把：
 *  - useWorkspaceActions hook（handleNewSession / handleCreateInWorkspace /
 *    handleSelect / autoOpenedRef effect）→ `hooks/use-workspace-actions.ts`。
 *  - useSlashCommands hook（handleCommand + applyArgSetting + handleSkillLoad）
 *    → `hooks/use-slash-commands.ts`。
 *  - useChatCompact（/compact handler）→ `hooks/use-chat-compact.ts`。
 *  - usePermissionModeToggle（perm cycle）→ `hooks/use-permission-mode-toggle.ts`。
 *  - useRewindConfirm（rewind picker confirm 副作用）→ `hooks/use-rewind-confirm.ts`。
 *  - <ChatSidebarContainer> → `components/ChatSidebarContainer.tsx`。
 *  - <ChatMainDialogs> + useMcpReload → `components/ChatMainDialogs.tsx`。
 *  - <ChatFooter> → `components/ChatFooter.tsx`。
 *
 * 本文件保留 ChatApp 的核心 orchestration（state / hooks 装配 / 三个状态
 * 分支的路由）。T4-T6 行为契约不变。
 */
import { useCallback, useEffect, useState } from "react";
import * as api from "./api/client";
import { AppShell } from "./components/AppShell";
import { ChatFooter } from "./components/ChatFooter";
import { ChatHeader } from "./components/ChatHeader";
import { ChatMainDialogs, useMcpReload } from "./components/ChatMainDialogs";
import { ChatSidebarContainer } from "./components/ChatSidebarContainer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PermissionDialog } from "./components/PermissionDialog";
import { StateBlock } from "./components/StateBlock";
import { useAsksPolling } from "./hooks/useAsksPolling";
import { useChatCompact } from "./hooks/use-chat-compact";
import { usePermissionMode } from "./hooks/usePermissionMode";
import { usePermissionModeToggle } from "./hooks/use-permission-mode-toggle";
import { useRewindConfirm } from "./hooks/use-rewind-confirm";
import { useSessionChat } from "./hooks/useSessionChat";
import { useSlashCommands } from "./hooks/use-slash-commands";
import { useSubagentsPolling } from "./hooks/useSubagentsPolling";
import { useWorkspace } from "./hooks/useWorkspace";
import { useWorkspaceActions } from "./hooks/use-workspace-actions";
import type { McpServerStatus, McpTool, SkillSummary } from "./api/types";
import type { WebRewindTarget } from "./lib/rewind-targets";
import { permissionModeLabel } from "./lib/permission-mode";
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
  const ws = useWorkspace();
  const {
    workspaceOpen,
    setWorkspaceOpen,
    sidebarSignal,
    bumpSidebar,
    handleNewSession,
    handleCreateInWorkspace,
    handleSelect,
  } = useWorkspaceActions(chat, ws);
  const [collapsed, setCollapsed] = useState(
    () => window.matchMedia(NARROW_QUERY).matches
  );
  const [thinkingSettings, setThinkingSettings] = useState<ThinkingSettings>(
    () => loadThinkingSettings()
  );
  const handleThinkingChange = useCallback((next: ThinkingSettings) => {
    setThinkingSettings(next);
    saveThinkingSettings(next);
  }, []);
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<readonly McpServerStatus[]>([]);
  const [mcpTools, setMcpTools] = useState<readonly McpTool[]>([]);
  const [mcpReloading, setMcpReloading] = useState(false);
  const [rewindTargets, setRewindTargets] = useState<
    ReadonlyArray<WebRewindTarget> | undefined
  >(undefined);
  const [rewindIndex, setRewindIndex] = useState(0);

  useEffect(() => {
    void api
      .listSkills()
      .then((res) => setSkills(res.skills))
      .catch(() => setSkills([]));
  }, []);

  const { handleCompact } = useChatCompact(chat);
  const handleSend = useCallback(
    (text: string) => chat.sendMessage(text, toWireOverride(thinkingSettings)),
    [chat, thinkingSettings]
  );
  const perm = usePermissionMode();
  const cyclePermMode = usePermissionModeToggle(chat, perm);
  const conversationId = chat.session?.conversation_id ?? null;
  const isSending = chat.phase === "sending";
  const askPolling = useAsksPolling(conversationId, isSending);
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

  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setCollapsed(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const header = (
    <ChatHeader
      phase={chat.phase}
      healthLabel={chat.healthLabel}
      workspaceBound={ws.bound}
      workspaceRoot={ws.root}
      onOpenWorkspacePicker={() => setWorkspaceOpen(true)}
    />
  );

  const reloadMcp = useMcpReload({
    chat,
    setMcpServers,
    setMcpTools,
    setMcpReloading,
  });
  const confirmRewind = useRewindConfirm({
    chat,
    rewindTargets,
    rewindIndex,
    setRewindTargets,
  });
  const { handleCommand, handleSkillLoad } = useSlashCommands({
    chat,
    perm,
    thinkingSettings,
    skills,
    setCollapsed,
    bumpSidebar,
    setWorkspaceOpen,
    setMcpServers,
    setMcpTools,
    setMcpOpen,
    setRewindTargets,
    setRewindIndex,
    handleThinkingChange,
    handleCompact,
    handleNewSession,
  });
  const side = (
    <ChatSidebarContainer
      chat={chat}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      sidebarSignal={sidebarSignal}
      onSelect={handleSelect}
      onNewSession={handleNewSession}
      onCreateInWorkspace={handleCreateInWorkspace}
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
        <ChatMainDialogs
          chat={chat}
          ws={ws}
          permissionDialog={permissionDialog}
          mcpOpen={mcpOpen}
          mcpServers={mcpServers}
          mcpTools={mcpTools}
          mcpReloading={mcpReloading}
          reloadMcp={reloadMcp}
          closeMcp={() => setMcpOpen(false)}
          rewindTargets={rewindTargets}
          rewindIndex={rewindIndex}
          selectRewind={setRewindIndex}
          confirmRewind={confirmRewind}
          closeRewind={() => setRewindTargets(undefined)}
          workspaceOpen={workspaceOpen}
          closeWorkspace={() => setWorkspaceOpen(false)}
        />
      }
      footer={
        <ChatFooter
          chat={chat}
          ws={ws}
          subagents={subagentPolling.subagents}
          thinkingSettings={thinkingSettings}
          onThinkingChange={handleThinkingChange}
          handleSend={handleSend}
          handleCommand={handleCommand}
          handleSkillLoad={handleSkillLoad}
          skills={skills}
          permissionModeLabel={
            perm.mode !== null ? permissionModeLabel(perm.mode) : null
          }
          cyclePermMode={cyclePermMode}
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
