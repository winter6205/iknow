import { staggerStyle } from "../lib/stagger";

// In-progress thinking bubble: lives at the bottom of MessageList while a
// request is in flight (chat.phase === "sending"). role="status" announces
// the live region politely. The three dots use a staggered pulse animation
// defined in tokens.css (--animate-think-pulse).
export type SendingIndicatorProps = {
  staggerIndex?: number;
};

export function SendingIndicator({ staggerIndex = 0 }: SendingIndicatorProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="正在思考"
      className="w-full self-stretch rounded-card border border-line bg-surface px-5 py-4 shadow-bubble animate-message-in"
      style={staggerStyle(staggerIndex)}
    >
      <div className="flex items-center gap-[8px] text-ink-2">
        <span className="font-mono text-[12.5px] tracking-[0.02em]">
          思考中
        </span>
        <span aria-hidden="true" className="flex items-center gap-[3px]">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-[5px] w-[5px] rounded-full bg-accent animate-think-pulse"
              style={{ animationDelay: `${i * 180}ms` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
