import { errorMessage } from "../errors.js";
import type { ClaimedDelivery, DeliveryClaimToken } from "./delivery-ledger.js";
import type { SubAgentEnvelope } from "./envelope.js";
import type { SubagentInfo } from "./manager.js";
import type {
  SubAgentTerminalNotice,
  SubAgentTerminalSubscriber,
} from "./mailbox.js";

export interface SubagentManagerDrainView {
  /**
   * Non-consuming read of terminal results. `includeDelivered` is
   * diagnostics-only (e.g. "which ids could a failed wake have seen");
   * delivery gates never pass it.
   */
  readonly drainCompleted: (
    conversationId?: string,
    opts?: { readonly includeDelivered?: boolean }
  ) => ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }>;
  /**
   * Optional delivery seam, optional the same way `abortTask` is: poll-only
   * fakes and wake-only views stay structural, and absence means "this view
   * cannot deliver" (hosts fall back to the read-only path). The registry
   * itself always exposes the full set.
   */
  readonly claimCompleted?: (
    conversationId?: string
  ) => ReadonlyArray<ClaimedDelivery<SubAgentEnvelope>>;
  /** Mark written deliveries delivered (unknown tokens are a no-op). */
  readonly acknowledgeDeliveries?: (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>
  ) => void;
  /** Return un-written deliveries to the claimable state (unknown tokens are a no-op). */
  readonly releaseDeliveries?: (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>
  ) => void;
}

export interface SubagentManagerWakeView extends SubagentManagerDrainView {
  readonly subscribe: (
    subscriber: SubAgentTerminalSubscriber,
    conversationId?: string
  ) => () => void;
}

export interface SubagentManagerReadView extends SubagentManagerWakeView {
  readonly listSubagents: (
    conversationId?: string
  ) => ReadonlyArray<SubagentInfo>;
  /**
   * Slice D / SC14: host-initiated hard kill of one worker (TUI Ctrl+X).
   * Optional so poll-only fakes and wake-only views stay structural; absent →
   * the registry reports "not aborted" instead of fabricating a kill.
   * Returns true only when an in-flight worker was actually signalled.
   */
  readonly abortTask?: (taskId: string) => boolean;
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
  // The aggregate always exposes the full delivery seam even though each
  // per-manager member stays optional (ADR-0150 §6).
  readonly claimCompleted: (
    conversationId?: string
  ) => ReadonlyArray<ClaimedDelivery<SubAgentEnvelope>>;
  readonly acknowledgeDeliveries: (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>
  ) => void;
  readonly releaseDeliveries: (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>
  ) => void;
  /** Always present on the aggregate (per-manager seam stays optional). */
  readonly abortTask: (taskId: string) => boolean;
  readonly register: (manager: SubagentManagerReadView | undefined) => void;
}

interface SubscriberSubscriptions {
  readonly conversationId?: string;
  readonly managers: Map<SubagentManagerReadView, () => void>;
}

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
  /** Owning manager per claim token, so ack/release route back to its ledger. */
  const claimOwners = new Map<DeliveryClaimToken, SubagentManagerReadView>();
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
      const scopedSubscriber =
        subscriptions.conversationId === undefined
          ? subscriber
          : (notice: SubAgentTerminalNotice): void => {
              if (notice.conversationId === subscriptions.conversationId) {
                subscriber(notice);
              }
            };
      const unsubscribe = manager.subscribe(
        scopedSubscriber,
        subscriptions.conversationId
      );
      subscriptions.managers.set(manager, unsubscribe);
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
    conversationId?: string,
    opts?: { readonly includeDelivered?: boolean }
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
        drained.push(...manager.drainCompleted(conversationId, opts));
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

  /**
   * Aggregate delivery take: every registered manager claims its own
   * undelivered terminal generations. The owning manager of every claim is
   * remembered so acknowledgement / release routes back to the ledger that
   * issued the token. A manager without the claim seam contributes nothing
   * (its results stay readable through the read-only path).
   */
  const claimCompleted = (
    conversationId?: string
  ): ReadonlyArray<ClaimedDelivery<SubAgentEnvelope>> => {
    const claimed: ClaimedDelivery<SubAgentEnvelope>[] = [];
    let managerIndex = 0;
    for (const manager of managers) {
      try {
        const claims = manager.claimCompleted?.(conversationId) ?? [];
        for (const claim of claims) claimOwners.set(claim.token, manager);
        claimed.push(...claims);
      } catch (cause) {
        const error = new SubagentManagerDrainError({
          managerIndex,
          cause,
        });
        try {
          reportError(error);
        } catch (reportingError) {
          reportObserverDiagnostic(
            "claim error reporter failed",
            reportingError
          );
        }
      }
      managerIndex += 1;
    }
    return claimed;
  };

  const acknowledgeDeliveries = (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>
  ): void => {
    for (const claim of claims) {
      const owner = claimOwners.get(claim.token);
      if (owner === undefined) continue;
      // The owner entry is dropped once routed: the ledger settles a token
      // exactly once, so keeping the routing map would grow with every
      // delivery for the life of the process.
      claimOwners.delete(claim.token);
      owner.acknowledgeDeliveries?.([claim]);
    }
  };

  const releaseDeliveries = (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>
  ): void => {
    for (const claim of claims) {
      const owner = claimOwners.get(claim.token);
      if (owner === undefined) continue;
      claimOwners.delete(claim.token);
      owner.releaseDeliveries?.([claim]);
    }
  };

  const listSubagents = (
    conversationId?: string
  ): ReadonlyArray<SubagentInfo> => {
    if (managers.size === 0) return [];
    if (managers.size === 1)
      return managers.values().next().value!.listSubagents(conversationId);
    const listed: SubagentInfo[] = [];
    for (const manager of managers) {
      listed.push(...manager.listSubagents(conversationId));
    }
    return listed;
  };

  /**
   * Slice D / SC14: fans one hard kill across the per-root managers. A
   * taskId is claimed by at most one manager, so the first manager that
   * reports true wins; managers without an abort seam are skipped rather
   * than treated as a failed kill.
   */
  const abortTask = (taskId: string): boolean => {
    for (const manager of managers) {
      if (manager.abortTask?.(taskId) === true) return true;
    }
    return false;
  };

  const subscribe = (
    subscriber: SubAgentTerminalSubscriber,
    conversationId?: string
  ): (() => void) => {
    if (subscribers.has(subscriber)) return () => {};
    const subscriptions: SubscriberSubscriptions = {
      conversationId,
      managers: new Map(),
    };
    subscribers.set(subscriber, subscriptions);
    for (const manager of managers) {
      attach(manager, subscriber, subscriptions);
    }

    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      subscribers.delete(subscriber);
      for (const unsubscribe of subscriptions.managers.values()) {
        try {
          unsubscribe();
        } catch (error) {
          reportObserverDiagnostic("manager unsubscribe failed", error);
        }
      }
      subscriptions.managers.clear();
    };
  };

  return Object.freeze({
    register,
    drainCompleted,
    claimCompleted,
    acknowledgeDeliveries,
    releaseDeliveries,
    listSubagents,
    abortTask,
    subscribe,
  });
}
