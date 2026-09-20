/**
 * ChatApp orchestration.
 *
 * Everything but orchestration lives outside ChatApp:
 *  - workspace handlers (handleNewSession / handleCreateInWorkspace /
 *    handleSelect) → `hooks/use-workspace-actions.ts`.
 *  - slash routing (handleCommand + applyArgSetting + handleSkillLoad)
 *    → `hooks/use-slash-commands.ts`.
 *  - /compact → `hooks/use-chat-compact.ts`; perm cycle →
 *    `hooks/use-permission-mode-toggle.ts`; rewind confirm →
 *    `hooks/use-rewind-confirm.ts`.
 *  - layout pieces → `components/ChatSidebarContainer.tsx`,
 *    `components/ChatMainDialogs.tsx` (+ useMcpReload),
 *    `components/ChatFooter.tsx`.
 *
 * Context-aware chip + picker-as-popover:
 *  - top-level `useSessionList` sharing the session list, so the active
 *    session's workspaceRoot can feed WorkspaceChip;
 *  - chip button ref + popover wrapper ref passed to ChatHeader (popover
 *    anchor); `usePopoverDismiss` watches Esc / outside-click and returns
 *    focus to the chip on close;
 *  - <WorkspacePicker> rendered through ChatHeader's `workspacePopover` slot
 *    (positioning owned by ChatHeader's wrapper div).
 *
 * What remains here is ChatApp's core orchestration (state / hook wiring /
 * routing across the three status branches).
 */
import { useCallback, useEffect, useState } from "react";
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
import { useSkills } from "./hooks/use-skills";
import { useSlashCommands } from "./hooks/use-slash-commands";
import { useSubagentsPolling } from "./hooks/useSubagentsPolling";
import { useWorkspace } from "./hooks/useWorkspace";
import { useWorkspaceActions } from "./hooks/use-workspace-actions";
import { useWorkspacePopover } from "./hooks/use-workspace-popover";
import type { McpServerStatus, McpTool } from "./api/types";
import type { WebRewindTarget } from "./lib/rewind-targets";
import { permissionModeLabel } from "./lib/permission-mode";
import {
  loadThinkingSettings,
  saveThinkingSettings,
  toWireOverride,
  type ThinkingSettings,
} from "./lib/thinking-settings";

/** Viewport width below which the sidebar starts collapsed. */
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
  // Keep the loadable-skill surface "hot at hand" — fetch on mount and
  // refetch when the window regains focus, so skills installed while away
  // appear in `/` candidates on return. See hooks/use-skills.ts for the trade-off.
  const skills = useSkills();
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
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpServers, setMcpServers] = useState<readonly McpServerStatus[]>([]);
  const [mcpTools, setMcpTools] = useState<readonly McpTool[]>([]);
  const [mcpReloading, setMcpReloading] = useState(false);
  const [rewindTargets, setRewindTargets] = useState<
    ReadonlyArray<WebRewindTarget> | undefined
  >(undefined);
  const [rewindIndex, setRewindIndex] = useState(0);

  // The whole popover concern (refs / dismiss listeners /
  // active-session lookup / slot JSX) lives in `useWorkspacePopover`; ChatApp
  // only consumes the returned fields and stays pure orchestration.
  const popover = useWorkspacePopover(
    {
      workspaceOpen,
      setWorkspaceOpen,
      sidebarSignal,
    },
    chat,
    ws
  );

  const { compacting, handleCompact } = useChatCompact(chat);
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

  // Popover slot — already built inside useWorkspacePopover, passed
  // straight through to ChatHeader. Visual positioning (absolute top-full
  // right-0 z-50) is owned by the wrapper div inside ChatHeader.
  const header = (
    <ChatHeader
      phase={chat.phase}
      healthLabel={chat.healthLabel}
      workspaceBound={ws.bound}
      workspaceRoot={ws.root}
      activeWorkspaceRoot={popover.activeWorkspaceRoot}
      chipButtonRef={popover.chipButtonRef}
      workspacePopoverRef={popover.popoverWrapperRef}
      workspacePopover={popover.workspacePopover}
      workspaceOpen={popover.open}
      onOpenWorkspacePicker={popover.onToggleOpen}
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
    compacting,
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
