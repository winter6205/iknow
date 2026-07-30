import type { SessionSummary } from "../api/types";
import type { ChatPhase } from "../hooks/useSessionChat";
import { shortId } from "../lib/format";
import styles from "./ChatHeader.module.css";

export type ChatHeaderProps = {
  session: SessionSummary | null;
  phase: ChatPhase;
  healthLabel: string | null;
  onReset: () => void;
  onNewSession: () => void;
};

function statusLabel(phase: ChatPhase): { text: string; tone: string } {
  switch (phase) {
    case "loading":
      return { text: "连接中", tone: "busy" };
    case "sending":
      return { text: "生成中", tone: "busy" };
    case "error":
      return { text: "错误", tone: "danger" };
    case "ready":
    default:
      return { text: "就绪", tone: "ok" };
  }
}

export function ChatHeader({
  session,
  phase,
  healthLabel,
  onReset,
  onNewSession,
}: ChatHeaderProps) {
  const status = statusLabel(phase);
  const busy = phase === "loading" || phase === "sending";
  const sessionShort = shortId(session?.conversation_id, 10);

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          ◆
        </span>
        <div className={styles.brandText}>
          <h1 className={styles.title}>iknow</h1>
          <p className={styles.subtitle}>企业知识库 Agent</p>
        </div>
      </div>

      <div className={styles.meta}>
        <span
          className={styles.status}
          data-tone={status.tone}
          title={healthLabel ?? undefined}
          aria-live="polite"
        >
          <span className={styles.dot} aria-hidden="true" />
          {status.text}
        </span>
        <span className={styles.sessionId} title={session?.conversation_id}>
          会话 {sessionShort}
        </span>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.btnGhost}
          disabled={busy || !session}
          onClick={onReset}
        >
          重置
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          disabled={busy}
          onClick={onNewSession}
        >
          新会话
        </button>
      </div>
    </header>
  );
}
