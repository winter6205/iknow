import { randomUUID } from "node:crypto";
import type {
  IknowAnswer,
  PriorChunk,
  SessionContext,
} from "../shared/schema.js";
import type { ConversationState } from "./types.js";

/** Minimal store surface used to resolve prior summaries. */
export type PriorLookupStore = {
  tryGetChunk?: (chunkId: string) => { summary?: string } | undefined;
};

const MAX_PRIORS = 5;
/** Cap for quote fallback when store has no summary. */
const MAX_QUOTE_SUMMARY_LEN = 200;
/**
 * Soft cap only if store summary is pathologically huge (defense-in-depth).
 * Normal store summaries are preferred as-is; this is not the 200 quote limit.
 */
const MAX_STORE_SUMMARY_LEN = 500;

export type CreateConversationOptions = {
  conversation_id?: string;
  json_mode?: boolean;
};

/**
 * Host-layer conversation bag (protocol-external).
 * Does not touch tool schema or SessionContext fields beyond session itself.
 */
export function createConversation(
  session: SessionContext,
  opts?: CreateConversationOptions
): ConversationState {
  return {
    conversation_id: opts?.conversation_id ?? randomUUID(),
    session,
    turns: [],
    last_priors: [],
    history_finals: [],
    json_mode: opts?.json_mode ?? false,
  };
}

/**
 * Derive next-turn prior_chunks from an answer's source_spans.
 * Unique chunk_ids in first-seen order, max K=5.
 * summary:
 * - store chunk.summary if present → preferred as-is (soft-cap 500 only if huge)
 * - else quote truncated to ≤200
 */
export function derivePriorsFromAnswer(
  answer: IknowAnswer,
  store: PriorLookupStore
): PriorChunk[] {
  const seen = new Set<string>();
  const priors: PriorChunk[] = [];

  for (const span of answer.source_spans) {
    const chunkId = span.chunk_id;
    if (!chunkId || seen.has(chunkId)) {
      continue;
    }
    seen.add(chunkId);

    const fromStore = store.tryGetChunk?.(chunkId)?.summary;
    let summary: string;
    if (typeof fromStore === "string" && fromStore.length > 0) {
      // Prefer store summary as-is; soft-cap only for pathological length.
      summary =
        fromStore.length > MAX_STORE_SUMMARY_LEN
          ? fromStore.slice(0, MAX_STORE_SUMMARY_LEN)
          : fromStore;
    } else {
      summary = (span.quote ?? "").slice(0, MAX_QUOTE_SUMMARY_LEN);
    }

    priors.push({ chunk_id: chunkId, summary });
    if (priors.length >= MAX_PRIORS) {
      break;
    }
  }

  return priors;
}

/**
 * Append a completed turn; refresh last_priors and history_finals.
 */
export function recordTurn(
  state: ConversationState,
  query: string,
  answer: IknowAnswer,
  store: PriorLookupStore
): void {
  state.turns.push({ query, answer });
  state.last_priors = derivePriorsFromAnswer(answer, store);
  state.history_finals.push(
    { role: "user", content: query },
    { role: "assistant", content: answer.text }
  );
}

export type ResetConversationOptions = {
  /** When true, assign a new conversation_id. Default keeps the existing id. */
  new_id?: boolean;
};

/**
 * Clear turns / priors / history; keep session.
 * conversation_id retained unless opts.new_id.
 */
export function resetConversation(
  state: ConversationState,
  opts?: ResetConversationOptions
): void {
  state.turns = [];
  state.last_priors = [];
  state.history_finals = [];
  if (opts?.new_id) {
    state.conversation_id = randomUUID();
  }
}
