import { FOCUS_RING } from "../lib/ui";

export type StateBlockKind = "empty" | "loading" | "error";

export type StateBlockProps = {
  kind: StateBlockKind;
  title: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
};

function a11yForKind(kind: StateBlockKind): {
  role?: "alert" | "status";
  "aria-live"?: "polite";
} {
  if (kind === "error") {
    // role=alert is assertive; do not also set aria-live=polite
    return { role: "alert" };
  }
  if (kind === "loading") {
    return { role: "status", "aria-live": "polite" };
  }
  // empty: no live region
  return {};
}

// Variant A palette: empty/loading use ink-2/ink-3 muted text, error uses danger.
const TITLE_COLOR: Record<StateBlockKind, string> = {
  empty: "text-ink-2",
  loading: "text-ink-2",
  error: "text-danger",
};

const DETAIL_COLOR: Record<StateBlockKind, string> = {
  empty: "text-ink-3",
  loading: "text-ink-3",
  error: "text-ink-2",
};

export function StateBlock({
  kind,
  title,
  detail,
  onRetry,
  retryLabel = "重试",
}: StateBlockProps) {
  const a11y = a11yForKind(kind);
  const showRetry = kind === "error" && Boolean(onRetry);

  return (
    <div
      role={a11y.role}
      aria-live={a11y["aria-live"]}
      data-kind={kind}
      className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 py-12 text-center animate-fade-in"
    >
      {kind === "loading" ? (
        <span
          aria-hidden="true"
          className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent"
        />
      ) : null}
      <p className={`m-0 text-lg font-semibold ${TITLE_COLOR[kind]}`}>
        {title}
      </p>
      {detail ? (
        <p
          className={`m-0 max-w-md whitespace-pre-wrap break-words text-sm ${DETAIL_COLOR[kind]}`}
        >
          {detail}
        </p>
      ) : null}
      {showRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-1 rounded-pill border border-line bg-accent-soft px-4 py-1.5 text-sm font-medium text-accent transition-all duration-200 ease-[var(--ease-soft)] hover:bg-accent hover:text-surface hover:border-accent ${FOCUS_RING}`}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
