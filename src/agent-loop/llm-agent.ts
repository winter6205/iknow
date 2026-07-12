/**
 * LLM tool-calling agent (M2): openai_tools protocol over 4 kb_* tools.
 * G2: never return without snapshot_id.
 * Hop budget: only kb_retrieve + kb_verify_citation count (max_hops default 5).
 */
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type { VectorIndex } from "../kb-retrieve/embedding/vector-index.js";
import type {
  AgentAnswerOpts,
  GovernanceStatus,
  IknowAnswer,
  PriorChunk,
  SessionContext,
  SourceSpan,
} from "../shared/schema.js";
import { IknowError, ValidationError } from "../shared/errors.js";
import { buildSnapshotId } from "../shared/hash.js";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.js";
import { MAX_HOPS } from "./loop.js";
import type { LlmChatClient, LlmMessage, LlmToolCall } from "./llm-client.js";
import { HOP_TOOLS, isKbToolName, KB_TOOL_DEFS } from "./tool-defs.js";
import { ToolTrace } from "./trace.js";

export type { AgentAnswerOpts };

export interface LlmIknowAgentOptions {
  store: InMemoryKnowledgeStore;
  session: SessionContext;
  llm: LlmChatClient;
  vectorIndex?: VectorIndex;
  maxHops?: number;
  /** From IKNOW_LLM_TOOL_PROTOCOL; only openai_tools is implemented. */
  toolProtocol?: "openai_tools" | "anthropic_tools";
  /**
   * Optional token budget hint for history truncation (design §6).
   * Falls back to llm.contextWindowTokens when present.
   */
  contextWindowTokens?: number;
}

/** Extra LLM rounds beyond max_hops (non-hop tools + final text). */
const EXTRA_ROUNDS = 8;

/** Cap history to last N final user/assistant messages (design §6). */
const HISTORY_MAX_MESSAGES = 6;

function buildSystemPrompt(maxHops: number): string {
  return `You are an enterprise knowledge-base agent for a single company.

Rules:
1. You MUST use the provided tools (kb_retrieve, kb_verify_citation, kb_compile, kb_governance). Never invent documents, facts, IDs, or policies.
2. Always retrieve before answering. Prefer grounded summaries from tool results only. Follow-up factual questions still need kb_retrieve (with prior_chunks when continuing a thread).
3. Hop budget: kb_retrieve and kb_verify_citation each consume 1 hop; max hops is ${maxHops}. kb_compile and kb_governance do not consume hops.
4. G2: every final answer requires a governance snapshot_id. Call kb_governance with action=snapshot_status (and the relevant doc_id when known) before you finish.
5. If evidence is missing, say you cannot confirm — do not fabricate.
6. Final reply may be plain text or a JSON object {"text":"...","source_spans":[{"chunk_id":"...","quote":"..."}]} . Prefer JSON when you have citations.
7. Do not claim external competitor knowledge or bypass role permissions.`;
}

export class LlmIknowAgent {
  private readonly store: InMemoryKnowledgeStore;
  private readonly llm: LlmChatClient;
  private readonly maxHops: number;
  private readonly tools: ToolRegistry;
  private readonly contextWindowTokens?: number;

  constructor(opts: LlmIknowAgentOptions) {
    if (opts.toolProtocol === "anthropic_tools") {
      throw new ValidationError(
        "anthropic_tools not implemented; use openai_tools",
        { toolProtocol: opts.toolProtocol },
      );
    }
    this.store = opts.store;
    this.llm = opts.llm;
    this.maxHops = opts.maxHops ?? MAX_HOPS;
    this.tools = createToolRegistry(opts.store, opts.session, {
      vectorIndex: opts.vectorIndex,
    });
    this.contextWindowTokens =
      opts.contextWindowTokens ??
      readContextWindowTokens(opts.llm);
  }

  /**
   * system + capped history finals + optional prior_chunks appendix + current user.
   */
  private buildInitialMessages(
    query: string,
    opts?: AgentAnswerOpts,
  ): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(this.maxHops) },
    ];

    const history = capHistory(opts?.history, this.contextWindowTokens);
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    const priors = normalizePriorChunks(opts?.prior_chunks);
    if (priors?.length) {
      messages.push({
        role: "system",
        content: priorChunksAppendix(priors),
      });
    }

    messages.push({ role: "user", content: query });
    return messages;
  }

  async answer(query: string, opts?: AgentAnswerOpts): Promise<IknowAnswer> {
    const trace = new ToolTrace();
    let hops = 0;
    const notes: string[] = [];
    let snapshotId: string | undefined;
    let governanceStatus: GovernanceStatus = "ok";
    let preferredDocId = "_session";
    const sourceSpansAccum: SourceSpan[] = [];

    const q = query.trim();
    if (!q) {
      return this.ensureG2({
        text: "请提供有效问题。",
        source_spans: [],
        trace,
        hops: 0,
        notes: ["empty_query"],
        preferredDocId: "_session",
      });
    }

    const messages = this.buildInitialMessages(q, opts);

    // Safety: bound total LLM rounds (hops + non-hop tools + final).
    const maxRounds = this.maxHops + EXTRA_ROUNDS;
    let finalContent: string | undefined;

    for (let round = 0; round < maxRounds; round++) {
      let result;
      try {
        result = await this.llm.chat(messages, KB_TOOL_DEFS);
      } catch (err) {
        // G2: LLM failure must still return a governance snapshot.
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`llm_error: ${msg}`);
        if (!snapshotId) {
          const g = await this.forceSnapshot(preferredDocId, trace);
          snapshotId = g.snapshot_id;
          governanceStatus = g.status;
          if (g.extraNotes?.length) notes.push(...g.extraNotes);
        }
        return {
          text: "模型调用失败，无法确认完整结论。",
          source_spans: sourceSpansAccum.slice(0, 5),
          snapshot_id: snapshotId,
          governance_status: governanceStatus,
          tool_trace: trace.names(),
          tool_calls: trace.logs(),
          hops_used: hops,
          notes,
        };
      }

      const toolCalls = result.tool_calls ?? [];

      if (toolCalls.length === 0) {
        finalContent = result.content ?? "";
        break;
      }

      // Assistant message with tool_calls (OpenAI protocol)
      messages.push({
        role: "assistant",
        content: result.content ?? null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const name = tc.function?.name ?? "";
        const isHop = HOP_TOOLS.has(name);

        if (isHop && hops >= this.maxHops) {
          const denied = {
            error: "MAX_HOPS",
            message: `hop budget exhausted (max_hops=${this.maxHops}); cannot call ${name}`,
          };
          notes.push("max_hops_exceeded");
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name,
            content: JSON.stringify(denied),
          });
          continue;
        }

        const { resultJson, args, docHint, spans } = await this.executeTool(
          name,
          tc,
        );
        if (isHop) hops += 1;
        // Only record known kb_* tools on the trajectory; unknown names get a note.
        if (isKbToolName(name)) {
          trace.record(name, args);
        } else {
          notes.push(`unknown_tool:${name || "empty"}`);
        }
        if (docHint) preferredDocId = docHint;
        if (spans?.length) sourceSpansAccum.push(...spans);

        if (name === "kb_governance") {
          try {
            const parsed = JSON.parse(resultJson) as {
              snapshot_id?: string;
              status?: GovernanceStatus;
            };
            if (parsed.snapshot_id) {
              snapshotId = parsed.snapshot_id;
              if (parsed.status) governanceStatus = parsed.status;
            }
          } catch {
            // tool payload may be error envelope
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name,
          content: resultJson,
        });
      }
    }

    // G2: if model never obtained snapshot, call governance ourselves
    if (!snapshotId) {
      const g = await this.forceSnapshot(preferredDocId, trace);
      snapshotId = g.snapshot_id;
      governanceStatus = g.status;
      if (g.extraNotes?.length) notes.push(...g.extraNotes);
    }

    const parsed = parseFinalContent(finalContent ?? "", sourceSpansAccum);

    return {
      text: parsed.text || "（模型未返回文本内容）",
      source_spans: parsed.source_spans,
      snapshot_id: snapshotId,
      governance_status: governanceStatus,
      tool_trace: trace.names(),
      tool_calls: trace.logs(),
      hops_used: hops,
      notes: notes.length ? notes : undefined,
    };
  }

  private async executeTool(
    name: string,
    tc: LlmToolCall,
  ): Promise<{
    resultJson: string;
    args: Record<string, unknown>;
    docHint?: string;
    spans?: SourceSpan[];
  }> {
    let args: Record<string, unknown> = {};
    try {
      args = parseArgs(tc.function?.arguments);
    } catch (err) {
      return {
        resultJson: JSON.stringify({
          error: "VALIDATION",
          message: err instanceof Error ? err.message : "invalid tool arguments",
        }),
        args: { raw: tc.function?.arguments },
      };
    }

    try {
      if (!isKbToolName(name)) {
        return {
          resultJson: JSON.stringify({
            error: "VALIDATION",
            message: `unknown tool: ${name}`,
          }),
          args,
        };
      }

      switch (name) {
        case "kb_retrieve": {
          const out = await this.tools.kb_retrieve(
            args as unknown as Parameters<ToolRegistry["kb_retrieve"]>[0],
          );
          const docHint = out.chunks[0]?.doc_id;
          const spans: SourceSpan[] = out.chunks.slice(0, 5).map((c) => ({
            chunk_id: c.chunk_id,
            quote: c.summary,
          }));
          return {
            resultJson: JSON.stringify(out),
            args,
            docHint,
            spans,
          };
        }
        case "kb_verify_citation": {
          const out = this.tools.kb_verify_citation(
            args as unknown as Parameters<ToolRegistry["kb_verify_citation"]>[0],
          );
          return { resultJson: JSON.stringify(out), args };
        }
        case "kb_compile": {
          const out = this.tools.kb_compile(
            args as unknown as Parameters<ToolRegistry["kb_compile"]>[0],
          );
          const docHint =
            typeof args.doc_id === "string" ? args.doc_id : undefined;
          return { resultJson: JSON.stringify(out), args, docHint };
        }
        case "kb_governance": {
          const out = this.tools.kb_governance(
            args as unknown as Parameters<ToolRegistry["kb_governance"]>[0],
          );
          let docHint: string | undefined;
          if (typeof args.doc_id === "string") {
            docHint = args.doc_id;
          } else if (typeof args.chunk_id === "string") {
            docHint = this.store.tryGetChunk(args.chunk_id)?.doc_id;
          }
          return {
            resultJson: JSON.stringify(out),
            args,
            docHint,
          };
        }
        default: {
          return {
            resultJson: JSON.stringify({
              error: "VALIDATION",
              message: `unhandled tool: ${name}`,
            }),
            args,
          };
        }
      }
    } catch (err) {
      if (err instanceof IknowError) {
        return {
          resultJson: JSON.stringify({
            error: err.code,
            message: err.message,
            details: err.details,
          }),
          args,
        };
      }
      return {
        resultJson: JSON.stringify({
          error: "TOOL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        }),
        args,
      };
    }
  }

  private async forceSnapshot(
    docId: string,
    trace: ToolTrace,
  ): Promise<{
    snapshot_id: string;
    status: GovernanceStatus;
    extraNotes?: string[];
  }> {
    const input = { action: "snapshot_status" as const, doc_id: docId };
    trace.record("kb_governance", input);
    try {
      const out = this.tools.kb_governance(input);
      return { snapshot_id: out.snapshot_id, status: out.status };
    } catch (err) {
      if (err instanceof IknowError && err.code === "GOVERNANCE_TIMEOUT") {
        return {
          ...localSnapshot(this.store, docId, "stale"),
          extraNotes: ["governance_timeout"],
        };
      }
      if (err instanceof IknowError && err.code === "PERMISSION_DENIED") {
        return {
          ...localSnapshot(this.store, docId, "ok"),
          extraNotes: ["permission_denied"],
        };
      }
      return {
        ...localSnapshot(this.store, docId, "stale"),
        extraNotes: [err instanceof Error ? err.message : "governance_error"],
      };
    }
  }

  private ensureG2(args: {
    text: string;
    source_spans: SourceSpan[];
    trace: ToolTrace;
    hops: number;
    notes: string[];
    preferredDocId: string;
  }): IknowAnswer {
    const g = localSnapshot(this.store, args.preferredDocId, "ok");
    return {
      text: args.text,
      source_spans: args.source_spans,
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      tool_trace: args.trace.names(),
      tool_calls: args.trace.logs(),
      hops_used: args.hops,
      notes: args.notes,
    };
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  const v = JSON.parse(raw) as unknown;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return v as Record<string, unknown>;
}

/**
 * Prefer structured JSON final content; otherwise plain text + accumulated spans
 * when a governance snapshot already exists (caller guarantees G2).
 */
export function parseFinalContent(
  content: string,
  fallbackSpans: SourceSpan[],
): { text: string; source_spans: SourceSpan[] } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { text: "", source_spans: fallbackSpans.slice(0, 5) };
  }

  // Fenced JSON
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  if (candidate.startsWith("{")) {
    try {
      const obj = JSON.parse(candidate) as {
        text?: unknown;
        answer?: unknown;
        source_spans?: unknown;
      };
      let text: string | undefined;
      if (typeof obj.text === "string") {
        text = obj.text;
      } else if (typeof obj.answer === "string") {
        text = obj.answer;
      }
      if (text !== undefined) {
        const spans = normalizeSpans(obj.source_spans);
        return {
          text,
          source_spans: spans.length ? spans : fallbackSpans.slice(0, 5),
        };
      }
    } catch {
      // fall through to plain text
    }
  }

  return {
    text: trimmed,
    source_spans: fallbackSpans.slice(0, 5),
  };
}

function normalizeSpans(raw: unknown): SourceSpan[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceSpan[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.chunk_id !== "string") continue;
    const span: SourceSpan = { chunk_id: o.chunk_id };
    if (typeof o.quote === "string") span.quote = o.quote;
    if (
      Array.isArray(o.offset) &&
      o.offset.length === 2 &&
      typeof o.offset[0] === "number" &&
      typeof o.offset[1] === "number"
    ) {
      span.offset = [o.offset[0], o.offset[1]];
    }
    out.push(span);
  }
  return out;
}

function governanceStatusFromResult(result: string): GovernanceStatus {
  if (result === "conflict") return "conflict";
  if (result === "ok") return "ok";
  return "stale";
}

function localSnapshot(
  store: InMemoryKnowledgeStore,
  docId: string,
  result: string,
): { snapshot_id: string; status: GovernanceStatus } {
  const doc = store.tryGetDocument(docId);
  const ts = new Date().toISOString();
  const status = governanceStatusFromResult(result);
  return {
    snapshot_id: buildSnapshotId({
      doc_id: docId,
      document_version: doc?.document_version ?? "0",
      check_type: "snapshot_status",
      result: status,
      ts,
    }),
    status,
  };
}

function readContextWindowTokens(llm: LlmChatClient): number | undefined {
  const cw = (llm as { contextWindowTokens?: unknown }).contextWindowTokens;
  return typeof cw === "number" && cw > 0 ? cw : undefined;
}

function normalizePriorChunks(
  priors: PriorChunk[] | undefined,
): PriorChunk[] | undefined {
  if (!priors?.length) return undefined;
  const out: PriorChunk[] = [];
  for (const p of priors) {
    if (
      typeof p?.chunk_id === "string" &&
      p.chunk_id.length > 0 &&
      typeof p?.summary === "string"
    ) {
      out.push({ chunk_id: p.chunk_id, summary: p.summary });
    }
  }
  return out.length ? out : undefined;
}

/**
 * Keep last N user/assistant finals; optionally shrink by approx char budget
 * derived from contextWindowTokens (~15% of window, 4 chars/token).
 */
export function capHistory(
  history: AgentAnswerOpts["history"] | undefined,
  contextWindowTokens?: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!history?.length) return [];
  let msgs = history
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
    .slice(-HISTORY_MAX_MESSAGES);

  if (contextWindowTokens == null || contextWindowTokens <= 0) {
    return msgs;
  }

  // ~4 chars/token; reserve ~15% of window for history finals only.
  const charBudget = Math.max(1, Math.floor(contextWindowTokens * 0.15 * 4));
  let total = 0;
  const kept: typeof msgs = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const len = msgs[i]!.content.length;
    if (kept.length > 0 && total + len > charBudget) break;
    kept.push(msgs[i]!);
    total += len;
  }
  return kept.reverse();
}

function priorChunksAppendix(priors: PriorChunk[]): string {
  const lines = priors.map(
    (p) =>
      `- ${p.chunk_id}: ${p.summary.length > 160 ? `${p.summary.slice(0, 160)}…` : p.summary}`,
  );
  return [
    "Prior chunks from earlier turns (ids + short summaries only).",
    "When continuing the same thread, pass them as prior_chunks to kb_retrieve.",
    "Do not invent chunk_ids. Prefer re-retrieve for new factual claims.",
    ...lines,
  ].join("\n");
}
