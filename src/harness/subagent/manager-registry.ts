import { errorMessage } from "../errors.js";
import type { SubAgentEnvelope } from "./envelope.js";
import type { SubagentInfo } from "./manager.js";
import type { SubAgentTerminalSubscriber } from "./mailbox.js";

export interface SubagentManagerDrainView {
  readonly drainCompleted: (conversationId?: string) => ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }>;
}

export interface SubagentManagerWakeView extends SubagentManagerDrainView {
  readonly subscribe: (subscriber: SubAgentTerminalSubscriber) => () => void;
}

export interface SubagentManagerReadView extends SubagentManagerWakeView {
  readonly listSubagents: () => ReadonlyArray<SubagentInfo>;
}

export class SubagentManagerDrainError extends Error {
  override readonly name = "SubagentManagerDrainError";
  readonly reason = "drainFailed" as const;
  readonly managerIndex: number;
  readonly cause: unknown;

  constructor(opts: {
    readonly managerIndex: number;
    readonly cause: unknown;
  }) {
    super(
      `subagent manager ${opts.managerIndex} drain failed: ${errorMessage(opts.cause)}`
    );
    this.managerIndex = opts.managerIndex;
    this.cause = opts.cause;
  }
}

export interface CreateSubagentManagerRegistryOptions {
  readonly onError?: (error: SubagentManagerDrainError) => void;
}

export interface SubagentManagerRegistry extends SubagentManagerReadView {
  readonly register: (manager: SubagentManagerReadView | undefined) => void;
}

type SubscriberSubscriptions = Map<SubagentManagerReadView, () => void>;

function reportObserverDiagnostic(scope: string, error: unknown): void {
  try {
    console.warn(`[subagent-manager-registry] ${scope}`, error);
  } catch (diagnosticError) {
    // EXIT: diagnostics are best-effort and must not escape registration or
    // subscriber cleanup.
    void diagnosticError;
  }
}

export function createSubagentManagerRegistry(
  options: CreateSubagentManagerRegistryOptions = {}
): SubagentManagerRegistry {
  const managers = new Set<SubagentManagerReadView>();
  const subscribers = new Map<
    SubAgentTerminalSubscriber,
    SubscriberSubscriptions
  >();
  const reportError =
    options.onError ??
    ((error: SubagentManagerDrainError): void => {
      reportObserverDiagnostic("manager drain failed", error);
    });

  const attach = (
    manager: SubagentManagerReadView,
    subscriber: SubAgentTerminalSubscriber,
    subscriptions: SubscriberSubscriptions
  ): void => {
    try {
      const unsubscribe = manager.subscribe(subscriber);
      subscriptions.set(manager, unsubscribe);
    } catch (error) {
      reportObserverDiagnostic("manager subscribe failed", error);
    }
  };

  const register = (manager: SubagentManagerReadView | undefined): void => {
    if (manager === undefined || managers.has(manager)) return;
    managers.add(manager);
    for (const [subscriber, subscriptions] of subscribers) {
      attach(manager, subscriber, subscriptions);
    }
  };

  const drainCompleted = (
    conversationId?: string
  ): ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }> => {
    const drained: Array<{
      readonly taskId: string;
      readonly envelope: SubAgentEnvelope;
    }> = [];
    let managerIndex = 0;
    for (const manager of managers) {
      try {
        drained.push(...manager.drainCompleted(conversationId));
      } catch (cause) {
        const error = new SubagentManagerDrainError({
          managerIndex,
          cause,
        });
        try {
          reportError(error);
        } catch (reportingError) {
          reportObserverDiagnostic(
            "drain error reporter failed",
            reportingError
          );
        }
      }
      managerIndex += 1;
    }
    return drained;
  };

  const listSubagents = (): ReadonlyArray<SubagentInfo> => {
    if (managers.size === 0) return [];
    if (managers.size === 1)
      return managers.values().next().value!.listSubagents();
    const listed: SubagentInfo[] = [];
    for (const manager of managers) {
      listed.push(...manager.listSubagents());
    }
    return listed;
  };

  const subscribe = (subscriber: SubAgentTerminalSubscriber): (() => void) => {
    if (subscribers.has(subscriber)) return () => {};
    const subscriptions: SubscriberSubscriptions = new Map();
    subscribers.set(subscriber, subscriptions);
    for (const manager of managers) {
      attach(manager, subscriber, subscriptions);
    }

    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      subscribers.delete(subscriber);
      for (const unsubscribe of subscriptions.values()) {
        try {
          unsubscribe();
        } catch (error) {
          reportObserverDiagnostic("manager unsubscribe failed", error);
        }
      }
      subscriptions.clear();
    };
  };

  return Object.freeze({
    register,
    drainCompleted,
    listSubagents,
    subscribe,
  });
}
