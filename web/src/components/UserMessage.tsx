import { staggerStyle } from "../lib/stagger";

export type UserMessageProps = {
  text: string;
  staggerIndex?: number;
};

// Right-aligned user bubble (Variant A decision #11). No role label.
export function UserMessage({ text, staggerIndex = 0 }: UserMessageProps) {
  return (
    <article
      aria-label="用户提问"
      className="self-end ml-auto max-w-[min(88%,34rem)] rounded-card border border-line bg-user px-[17px] py-[11px] text-ink shadow-bubble animate-message-in"
      style={staggerStyle(staggerIndex)}
    >
      <p className="m-0 text-[14px] leading-[1.55]">{text}</p>
    </article>
  );
}
