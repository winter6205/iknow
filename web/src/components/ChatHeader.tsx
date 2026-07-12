import type { AgentMode, CallerRole, SessionSummary } from "../api/types";
import type { ChatPhase } from "../hooks/useSessionChat";
import { shortId } from "../lib/format";
import styles from "./ChatHeader.module.css";

export type ChatHeaderProps = {
  session: SessionSummary | null;
  phase: ChatPhase;
  healthLabel: string | null;
  mode: AgentMode;
  role: CallerRole;
  onModeChange: (mode: AgentMode) => void;
  onRoleChange: (role: CallerRole) => void;
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

function parseAgentMode(value: string): AgentMode | null {
  if (value === "deterministic" || value === "llm") return value;
  return null;
}

function parseCallerRole(value: string): CallerRole | null {
  if (value === "employee" || value === "manager" || value === "admin") {
    return value;
  }
  return null;
}

export function ChatHeader({
  session,
  phase,
  healthLabel,
  mode,
  role,
  onModeChange,
  onRoleChange,
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
        <label className={styles.field} htmlFor="iknow-mode">
          <span className={styles.fieldLabel}>模式</span>
          <select
            id="iknow-mode"
            className={styles.select}
            value={mode}
            disabled={busy}
            onChange={(e) => {
              const next = parseAgentMode(e.target.value);
              if (next) onModeChange(next);
            }}
          >
            <option value="deterministic">deterministic</option>
            <option value="llm">llm</option>
          </select>
        </label>

        <label className={styles.field} htmlFor="iknow-role">
          <span className={styles.fieldLabel}>角色</span>
          <select
            id="iknow-role"
            className={styles.select}
            value={role}
            disabled={busy}
            onChange={(e) => {
              const next = parseCallerRole(e.target.value);
              if (next) onRoleChange(next);
            }}
          >
            <option value="employee">employee</option>
            <option value="manager">manager</option>
            <option value="admin">admin</option>
          </select>
        </label>

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
