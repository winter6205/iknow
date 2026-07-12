import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import type {
  AgentMode,
  CallerRole,
  IknowAnswer,
  SessionSummary,
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
      answer: IknowAnswer;
    };

export type SessionChatState = {
  phase: ChatPhase;
  error: string | null;
  session: SessionSummary | null;
  messages: ChatUiMessage[];
  /** Latest agent answer for G2 panel (null before first turn). */
  lastAnswer: IknowAnswer | null;
  healthLabel: string | null;
  mode: AgentMode;
  role: CallerRole;
};

export type SessionChatApi = SessionChatState & {
  sendMessage: (text: string) => Promise<void>;
  reset: () => Promise<void>;
  newSession: () => Promise<void>;
  setMode: (mode: AgentMode) => Promise<void>;
  setRole: (role: CallerRole) => Promise<void>;
  retryBootstrap: () => void;
  /** Clear mid-session error without resetting conversation. */
  clearError: () => void;
};

/** Safe extras for applySession — cannot override derived session fields. */
type ApplySessionExtras = {
  healthLabel?: string | null;
};

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

function turnsToMessages(turns: TurnDto[]): ChatUiMessage[] {
  const out: ChatUiMessage[] = [];
  turns.forEach((t, i) => {
    const snap = t.answer.snapshot_id || "nosnap";
    const q = queryIdSlice(t.query);
    out.push({
      id: `u-${i}-${snap}-${q}`,
      role: "user",
      text: t.query,
    });
    out.push({
      id: `a-${i}-${snap}-${q}`,
      role: "agent",
      text: t.answer.text,
      answer: t.answer,
    });
  });
  return out;
}

function lastAnswerFromMessages(messages: ChatUiMessage[]): IknowAnswer | null {
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
  mode: "deterministic",
  role: "employee",
};

export function useSessionChat(): SessionChatApi {
  const [state, setState] = useState<SessionChatState>(INITIAL);
  const bootGen = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const modeRef = useRef<AgentMode>(INITIAL.mode);
  const roleRef = useRef<CallerRole>(INITIAL.role);

  const applySession = useCallback(
    (
      session: SessionSummary,
      turns: TurnDto[],
      extras: ApplySessionExtras = {},
    ) => {
      sessionIdRef.current = session.conversation_id;
      modeRef.current = session.mode;
      roleRef.current = session.caller_role;
      const messages = turnsToMessages(turns);
      // Spread extras first so derived session/messages/mode/role always win.
      setState((prev) => ({
        ...prev,
        ...extras,
        phase: "ready",
        error: null,
        session,
        messages,
        lastAnswer: lastAnswerFromMessages(messages),
        mode: session.mode,
        role: session.caller_role,
      }));
    },
    [],
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
      const created = await api.createSession({
        role: roleRef.current,
        mode: modeRef.current,
      });
      if (gen !== bootGen.current) return;
      applySession(created.session, created.turns, {
        healthLabel: `${health.service} ${health.version}`,
      });
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
  }, [applySession]);

  useEffect(() => {
    void bootstrap();
    return () => {
      bootGen.current += 1;
    };
  }, [bootstrap]);

  const sendMessage = useCallback(async (text: string) => {
    const gen = bootGen.current;
    const id = sessionIdRef.current;
    const trimmed = text.trim();
    if (!id || !trimmed) return;

    const userMsg: ChatUiMessage = {
      id: `u-local-${Date.now()}-${queryIdSlice(trimmed)}`,
      role: "user",
      text: trimmed,
    };
    setState((prev) => ({
      ...prev,
      phase: "sending",
      error: null,
      messages: [...prev.messages, userMsg],
    }));

    try {
      const res = await api.postMessage(id, trimmed);
      if (gen !== bootGen.current) return;
      sessionIdRef.current = res.session.conversation_id;
      modeRef.current = res.session.mode;
      roleRef.current = res.session.caller_role;
      const agentMsg: ChatUiMessage = {
        id: `a-${res.turn.answer.snapshot_id || Date.now()}-${queryIdSlice(trimmed)}`,
        role: "agent",
        text: res.turn.answer.text,
        answer: res.turn.answer,
      };
      setState((prev) => ({
        ...prev,
        phase: "ready",
        error: null,
        session: res.session,
        mode: res.session.mode,
        role: res.session.caller_role,
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
  }, []);

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

  const newSession = useCallback(async () => {
    // Bump gen so in-flight sendMessage / reset / postCommand cannot clobber.
    const gen = ++bootGen.current;
    setState((prev) => ({
      ...prev,
      phase: "loading",
      error: null,
      messages: [],
      lastAnswer: null,
    }));
    try {
      const created = await api.createSession({
        role: roleRef.current,
        mode: modeRef.current,
      });
      if (gen !== bootGen.current) return;
      applySession(created.session, created.turns);
    } catch (e) {
      if (gen !== bootGen.current) return;
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
      }));
    }
  }, [applySession]);

  /** Wait for API confirm before updating mode/role (no optimistic UI). */
  const postCommand = useCallback(
    async (command: "mode" | "role", args: string[]) => {
      const gen = bootGen.current;
      const id = sessionIdRef.current;
      if (!id) return;
      try {
        const res = await api.postCommand(id, command, args);
        if (gen !== bootGen.current) return;
        sessionIdRef.current = res.session.conversation_id;
        modeRef.current = res.session.mode;
        roleRef.current = res.session.caller_role;
        setState((prev) => ({
          ...prev,
          session: res.session,
          mode: res.session.mode,
          role: res.session.caller_role,
          error: null,
          phase: prev.phase === "error" ? "ready" : prev.phase,
        }));
      } catch (e) {
        if (gen !== bootGen.current) return;
        // Do not write optimistic mode/role — server values stay in refs/state.
        setState((prev) => ({
          ...prev,
          phase: "error",
          error: errMessage(e),
        }));
      }
    },
    [],
  );

  const setMode = useCallback(
    async (mode: AgentMode) => {
      const gen = bootGen.current;
      const id = sessionIdRef.current;
      // No session yet: local preference only (used by next createSession).
      if (!id) {
        modeRef.current = mode;
        if (gen !== bootGen.current) return;
        setState((prev) => ({ ...prev, mode }));
        return;
      }
      await postCommand("mode", [mode]);
    },
    [postCommand],
  );

  const setRole = useCallback(
    async (role: CallerRole) => {
      const gen = bootGen.current;
      const id = sessionIdRef.current;
      if (!id) {
        roleRef.current = role;
        if (gen !== bootGen.current) return;
        setState((prev) => ({ ...prev, role }));
        return;
      }
      await postCommand("role", [role]);
    },
    [postCommand],
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
        phase: prev.session ? "ready" : prev.phase === "error" ? "error" : prev.phase,
      };
    });
  }, []);

  return {
    ...state,
    sendMessage,
    reset,
    newSession,
    setMode,
    setRole,
    retryBootstrap,
    clearError,
  };
}
