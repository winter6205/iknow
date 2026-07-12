import styles from "./StateBlock.module.css";

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
      className={`${styles.block} ${styles[kind]}`}
      role={a11y.role}
      aria-live={a11y["aria-live"]}
      data-kind={kind}
    >
      <p className={styles.title}>{title}</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {kind === "loading" ? (
        <div className={styles.spinner} aria-hidden="true" />
      ) : null}
      {showRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
