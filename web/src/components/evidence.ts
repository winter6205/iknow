/**
 * G2 证据投影类型（issue #92 #13-16）。
 * reserved：当前 Session API wire 不携带这些字段（spec 022 SC6/SC8 已退役 G2，
 * TurnAnswerDto = { finalText, stopReason, turnCount }）。组件经可选 props 预留结构，
 * G2 重新上 wire 由单独 ticket 闭合。见 plans/092-web-tailwind-rewrite.md §0 + ADR-0002。
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

/** 去 "snap_" 前缀，取前 n 字符短显。 */
export function shortSnap(id: string, n = 8): string {
  const bare = id.startsWith("snap_") ? id.slice(5) : id;
  return bare.slice(0, n);
}
