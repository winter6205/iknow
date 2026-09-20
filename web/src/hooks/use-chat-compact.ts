/**
 * ChatApp `/compact` command hook.
 *
 * Extracts the ~20-line `handleCompact` so ChatApp's main file does not carry
 * business error handling. Behavioral contract unchanged.
 */
import { useCallback, useState } from "react";
import type { useSessionChat } from "./useSessionChat";

type ChatApi = ReturnType<typeof useSessionChat>;

export function useChatCompact(chat: ChatApi): {
  readonly compacting: boolean;
  readonly handleCompact: () => Promise<void>;
} {
  const [compacting, setCompacting] = useState(false);
  const handleCompact = useCallback(async () => {
    if (compacting) return;
    setCompacting(true);
    try {
      const didCompact = await chat.compact();
      // web's useSessionChat.compact() still
      // returns a plain boolean (keeping the SessionChatApi surface narrow), so
      // this hook uses simplified two-branch wording; TUI reason precision
      // lives in src/tui/app.tsx compactNoticeFor. didCompact=true covers both
      // success paths (windowed / full_summary); the false branch means "no
      // compactable context" — never cite the auto threshold. The web
      // api.compactSession sends no signal (no cancel entry); on abort the hub
      // returns 200 + {compacted:false, cancelled:true} without throwing, so
      // that response also lands here merged with messages_too_few (an
      // accepted web-side decision); catch only sees real network/server failures.
      chat.pushNotice(
        didCompact
          ? "已压缩上下文"
          : chat.session
            ? "没有可压缩的上下文，会话保持原样。"
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
  return { compacting, handleCompact };
}
