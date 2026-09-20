/**
 * src/harness/sandbox/egress/violations.ts
 *
 * Egress violation recorder — the "record" hop of the violation feedback
 * channel.
 *
 * Single responsibility: record structured violations when the egress proxy
 * filter callback returns false, and provide the session-end drain interface.
 * The bash handler consumes this for feed-back — appending violation text to
 * the tool_result stderr or a typed failure.
 *
 * Shape choice: typed records (`kind`-discriminated union) held by a plain
 * class with readonly fields — same shape as ToolExecutionError /
 * McpLifecycleError: catchers must branch on `kind` before rendering
 * (typed-error catch contract); `err instanceof Error ? err.message :
 * String(err)` is forbidden.
 *
 * Why a standalone piece (not folded into policy.ts / bash.ts):
 *   - domain-decision denial is a **boundary statement**, orthogonal to the
 *     command execution result; standalone containment is cleaner;
 *   - every violation must carry a `command` field, injected at bash assembly
 *     time (failure-trace requirement);
 *   - session/drain pairing: one drain per session, buffer cleared after.
 */

import { VIOLATION_PREFIXES } from "../../permission/prefixes.js";

/**
 * Allowlist provenance — the closed three-tier value injected by the
 * assembly surface (the whole chain migrated at once, no legacy aliases):
 *   - "builtin"   = code-borne pre-allow tier (assembly path with the
 *
 // (ADR-0104)
 *     settings section absent);
 *   - "persisted" = user-persisted settings merged as an increment
 *     (assembly path with the section present);
 *   - "session"   = session-level approval (bash factory wrapper fallback).
 * Default = provenance unstated (do not fabricate one of the three tiers).
 * Observation surface only; never part of the decision.
 */
export type EgressAllowlistSource = "builtin" | "session" | "persisted";

export type EgressViolationReason =
  /** CONNECT host missed the allowlist (a denied-set/pattern hit is handled separately). */
  | "not-in-allowlist"
  /** CONNECT host hit the denied set / denied pattern (deny wins). */
  | "denied"
  /** Empty allowlist (fail-closed start). */
  | "allowlist-empty"
  /** Malformed allowlist entries (`:65536` etc.). */
  | "allowlist-malformed"
  /** Address guard denial (resolved into loopback / private / metadata etc.). */
  | "address-denied"
  /** First-seen domain at a non-interactive entry with no askApproval inlet. */
  | "no-approval-inlet"
  /** User explicitly denied approval at the interactive entry — kept distinct
   *  from no-approval-inlet: the three signal classes (infra / user-denied /
   *  unconfigured) require different fixes. */
  | "denied-by-user"
  /** Infrastructure fault (proxy / relay dependency missing) — not a domain decision */
  | "infra-unavailable"
  /**
   * Bypass diagnostic tier: request body carries `Content-Encoding`, the
   * package's byte scan cannot see through compressed bodies → body
   * substitution is skipped and the fake value reaches upstream unchanged
   * (fail-safe direction = auth fails with 401, diagnosable, not a leak).
   * **Not** a domain decision; no allowlist fix guidance.
   */
  | "substitution-skipped"
  /**
   * Bypass diagnostic tier: the domain is exempted by `shouldTerminateTLS`
   * (no TLS termination → substitution necessarily cannot run) AND a
   * credential entry with injection configured exists for that host
   * (`namesInjectableAt` non-empty). The exemption itself is not a
   * violation; what this trace says is "exemption ∧ injectable credentials =
   * those credentials are unusable at this host".
   */
  | "tls-exempt-injectable";

export interface EgressViolation {
  readonly kind: "egress_violation";
  readonly host: string;
  readonly port: number;
  readonly reason: EgressViolationReason;
  /**
   * Command context (the spawned raw command text or named entry). **For
   * observation only** — never part of the decision and never folded into the
   * host field (so command strings cannot pollute domain logs).
   */
  readonly command: string;
}

export interface EgressViolationSink {
  /** Called once per filter callback; pure append, zero async. */
  record(v: EgressViolation): void;
  /**
   * Session-end drain — the caller (bash handler) takes the snapshot and the
   * container is cleared. The returned snapshot is readonly; a second drain
   * returns an empty array.
   */
  drain(): readonly EgressViolation[];
  /**
   * Current recorded count (tests / diagnostics).
   */
  size(): number;
}

/**
 * Factory — one session holds the violation array; `drain()` snapshots then
 * clears (slice shares no reference, so later records cannot disturb an
 * already-drained copy).
 *
 * Not a concurrency primitive: within this repo's egress domain the filter is
 * not assumed to be hit from multiple threads; under Node's single-threaded
 * event loop, append/drain ordering suffices. In production, "concurrent
 * requests in one session" are serialized by the upstream proxy process (the
 * HTTP server side).
 */
export function createEgressViolationSink(): EgressViolationSink {
  let buffer: EgressViolation[] = [];
  return Object.freeze({
    record(v: EgressViolation) {
      // Defensive: empty host / non-numeric port → not buffered (guards
      // against log injection and broken downstream assumptions). Callers
      // should already reject empty hosts at the decision layer; this is the
      // backstop.
      if (typeof v.host !== "string" || v.host.length === 0) return;
      if (!Number.isInteger(v.port) || v.port < 0) return;
      buffer.push(Object.freeze({ ...v }));
    },
    drain() {
      const out = buffer.slice();
      buffer = [];
      return Object.freeze(out);
    },
    size() {
      return buffer.length;
    },
  });
}

/**
 * Render a violation snapshot as human-readable multiline text (one line per
 * violation; trailing newline optional).
 *
 * - not-in-allowlist: denied domain + suggested config key.
 * - denied: denied domain + matched deny rule literal.
 * - allowlist-empty: the fact that no allowedDomains source is present.
 * - allowlist-malformed: malformed entries (command-level phrasing).
 * - address-denied: denied domain + resolved address + matched tier (loopback
 *   / private etc.).
 * - no-approval-inlet: denied domain + non-interactive-entry fact.
 * - denied-by-user: denied domain + explicit user denial fact + config key
 *   guidance.
 * - infra-unavailable: infrastructure fault — must **never** be merged into
 *   the same segment as domain denials (fixes differ completely: infra =
 *   repair the product dependency / bundled relay; domain = change config).
 *   This function only renders line by line; the infra/domain segregation
 *   logic lives in `renderEgressFailureMessage`.
 *
 * Deliberately never renders secrets / tokens / full command text — commands
 * truncate to 80 chars.
 */
export function renderEgressViolations(
  violations: readonly EgressViolation[]
): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(renderSingleViolation(v));
  }
  return lines.join("\n");
}

/**
 * Bypass diagnostic tier: separated from domain denials and infra faults by
 * prefix (`[egress_diagnostic]`) so the four signal classes never mix — the
 * fix here is "make the body scannable / review the exemption list", nothing
 * to do with the allowlist.
 */
type EgressDiagnosticReason = "substitution-skipped" | "tls-exempt-injectable";

/** Domain-decision / infra reasons (everything but diagnostics; exhaustiveness is compiler-enforced). */
type EgressDomainReason = Exclude<
  EgressViolationReason,
  EgressDiagnosticReason
>;

const DIAGNOSTIC_RENDERERS: Record<
  EgressDiagnosticReason,
  (target: string, cmd: string) => string
> = {
  "substitution-skipped": (target, cmd) =>
    `[egress_diagnostic] ${target} request body carried Content-Encoding; masked-credential substitution skipped and the fake value reaches upstream unchanged (fail-safe direction: auth fails, no secret leaks; not a domain decision) (command: ${cmd})`,
  "tls-exempt-injectable": (target, cmd) =>
    `[egress_diagnostic] ${target} is exempted from TLS termination while masked credentials are configured for injection there — substitution cannot run on exempted hosts, so those credentials are unusable at this host (fail-safe; not a domain decision) (command: ${cmd})`,
};

function renderSingleViolation(v: EgressViolation): string {
  const cmd =
    v.command.length > 80 ? `${v.command.slice(0, 77)}...` : v.command;
  const target = `${v.host}:${v.port}`;
  // In the default branch TS narrows reason to the full set minus the
  // diagnostic tiers (exhaustiveness pinned by the compiler).
  switch (v.reason) {
    case "substitution-skipped":
    case "tls-exempt-injectable":
      return DIAGNOSTIC_RENDERERS[v.reason](target, cmd);
    default:
      return renderDomainViolation(v.reason, target, cmd);
  }
}

function renderDomainViolation(
  reason: EgressDomainReason,
  target: string,
  cmd: string
): string {
  switch (reason) {
    case "not-in-allowlist":
      return `[network_denied] ${target} not in allowed domains (command: ${cmd}); configure isolation.network.allowedDomains or approve this domain interactively`;
    case "denied":
      return `[network_denied] ${target} matched a deny rule (command: ${cmd})`;
    case "allowlist-empty":
      return `[network_denied] ${target} rejected: allowed domains list is empty (configure isolation.network.allowedDomains or approve interactively) (command: ${cmd})`;
    case "allowlist-malformed":
      return `[network_denied] ${target} rejected: allowed domains list contains only malformed entries (command: ${cmd})`;
    case "address-denied":
      return `[network_denied] ${target} resolved to a denied address (command: ${cmd}); an allowed hostname must not resolve into loopback / private / metadata IP space`;
    case "no-approval-inlet":
      return `[network_denied] ${target} seen for the first time and no interactive approval inlet is available (command: ${cmd}); pre-add it to isolation.network.allowedDomains for non-interactive runs`;
    case "denied-by-user":
      return `[network_denied] ${target} denied by user for this session (command: ${cmd}); to allow this host pre-add it to isolation.network.allowedDomains or approve it interactively`;
    case "infra-unavailable":
      return `[network_denied] ${target} egress seam unavailable (command: ${cmd}); infrastructure fault, not a domain allowlist decision`;
  }
}

/**
 * Whether a violation is classified as an "infrastructure fault" — kept
 * distinct from domain denials: infra = repair the runtime / the bundled
 * relay, and it must **never** receive config-key guidance; domain denial =
 * change config / use the interactive approval entry.
 */
function isInfraViolation(v: EgressViolation): boolean {
  return v.reason === "infra-unavailable";
}

/**
 * Shared remediation footers — reused when multiple violations merge (no
 * per-line repetition). Two semantics, two texts: domain denials get the
 * config key + approval entry; infra gets the infrastructure repair note.
 * The comment only explains why there are two segments — the fix actions
 * differ.
 */
const REMEDIATION_DOMAIN = `Remediation: add the host to isolation.network.allowedDomains in user settings, or approve it interactively through the permission prompt; the command itself ran to completion inside the sandbox — exit code still reflects the command, not this denial.`;
const REMEDIATION_INFRA = `Remediation: this is an infrastructure fault, not a domain decision — check the iknow-bundled egress relay (vendor/egress-relay assets + a Node >=20 runtime in the install root), not the allowlist; the command itself ran to completion inside the sandbox — exit code still reflects the command, not this denial.`;
const SOURCE_LABEL: Record<EgressAllowlistSource, string> = {
  builtin: "built-in preset allowlist (github / npm / playwright defaults)",
  session: "session-level allowlist",
  persisted: "user-settings persisted allowlist",
};

/**
 * Typed failure message — assembled as one block containing:
 *   - the `[network_denied]` prefix (so the existing `categorizeResult` lands
 *     it in the mid tier, keeping the networkDenied → mid branch in
 *     violation-handling.ts working without touching that file);
 *   - one line per violation (denied domain + readable text for the matched reason);
 *   - the shared remediation footer (not repeated per line);
 *   - allowlist provenance (default = unannotated, **never fabricated**);
 *   - the "command ran to completion but egress was denied" semantics (so the
 *     model does not misread it as a process crash).
 *
 * Infra / domain denials are **never merged** into one segment: the two
 * signal classes need completely different fixes, and mixing would mislead
 * the model. Pure infra → no domains listed; pure domain → never says "infra".
 *
 * `infraHint`: an optional repair snippet for infra faults (injected by the
 * bash assembly layer onto typed errors such as the bundled relay's missing
 * dependencies; per the typed-error catch contract). Inserted as one line
 * only on the infra-only path (before REMEDIATION_INFRA) so the model/TUI can
 * see "which binary + how to install"; not inserted by default (avoids
 * boilerplate when there is no information).
 */
export function renderEgressFailureMessage(args: {
  readonly violations: readonly EgressViolation[];
  readonly allowlistSource?: EgressAllowlistSource;
  readonly infraHint?: string;
}): string {
  const { violations, allowlistSource, infraHint } = args;
  if (violations.length === 0) return "";

  const infraOnly = violations.every(isInfraViolation);
  const domainOnly = violations.every((v) => !isInfraViolation(v));
  // Defensive: infra + domain mix (theoretically impossible from the filter;
  // kept for future reason-set expansion). Render only the domain portion in
  // that case, with infra as its own segment — avoid implying "infra is a
  // domain allowlist decision".
  const domainViolations = violations.filter((v) => !isInfraViolation(v));
  const infraViolations = violations.filter(isInfraViolation);

  const lines: string[] = [];
  lines.push(
    `${VIOLATION_PREFIXES.networkDenied} command ran to completion inside the sandbox; egress connection was denied at the network boundary.`
  );
  if (domainOnly) {
    appendDomainPortion(lines, domainViolations, allowlistSource);
  } else if (infraOnly) {
    appendInfraPortion(lines, infraViolations, infraHint);
  } else {
    // Mixed: two segments (the three signal classes must stay distinguishable;
    // infra ≠ domain denial).
    lines.push("Domain-deny portion:");
    appendDomainPortion(lines, domainViolations, allowlistSource);
    lines.push("Infrastructure-fault portion:");
    appendInfraPortion(lines, infraViolations, infraHint);
  }
  return lines.join("\n");
}

/**
 * Assemble the domain-denial segment — renders each violation from the list
 * plus the shared REMEDIATION_DOMAIN footer (no per-line repetition).
 * Extracted to keep `renderEgressFailureMessage` within the complexity lint
 * gate.
 */
function appendDomainPortion(
  lines: string[],
  domainViolations: readonly EgressViolation[],
  allowlistSource: EgressAllowlistSource | undefined
): void {
  if (allowlistSource !== undefined) {
    lines.push(`Current allowlist source: ${SOURCE_LABEL[allowlistSource]}.`);
  }
  for (const v of domainViolations) {
    lines.push(renderSingleViolation(v));
  }
  lines.push(REMEDIATION_DOMAIN);
}

/**
 * Assemble the infrastructure-fault segment — renders each violation plus the
 * optional infraHint (typed-error catch contract landing: the detail +
 * remediationHint carried by EgressRelayUnavailableError, so the model/TUI
 * directly sees "which product dependency is missing + how to fix it" — per
 * ADR-0107 this names the bundled relay, not a system package — and typed-error
 * information is no longer swallowed as [object Object]) + the
 * REMEDIATION_INFRA footer. Extracted to keep `renderEgressFailureMessage`
 * within the complexity lint gate.
 */
function appendInfraPortion(
  lines: string[],
  infraViolations: readonly EgressViolation[],
  infraHint: string | undefined
): void {
  for (const v of infraViolations) {
    lines.push(renderSingleViolation(v));
  }
  if (infraHint !== undefined && infraHint.length > 0) {
    lines.push(infraHint);
  }
  lines.push(REMEDIATION_INFRA);
}

/**
 * The "first unknown host key" guidance line for ssh-class failure feed-back
 * text.
 *
 * Background: with no known_hosts entry ssh asks to confirm the fingerprint,
 * the fence has no tty → failure before authentication (`Host key verification
 * failed.` / `The authenticity of host ... can't be established.`). Guidance =
 * the pinned two options: pre-populate known_hosts on the host via
 * `ssh-keyscan` / confirm once interactively, or pass an explicit
 * `-o UserKnownHostsFile=` inside the sandbox using the combined form
 * (`GIT_SSH_COMMAND="$GIT_SSH_COMMAND ..."` referencing the injected value,
 * same merge strategy as the rest of the ssh wiring). We do **not** inject or
 * suggest `StrictHostKeyChecking=no` by default — weakening the trust plane is
 * out of scope, and a reverse assertion pins that wording away.
 *
 * The detection is **text-surface observation**, not framework attribution: it
 * happens at the command layer (tunnel already up, ssh itself refuses),
 * produces no egress violation and does not touch the typed-failure channel;
 * the bash assembly layer appends one line only when the egress seam is in
 * play, the command exits non-zero, and stderr matches a known ssh host-key
 * shape. Pure function (no I/O); the pattern set is extensible; a miss =
 * undefined (better to say nothing than to misreport).
 */
const SSH_HOST_KEY_PATTERNS: readonly RegExp[] = [
  /Host key verification failed/,
  /The authenticity of host .* can'?t be established/,
];

export const SSH_HOST_KEY_GUIDANCE_LINE =
  '[iknow-egress] ssh first-time unknown host key (no known_hosts entry): the fence has no tty to confirm the fingerprint, so ssh fails before auth. Fix on the host side first: `ssh-keyscan <host> >> ~/.ssh/known_hosts` (verify the fingerprint out-of-band) or confirm once via an interactive login; alternatively pass an explicit known_hosts inside the sandbox with the combined form `GIT_SSH_COMMAND="$GIT_SSH_COMMAND -o UserKnownHostsFile=<path>"`. StrictHostKeyChecking stays at its default (this product does not disable host-key trust).';

export function sshHostKeyFailureGuidance(stderr: string): string | undefined {
  return SSH_HOST_KEY_PATTERNS.some((re) => re.test(stderr))
    ? SSH_HOST_KEY_GUIDANCE_LINE
    : undefined;
}
