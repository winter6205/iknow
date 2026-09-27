/**
 * src/harness/permission/security-review.ts
 *
 * ADR-0127 Security review requirement — the pre-mode review gate's shared
 * contract. Deliberately outside HardRuleSpec, which stays deny-only: a review
 * requirement is neither an ask arm of the hard wall nor a persisted grant.
 *
 * Ordering (SC-GATES-5): confirmed danger denies first; a review requirement
 * is evaluated before session/project grants and before either mode branch;
 * proven inert content follows the ordinary permission flow.
 */

import { VIOLATION_PREFIXES } from "./prefixes.js";

/** The typed causes, one table (SSOT): the union below and the wire schema
 *  enum in subagent/envelope.ts both derive from this list — a value-set
 *  change lands on exactly one line (ADR-0127). */
export const SECURITY_REVIEW_CAUSES = [
  /** A destructive-looking operand may be executed by a program not proven inert. */
  "execution-unresolved",
  /** Text that looks dangerous is not positively proven to be inert data. */
  "data-ownership-unresolved",
  /** Heredoc receiver is missing, ambiguous, or unclassified. */
  "receiver-unresolved",
  /** Bounded recursive analysis hit its budget with relevant content open. */
  "bounded-analysis-exhausted",
] as const;

/** Typed cause: why the security-relevant pattern's ownership is unresolved. */
export type SecurityReviewCause = (typeof SECURITY_REVIEW_CAUSES)[number];

/** Evidence record: the cause plus the unresolved source span. */
export interface SecurityReviewRequirement {
  readonly cause: SecurityReviewCause;
  /** Character span in the command text of the unresolved region. */
  readonly span: { readonly start: number; readonly end: number };
  /** Non-empty structural detail (what region, which inner command). */
  readonly detail: string;
}

/** One call-scoped review presentation to a human. Approval covers only this request. */
export interface SecurityReviewRequest {
  readonly requirement: SecurityReviewRequirement;
  readonly tool: string;
  readonly input: unknown;
  readonly summaryHint: string;
  /** Caller-generated unique id; the answer is bound to it, never to a class of calls. */
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

/**
 * End-to-end interactive review route supplied by host entry adapters
 * (TTY, TUI bridge, serve hub) or, for workers, a parent-owned broker relay.
 * Presence of this object — not the presence of an ask callback — is the
 * proof that a request can reach a user. Callbacks that cannot reach a user
 * (createNoAskUser, bare-ACI permissive defaults) must never be constructed
 * into a route.
 */
export interface SecurityReviewRoute {
  readonly interactive: true;
  /** Resolve true (approve this call) / false (deny this call). Reject,
   *  abort, timeout, or disconnect must be converted to false by the route
   *  owner before resolution, or thrown — the executor turns either into a
   *  typed deny with the cause recorded. */
  request(req: SecurityReviewRequest): Promise<boolean>;
}

/** Executor option name carrying a route into createPermissionExecutor. */
export const SECURITY_REVIEW_OPTION = "securityReview";

/** Typed deny prefix for the no-route / route-failure case. The token lives
 *  in the SSOT prefix table (recognize side: sandbox/violation-handling);
 *  the trailing space is part of the frozen deny-message shape. */
export const SECURITY_REVIEW_DENY_PREFIX =
  `${VIOLATION_PREFIXES.securityReviewUnavailable} `;
