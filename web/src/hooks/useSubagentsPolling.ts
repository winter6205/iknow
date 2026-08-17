import { useEffect, useRef, useState } from "react";
import { getSubagents } from "../api/client";
import type { SubagentStatus } from "../api/types";

/** Pool interval for the subagent status endpoint (spec #358 Tech Stack: 2–3s). */
const POLL_MS = 2_500;

export interface SubagentsPollingApi {
  /** Current in-flight / finished subagents for the conversation, [] before first tick. */
  readonly subagents: ReadonlyArray<SubagentStatus>;
  /** true while recent polls fail (mirror useAsksPolling pollError); undefined before first tick. */
  readonly error?: boolean;
}

/**
 * Polls GET /sessions/:id/subagents (spec #358 T8) while a conversation is
 * active, so the SPA can render the subagent status bar without an SSE /
 * websocket push channel (spec Boundaries Never).
 *
 * Kept as a dedicated hook mirroring useAsksPolling: setInterval inside
 * useEffect keyed on [conversationId], alive-ref stale-drop, clearInterval on
 * cleanup. 0 items → empty render (component hides the bar).
 */
export function useSubagentsPolling(
  conversationId: string | null
): SubagentsPollingApi {
  const [subagents, setSubagents] = useState<ReadonlyArray<SubagentStatus>>([]);
  const [error, setError] = useState<boolean | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = conversationId;

  useEffect(() => {
    setSubagents([]);
    setError(undefined);
    if (!conversationId) return;
    const tick = async (): Promise<void> => {
      const cid = conversationRef.current;
      if (!cid) return;
      try {
        const { subagents: next } = await getSubagents(cid);
        setSubagents(next);
        setError(false);
      } catch {
        // Network/poll failure is swallowed (mirror useAsksPolling pollError
        // semantics): the chat stays usable and the next tick retries.
        // Last-known subagents remain visible so the bar does not flash empty
        // on a transient blip.
        setError(true);
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
  }, [conversationId]);

  return { subagents, error };
}
