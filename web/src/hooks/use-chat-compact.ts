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
      // plan manual-compact-trigger T2:web 端 useSessionChat.compact() 仍只
      // 返 boolean(避免扩 SessionChatApi 公开 surface),hook 走简化二分支
      // 文案。TUI reason 精度由 src/tui/app.tsx compactNoticeFor 承担。
      // didCompact=true 涵盖 windowed / full_summary 两条压缩成功路径;false
      // 只剩 messages_too_few 语义(T1 后手动路径 no-op 不含
      // below_token_threshold;cancelled 路径 runFullCompact 抛错已走
      // catch 分支),文案语义是「没有可压缩的上下文」,禁止引用 auto 阈值。
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
