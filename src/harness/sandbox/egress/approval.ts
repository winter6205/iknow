/**
 * src/harness/sandbox/egress/approval.ts
 *
 * First-seen domain approval flow — session-level gate.
 *
 // (ADR-0097)
 *
 * Single responsibility: hold the per-process session allow/deny sets plus
 * the concurrent-merge table in one place, encapsulating "host decision =
 * ask interface" as `askIfUnknown(host): Promise<boolean>`. The decision
 * side (session.ts filter callback) asks once for a boolean; after the
 * decision the host enters a set and is never asked again in this session.
 *
 * Invariants:
 *   - same host concurrent while pending → merged into one ask (same Promise);
 *   - different hosts concurrent → independent asks, no merge;
 *   - denied → the host is denied for the rest of the session, no re-ask;
 *   - approved → the host is allowed for the rest of the session, no re-ask;
 *   - askApproval absent → deny on first sight (fail-closed);
 *   - askApproval throws → fail-closed, host enters the denied set so later
 *     requests never attempt an ask (stale in-flight cannot block them).
 *
 * Persistence write-back: approval = session-level allow, always done;
 *
 // (ADR-0097)
 * writing back to user settings is an optional side action. settings.ts
 * already offers a `persist-settings` shape to borrow, but write-back is
 * **not** implemented here.
 *
 * The state container deliberately lives on the egress side (not
 * session-grants / NormalRuleSpec):
 *   - session-grants is NormalRuleSpec-shaped, semantically misaligned with
 *     "approve a host";
 *   - domain allow/deny sets are self-contained in the egress domain and
 *     consumed right next to the decision side;
 *   - an in-process Map/Set suffices — no new dependency surface.
 */

/**
 * AskApproval interface — injected into the bash tool (the call site adapts
 * the existing AskUser into
 * `(host) => askUser({ tool: "egress-domain-approval", summaryHint: ... })`).
 *
 * Default = fail-closed: an unseen host is denied outright with reason
 * `no-approval-inlet` (see the session.ts filter and violations.ts rendering).
 */
export type AskApproval = (host: string) => Promise<boolean>;

export interface EgressApprovalGate {
  /**
   * For a host, returns whether it is allowed in this session.
   * - already in allowedThisSession → true, no ask;
   * - already in deniedThisSession → false, no ask;
   * - in-flight Promise exists → return it (same-host concurrency merges);
   * - otherwise call askApproval(host) → on settle update one set, return result.
   */
  askIfUnknown(host: string): Promise<boolean>;
  /** Observe hosts approved this session (frozen; feeds the "session-level allowlist" annotation). */
  allowedThisSession(): readonly string[];
  /** Observe hosts denied this session (frozen). */
  deniedThisSession(): readonly string[];
}

export interface CreateEgressApprovalGateOptions {
  /**
   * Injected ask surface; absent = fail-closed (unseen host denied outright).
   * Throws → fail-closed like an attended deny; host enters the denied set.
   */
  readonly askApproval?: AskApproval;
}

/**
 * Normalize host key — trim + lowercase. The domain matcher is
 * case-insensitive (see domain-matcher.ts `host.trim().toLowerCase()`); the
 * approval sets use the same form so "Example.COM" and "example.com" are not
 * asked twice.
 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * Build the egress approval gate — one instance lives for the lifetime of
 * the bash-tool factory closure, shared across calls.
 *
 * Concurrency model: under Node's single-threaded event loop, writing the
 * in-flight Promise and reading it must be observable within the same tick,
 * so `askIfUnknown` writes the in-flight table **synchronously** and returns
 * asynchronously. Repeated entries for the same host while pending hit the
 * table directly and merge, never invoking askApproval concurrently.
 */
export function createEgressApprovalGate(
  opts: CreateEgressApprovalGateOptions
): EgressApprovalGate {
  const inFlight = new Map<string, Promise<boolean>>();
  const allowed = new Set<string>();
  const denied = new Set<string>();

  const askIfUnknown = async (host: string): Promise<boolean> => {
    const key = normalizeHost(host);
    if (allowed.has(key)) return true;
    if (denied.has(key)) return false;

    // Same-host in-flight Promise exists → merge, await it directly.
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    // No askApproval inlet → fail-closed: deny on first sight and add to the
    // denied set, so repeated requests never attempt any ask. The
    // non-interactive-entry first-seen path must fail typed, with the
    // violation reason recorded by the call site as `no-approval-inlet`.
    if (opts.askApproval === undefined) {
      denied.add(key);
      return false;
    }

    // Start the in-flight Promise — written to the inFlight table
    // synchronously (concurrent same-host entries then hit it and merge).
    const promise = (async (): Promise<boolean> => {
      let approved: boolean;
      try {
        approved = await opts.askApproval!(host);
      } catch {
        // fail-closed: a throwing ask puts the host in the denied set. The
        // catch does not rethrow, guaranteeing inFlight.delete runs; later
        // requests take the deniedThisSession hit path.
        approved = false;
      }
      // Terminal commit: approved → allowed, else → denied. Either way, clear in-flight.
      if (approved) allowed.add(key);
      else denied.add(key);
      inFlight.delete(key);
      return approved;
    })();
    inFlight.set(key, promise);
    return promise;
  };

  const allowedThisSession = (): readonly string[] =>
    Object.freeze([...allowed]);
  const deniedThisSession = (): readonly string[] => Object.freeze([...denied]);

  return Object.freeze({
    askIfUnknown,
    allowedThisSession,
    deniedThisSession,
  });
}
