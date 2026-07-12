import type { ChatUiMessage } from "../hooks/useSessionChat";
import { shortId } from "../lib/format";
import styles from "./MessageBubble.module.css";

export type MessageBubbleProps = {
  message: ChatUiMessage;
};

function sourceKey(
  s: { chunk_id: string; offset?: [number, number] },
  index: number,
): string {
  if (s.offset) {
    return `${s.chunk_id}:${s.offset[0]}-${s.offset[1]}`;
  }
  return `${s.chunk_id}#${index}`;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <article className={`${styles.bubble} ${styles.user}`} data-role="user">
        <header className={styles.head}>
          <span className={styles.role}>你</span>
        </header>
        <div className={styles.body}>{message.text}</div>
      </article>
    );
  }

  const { answer } = message;
  const sources = answer.source_spans ?? [];
  const govStatus = String(answer.governance_status).toLowerCase();

  return (
    <article className={`${styles.bubble} ${styles.agent}`} data-role="agent">
      <header className={styles.head}>
        <span className={styles.role}>Agent</span>
        <span className={styles.metaLine}>
          hops {answer.hops_used}
          {" · "}
          snap {shortId(answer.snapshot_id, 8)}
          {" · "}
          <span className={styles.gov} data-status={govStatus}>
            {answer.governance_status || "—"}
          </span>
        </span>
      </header>
      <div className={styles.body}>{message.text}</div>
      {sources.length > 0 ? (
        <footer className={styles.sources}>
          <h3 className={styles.sourcesTitle}>来源</h3>
          <ol className={styles.sourceList}>
            {sources.map((s, i) => (
              <li key={sourceKey(s, i)} className={styles.sourceItem}>
                <span className={styles.chunkId} title={s.chunk_id}>
                  {shortId(s.chunk_id, 12)}
                </span>
                {s.quote ? (
                  <span className={styles.quote}>「{s.quote}」</span>
                ) : null}
              </li>
            ))}
          </ol>
        </footer>
      ) : null}
    </article>
  );
}
