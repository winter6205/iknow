import type { IknowAnswer, SessionSummary } from "../api/types";
import { prettyJson, SHORT_CONV, SHORT_SNAP, shortId } from "../lib/format";
import styles from "./G2Panel.module.css";

export type G2PanelProps = {
  session: SessionSummary | null;
  answer: IknowAnswer | null;
};

export function G2Panel({ session, answer }: G2PanelProps) {
  return (
    <aside className={styles.panel} aria-label="G2 证据包">
      <header className={styles.header}>
        <h2 className={styles.title}>G2 证据包</h2>
        <p className={styles.lead}>
          每轮回答的 snapshot / sources / governance / tools
        </p>
      </header>

      <section className={styles.section} aria-labelledby="g2-session">
        <h3 id="g2-session" className={styles.sectionTitle}>
          会话
        </h3>
        <dl className={styles.dl}>
          <div className={styles.row}>
            <dt>conversation</dt>
            <dd title={session?.conversation_id}>
              {shortId(session?.conversation_id, SHORT_CONV)}
            </dd>
          </div>
          <div className={styles.row}>
            <dt>role</dt>
            <dd>{session?.caller_role ?? "—"}</dd>
          </div>
          <div className={styles.row}>
            <dt>mode</dt>
            <dd>{session?.mode ?? "—"}</dd>
          </div>
          <div className={styles.row}>
            <dt>turns</dt>
            <dd>{session?.turn_count ?? 0}</dd>
          </div>
          <div className={styles.row}>
            <dt>prior</dt>
            <dd>{session?.prior_count ?? 0}</dd>
          </div>
          <div className={styles.row}>
            <dt>embeddings</dt>
            <dd>{session ? (session.embeddings ? "on" : "off") : "—"}</dd>
          </div>
          <div className={styles.row}>
            <dt>json_mode</dt>
            <dd>{session ? (session.json_mode ? "on" : "off") : "—"}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="g2-envelope">
        <h3 id="g2-envelope" className={styles.sectionTitle}>
          最近一轮 G2
        </h3>
        {!answer ? (
          <p className={styles.empty}>尚无 agent 回答；发送消息后显示信封字段。</p>
        ) : (
          <G2Envelope answer={answer} />
        )}
      </section>
    </aside>
  );
}

function G2Envelope({ answer }: { answer: IknowAnswer }) {
  const g2 = {
    snapshot_id: answer.snapshot_id,
    source_spans: answer.source_spans ?? [],
    governance_status: answer.governance_status,
    tool_calls: answer.tool_calls ?? [],
    tool_trace: answer.tool_trace ?? [],
    hops_used: answer.hops_used,
    notes: answer.notes ?? [],
  };

  return (
    <>
      <dl className={styles.dl}>
        <div className={styles.row}>
          <dt>snapshot_id</dt>
          <dd title={answer.snapshot_id}>
            {shortId(answer.snapshot_id, SHORT_SNAP)}
          </dd>
        </div>
        <div className={styles.row}>
          <dt>governance</dt>
          <dd
            className={styles.gov}
            data-status={String(answer.governance_status).toLowerCase()}
          >
            {answer.governance_status || "—"}
          </dd>
        </div>
        <div className={styles.row}>
          <dt>source_spans</dt>
          <dd>{answer.source_spans?.length ?? 0}</dd>
        </div>
        <div className={styles.row}>
          <dt>tool_calls</dt>
          <dd>{answer.tool_calls?.length ?? 0}</dd>
        </div>
        <div className={styles.row}>
          <dt>hops_used</dt>
          <dd>{answer.hops_used}</dd>
        </div>
      </dl>
      <pre className={styles.json} tabIndex={0}>
        {prettyJson(g2)}
      </pre>
    </>
  );
}
