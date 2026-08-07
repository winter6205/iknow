import { useEffect, useRef, useState } from "react";
import {
  listPendingAsks,
  resolveAsk,
  type AskDecision,
  type PendingAsk,
} from "../api/client";

/** Poll interval for the pending-permission list (ms). */
const POLL_MS = 2_000;

export interface AskPollingApi {
  /** First (most recent) pending ask, or null when none / not polling. */
  readonly pendingAsk: PendingAsk | null;
  /** true while the SPA cannot reach the session server (poll failures). */
  readonly pollError: boolean;
  /** Resolve the current pending ask with a three-way decision. */
  readonly decide: (
    conversationId: string,
    askId: string,
    decision: AskDecision
  ) => Promise<void>;
}

/**
 * Polls the session server for pending permission requests while a message
 * turn is in flight, so the user can approve / always-allow / deny a tool
 * call that the harness classified as `ask`.
 *
 * Kept as a dedicated hook (not merged into useSessionChat) so the 400+ line
 * chat hook does not grow further and the polling lifecycle is testable in
 * isolation.
 */
export function useAsksPolling(
  conversationId: string | null,
  isSending: boolean
): AskPollingApi {
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const [pollError, setPollError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = conversationId;

  useEffect(() => {
    setPendingAsk(null);
    setPollError(false);
    if (!conversationId || !isSending) return;
    const tick = async (): Promise<void> => {
      const cid = conversationRef.current;
      if (!cid) return;
      try {
        const { asks } = await listPendingAsks(cid);
        setPendingAsk(asks.length > 0 ? (asks[0] ?? null) : null);
        setPollError(false);
      } catch {
        setPollError(true);
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    timerRef.current = timer;
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [conversationId, isSending]);

  const decide = async (
    cid: string,
    askId: string,
    decision: AskDecision
  ): Promise<void> => {
    try {
      await resolveAsk(cid, askId, decision);
      setPendingAsk(null);
      setPollError(false);
    } catch {
      // Network failure is surfaced as an error state; the ask itself will
      // fail closed server-side (5s timeout) rather than being silently
      // reported as "user denied".
      setPollError(true);
    }
  };

  return { pendingAsk, pollError, decide };
}
