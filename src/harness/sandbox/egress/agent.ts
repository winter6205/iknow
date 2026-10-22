/**
 * src/harness/sandbox/egress/agent.ts
 *
 * The session-resident egress **agent** — the long-lived half of the egress
 * seam (plan T4 "出口代理会话级常驻"), and the **per-call endpoint** it hands
 * out (plan T5 "按调用子 socket").
 *
 * // (ADR-0097)
 * Why the seam is split in two levels:
 *
 * The upstream proxy package binds ONE `filter` and ONE sink channel per
 * proxy-server instance (`createHttpProxyServer(options)` closes over a single
 * options object). A single long-lived proxy server therefore cannot carry a
 * per-call policy and per-call violation attribution unless the call identity
 * is read out of a request header — and the plan explicitly forbids that
 * ("按调用策略与违规记录挂在子 socket 上，不读请求头标识"). The split is what
 * satisfies both requirements at once:
 *
 *   - the **AGENT** (one per session, lazily started, disposed at session
 *     exit) owns the expensive profile: relay resolution, the durable CA load
 *     + trust-bundle write, the credential mint (sentinel registry / masked
 *     store / masked binds), the proxy auth token and the ssh-agent verdict.
 *     Loaded ONCE — the second call of the session reuses it.
 *   - the **ENDPOINT** (one per call, created and disposed inside the call)
 *     owns the cheap per-call half: a fresh unix socket (path carries the
 *     one-shot call id, mode 0600), a proxy-server instance whose filter
 *     closure carries THAT call's policy and THAT call's violation sink, and
 *     the fence spec whose socket path + bridge script point at that socket.
 *
 * A proxy-server INSTANCE is still created per call (it is cheap: one
 * `createServer()` + `listen` + `chmod`); what is no longer created and
 * destroyed per call is the expensive profile (CA load, trust-bundle write,
 * credential mint).
 *
 * Invariants:
 *
 * // (ADR-0097)
 *   - the agent is created by an explicit factory and passed to whoever uses
 *     it — there is NO module-level singleton and NO module-level cache;
 *   - the start is lazy and idempotent: the first call loads the profile, a
 *     later call reuses it, and concurrent first calls share ONE in-flight
 *     start (never two profiles);
 *   - a start failure is FAIL-CLOSED: the caller receives the typed error and
 *     NO endpoint is created (never a silent direct connection);
 *   - the agent-level sink holds only records produced OUTSIDE a call (today:
 *     none — the mint records no violation; the CA store's notices travel on
 *     their own `onWarn` channel). It never mixes calls together: every
 *     call's violations live in that call's endpoint sink and nowhere else.
 *
 * Relationship to `session.ts`: the low-level pieces (filter callback, proxy
 * start, spec assembly, listen / socket cleanup, mint / release) stay in
 * `session.ts` — they are shared with the legacy per-call session path — and
 * are consumed here. The per-call endpoint builder
 * (`startEgressCallEndpoint`) lives there too, because the legacy
 * compatibility entry (`createEgressSession`) composes the very same
 * profile + endpoint pair; keeping one builder means there is exactly ONE
 * implementation of "one call's seam".
 */

import type { Server } from "node:http";
import { ToolExecutionError } from "../../errors.js";
import {
  createEgressViolationSink,
  type EgressViolationSink,
} from "./violations.js";
import {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "./upstream.js";
import {
  defaultSocketPathFactory,
  newSessionId,
  releaseCredentialResources,
  resolveEgressProfile,
  startEgressCallEndpoint,
  type EgressCallEndpoint,
  type EgressCallPolicy,
  type EgressProfile,
  type EgressProfileOptions,
} from "./session.js";

/**
 * Typed error for "the agent was already released" — a call that arrives
 * after the session teardown gets this error instead of a half-open seam
 * (fail-closed: no endpoint, no socket, no direct connection).
 */
export class EgressAgentDisposedError extends ToolExecutionError {
  override readonly name: string = "EgressAgentDisposedError";
  /** The agent's id (observation surface). */
  readonly agentId: string;
  constructor(agentId: string) {
    super(
      `egress agent ${agentId} is already released — no egress seam is available for this call (fail-closed; the session outlived the agent).`
    );
    this.agentId = agentId;
  }
}

/**
 * Agent construction inputs — the session-level half of the seam.
 *
 * Every seam of the legacy session path is available here too (relay
 * resolver, socket path factory, proxy-server factory, CA loader, CA dir,
 * host env, tls-exempt hosts, mint observation), so tests can inject the same
 * fixtures.
 */
export interface EgressAgentOptions extends EgressProfileOptions {
  /**
   * Unix socket path factory for the per-call endpoints — receives the
   * one-shot call id (default `join(tmpdir(), iknow-egress-<callId>.sock)`).
   */
  readonly socketPathFactory?: (id: string) => string;
  /**
   * Test seam: inject the `createHttpProxyServer` factory so unit tests can
   * capture the per-call `filter` closure and drive it directly. Production
   * does not pass it (the default `createHttpProxyServer` is used).
   */
  readonly createHttpProxyServer?: (opts: HttpProxyServerOptions) => Server;
  /**
   * Domain-pattern set exempt from TLS termination (agent-level setting —
   * the same set applies to every call of the session). Default empty =
   * terminate all allowed domains.
   */
  readonly tlsExemptHosts?: readonly string[];
  /**
   * Agent-level violation sink — the landing zone for records produced
   * OUTSIDE a call (today: none; the mint records no violation). It never
   * receives a call's violations: those live in the call's endpoint sink.
   */
  readonly violationSink?: EgressViolationSink;
}

/**
 * The session-resident egress agent.
 *
 * Lifecycle: `createEgressAgent` → (lazily, on the first call)
 * `createCallEndpoint` per call → `dispose` at session exit.
 */
export interface EgressAgent {
  /** The agent's session id (16 hex chars) — stable from factory time. */
  readonly id: string;
  /**
   * The agent-level sink — records produced outside any single call. Never
   * mixed with a call's violations.
   */
  readonly violationSink: EgressViolationSink;
  /**
   * Load the session profile (idempotent). Called implicitly by the first
   * `createCallEndpoint`; exposed so a caller can warm the profile up front
   * (and so a start failure surfaces at a chosen point).
   */
  ensureStarted(): Promise<void>;
  /**
   * Create THIS call's endpoint: its own unix socket (path carries the
   * one-shot call id, mode 0600), its own proxy-server instance (its filter
   * closure carries this call's policy + this call's sink) and its own fence
   * spec.
   *
   * Throws the typed start error (fail-closed) when the profile cannot be
   * loaded — no endpoint, no socket, no direct connection.
   */
  createCallEndpoint(policy: EgressCallPolicy): Promise<EgressCallEndpoint>;
  /**
   * Release the session: the live endpoints (if any) are closed first, then
   * the credential layer (registry / masked store / trust bundle) is released.
   * **Idempotent** (finally-safe).
   */
  dispose(): Promise<void>;
}

/**
 * Track a live endpoint so the agent's dispose is a complete teardown: the
 * wrapper drops the endpoint from the live set as soon as the call releases
 * it, so a long session does not accumulate dead endpoints.
 */
function trackEndpoint(
  endpoint: EgressCallEndpoint,
  live: Set<EgressCallEndpoint>
): EgressCallEndpoint {
  const release = endpoint.dispose;
  return Object.freeze({
    id: endpoint.id,
    socketPath: endpoint.socketPath,
    spec: endpoint.spec,
    violationSink: endpoint.violationSink,
    dispose: async (): Promise<void> => {
      live.delete(endpoint);
      await release();
    },
  });
}

/**
 * Factory: create the session-resident egress agent.
 *
 * Nothing is loaded here — the profile is resolved on the first
 * `createCallEndpoint` (or on an explicit `ensureStarted`). The start is
 * idempotent and concurrency-safe: concurrent first calls share ONE in-flight
 * start, so a session never ends up with two profiles.
 */
export function createEgressAgent(options: EgressAgentOptions): EgressAgent {
  const id = options.id ?? newSessionId();
  const agentSink = options.violationSink ?? createEgressViolationSink();
  const socketPathFactory =
    options.socketPathFactory ?? defaultSocketPathFactory;
  const createHttpProxy =
    options.createHttpProxyServer ?? createHttpProxyServer;
  const tlsExemptHosts = options.tlsExemptHosts ?? [];

  let profile: EgressProfile | undefined;
  let startPromise: Promise<EgressProfile> | undefined;
  let disposed = false;
  const liveEndpoints = new Set<EgressCallEndpoint>();

  /**
   * Resolve the profile once. A failed start is NOT cached as a permanent
   * state: the in-flight handle is cleared so a later call may retry (the
   * failure itself is reported to the caller, never swallowed).
   *
   * The RESOLVED profile is retained: it is the only handle on the credential
   * layer (registry / masked store / trust bundle), so `dispose()` releases
   * the layer through it.
   */
  const ensureProfile = async (): Promise<EgressProfile> => {
    if (disposed) throw new EgressAgentDisposedError(id);
    if (profile !== undefined) return profile;
    const inFlight = startPromise;
    if (inFlight !== undefined) return inFlight;
    const attempt = resolveEgressProfile({ ...options, id });
    startPromise = attempt;
    try {
      const resolved = await attempt;
      if (disposed) {
        // EXIT: the agent was released while this start was in flight. The
        // DISPOSER owns the resolved profile — it took the in-flight handle
        // over before clearing it — so this branch only reports the typed
        // refusal. Releasing the credential layer here would race the
        // disposer's own release and could invert ADR-0146's teardown order.
        throw new EgressAgentDisposedError(id);
      }
      profile = resolved;
      return resolved;
    } catch (err) {
      // A failed start leaves NO half state: no profile is retained and the
      // in-flight handle is cleared, so a later call may retry.
      // EXIT: the start failed → the in-flight handle is cleared (no cached
      // failure) so a later call may retry; the original typed error
      // propagates unchanged.
      if (startPromise === attempt) startPromise = undefined;
      throw err;
    }
  };

  const createCallEndpoint = async (
    policy: EgressCallPolicy
  ): Promise<EgressCallEndpoint> => {
    const resolved = await ensureProfile();
    const endpoint = await startEgressCallEndpoint(resolved, policy, {
      createHttpProxy,
      socketPathFactory,
      tlsExemptHosts,
    });
    liveEndpoints.add(endpoint);
    return trackEndpoint(endpoint, liveEndpoints);
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    // Take ownership of the in-flight start BEFORE clearing the handle: the
    // resolved profile is the only handle on the credential layer, so
    // whoever disposes the agent must release that layer — not the abandoned
    // continuation, which would release it after `dispose()` had resolved.
    const inFlight = startPromise;
    startPromise = undefined;
    // Close the calls that are still open (each endpoint's dispose is
    // idempotent, so a call that already released its endpoint is a no-op).
    for (const endpoint of [...liveEndpoints]) {
      await endpoint.dispose();
    }
    liveEndpoints.clear();
    // The credential layer is released AFTER the endpoints: an endpoint
    // borrows the registry / CA, so the endpoints must be gone first
    // (ADR-0146 teardown order). The retained profile is the only handle on
    // that layer — without it this release would be a no-op.
    const current = profile;
    profile = undefined;
    if (current !== undefined) {
      await releaseCredentialResources(current.credential);
      return;
    }
    // EXIT: no profile was retained, so a start was still in flight. The
    // disposer takes it over and releases the layer it resolves, so the
    // credential layer cannot outlive `dispose()`. A rejected start has no
    // layer to release, so its rejection is swallowed here (the original
    // caller still sees it).
    if (inFlight !== undefined) {
      const resolved = await inFlight.catch(() => undefined);
      await releaseCredentialResources(resolved?.credential);
    }
  };

  return Object.freeze({
    id,
    violationSink: agentSink,
    ensureStarted: async (): Promise<void> => {
      await ensureProfile();
    },
    createCallEndpoint,
    dispose,
  });
}

export type { EgressCallEndpoint, EgressCallPolicy };
