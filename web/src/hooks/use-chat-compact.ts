/**
 * serve-workspace T7a — ChatApp `/compact` 命令 hook (review fix M6)。
 *
 * 把 ChatApp 内 ~20 行的 `handleCompact` 函数抽到本 hook，避免 ChatApp 主
 * 文件承载业务错误处理。T5-T6 行为契约不变。
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
      // plan T4:web 端 useSessionChat.compact() 仍只返 boolean(避免扩
      // SessionChatApi 公开 surface + 打破 tests/web 既有断言),hook 走
      // 简化二分支文案。TUI 4 分支精度由 src/tui/app.tsx 承担。didCompact
      // 涵盖 windowed / full_summary 两条压缩成功路径;false 涵盖
      // below_token_threshold / messages_too_few / cancelled 三态,后者已
      // 走 try/catch 抛错分支(cancelled 路径 runFullCompact 抛错)。
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
  return { compacting, handleCompact };
}
