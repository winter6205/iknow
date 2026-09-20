/**
 * ChatApp slash-command routing hook.
 *
 * Consolidates the ~140-line `handleCommand` + `applyArgSetting` +
 * `handleSkillLoad` from ChatApp, so the main file no longer carries per-case
 * inline IIFEs / notice strings and stays ≤ 200 lines.
 *
 * Behavioral contract: 100% equivalent to the original inline handlers; only the carrier changed.
 */
import { useCallback, useRef } from "react";
import * as api from "../api/client";
import {
  resolveArgCommand,
  slashHelpText,
  type SlashCommandName,
} from "../lib/slash";

// SSOT mirror across the web ↔ src workspace boundary. `web/` is a separate
// Vite workspace (`web/tsconfig.json` includes only `web/src`, no path map to
// `../src/`), so it cannot import `SKILL_LOAD_PREFIX` / `buildSkillLoadText`
// from `src/harness/skill/body.ts`. Keep the byte-level shape identical to
// `src/tui/app.tsx` and `src/session-api/hub.ts`: any literal change must be
// synchronized in all three places.
const SKILL_LOAD_PREFIX_WEB = '[skill-load name="';
import { formatSessionInfo } from "../lib/session-info";
import type { WebRewindTarget } from "../lib/rewind-targets";
import {
  toWireOverride,
  type ThinkingEffort,
  type ThinkingSettings,
} from "../lib/thinking-settings";
import type { usePermissionMode } from "./usePermissionMode";
import type { useSessionChat } from "./useSessionChat";

type ChatApi = ReturnType<typeof useSessionChat>;
type PermApi = ReturnType<typeof usePermissionMode>;

export type UseSlashCommandsArgs = {
  readonly chat: ChatApi;
  readonly perm: PermApi;
  readonly thinkingSettings: ThinkingSettings;
  readonly skills: ReadonlyArray<{ readonly name: string }>;
  readonly setCollapsed: (updater: (c: boolean) => boolean) => void;
  readonly bumpSidebar: () => void;
  readonly setWorkspaceOpen: (open: boolean) => void;
  readonly setMcpServers: (
    servers: ReadonlyArray<import("../api/types").McpServerStatus>
  ) => void;
  readonly setMcpTools: (
    tools: ReadonlyArray<import("../api/types").McpTool>
  ) => void;
  readonly setMcpOpen: (open: boolean) => void;
  readonly setRewindTargets: (
    targets: ReadonlyArray<WebRewindTarget> | undefined
  ) => void;
  readonly setRewindIndex: (n: number) => void;
  readonly handleThinkingChange: (next: ThinkingSettings) => void;
  readonly handleCompact: () => Promise<void>;
  readonly compacting: boolean;
  readonly handleNewSession: () => Promise<void>;
};

export type UseSlashCommandsResult = {
  readonly handleCommand: (name: SlashCommandName, arg?: string) => void;
  readonly handleSkillLoad: (name: string, remainder: string) => Promise<void>;
};

/**
 * /thinking and /effort subcommand handling (applyArgSetting): both mutate
 * thinkingSettings (effort also turns enabled on) and push a notice.
 */
function applyArgSetting(
  args: UseSlashCommandsArgs,
  cmd: "thinking" | "effort",
  value: string
): void {
  if (cmd === "thinking") {
    args.handleThinkingChange({
      ...args.thinkingSettings,
      enabled: value === "on",
    });
    args.chat.pushNotice(value === "on" ? "已开启思考" : "已关闭思考");
    return;
  }
  // effort only takes effect while thinking is on (toWireOverride: !enabled →
  // mode off), so set enabled=true too. The value passed lexicon-range
  // validation (a ThinkingEffort subset).
  args.handleThinkingChange({
    enabled: true,
    effort: value as ThinkingEffort,
  });
  args.chat.pushNotice(`思考强度已设为 ${value}`);
}

export function useSlashCommands(
  args: UseSlashCommandsArgs
): UseSlashCommandsResult {
  const {
    chat,
    perm,
    thinkingSettings,
    skills,
    handleCompact,
    compacting,
    handleNewSession,
  } = args;

  const continueInFlight = useRef(false);

  const handleCommand = useCallback(
    (name: SlashCommandName, arg?: string) => {
      switch (name) {
        case "compact":
          if (chat.phase === "sending") {
            chat.pushNotice("回复生成中，稍后再试");
          } else {
            void handleCompact();
          }
          break;
        case "continue": {
          if ((arg ?? "").trim() !== "") {
            chat.pushNotice("用法：/continue");
            break;
          }
          if (
            chat.phase === "sending" ||
            compacting ||
            continueInFlight.current
          ) {
            chat.pushNotice("请先等待当前回复完成（busy_stop_first）");
            break;
          }
          continueInFlight.current = true;
          void chat
            .continue()
            .catch((e: unknown) => {
              chat.pushNotice(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
              continueInFlight.current = false;
            });
          break;
        }
        case "new":
          void handleNewSession();
          break;
        case "sessions":
          args.setCollapsed(() => false);
          args.bumpSidebar();
          break;
        case "help":
          chat.pushNotice(slashHelpText(skills.map((s) => s.name)));
          break;
        case "info":
          chat.pushNotice(
            formatSessionInfo({
              conversationId: chat.session?.conversation_id ?? null,
              turnCount: chat.session?.turn_count ?? 0,
              jsonMode: chat.session?.json_mode ?? false,
              phase: chat.phase,
              contextWindow: chat.contextWindow,
              lastUsage: chat.lastAnswer?.lastUsage ?? null,
              thinkingEnabled: thinkingSettings.enabled,
              effort: thinkingSettings.effort,
            })
          );
          break;
        case "quit":
        case "exit":
          chat.pushNotice("浏览器中关闭标签页即可退出（无独立进程）。");
          break;
        case "mcp":
          void (async () => {
            try {
              const [st, tools] = await Promise.all([
                api.listMcp(),
                api.listMcpTools(),
              ]);
              args.setMcpServers(st.servers);
              args.setMcpTools(tools.tools);
              args.setMcpOpen(true);
            } catch (e) {
              chat.pushNotice(
                `MCP 看板失败：${e instanceof Error ? e.message : String(e)}`
              );
            }
          })();
          break;
        case "workspace":
          args.setWorkspaceOpen(true);
          break;
        case "rewind":
          if (chat.phase === "sending") {
            chat.pushNotice("回复生成中，稍后再试");
            break;
          }
          void (async () => {
            const id = chat.session?.conversation_id;
            if (!id) {
              chat.pushNotice("当前无会话可回退");
              return;
            }
            try {
              const { targets } = await api.listRewindTargets(id);
              if (targets.length === 0) {
                chat.pushNotice("Nothing to rewind to yet.");
                return;
              }
              args.setRewindIndex(0);
              args.setRewindTargets(targets);
            } catch (e) {
              chat.pushNotice(
                `无法加载回退锚点：${
                  e instanceof Error ? e.message : String(e)
                }`
              );
            }
          })();
          break;
        case "graph": {
          // Send args verbatim: value domain and wording are decided server-side in applyGraphCommand.
          const raw = (arg ?? "").trim();
          const parts = raw === "" ? [] : raw.split(/\s+/);
          void api
            .applyGraphMode(parts)
            .then((res) => {
              chat.pushNotice(res.message);
            })
            .catch((e: unknown) => {
              // EXIT: on 400/404 notice only; never fall back to sending a normal message.
              chat.pushNotice(e instanceof Error ? e.message : String(e));
            });
          break;
        }
        case "thinking":
        case "effort": {
          const res = resolveArgCommand(name, arg);
          if (res.ok) applyArgSetting(args, name, res.value);
          else chat.pushNotice(res.notice);
          break;
        }
      }
    },
    [
      chat,
      perm,
      handleCompact,
      compacting,
      handleNewSession,
      args,
      skills,
      thinkingSettings,
    ]
  );

  const handleSkillLoad = useCallback(
    async (name: string, remainder: string) => {
      try {
        const { body } = await api.getSkillBody(name);
        const tail = remainder.length > 0 ? `\n\n${remainder}` : "";
        const sendText = `${SKILL_LOAD_PREFIX_WEB}${name}"]\n${body}${tail}`;
        const displayText = `[加载技能 ${name}]${
          remainder.length > 0 ? ` ${remainder}` : ""
        }`;
        await chat.sendMessage(
          sendText,
          toWireOverride(thinkingSettings),
          displayText
        );
      } catch (e) {
        chat.pushNotice(
          `加载技能失败：${e instanceof Error ? e.message : String(e)}`
        );
      }
    },
    [chat, thinkingSettings]
  );

  return { handleCommand, handleSkillLoad };
}
