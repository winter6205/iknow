import styles from "./StateBlock.module.css";

export type StateBlockKind = "empty" | "loading" | "error";

export type StateBlockProps = {
  kind: StateBlockKind;
  title: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
};

export function StateBlock({
  kind,
  title,
  detail,
  onRetry,
  retryLabel = "重试",
}: StateBlockProps) {
  const role = kind === "error" ? "alert" : kind === "loading" ? "status" : undefined;
  const live = kind === "error" || kind === "loading" ? "polite" : undefined;

  return (
    <div
      className={`${styles.block} ${styles[kind]}`}
      role={role}
      aria-live={live}
      data-kind={kind}
    >
      <p className={styles.title}>{title}</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {kind === "loading" ? (
        <div className={styles.spinner} aria-hidden="true" />
      ) : null}
      {onRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
