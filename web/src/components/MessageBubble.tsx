import type { ChatUiMessage } from "../hooks/useSessionChat";
import styles from "./MessageBubble.module.css";

export type MessageBubbleProps = {
  message: ChatUiMessage;
};

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

  return (
    <article className={`${styles.bubble} ${styles.agent}`} data-role="agent">
      <header className={styles.head}>
        <span className={styles.role}>Agent</span>
        <span className={styles.metaLine}>
          {answer.stopReason}
          {" · "}
          turns {answer.turnCount}
        </span>
      </header>
      <div className={styles.body}>{message.text}</div>
    </article>
  );
}
