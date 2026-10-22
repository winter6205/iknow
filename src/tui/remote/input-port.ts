/**
 * Remote input port (spec specs/remote-sync.md §4.3).
 *
 * Host-neutral registry the TUI app binds to the functions its keyboard
 * already uses (sendTurn / resolvePermissionAsk / interruptForegroundTurn).
 * The socket server consumes the three operations; every rejection is a typed
 * failure with no turn, queue or permission side effect.
 *
 * Bindings are generation-guarded: a second bind replaces the first, and the
 * first unbind can neither clear the second nor be revived by it.
 */
import type {
  AnswerChoice,
  RemoteOperation,
} from "../../remote-api/protocol.js";

/** Typed pre-acceptance failure: no turn started, no queue entry. */
export interface RemoteSendFailed {
  readonly failed: true;
}

/** Send outcome the app binding reports; the port turns `failed` into a typed
 *  rejection instead of claiming a turn started. */
export type RemoteSendResult = "sent" | "queued" | RemoteSendFailed;

export interface RemoteInputBindings {
  readonly getActiveConversationId: () => string | null;
  readonly sendMessage: (
    text: string,
    origin: "remote"
  ) => Promise<RemoteSendResult> | RemoteSendResult;
  readonly answerApproval: (
    toolUseId: string,
    answer: AnswerChoice,
    origin: "remote"
  ) => Promise<"ok" | "not_pending"> | "ok" | "not_pending";
  readonly abort: () =>
    { interrupted: boolean } | Promise<{ interrupted: boolean }>;
}

export interface RemoteInputPort {
  bind(bindings: RemoteInputBindings): () => void;
  sendMessage(
    text: string,
    conversationId?: string
  ): Promise<RemoteOperation<{ status: "sent" | "queued" }>>;
  answerApproval(
    toolUseId: string,
    answer: AnswerChoice
  ): Promise<RemoteOperation<Record<string, never>>>;
  abort(): Promise<RemoteOperation<{ interrupted: boolean }>>;
}

type PortErrorCode =
  "not_ready" | "empty_text" | "not_active" | "not_pending" | "bad_request";

function failure<T>(code: PortErrorCode, message: string): RemoteOperation<T> {
  return { ok: false, code, message };
}

function notReady<T>(): RemoteOperation<T> {
  return failure(
    "not_ready",
    "remote input is not bound: the TUI is not ready"
  );
}

interface ActiveBindings {
  readonly generation: number;
  readonly bindings: RemoteInputBindings;
}

export function createRemoteInputPort(): RemoteInputPort {
  let active: ActiveBindings | undefined;
  let lastGeneration = 0;

  function bind(bindings: RemoteInputBindings): () => void {
    lastGeneration += 1;
    const generation = lastGeneration;
    active = { generation, bindings };
    return () => {
      // A stale unbind must not clear a later bind.
      if (active?.generation !== generation) return;
      active = undefined;
    };
  }

  async function sendMessage(
    text: string,
    conversationId?: string
  ): Promise<RemoteOperation<{ status: "sent" | "queued" }>> {
    const current = active;
    if (current === undefined) return notReady();
    if (text.trim() === "") {
      return failure("empty_text", "message text must not be empty");
    }
    try {
      if (conversationId !== undefined) {
        const activeConversationId = current.bindings.getActiveConversationId();
        if (
          activeConversationId === null ||
          conversationId !== activeConversationId
        ) {
          return failure("not_active", "conversation is not the active one");
        }
      }
      const status = await current.bindings.sendMessage(text, "remote");
      if (status === "sent" || status === "queued") {
        return { ok: true, value: { status } };
      }
      // The binding refused the message before a turn started (session
      // creation failed or no target conversation): report it as a rejection.
      return failure("bad_request", "send_message failed in the TUI binding");
    } catch {
      // Never echo the text: it is user content the seat must not log or
      // send back to a client.
      return failure("bad_request", "send_message failed in the TUI binding");
    }
  }

  async function answerApproval(
    toolUseId: string,
    answer: AnswerChoice
  ): Promise<RemoteOperation<Record<string, never>>> {
    const current = active;
    if (current === undefined) return notReady();
    try {
      const outcome = await current.bindings.answerApproval(
        toolUseId,
        answer,
        "remote"
      );
      if (outcome === "ok") return { ok: true, value: {} };
      return failure(
        "not_pending",
        "no pending approval matches this tool call"
      );
    } catch {
      return failure(
        "bad_request",
        "answer_approval failed in the TUI binding"
      );
    }
  }

  async function abort(): Promise<RemoteOperation<{ interrupted: boolean }>> {
    const current = active;
    if (current === undefined) return notReady();
    try {
      const { interrupted } = await current.bindings.abort();
      return { ok: true, value: { interrupted } };
    } catch {
      return failure("bad_request", "abort failed in the TUI binding");
    }
  }

  return { bind, sendMessage, answerApproval, abort };
}
