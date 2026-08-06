import { useEffect, useRef } from "react";
import type { ChatUiMessage } from "../hooks/useSessionChat";
import { AgentCard } from "./AgentCard";
import { SendingIndicator } from "./SendingIndicator";
import { StateBlock } from "./StateBlock";
import { UserMessage } from "./UserMessage";

export type MessageListProps = {
  messages: ChatUiMessage[];
  emptyHint?: string;
  /** True while a request is in flight — renders the in-progress bubble at the bottom (T4). */
  sending?: boolean;
};

// Flat per-message render under Turn semantics: user (idx*2) + agent (idx*2+1),
// single 26px conversation gap (Stage 2 brief). Evidence is reserved — wire 不携带,
// MessageList passes no evidence prop, so evidence UI 当前不触发（见 AgentCard 顶注）。
export function MessageList({
  messages,
  emptyHint = "发送问题开始对话。",
  sending = false,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-12 animate-fade-in">
        <StateBlock kind="empty" title="暂无消息" detail={emptyHint} />
      </div>
    );
  }

  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="对话记录"
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6"
    >
      <ul className="m-0 mx-auto flex w-full max-w-[var(--chat-max)] list-none flex-col gap-[18px] p-0">
        {messages.map((m, idx) => (
          <li key={m.id}>
            {m.role === "user" ? (
              <UserMessage text={m.text} staggerIndex={idx * 2} />
            ) : (
              <AgentCard
                text={m.text}
                answer={m.answer}
                staggerIndex={idx * 2 + 1}
              />
            )}
          </li>
        ))}
        {sending ? (
          <li key="__sending__">
            <SendingIndicator staggerIndex={messages.length * 2} />
          </li>
        ) : null}
      </ul>
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}
