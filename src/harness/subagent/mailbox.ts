import type { SubAgentEnvelope } from "./envelope.js";

/**
 * Terminal facts that a host needs to build a parent-visible handoff.
 *
 * This deliberately excludes the worker conversation and usage data. The
 * manager buffer remains the source for the full terminal envelope; mailbox
 * subscribers only receive a frozen notification snapshot.
 */
export interface SubAgentTerminalNotice {
  readonly taskId: string;
  readonly conversationId?: string;
  readonly status: SubAgentEnvelope["status"];
  readonly summary: string;
  readonly result: string;
  readonly fileRefs?: readonly string[];
  readonly reason?: SubAgentEnvelope["reason"];
  readonly stop_reason?: SubAgentEnvelope["stop_reason"];
  readonly truncated?: boolean;
  readonly totalLength?: number;
  readonly tmp_root?: string;
  /**
   * Locked sentence 2: pad-relative path of the host-written final text.
   * Absent when no file was written (Postel) — a woken parent must not be
   * pointed at a file that does not exist.
   */
  readonly output_path?: string;
}

export type SubAgentTerminalSubscriber = (
  notice: SubAgentTerminalNotice
) => void;

export interface SubAgentMailbox {
  readonly publish: (notice: SubAgentTerminalNotice) => void;
  readonly subscribe: (subscriber: SubAgentTerminalSubscriber) => () => void;
  readonly clear: () => void;
}

export interface CreateSubAgentMailboxOptions {
  readonly onSubscriberError?: (error: unknown) => void;
}

function reportSubscriberDiagnostic(scope: string, error: unknown): void {
  try {
    console.warn(`[subagent] ${scope}`, error);
  } catch (diagnosticError) {
    // EXIT: diagnostics are best-effort; a broken console must not escape
    // publish() while isolating a subscriber failure.
    void diagnosticError;
  }
}

function snapshotNotice(
  notice: SubAgentTerminalNotice
): SubAgentTerminalNotice {
  return Object.freeze({
    taskId: notice.taskId,
    ...(notice.conversationId !== undefined
      ? { conversationId: notice.conversationId }
      : {}),
    status: notice.status,
    summary: notice.summary,
    result: notice.result,
    ...(notice.fileRefs !== undefined
      ? { fileRefs: Object.freeze([...notice.fileRefs]) }
      : {}),
    ...(notice.reason !== undefined ? { reason: notice.reason } : {}),
    ...(notice.stop_reason !== undefined
      ? { stop_reason: notice.stop_reason }
      : {}),
    ...(notice.truncated !== undefined ? { truncated: notice.truncated } : {}),
    ...(notice.totalLength !== undefined
      ? { totalLength: notice.totalLength }
      : {}),
    ...(notice.tmp_root !== undefined ? { tmp_root: notice.tmp_root } : {}),
    ...(notice.output_path !== undefined
      ? { output_path: notice.output_path }
      : {}),
  });
}

export function createSubAgentMailbox(
  options: CreateSubAgentMailboxOptions = {}
): SubAgentMailbox {
  const notices: SubAgentTerminalNotice[] = [];
  const subscribers = new Set<SubAgentTerminalSubscriber>();
  const onSubscriberError =
    options.onSubscriberError ??
    ((error: unknown): void => {
      reportSubscriberDiagnostic("terminal subscriber failed", error);
    });

  const notify = (
    subscriber: SubAgentTerminalSubscriber,
    notice: SubAgentTerminalNotice
  ): void => {
    try {
      subscriber(notice);
    } catch (error) {
      try {
        onSubscriberError(error);
      } catch (reportingError) {
        reportSubscriberDiagnostic(
          "terminal subscriber error reporter failed",
          reportingError
        );
      }
    }
  };

  const publish = (notice: SubAgentTerminalNotice): void => {
    const snapshot = snapshotNotice(notice);
    notices.push(snapshot);
    for (const subscriber of [...subscribers]) {
      notify(subscriber, snapshot);
    }
  };

  const subscribe = (subscriber: SubAgentTerminalSubscriber): (() => void) => {
    const isNewSubscriber = !subscribers.has(subscriber);
    subscribers.add(subscriber);
    if (isNewSubscriber) {
      for (const notice of notices) notify(subscriber, notice);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(subscriber);
    };
  };

  const clear = (): void => {
    notices.length = 0;
  };

  return Object.freeze({ publish, subscribe, clear });
}
