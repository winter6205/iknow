// evidence?: reserved — Session API wire 当前不携带这些字段，组件结构预留。
//
// thinking/toolCalls（T4）：wire 已携带，组件按视觉层级渲染——
// thinking 在上（折叠展开），body 居中（GFM markdown），toolCalls 在下（单展开）。

import { useState, type ReactNode } from "react";
import type { TurnAnswerDto } from "../api/types";
import { staggerStyle } from "../lib/stagger";
import { GOV_LABEL, shortSnap } from "./evidence";
import type { EvidenceProjection, GovernanceStatus } from "./evidence";
import { EvidencePanel } from "./EvidencePanel";
import { MarkdownBody } from "./MarkdownBody";
import { StopNotice } from "./StopNotice";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallList } from "./ToolCallList";

export type AgentCardProps = {
  text: string;
  /** Optional TurnAnswerDto — T4 renders `thinking` + `toolCalls` projections. */
  answer?: TurnAnswerDto;
  /** Evidence projection reserved (see file header). 当前不渲染。 */
  evidence?: EvidenceProjection;
  /** Optional override for body rendering; default = GFM markdown with code highlighting (decision #19/T3). */
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

export function AgentCard({
  text,
  answer,
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

  const thinking = answer?.thinking;
  const toolCalls = answer?.toolCalls;
  const activity = answer?.activity;
  const hasActivity = activity !== undefined && activity.length > 0;

  return (
    <article
      aria-label="知识库回答"
      className="w-full self-stretch rounded-card border border-line bg-surface px-5 py-4 shadow-bubble animate-message-in"
      style={staggerStyle(staggerIndex)}
    >
      {/* thinking 折叠展开（默认收起，aria-expanded + 键盘可达）。 */}
      {thinking ? (
        <ThinkingBlock
          thinking={thinking}
          {...(answer?.thinkingMs !== undefined
            ? { thinkingMs: answer.thinkingMs }
            : {})}
        />
      ) : null}

      {/* Ordered activity replaces the legacy body/tools pair only when non-empty. */}
      {hasActivity ? (
        <div className="flex flex-col">
          {activity.map((item, index) =>
            item.type === "text" ? (
              <div
                key={`activity-text-${index}`}
                className="text-[15px] leading-[1.7] text-ink [overflow-wrap:anywhere]"
              >
                {renderBody ? (
                  renderBody(item.text)
                ) : (
                  <MarkdownBody text={item.text} />
                )}
              </div>
            ) : (
              <ToolCallList
                key={`activity-tool-${item.tool.id}-${index}`}
                toolCalls={[item.tool]}
              />
            )
          )}
        </div>
      ) : (
        <>
          {/* Claims / body (T3: default = GFM markdown with code highlighting; renderBody overrides for tests). */}
          <div className="text-[15px] leading-[1.7] text-ink [overflow-wrap:anywhere]">
            {renderBody ? renderBody(text) : <MarkdownBody text={text} />}
          </div>
        </>
      )}

      {/* Stop-reason notice (non-completed) + turnCount meta info (T6) — quiet mono row below the body. */}
      <StopNotice
        stopReason={answer?.stopReason}
        turnCount={answer?.turnCount}
      />

      {/* Legacy toolCalls stay after the stop notice; ordered activity renders tools inline above. */}
      {!hasActivity && toolCalls && toolCalls.length > 0 ? (
        <ToolCallList toolCalls={toolCalls} />
      ) : null}

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
