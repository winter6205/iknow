/**
 * ChatApp footer assembly.
 *
 * Extracts the <SubagentStatusBar> + <Composer> wiring out of ChatApp so its
 * main file sheds ~25 lines of JSX.
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
      {/* Subagent status bar: returns null with zero subagents, so idle sessions stay undisturbed. */}
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
