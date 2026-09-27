/**
 * Evidence projection types (kept for future wire-field expansion).
 * The current Session API wire (TurnAnswerDto = { finalText, stopReason?,
 * turnCount, outcome?, outputLimitNotice?, … }) carries none of these fields —
 * `stopReason` is optional because a turn with no terminal outcome record
 * reports `outcome: { terminal: "unknown" }` instead; components reserve the
 * shape via optional props.
 */
export type GovernanceStatus = "ok" | "stale" | "conflict";

export interface SourceSpanView {
  readonly chunk_id: string;
  readonly quote?: string;
  readonly doc_id?: string;
  readonly source_ref?: string;
}

export interface EvidenceProjection {
  readonly sourceSpans?: readonly SourceSpanView[];
  readonly governanceStatus?: GovernanceStatus;
  readonly snapshotId?: string;
  readonly hopsUsed?: number;
  readonly notes?: readonly string[];
}

export const GOV_LABEL: Record<GovernanceStatus, string> = {
  ok: "已核验",
  stale: "已过期",
  conflict: "存在冲突",
};

/** Strip the "snap_" prefix, show the first n chars. */
export function shortSnap(id: string, n = 8): string {
  const bare = id.startsWith("snap_") ? id.slice(5) : id;
  return bare.slice(0, n);
}
