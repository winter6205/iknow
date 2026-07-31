// evidence?: reserved — Session API wire 当前不携带 G2 字段（spec 022 SC6/SC8）。
// 组件结构预留，G2 重新上 wire 由单独 ticket 闭合。
// 见 plans/092-web-tailwind-rewrite.md §0 + ADR-0002。

import { useState, type ReactNode } from "react";
import type { TurnAnswerDto } from "../api/types";
import { staggerStyle } from "../lib/stagger";
import { GOV_LABEL, shortSnap } from "./evidence";
import type { EvidenceProjection, GovernanceStatus } from "./evidence";
import { EvidencePanel } from "./EvidencePanel";

export type AgentCardProps = {
  text: string;
  /** Reserved for future wiring; not rendered in Variant A (decision #17/#18). */
  answer?: TurnAnswerDto;
  /** Evidence projection reserved (see file header). Wire 不携带 G2，当前不渲染。 */
  evidence?: EvidenceProjection;
  /** Reserved override for body rendering (decision #19); default = plain <p>。 */
  renderBody?: (text: string) => ReactNode;
  staggerIndex?: number;
};

// Three-state governance palette (issue #92 #13-16).
const GOV_CLASS: Record<GovernanceStatus, string> = {
  ok: "bg-accent-soft text-ok",
  stale: "bg-warn-soft text-warn",
  conflict: "bg-danger-soft text-danger",
};

type EvidenceBlockProps = {
  spans: NonNullable<EvidenceProjection["sourceSpans"]>;
  isConflict: boolean;
};

// Local owner of single-expand index for the evidence chips within one card.
function EvidenceBlock({ spans, isConflict }: EvidenceBlockProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <section
      aria-label="相关来源"
      className="mt-[18px] border-t border-line pt-[15px]"
    >
      <div className="mb-[9px] font-mono text-[10px] tracking-[0.03em] text-ink-3">
        相关来源
      </div>
      <div className="flex flex-col gap-[7px]">
        {spans.map((span, index) => (
          <EvidencePanel
            key={`${span.chunk_id}-${index}`}
            span={span}
            isConflict={isConflict}
            isExpanded={expandedIndex === index}
            onToggle={() =>
              setExpandedIndex((current) => (current === index ? null : index))
            }
          />
        ))}
      </div>
    </section>
  );
}

// `answer` is accepted (contract) but not rendered — Variant A decisions #17/#18
// (no tool_calls/tool_trace, no JSON toggle). Left undeclared here to avoid an
// unused binding; it remains part of AgentCardProps for future wiring.
export function AgentCard({
  text,
  evidence,
  renderBody,
  staggerIndex = 0,
}: AgentCardProps) {
  const spans = evidence?.sourceSpans;
  const governance = evidence?.governanceStatus;
  const snapshotId = evidence?.snapshotId;
  const hopsUsed = evidence?.hopsUsed;
  const notes = evidence?.notes;
  const isConflict = governance === "conflict";

  const hasFooter =
    governance !== undefined ||
    (snapshotId !== undefined && hopsUsed !== undefined);

  return (
    <article
      aria-label="知识库回答"
      className="w-full self-stretch rounded-card border border-line bg-surface px-5 py-4 shadow-bubble animate-message-in"
      style={staggerStyle(staggerIndex)}
    >
      {/* Claims / body (decision #19: renderBody reserved, default plain text). */}
      <div className="text-[15px] leading-[1.7] text-ink [overflow-wrap:anywhere]">
        {renderBody ? renderBody(text) : <p className="m-0">{text}</p>}
      </div>

      {/* Notes (quiet, mono). */}
      {notes && notes.length > 0 ? (
        <div className="mt-[10px] font-mono text-[11px] leading-[1.5] text-ink-3">
          {notes.map((note, i) => (
            <p key={`${i}-${note}`} className="m-0">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      {/* Source spans → chips + expand panels (#13-16). */}
      {spans && spans.length > 0 ? (
        <EvidenceBlock spans={spans} isConflict={isConflict} />
      ) : null}

      {/* Footer: governance badge + snapshot/hops (#15). */}
      {hasFooter ? (
        <footer className="mt-[18px] flex flex-wrap items-center gap-[9px] border-t border-line pt-[13px]">
          {governance !== undefined ? (
            <span
              className={`whitespace-nowrap rounded-pill px-[9px] py-[5px] text-[11px] leading-tight ${GOV_CLASS[governance]}`}
            >
              {GOV_LABEL[governance]}
            </span>
          ) : null}
          {snapshotId !== undefined && hopsUsed !== undefined ? (
            <span className="whitespace-nowrap font-mono text-[10px] leading-snug text-ink-3">
              snap {shortSnap(snapshotId)} · hops {hopsUsed}
            </span>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
