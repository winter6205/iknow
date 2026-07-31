import type { ChatPhase } from "../hooks/useSessionChat";

export type ChatHeaderProps = {
  phase: ChatPhase;
  healthLabel: string | null;
};

function statusFor(phase: ChatPhase): { label: string; dotClass: string } {
  switch (phase) {
    case "loading":
      return { label: "连接中", dotClass: "bg-warn" };
    case "sending":
      return { label: "生成中", dotClass: "bg-warn" };
    case "error":
      return { label: "连接异常", dotClass: "bg-danger" };
    case "ready":
    default:
      return { label: "已连接", dotClass: "bg-ok" };
  }
}

export function ChatHeader({ phase, healthLabel }: ChatHeaderProps) {
  const status = statusFor(phase);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-5">
      {/* Brand wordmark — h1 restores page heading hierarchy; m-0 neutralizes
          the h1 default block margins so the visual footprint matches span. */}
      <div className="flex items-center gap-2">
        <span className="text-base leading-none text-accent" aria-hidden="true">
          ◆
        </span>
        <h1 className="m-0 text-base font-medium tracking-[-0.015em] text-ink">
          iknow
        </h1>
      </div>

      {/* Connection status */}
      <span
        className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.02em] text-ink-3"
        title={healthLabel ?? undefined}
        aria-live="polite"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass}`}
          aria-hidden="true"
        />
        {status.label}
      </span>
    </header>
  );
}
