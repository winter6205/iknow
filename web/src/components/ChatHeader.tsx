import type { ReactNode, Ref } from "react";
import type { ChatPhase } from "../hooks/useSessionChat";
import { WorkspaceChip } from "./WorkspaceChip";

export type ChatHeaderProps = {
  phase: ChatPhase;
  healthLabel: string | null;
  /** serve-workspace T5: picker 绑定态（chip 展示）。 */
  workspaceBound: boolean;
  workspaceRoot: string | null;
  onOpenWorkspacePicker: () => void;
  /**
   * serve-workspace T8: 当前 active session 的 workspaceRoot（来自
   * session-list look-up by currentConversationId）。Chip 显示优先级
   * 高于 workspaceRoot — 一旦用户在工作空间内, chip 就显示该会话所在
   * 根名, 不再退到 unbound 警告色。
   */
  activeWorkspaceRoot?: string | null;
  /**
   * serve-workspace T8: chip button ref — 父层 App 把此 ref 传给 popover
   * dismiss hook, Esc / outside-click 后焦点回 chip (a11y 红线)。
   */
  chipButtonRef?: Ref<HTMLButtonElement>;
  /**
   * serve-workspace T8: chip + popover 容器 ref — popover 内部 hit-testing
   * 用 (outside-click 时跳过该 ref 内元素)。
   */
  workspacePopoverRef?: Ref<HTMLDivElement>;
  /**
   * serve-workspace T8: popover 内容插槽 — 父层 App 渲染 <WorkspacePicker>
   * 并通过该 prop 注入。popover 仅在 `workspaceOpen` 时显示, App 用 CSS
   * 锚定 (absolute top-full right-0 mt-1 z-50)。
   */
  workspacePopover?: ReactNode;
  /** serve-workspace T8: popover 显示态 — 控制插槽渲染。 */
  workspaceOpen?: boolean;
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

export function ChatHeader({
  phase,
  healthLabel,
  workspaceBound,
  workspaceRoot,
  activeWorkspaceRoot,
  onOpenWorkspacePicker,
  chipButtonRef,
  workspacePopoverRef,
  workspacePopover,
  workspaceOpen,
}: ChatHeaderProps) {
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

      {/* Right meta cluster: trace panel entry + chip (with popover) + status */}
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
        {/* T8: chip wrapper `relative` 让 popover 用 absolute 锚定 chip 右上。
            workspacePopoverRef 透传给外层 div, 供 outside-click hit-testing。 */}
        <div ref={workspacePopoverRef} className="relative">
          <WorkspaceChip
            bound={workspaceBound}
            root={workspaceRoot}
            activeWorkspaceRoot={activeWorkspaceRoot}
            onOpen={onOpenWorkspacePicker}
            buttonRef={chipButtonRef}
          />
          {workspaceOpen && workspacePopover ? (
            <div className="absolute right-0 top-full z-50 mt-1">
              {workspacePopover}
            </div>
          ) : null}
        </div>
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
