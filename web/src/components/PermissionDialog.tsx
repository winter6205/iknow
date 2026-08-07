import { useCallback } from "react";
import type { AskDecision, PendingAsk } from "../api/client";

export interface PermissionDialogProps {
  readonly ask: PendingAsk;
  readonly conversationId: string;
  readonly onDecide: (
    conversationId: string,
    askId: string,
    decision: AskDecision
  ) => Promise<void>;
  readonly pollError: boolean;
}

/**
 * Three-button permission dialog surfaced by the SPA when the harness
 * classifies a tool call as `ask`. Decisions:
 *   - allow-once:    release the waiter as approved, do not persist.
 *   - always-allow:  release as approved AND add a session-grants rule so the
 *                    next identical tool call is auto-approved within this
 *                    server process (memory-only; cleared on restart).
 *   - deny:          release as denied — the harness records [user_denied].
 *
 * Layout follows the chat composer pattern (bordered card, vertical stack of
 * buttons, primary action at bottom) so users learn one interaction model.
 */
export function PermissionDialog(props: PermissionDialogProps) {
  const { ask, conversationId, onDecide, pollError } = props;
  const handle = useCallback(
    (decision: AskDecision) => () => {
      void onDecide(conversationId, ask.id, decision);
    },
    [ask.id, conversationId, onDecide]
  );
  return (
    <div
      role="dialog"
      aria-label="Permission request"
      style={{
        border: "1px solid var(--ik-border, #444)",
        borderRadius: 6,
        padding: "12px 14px",
        margin: "8px 0",
        background: "var(--ik-bg-soft, rgba(255,255,255,0.04))",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Permission requested
      </div>
      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>
        Tool <code>{ask.tool}</code>
        {ask.summaryHint ? (
          <>
            {" "}
            — <span>{ask.summaryHint}</span>
          </>
        ) : null}
      </div>
      {pollError ? (
        <div
          style={{ color: "var(--ik-warn, #c97)", marginBottom: 8 }}
          role="status"
        >
          Connection lost — ask will fail closed unless resolved.
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={handle("allow-once")}>
          Allow once
        </button>
        <button type="button" onClick={handle("always-allow")}>
          Always allow
        </button>
        <button type="button" onClick={handle("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
