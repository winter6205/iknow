/**
 * serve-workspace T7a — SessionSidebar 的三态展示组件。
 *
 * loading / error / empty 三个无状态展示组件。它们与 useSessionList 紧耦合
 * （errorMsg / retry 由 SessionSidebar 注入），但本身零 prop drilling —
 * 抽出来便于 SessionSidebar.tsx 收敛到 ≤300 行。
 */
import { FOCUS_RING } from "../../lib/ui";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function LoadingState() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      role="status"
      aria-live="polite"
    >
      <div
        className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-accent"
        aria-hidden="true"
      />
      <p className="m-0 text-sm text-ink-2">加载会话列表…</p>
    </div>
  );
}

export function ErrorState({
  detail,
  onRetry,
}: {
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      role="alert"
    >
      <p className="m-0 text-sm font-medium text-danger">无法加载会话列表</p>
      <p className="m-0 break-all text-xs text-ink-3">{detail}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cx(
          "mt-1 rounded-pill border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-medium text-accent",
          "transition-colors duration-[160ms] ease-soft hover:border-accent hover:bg-accent hover:text-ink",
          FOCUS_RING
        )}
      >
        重试
      </button>
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <p className="m-0 text-sm text-ink-2">暂无会话</p>
      <p className="m-0 text-xs text-ink-3">发送消息或点击「新会话」开始。</p>
    </div>
  );
}
