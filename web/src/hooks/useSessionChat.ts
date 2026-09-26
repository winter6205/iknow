import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import type {
  SessionSummary,
  ThinkingOverride,
  TurnAnswerDto,
  TurnDto,
} from "../api/types";
import { SessionApiError } from "../api/types";

export type ChatPhase = "loading" | "ready" | "sending" | "error";

export type ChatUiMessage =
  | {
      id: string;
      role: "user";
      text: string;
    }
  | {
      id: string;
      role: "agent";
      text: string;
      answer: TurnAnswerDto;
    }
  | {
      // Local-only notice (slash-command feedback etc.): never on the wire,
      // never produced by turnsToMessages, and cleared (replaced) by
      // applySession on session switch / compact refresh.
      id: string;
      role: "notice";
      text: string;
    };

export type SessionChatState = {
  phase: ChatPhase;
  error: string | null;
  session: SessionSummary | null;
  messages: ChatUiMessage[];
  /** Latest agent answer (null before first turn). */
  lastAnswer: TurnAnswerDto | null;
  healthLabel: string | null;
  contextWindow: number | null;
  /** Model routing id (delivered by health); null when unconfigured. Shown in the status bar under the input. */
  model: string | null;
};

export type SessionChatApi = SessionChatState & {
  /** `thinking` is an optional per-turn override; when omitted the backend uses cached config. */
  sendMessage: (
    text: string,
    thinking?: ThinkingOverride,
    displayText?: string
  ) => Promise<void>;
  reset: () => Promise<void>;
  compact: () => Promise<boolean>;
  /** Skip-append continue: agent bubble only; failure rethrows (no StateBlock). */
  continue: () => Promise<void>;
  rewind: (head: string | null) => Promise<void>;
  newSession: () => Promise<void>;
  /** Switch to an existing conversation by id (sidebar selection). */
  setConversation: (id: string) => Promise<void>;
  retryBootstrap: () => void;
  /** Clear mid-session error without resetting conversation. */
  clearError: () => void;
  /** Append a local-only notice message (slash-command feedback; not on the wire). */
  pushNotice: (text: string) => void;
};

/** Safe extras for applySession — cannot override derived session fields. */
type ApplySessionExtras = {
  healthLabel?: string | null;
  contextWindow?: number | null;
  model?: string | null;
};

/**
 * Every visit starts from a freshly created session — no more restoring
 * a stale conversation_id from localStorage. Entry auto-bind guarantees
 * `createSession` always succeeds under the default workspace, so
 * fresh-on-mount needs no fallback path: UI and session files map 1:1.
 */
function errMessage(e: unknown): string {
  if (e instanceof SessionApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Short stable-ish slice for message ids (not a cryptographic hash). */
function queryIdSlice(query: string): string {
  const raw = query.slice(0, 24);
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) {
    h = (h * 31 + raw.charCodeAt(i)) | 0;
  }
  return `${raw.length.toString(36)}_${(h >>> 0).toString(36)}`;
}

/**
 * Project wire turns → timeline messages (exported for tests/web/).
 *
 * Agent-message keep predicate: emit when finalText is non-empty OR when the
 * turn carries thinking OR tool calls OR the hub's output-limit notice. A
 * maxTurns/timeout turn that ran tools (or thought) but never produced text is
 * NOT a blank reply — dropping it loses the tool/thinking trail entirely. A
 * truncated response can carry nothing but its notice, and that notice has to
 * stay on screen, so it keeps the message too. AgentCard renders
 * the empty-text body region as an empty block alongside its thinking /
 * tool sections, so `text: ""` is safe for the display path.
 */
export function turnsToMessages(turns: TurnDto[]): ChatUiMessage[] {
  const out: ChatUiMessage[] = [];
  turns.forEach((t, i) => {
    const q = queryIdSlice(t.query);
    // Skip empty user turns (e.g. backend bootstrap records with no query) —
    // these render as a blank pill in the timeline.
    if (t.query.trim()) {
      out.push({
        id: `u-${i}-${q}`,
        role: "user",
        text: t.query,
      });
    }
    if (hasDisplayableAnswer(t.answer)) {
      out.push({
        id: `a-${i}-${q}`,
        role: "agent",
        text: t.answer.finalText,
        answer: t.answer,
      });
    }
  });
  return out;
}

/** FinalText content OR any thinking entries OR any tool calls OR a notice. */
function hasDisplayableAnswer(answer: TurnAnswerDto): boolean {
  if (answer.finalText.trim()) return true;
  if (answer.thinking !== undefined) return true;
  if (answer.toolCalls !== undefined && answer.toolCalls.length > 0) {
    return true;
  }
  // The notice is the only evidence a thinking-less, text-less truncation
  // leaves behind; dropping the message would drop the notice with it.
  if (answer.outputLimitNotice !== undefined) return true;
  return false;
}

function lastAnswerFromMessages(
  messages: ChatUiMessage[]
): TurnAnswerDto | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "agent") return m.answer;
  }
  return null;
}

const INITIAL: SessionChatState = {
  phase: "loading",
  error: null,
  session: null,
  messages: [],
  lastAnswer: null,
  healthLabel: null,
  contextWindow: null,
  model: null,
};

export function useSessionChat(): SessionChatApi {
  const [state, setState] = useState<SessionChatState>(INITIAL);
  const bootGen = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const noticeSeq = useRef(0);

  const applySession = useCallback(
    (
      session: SessionSummary,
      turns: TurnDto[],
      extras: ApplySessionExtras = {}
    ) => {
      sessionIdRef.current = session.conversation_id;
      const messages = turnsToMessages(turns);
      // Spread extras first so derived session/messages always win.
      setState((prev) => ({
        ...prev,
        ...extras,
        phase: "ready",
        error: null,
        session,
        messages,
        lastAnswer: lastAnswerFromMessages(messages),
      }));
    },
    []
  );

  /**
   * Fetch a stored session's history and adopt it as the active conversation.
   * Used by `setConversation` (sidebar selection / `newSession` flows that
   * switch into an existing id).
   */
  const adoptSession = useCallback(
    async (id: string, gen: number, extras: ApplySessionExtras = {}) => {
      const got = await api.getSessionHistory(id);
      if (gen !== bootGen.current) return;
      applySession(got.session, got.turns, extras);
    },
    [applySession]
  );

  /** Create a fresh session and adopt it. */
  const createAndAdopt = useCallback(
    async (gen: number, extras: ApplySessionExtras = {}) => {
      const created = await api.createSession({});
      if (gen !== bootGen.current) return;
      applySession(created.session, created.turns, extras);
    },
    [applySession]
  );

  const bootstrap = useCallback(async () => {
    const gen = ++bootGen.current;
    setState((prev) => ({
      ...prev,
      phase: "loading",
      error: null,
      messages: [],
      lastAnswer: null,
      session: null,
    }));
    try {
      const health = await api.health();
      if (gen !== bootGen.current) return;
      const healthExtras: ApplySessionExtras = {
        healthLabel: `${health.service} ${health.version}`,
        contextWindow: health.contextWindow,
        model: health.model ?? null,
      };
      // Fresh-on-mount always — once health passes, createSession
      // immediately; no localStorage read, no restoring old sessions. After
      // entry auto-bind, `createSession` always succeeds under the default
      // workspace, so no fallback is needed.
      await createAndAdopt(gen, healthExtras);
    } catch (e) {
      if (gen !== bootGen.current) return;
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
        session: null,
        messages: [],
        lastAnswer: null,
      }));
    }
  }, [adoptSession, createAndAdopt]);

  useEffect(() => {
    void bootstrap();
    return () => {
      bootGen.current += 1;
    };
  }, [bootstrap]);

  const sendMessage = useCallback(
    async (text: string, thinking?: ThinkingOverride, displayText?: string) => {
      const gen = bootGen.current;
      const id = sessionIdRef.current;
      const trimmed = text.trim();
      if (!id || !trimmed) return;

      const userMsg: ChatUiMessage = {
        id: `u-local-${Date.now()}-${queryIdSlice(trimmed)}`,
        role: "user",
        text: displayText ?? trimmed,
      };
      setState((prev) => ({
        ...prev,
        phase: "sending",
        error: null,
        messages: [...prev.messages, userMsg],
      }));

      try {
        const res = await api.postMessage(id, trimmed, { thinking });
        if (gen !== bootGen.current) return;
        sessionIdRef.current = res.session.conversation_id;
        const agentMsg: ChatUiMessage = {
          id: `a-${Date.now()}-${queryIdSlice(trimmed)}`,
          role: "agent",
          text: res.turn.answer.finalText,
          answer: res.turn.answer,
        };
        setState((prev) => ({
          ...prev,
          phase: "ready",
          error: null,
          session: res.session,
          messages: [...prev.messages, agentMsg],
          lastAnswer: res.turn.answer,
        }));
      } catch (e) {
        if (gen === bootGen.current) {
          setState((prev) => ({
            ...prev,
            phase: "error",
            error: errMessage(e),
            // Intentional: keep optimistic user bubble on failed send so history
            // still shows what was attempted; Composer keeps draft via rethrow.
          }));
        }
        // Always rethrow so Composer keeps draft text for retry.
        throw e instanceof Error ? e : new Error(errMessage(e));
      }
    },
    []
  );

  const reset = useCallback(async () => {
    const gen = bootGen.current;
    const id = sessionIdRef.current;
    if (!id) {
      await bootstrap();
      return;
    }
    setState((prev) => ({ ...prev, phase: "loading", error: null }));
    try {
      const res = await api.resetSession(id, { new_id: false });
      if (gen !== bootGen.current) return;
      // reset keeps the same conversation_id; storage entry stays valid.
      applySession(res.session, res.turns);
    } catch (e) {
      if (gen !== bootGen.current) return;
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
      }));
    }
  }, [applySession, bootstrap]);

  const compact = useCallback(async (): Promise<boolean> => {
    const gen = bootGen.current;
    const id = sessionIdRef.current;
    if (!id) return false;
    // Keep phase=ready (no loading) so a light op like compaction doesn't
    // flash the whole screen. Failure does not set the global error
    // StateBlock (it would cover the message area) — rethrow and let the
    // caller (App handleCompact) show a local notice instead, avoiding
    // confusion with sendMessage's big error UI.
    try {
      const res = await api.compactSession(id);
      if (gen !== bootGen.current) return false;
      applySession(res.session, res.turns);
      return res.compacted;
    } catch (e) {
      if (gen !== bootGen.current) return false;
      throw e instanceof Error ? e : new Error(errMessage(e));
    }
  }, [applySession]);

  const continueRun = useCallback(async (): Promise<void> => {
    const gen = bootGen.current;
    const id = sessionIdRef.current;
    if (!id) return;
    // Agent bubble only (no optimistic userMsg). phase=sending locks Composer
    // like sendMessage; failure restores ready and rethrows (like compact).
    setState((prev) => ({ ...prev, phase: "sending", error: null }));
    try {
      const res = await api.continueSession(id);
      if (gen !== bootGen.current) return;
      sessionIdRef.current = res.session.conversation_id;
      const agentMsg: ChatUiMessage = {
        id: `a-${Date.now()}-${queryIdSlice(res.turn.query || "continue")}`,
        role: "agent",
        text: res.turn.answer.finalText,
        answer: res.turn.answer,
      };
      setState((prev) => ({
        ...prev,
        phase: "ready",
        error: null,
        session: res.session,
        messages: [...prev.messages, agentMsg],
        lastAnswer: res.turn.answer,
      }));
    } catch (e) {
      if (gen !== bootGen.current) return;
      setState((prev) => ({ ...prev, phase: "ready" }));
      throw e instanceof Error ? e : new Error(errMessage(e));
    }
  }, []);

  const rewind = useCallback(
    async (head: string | null): Promise<void> => {
      const gen = bootGen.current;
      const id = sessionIdRef.current;
      if (!id) return;
      try {
        const res = await api.rewindSession(id, head);
        if (gen !== bootGen.current) return;
        applySession(res.session, res.turns);
      } catch (e) {
        if (gen !== bootGen.current) return;
        throw e instanceof Error ? e : new Error(errMessage(e));
      }
    },
    [applySession]
  );

  const newSession = useCallback(async () => {
    // Bump gen so in-flight sendMessage / reset cannot clobber.
    const gen = ++bootGen.current;
    setState((prev) => ({
      ...prev,
      phase: "loading",
      error: null,
      messages: [],
      lastAnswer: null,
    }));
    try {
      await createAndAdopt(gen);
    } catch (e) {
      if (gen !== bootGen.current) return;
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
      }));
    }
  }, [createAndAdopt]);

  const setConversation = useCallback(
    async (id: string) => {
      const trimmed = id.trim();
      if (!trimmed) return;
      // Already viewing this conversation: no-op (avoids a redundant fetch).
      if (trimmed === sessionIdRef.current) return;
      // Bump gen so in-flight sendMessage / reset cannot clobber the switch.
      const gen = ++bootGen.current;
      setState((prev) => ({
        ...prev,
        phase: "loading",
        error: null,
        messages: [],
        lastAnswer: null,
      }));
      try {
        await adoptSession(trimmed, gen);
      } catch (e) {
        if (gen !== bootGen.current) return;
        setState((prev) => ({
          ...prev,
          phase: "error",
          error: errMessage(e),
        }));
      }
    },
    [adoptSession]
  );

  const retryBootstrap = useCallback(() => {
    void bootstrap();
  }, [bootstrap]);

  const clearError = useCallback(() => {
    setState((prev) => {
      if (!prev.error) return prev;
      return {
        ...prev,
        error: null,
        phase: prev.session ? "ready" : prev.phase,
      };
    });
  }, []);

  const pushNotice = useCallback((text: string) => {
    noticeSeq.current += 1;
    const notice: ChatUiMessage = {
      id: `n-${noticeSeq.current}`,
      role: "notice",
      text,
    };
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, notice],
    }));
  }, []);

  return {
    ...state,
    sendMessage,
    reset,
    compact,
    continue: continueRun,
    rewind,
    newSession,
    setConversation,
    retryBootstrap,
    clearError,
    pushNotice,
  };
}
