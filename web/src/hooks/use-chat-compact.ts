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
  return { compacting, handleCompact };
}
