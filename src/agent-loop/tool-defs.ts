/**
 * OpenAI tools protocol definitions for the 4 iknow KB tools.
 * Field shapes align with src/shared/schema.ts (tool-schema v0.1).
 */
import type { LlmToolDef } from "./llm-client.js";

export const KB_TOOL_DEFS: LlmToolDef[] = [
  {
    type: "function",
    function: {
      name: "kb_retrieve",
      description:
        "Retrieve enterprise KB chunks via dual-index RRF. Use for every user question before answering. Returns summaries + chunk_ids only (not raw invention).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Search query (user intent, concise).",
          },
          prior_chunks: {
            type: "array",
            description: "Optional prior hits for multi-hop retrieve (summary only).",
            items: {
              type: "object",
              properties: {
                chunk_id: { type: "string" },
                summary: { type: "string" },
              },
              required: ["chunk_id", "summary"],
            },
          },
          index: {
            type: "string",
            enum: ["chunk", "fact", "both"],
            description: "Default both.",
          },
          filter: {
            type: "object",
            properties: {
              doc_type: { type: "string" },
              time_range: {
                type: "array",
                items: { type: "string" },
                minItems: 2,
                maxItems: 2,
                description: "ISO8601 [start, end]",
              },
              freshness_level: {
                type: "string",
                enum: ["fresh", "stale", "any"],
              },
            },
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_verify_citation",
      description:
        "Verify a single-sentence claim against a source span. Returns supported | partially_supported | unsupported (no continuous confidence).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: {
            type: "string",
            description: "One claim sentence extracted from the draft answer.",
          },
          source_span: {
            type: "object",
            properties: {
              chunk_id: { type: "string" },
              quote: { type: "string" },
              offset: {
                type: "array",
                items: { type: "number" },
                minItems: 2,
                maxItems: 2,
              },
            },
            required: ["chunk_id"],
          },
        },
        required: ["claim", "source_span"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_compile",
      description:
        "On-demand compile of a document into structured facts. Requires content_hash and document_version for dedupe.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          doc_id: { type: "string" },
          content: {
            type: "string",
            description: "Optional document text for agent-driven compile.",
          },
          force: { type: "boolean" },
          content_hash: {
            type: "string",
            description: "Required hash of content for skip/recompile.",
          },
          document_version: {
            type: "string",
            description: "Required document version binding.",
          },
        },
        required: ["doc_id", "content_hash", "document_version"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kb_governance",
      description:
        "Governance checks: freshness, conflict detection, or snapshot_status. Final answers MUST include snapshot_id from snapshot_status (G2).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["check_freshness", "detect_conflict", "snapshot_status"],
          },
          doc_id: { type: "string" },
          chunk_id: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
];

/** Tools that consume hop budget (max_hops). */
export const HOP_TOOLS = new Set(["kb_retrieve", "kb_verify_citation"]);

export const TOOL_NAMES = [
  "kb_retrieve",
  "kb_verify_citation",
  "kb_compile",
  "kb_governance",
] as const;

export type KbToolName = (typeof TOOL_NAMES)[number];

export function isKbToolName(name: string): name is KbToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}
