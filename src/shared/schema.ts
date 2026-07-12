/**
 * Machine-consumable TypeScript contracts for iknow 4 tools.
 * Source of truth: docs/iknow-spec/docs/protocol/tool-schema.md (v0.1)
 *
 * RRF_K = 60 per architecture.md (dual-index fusion).
 */

/** Reciprocal Rank Fusion constant (architecture dual-index RRF). */
export const RRF_K = 60 as const;

// ---------------------------------------------------------------------------
// Shared enums / primitives
// ---------------------------------------------------------------------------

export type FreshnessLevel = "fresh" | "stale" | "any";
export type FactStatus = "compiled" | "outdated" | "missing";
export type RetrieveIndex = "chunk" | "fact" | "both";
export type Verdict = "supported" | "partially_supported" | "unsupported";
export type CompileStatus = "ok" | "partial" | "failed";
export type GovernanceAction =
  | "check_freshness"
  | "detect_conflict"
  | "snapshot_status";
export type GovernanceStatus = "ok" | "stale" | "conflict";

/** Allowed session caller roles (schema truth; CLI / harness must match). */
export const CALLER_ROLES = ["employee", "manager", "admin"] as const;
export type CallerRole = (typeof CALLER_ROLES)[number];

export function isCallerRole(value: unknown): value is CallerRole {
  return (
    typeof value === "string" &&
    (CALLER_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Parse a role string to CallerRole.
 * Throws Error when value is not in CALLER_ROLES (CLI / harness entry).
 */
export function parseCallerRole(value: unknown): CallerRole {
  if (isCallerRole(value)) {
    return value;
  }
  throw new Error(
    `Invalid caller role: ${JSON.stringify(value)}; expected one of: ${CALLER_ROLES.join("|")}`,
  );
}

// ---------------------------------------------------------------------------
// Session (harness-injected; not a tool input)
// ---------------------------------------------------------------------------

export interface SessionContext {
  caller_role: CallerRole;
  /** Test / eval flag: force governance path timeout (edge-006). */
  simulate_governance_timeout?: boolean;
}

// ---------------------------------------------------------------------------
// 1. kb_retrieve
// ---------------------------------------------------------------------------

export interface PriorChunk {
  chunk_id: string;
  /** From prior retrieve summary; not raw chunk text. */
  summary: string;
}

export interface KbRetrieveFilter {
  doc_type?: string;
  /** ISO8601 range [start, end]. */
  time_range?: [string, string];
  /** A-filter online freshness check; default any if omitted. */
  freshness_level?: FreshnessLevel;
}

export interface KbRetrieveInput {
  query: string;
  prior_chunks?: PriorChunk[];
  /** Default 'both'. */
  index?: RetrieveIndex;
  filter?: KbRetrieveFilter;
}

export interface Chunk {
  chunk_id: string;
  doc_id: string;
  doc_type: string;
  summary: string;
  source_ref: string;
  chunk_version: string;
  fact_status: FactStatus;
}

export interface KbRetrieveOutput {
  chunks: Chunk[];
  /** Set when A-filter governance timed out (degraded path). */
  governance_degraded?: boolean;
  degradation_note?: string;
}

// ---------------------------------------------------------------------------
// 2. kb_verify_citation
// ---------------------------------------------------------------------------

export interface SourceSpan {
  chunk_id: string;
  quote?: string;
  offset?: [number, number];
}

export interface KbVerifyCitationInput {
  /** Single-sentence claim extracted from the draft. */
  claim: string;
  source_span: SourceSpan;
}

export interface KbVerifyCitationOutput {
  /** Pure three-state; no continuous confidence. */
  verdict: Verdict;
  /** Closest non-supporting span when unsupported. */
  evidence_span?: string;
  chunk_version: string;
  /** Doc/chunk version policy signal. */
  version_stale?: boolean;
}

// ---------------------------------------------------------------------------
// 3. kb_compile
// ---------------------------------------------------------------------------

export interface KbCompileInput {
  doc_id: string;
  /** Agent-provided content for on-demand compile; pipeline may omit. */
  content?: string;
  force?: boolean;
  /** Required: dedupe / skip recompile. */
  content_hash: string;
  document_version: string;
}

export interface CompiledFact {
  entity: string;
  attributes: { key: string; value: string }[];
  source_span: string;
  source_chunk_id: string;
  source_doc_id: string;
  chunk_version: string;
}

export interface KbCompileOutput {
  facts: CompiledFact[];
  compile_status: CompileStatus;
  /** Eval / human audit only; not a runtime gate. */
  hallucination_flag?: boolean;
}

// ---------------------------------------------------------------------------
// 4. kb_governance
// ---------------------------------------------------------------------------

export interface KbGovernanceInput {
  action: GovernanceAction;
  doc_id?: string;
  chunk_id?: string;
}

export interface KbGovernanceOutput {
  status: GovernanceStatus;
  /**
   * = hash({doc_id, document_version, check_type, result, ts})
   * Includes document_version for version consistency.
   */
  snapshot_id: string;
  /** ISO8601 */
  checked_at: string;
  chunk_version?: string;
  requires_approval?: boolean;
  approval_reason?: string;
}

// ---------------------------------------------------------------------------
// Snapshot payload used to build snapshot_id
// ---------------------------------------------------------------------------

export interface SnapshotPayload {
  doc_id: string;
  document_version: string;
  check_type: string;
  result: string;
  ts: string;
}

// ---------------------------------------------------------------------------
// Agent answer envelope (G2)
// ---------------------------------------------------------------------------

/** Structured tool call log (trajectory-eval-spec §1.2). */
export interface ToolCallLog {
  tool: string;
  args: Record<string, unknown>;
  /** 1-based ordinal in this answer run (not a wall-clock timestamp). */
  ordinal: number;
}

export interface IknowAnswer {
  text: string;
  source_spans: SourceSpan[];
  /** G2 required on every final answer. */
  snapshot_id: string;
  governance_status: GovernanceStatus;
  /** Tool names only (compat). Prefer tool_calls for trajectory eval. */
  tool_trace: string[];
  /** Structured call log for trajectory scoring. */
  tool_calls: ToolCallLog[];
  hops_used: number;
  notes?: string[];
}

/**
 * Multi-turn opts for Agent.answer (host→agent; does not change tool schema).
 * - prior_chunks: protocol bridge into first kb_retrieve (both modes)
 * - history: LLM-only short window of final user/assistant turns
 */
export interface AgentAnswerOpts {
  prior_chunks?: PriorChunk[];
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}
