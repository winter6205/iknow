import { useEffect, useRef } from "react";
import type { ChatUiMessage } from "../hooks/useSessionChat";
import { MessageBubble } from "./MessageBubble";
import { StateBlock } from "./StateBlock";
import styles from "./MessageList.module.css";

export type MessageListProps = {
  messages: ChatUiMessage[];
  emptyHint?: string;
};

export function MessageList({
  messages,
  emptyHint = "发送问题开始对话。回答将附带 G2 证据包（snapshot / sources / governance / tools）。",
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className={styles.wrap}>
        <StateBlock kind="empty" title="暂无消息" detail={emptyHint} />
      </div>
    );
  }

  return (
    <div
      className={styles.wrap}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="对话记录"
    >
      <ul className={styles.list}>
        {messages.map((m) => (
          <li key={m.id} className={styles.item}>
            <MessageBubble message={m} />
          </li>
        ))}
      </ul>
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}
