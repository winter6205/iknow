/**
 * serve-workspace T7a — ChatApp 底部 footer (review fix M6)。
 *
 * 把 ChatApp 内 `<SubagentStatusBar>` + `<Composer>` 的装配从 ChatApp 抽到
 * 本组件，避免 ChatApp 主文件承载 ~25 行 JSX。T5-T6 行为契约不变。
 */
import type { ReactNode } from "react";
import { Composer } from "./Composer";
import { SubagentStatusBar } from "./SubagentStatusBar";
import type { SubagentStatus } from "../api/types";
import type { ThinkingSettings } from "../lib/thinking-settings";
import type { SkillSummary } from "../api/types";
import type { useSessionChat } from "../hooks/useSessionChat";

type ChatApi = ReturnType<typeof useSessionChat>;

export function ChatFooter({
  chat,
  ws,
  subagents,
  thinkingSettings,
  onThinkingChange,
  handleSend,
  handleCommand,
  handleSkillLoad,
  skills,
  permissionModeLabel,
  cyclePermMode,
}: {
  chat: ChatApi;
  ws: { readonly bound: boolean };
  subagents: ReadonlyArray<SubagentStatus>;
  thinkingSettings: ThinkingSettings;
  onThinkingChange: (next: ThinkingSettings) => void;
  handleSend: (text: string) => Promise<void> | void;
  handleCommand: (
    name: import("../lib/slash").SlashCommandName,
    arg?: string
  ) => void;
  handleSkillLoad: (name: string, remainder: string) => Promise<void>;
  skills: ReadonlyArray<SkillSummary>;
  permissionModeLabel: string | null;
  cyclePermMode: () => Promise<void>;
}): ReactNode {
  return (
    <>
      {/* 子代理状态栏（spec #358 SC8）：零子代理 → 组件返回 null，不打扰 idle 会话。 */}
      <SubagentStatusBar subagents={subagents} />
      <Composer
        disabled={!chat.session || chat.phase === "loading" || !ws.bound}
        sending={chat.phase === "sending"}
        thinkingSettings={thinkingSettings}
        onThinkingChange={onThinkingChange}
        onSend={handleSend}
        onCommand={handleCommand}
        onSkillLoad={handleSkillLoad}
        skills={skills}
        onNotice={chat.pushNotice}
        usage={chat.lastAnswer?.lastUsage ?? null}
        contextWindow={chat.contextWindow}
        model={chat.model}
        permissionModeLabel={permissionModeLabel}
        onPermissionModeToggle={() => {
          void cyclePermMode();
        }}
      />
    </>
  );
}
