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

      {/* Right meta cluster: trace panel entry + connection status */}
      <div className="flex items-center gap-3">
        {/* ADR-0020: trace inspection panel lives in-process at /trace — same
            styling as the connection status (low-frequency dev tool, meta
            area, never competes with the composer). */}
        <a
          href="/trace"
          title="Trace 检测面板（ADR-0020：与对话服务同进程）"
          className="flex items-center gap-1 font-mono text-[11px] tracking-[0.02em] text-ink-3 transition-colors hover:text-ink"
        >
          <span aria-hidden="true">▗</span>
          Trace
        </a>
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
      </div>
    </header>
  );
}
