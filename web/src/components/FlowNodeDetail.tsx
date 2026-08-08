/* 右侧详情面板：选中事件的 keyvals 字段 + 原始 payload
   移植自 prototype web/trace-prototype/src/components/SideRight.tsx。 */
import type { TraceEvent } from "../lib/flowTree";
import { STATIONS, fmtDur, statusTone } from "../lib/flowTree";

export type FlowNodeDetailProps = {
  event: TraceEvent | null;
};

export function FlowNodeDetail({ event }: FlowNodeDetailProps) {
  if (!event) {
    return (
      <aside className="tp-side-r">
        <div className="placeholder">
          ← 点击事件节点查看详情
          <div className="hint">每个事件都属于 lifecycle 的一环</div>
        </div>
      </aside>
    );
  }
  const tone = statusTone(event.status);
  const stn = STATIONS.find((s) => s.id === event.station);
  return (
    <aside className="tp-side-r">
      <p className="eyebrow">
        T{event.turn + 1} · {stn?.label}
      </p>
      <h2 className="title">{event.label}</h2>
      <p className="sub">
        idx #{event.idx} · {event.fields["kind"] ?? event.station}
      </p>

      <div className="stat-row">
        <div className="stat">
          <div className="k">状态</div>
          <div className={`v ${tone}`}>{event.status}</div>
        </div>
        <div className="stat">
          <div className="k">时长</div>
          <div className="v">{fmtDur(event.durationMs)}</div>
        </div>
      </div>

      <h3>字段</h3>
      <dl className="fields">
        {Object.entries(event.fields).map(([k, v]) => (
          <div key={`${event.idx}-${k}`} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>

      <h3>RAW JSON</h3>
      <pre className="raw">
        {JSON.stringify(
          {
            idx: event.idx,
            turn: event.turn,
            station: event.station,
            status: event.status,
            label: event.label,
            durationMs: event.durationMs,
            ...event.fields,
          },
          null,
          2
        )}
      </pre>
    </aside>
  );
}
