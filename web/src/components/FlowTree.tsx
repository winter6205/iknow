/* FlowTree — tree topology: the 7 stations sit in a horizontal row on top,
   events drop vertically into their station's subtree.
   Ported from prototype web/trace-prototype/src/variants/FlowTree.tsx (#291).
   Data source is now TraceEvent[] projected from the real API (see lib/flowTree.ts). */
import type { ReactNode } from "react";
import type { TraceEvent, StationId } from "../lib/flowTree";
import { STATIONS, fmtDur, statusTone, isErr } from "../lib/flowTree";

interface Props {
  events: TraceEvent[];
  selectedIdx: number | null;
  onSelect: (idx: number) => void;
}

const ICONS: Record<string, string> = {
  session:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  llm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 7l3-3 3 3-3 3-3-3zM10 14l-3 3-3-3 3-3 3 3zM7 10l3-3 3 3-3 3-3-3z"/></svg>',
  sandbox:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M7 6V4a5 5 0 0 1 10 0v2"/></svg>',
  permission:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z"/></svg>',
  violation:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4l9 16H3l9-16z"/><path d="M12 10v5M12 18v.1"/></svg>',
  subagent:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M12 7.5v3M12 10.5l-4.5 6M12 10.5l4.5 6"/></svg>',
};

/* Layout constants (px, logical canvas) */
const WIDTH = 1100;
const NODE_W = 152;
const NODE_H = 64;
const ROW_GAP = 22;
const BADGE_D = 36;
const TURN0_TOP = 110;
const TURN1_TOP = 360;
const TOTAL_H = 720;
/* Station trunk: hung on the column's left side (column pitch 183.3, node width 152, gap 31.3); TRUNK_OFF offsets it from the column centre */
const TRUNK_OFF = 84;
const RAIL_Y = BADGE_D / 2;
/* Row-gap / corridor routing constants */
const ROW_GAP_Y = TURN0_TOP + NODE_H + ROW_GAP / 2; // 185 (between turn-0 upper and lower rows)
const CORRIDOR_A_LO = TURN0_TOP + 2 * NODE_H + ROW_GAP + 15; // 275 (lower edge of the inter-turn corridor)
const CORRIDOR_B = TURN1_TOP + 2 * NODE_H + ROW_GAP + 20; // 530 (corridor below turn 1)

const stationIdx = (s: StationId) => STATIONS.findIndex((x) => x.id === s);
const colCenter = (i: number) => (WIDTH * (i + 0.5)) / STATIONS.length;

interface Pos {
  left: number;
  top: number;
  cx: number;
  cy: number;
  trunkX: number;
}

export function FlowTree({ events, selectedIdx, onSelect }: Props) {
  /* Absolute position per event: turn 0 in the upper band, turn 1 in the lower band; stacked by idx within each column with a gap */
  const pos = new Map<number, Pos>();
  for (const s of STATIONS) {
    const col = events
      .filter((e) => e.station === s.id)
      .sort((a, b) => a.idx - b.idx);
    const cx = colCenter(stationIdx(s.id));
    /* Trunk on the left for every column (at WIDTH the leftmost trunk still fits inside the canvas) */
    const trunkX = cx - TRUNK_OFF < 0 ? cx + TRUNK_OFF : cx - TRUNK_OFF;
    const place = (list: TraceEvent[], topOffset: number) =>
      list.forEach((e, i) => {
        const top = topOffset + i * (NODE_H + ROW_GAP);
        pos.set(e.idx, {
          left: cx - NODE_W / 2,
          top,
          cx,
          cy: top + NODE_H / 2,
          trunkX,
        });
      });
    place(
      col.filter((e) => e.turn === 0),
      TURN0_TOP
    );
    // Real traces usually span more turns than the prototype's 2; stack every
    // turn >= 1 into the lower band (TURN1_TOP) so turn >= 2 events still get a
    // position (otherwise pos.get would return undefined).
    place(
      col.filter((e) => e.turn >= 1),
      TURN1_TOP
    );
  }

  /* Station → event arcs: node top corner → column trunk → badge centre */
  const stationArcs = events.map((e) => {
    const p = pos.get(e.idx)!;
    const color = isErr(e.status) ? "var(--color-danger)" : "var(--color-line)";
    const cornerX = p.trunkX < p.cx ? p.left : p.left + NODE_W;
    return (
      <polyline
        key={"a" + e.idx}
        points={`${cornerX},${p.top} ${p.trunkX},${p.top} ${p.trunkX},${RAIL_Y} ${p.cx},${RAIL_Y}`}
        fill="none"
        stroke={color}
        strokeWidth={isErr(e.status) ? 2.2 : 1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  });

  /* Sequence arcs: adjacent events in time order; error chains turn fully red + bolder */
  const seqArcs: ReactNode[] = [];
  for (let k = 0; k < events.length - 1; k++) {
    const a = events[k];
    const b = events[k + 1];
    const pa = pos.get(a.idx)!;
    const pb = pos.get(b.idx)!;
    const isErrLine = isErr(a.status) || isErr(b.status);
    const color = isErrLine ? "var(--color-danger)" : "var(--color-line)";
    const strokeW = isErrLine ? 2.5 : 1.4;
    let d: string;
    if (a.station === b.station) {
      /* Same column: node bottom → next node top (small vertical S; not hit by current data) */
      const y1 = pa.top + NODE_H;
      const y2 = pb.top;
      d = `M ${pa.cx} ${y1} C ${pa.cx} ${y1 + 16}, ${pa.cx} ${y2 - 16}, ${pa.cx} ${y2}`;
    } else if (pb.cx > pa.cx) {
      /* Cross-column left→right: right edge → next node's left edge (small horizontal S, same row height) */
      const x1 = pa.left + NODE_W;
      const x2 = pb.left;
      const dx = Math.max(8, (x2 - x1) / 2);
      d = `M ${x1} ${pa.cy} C ${x1 + dx} ${pa.cy}, ${x2 - dx} ${pb.cy}, ${x2} ${pb.cy}`;
    } else if (a.turn !== b.turn) {
      /* Cross-column right→left across turns: routed through the inter-turn corridor (y 260..360) */
      const y1 = pa.top + NODE_H;
      const y2 = pb.top;
      const c = (y1 + y2) / 2;
      d = `M ${pa.cx} ${y1} C ${pa.cx} ${c}, ${pb.cx} ${c}, ${pb.cx} ${y2}`;
    } else if (a.turn === 0 && pa.top < pb.top) {
      /* Turn-0 upper → lower row: through the small inter-row corridor (avoids sweeping over same-column lower nodes) */
      d = `M ${pa.cx} ${pa.top + NODE_H} C ${pa.cx} ${ROW_GAP_Y}, ${pb.cx} ${ROW_GAP_Y}, ${pb.cx} ${pb.top}`;
    } else if (a.turn === 0) {
      /* Turn-0 lower → lower row: along the inter-turn corridor's lower edge */
      d = `M ${pa.cx} ${pa.top + NODE_H} C ${pa.cx} ${CORRIDOR_A_LO}, ${pb.cx} ${CORRIDOR_A_LO}, ${pb.cx} ${pb.top + NODE_H}`;
    } else {
      /* Turn 1: detour via the bottom corridor (above the canvas edge) */
      d = `M ${pa.cx} ${pa.top + NODE_H} C ${pa.cx} ${CORRIDOR_B}, ${pb.cx} ${CORRIDOR_B}, ${pb.cx} ${pb.top + NODE_H}`;
    }
    seqArcs.push(
      <path
        key={"s" + k}
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeW}
        strokeLinecap="round"
      />
    );
  }

  /* Error-chain background band: one pale-red mask covering the region the error chain traverses */
  const errIdxs = events.filter((e) => isErr(e.status));
  let band: ReactNode = null;
  if (errIdxs.length > 0) {
    const xs = errIdxs.map((e) => pos.get(e.idx)!.left);
    const bandX = Math.min(...xs) - 14;
    const bandW = Math.max(...xs) + NODE_W + 14 - bandX;
    const bandY = TURN1_TOP - 12;
    const bandH = CORRIDOR_B + 40 - bandY;
    band = (
      <rect
        key="err-band"
        x={bandX}
        y={bandY}
        width={bandW}
        height={bandH}
        rx={14}
        fill="rgba(176,74,58,0.045)"
        stroke="rgba(176,74,58,0.13)"
        strokeDasharray="4 5"
      />
    );
  }

  return (
    <div style={{ position: "relative", width: WIDTH, height: TOTAL_H }}>
      {/* SVG connector layer */}
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: WIDTH,
          height: TOTAL_H,
          pointerEvents: "none",
        }}
      >
        {band}
        {stationArcs}
        {seqArcs}
      </svg>

      {/* Top station badges (one per column) */}
      {STATIONS.map((s) => {
        const cx = colCenter(stationIdx(s.id));
        const hasErr = events.some(
          (e) => e.station === s.id && isErr(e.status)
        );
        return (
          <div
            key={s.id}
            style={{
              position: "absolute",
              left: cx - BADGE_D / 2,
              top: 0,
              width: BADGE_D,
              height: BADGE_D,
              borderRadius: "50%",
              background: "var(--color-surface)",
              border: `1.5px solid ${hasErr ? "var(--color-danger)" : "var(--color-line)"}`,
              color: hasErr ? "var(--color-danger)" : "var(--color-ink-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.02em",
              zIndex: 2,
            }}
          >
            {s.label}
          </div>
        );
      })}

      {/* Event nodes */}
      {events.map((e) => {
        const p = pos.get(e.idx)!;
        const tone = statusTone(e.status);
        const st = STATIONS.find((x) => x.id === e.station)!;
        const cls = [
          "tp-node",
          "status-" + tone,
          selectedIdx === e.idx ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={e.idx}
            className={cls}
            style={{ left: p.left, top: p.top }}
            onClick={() => onSelect(e.idx)}
          >
            <div className="r1">
              <span
                className="ic"
                dangerouslySetInnerHTML={{ __html: ICONS[e.station] }}
              />
              <span>
                T{e.turn + 1} · {st.label}
              </span>
            </div>
            <div className="name">{e.label}</div>
            <div className="r3">
              <span className="stat">
                <span className="d" />
                {e.status}
              </span>
              <span className="dur">{fmtDur(e.durationMs)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
