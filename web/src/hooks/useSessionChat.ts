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
};

function errMessage(e: unknown): string {
  if (e instanceof SessionApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function turnsToMessages(turns: TurnDto[]): ChatUiMessage[] {
  const out: ChatUiMessage[] = [];
  turns.forEach((t, i) => {
    out.push({ id: `u-${i}-${t.query.length}`, role: "user", text: t.query });
    out.push({
      id: `a-${i}-${t.answer.snapshot_id || i}`,
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
      extras: Partial<SessionChatState> = {},
    ) => {
      sessionIdRef.current = session.conversation_id;
      modeRef.current = session.mode;
      roleRef.current = session.caller_role;
      const messages = turnsToMessages(turns);
      setState((prev) => ({
        ...prev,
        phase: "ready",
        error: null,
        session,
        messages,
        lastAnswer: lastAnswerFromMessages(messages),
        mode: session.mode,
        role: session.caller_role,
        ...extras,
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
    const id = sessionIdRef.current;
    const trimmed = text.trim();
    if (!id || !trimmed) return;

    const userMsg: ChatUiMessage = {
      id: `u-local-${Date.now()}`,
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
      sessionIdRef.current = res.session.conversation_id;
      modeRef.current = res.session.mode;
      roleRef.current = res.session.caller_role;
      const agentMsg: ChatUiMessage = {
        id: `a-${res.turn.answer.snapshot_id || Date.now()}`,
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
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
        // keep optimistic user message; allow retry via composer or reset
      }));
    }
  }, []);

  const reset = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) {
      await bootstrap();
      return;
    }
    setState((prev) => ({ ...prev, phase: "loading", error: null }));
    try {
      const res = await api.resetSession(id, { new_id: false });
      applySession(res.session, res.turns);
    } catch (e) {
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
      }));
    }
  }, [applySession, bootstrap]);

  const newSession = useCallback(async () => {
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
      applySession(created.session, created.turns);
    } catch (e) {
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
      }));
    }
  }, [applySession]);

  const setMode = useCallback(async (mode: AgentMode) => {
    const id = sessionIdRef.current;
    modeRef.current = mode;
    setState((prev) => ({ ...prev, mode }));
    if (!id) return;
    try {
      const res = await api.postCommand(id, "mode", [mode]);
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
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
      }));
    }
  }, []);

  const setRole = useCallback(async (role: CallerRole) => {
    const id = sessionIdRef.current;
    roleRef.current = role;
    setState((prev) => ({ ...prev, role }));
    if (!id) return;
    try {
      const res = await api.postCommand(id, "role", [role]);
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
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: errMessage(e),
      }));
    }
  }, []);

  const retryBootstrap = useCallback(() => {
    void bootstrap();
  }, [bootstrap]);

  return {
    ...state,
    sendMessage,
    reset,
    newSession,
    setMode,
    setRole,
    retryBootstrap,
  };
}
