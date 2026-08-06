/**
 * In-process knowledge store entity shapes.
 * Independent of tool contracts (kb_* retired 023; tools now via harness ACI).
 */

export type Freshness = "fresh" | "stale" | "revoked";
export type Sensitivity = "normal" | "sensitive" | "competitor_external";

export interface DocumentRecord {
  doc_id: string;
  document_version: string;
  doc_type: string;
  title: string;
  freshness: Freshness;
  sensitivity: Sensitivity;
  /** Optional full body when loaded for compile. */
  content?: string;
  content_hash?: string;
  /** ISO8601 when known. */
  effective_at?: string;
  updated_at?: string;
  /** Sensitive surface requires approval before answer. */
  requires_approval?: boolean;
}

export interface ChunkRecord {
  chunk_id: string;
  doc_id: string;
  chunk_version: string;
  text: string;
  summary: string;
  source_ref: string;
  /** Keywords from compile fact-arm ranking; never returned as fact text. */
  fact_keywords?: string[];
}

export interface FactRecord {
  fact_id: string;
  entity: string;
  attributes: { key: string; value: string }[];
  source_span: string;
  source_chunk_id: string;
  source_doc_id: string;
  chunk_version: string;
  content_hash: string;
  document_version: string;
}
