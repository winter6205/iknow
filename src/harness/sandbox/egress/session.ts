/**
 * src/harness/sandbox/egress/session.ts
 *
 * Egress session lifecycle pieces — the foreground shape of the proxy
 *
 // (ADR-0097)
 * lifecycle / dispose contract (ADR-0107 egress relay lineage).
 *
 * Single responsibility: wrap "resolve bundled relay dependencies → start the
 * HTTP proxy (token isolation + filter callback, listening directly on a unix
 * socket) → expose the spec consumed by bwrap fence assembly → release on
 * teardown" into one session shape, created per foreground call.
 *
 * ADR-0107 retrofit: **socat is not a product dependency, on either side**.
 * The host-side "socat bridge (unix socket ↔ proxy TCP port)" is deleted —
 * `createHttpProxyServer` returns a bare node:http Server that
 * `listen(<unixSocketPath>)`s directly (in-package precedent: the stale
 * unlink + listen(sockPath) in sandbox-runtime's dist/sandbox/mux-proxy.js).
 * The in-fence half-bridge becomes this repo's bundled node relay assets
 * (resolved by relay-assets.ts; `EgressFenceSpec.relayAssetsDir` feeds the
 * fence `--ro-bind`). A missing relay dependency (node runtime / bundled
 * assets) = fail-closed, throwing `EgressRelayUnavailableError` — the guidance
 * names **this product's dependency** (reinstall iknow / repair the install
 * root) and contains no socat/apt install wording.
 *
 * Socket paths carry a per-session random id with stale sockets cleaned before
 * startup (see the ADR decision docs). The SOCKS5 / git-over-SOCKS surface
 * (port 1080 segment) was ruled out of the current branch by the operator;
 *
 // (ADR-0105)
 * the credential surface has its own ADR lineage. Add a second socket here if
 * a mux shape is ever introduced.
 *
 * Filter callback ↔ approvalGate wiring (first-time domain approval flow):
 * when `decideEgress` returns `not-in-allowlist` and a gate is present → call
 *
 // (ADR-0097)
 * `gate.askIfUnknown(host)`; approve adds to the session set and passes;
 * deny records a `denied-by-user` violation and blocks. Gate absent → record
 * `no-approval-inlet` + block (fail-closed for non-interactive entry points
 * meeting a new domain for the first time).
 *
 * Invariants:
 *
 // (ADR-0097)
 *   - abnormal and normal paths share one release channel (finally-safe dispose).
 *   - dispose is idempotent (repeat calls neither throw nor warn).
 *   - the token is per session (prevents other host processes from connecting
 *     to the proxy directly to bypass the filter).
 *
 * Threat model — local exposure surface (registered at end-of-round review):
 *   - the proxy unix socket lands in shared /tmp and node's default listen
 *     mode = 0777 & ~umask (commonly 0755) → chmod 0600 immediately after a
 *     successful listen (`listenOnUnixSocket`), so local other users cannot
 *     connect even knowing the path.
 *   - **known residual surface**: the token rides the fence's
 *     `bwrap --setenv HTTP_PROXY …` argv, briefly readable by local other
 *     users via /proc/<pid>/cmdline during the fence startup window (the
 *     socket path likewise, via the inner preamble argv). This seam does not
 *     change the bwrap env channel for it (--setenv is the env-injection
 *     SSOT; altering the transport is a fence architecture change); the
 *     practical backstop is the socket 0600 above — a stolen token with no
 *     socket connection still cannot bypass the filter. The residual risk is
 *     accepted and registered here explicitly.
 */

import { chmodSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders, Server } from "node:http";
import { ToolExecutionError } from "../../errors.js";
import {
  createHttpProxyServer,
  createResolvedAddressGuard,
  disposeMitmCA,
  matchesDomainPattern,
  type HttpProxyServerOptions,
  type MitmCA,
} from "./upstream.js";
import {
  createEgressViolationSink,
  type EgressAllowlistSource,
  type EgressViolationSink,
} from "./violations.js";
import type { EgressApprovalGate } from "./approval.js";
import {
  mintEgressCredentialLayer,
  type EgressCredentialRoster,
} from "./credential-assembly.js";
import {
  type EgressCredentialMint,
  type EgressFenceBind,
} from "./credential-mint.js";
import { loadEgressCa, type EgressCaLoad } from "./ca-store.js";
import { resolveEgressRelay, type EgressRelayPaths } from "./relay-assets.js";

/**
 * Decision input — read from settings by the bash handler and injected here
 * (dependency injection; the egress domain never reads settings directly).
 *
 * Why injection: domain-matcher.ts already consumes plain data; this layer
 * keeps the same shape — the assembly surface (bash handler) holds the
 * settings source, so the egress domain never imports config back.
 */
export interface EgressPolicyInput {
  /** Domain allowlist (from `isolation.network.allowedDomains`). */
  readonly allowedDomains: readonly string[];
  /** Domain denylist (from `isolation.network.deniedDomains`). */
  readonly deniedDomains: readonly string[];
  /**
   * Extra denied tiers for the address guard. When omitted the session falls
   * back to `domain-matcher.DEFAULT_PRIVATE_DENIED_RANGES`.
   */
  readonly deniedResolvedAddresses?: readonly string[];
  /**
   * Command context field — injected into violation records for observation /
   * feed-back. In the foreground shape this is `bash.ts`'s finalCommand (the
   * real value after secret restoration) or the original placeholder
   * `command` (which one is the call surface's choice); never participates in
   * decisions.
   */
  readonly commandLabel: string;
  /**
   * Allowlist provenance — the closed three-tier `EgressAllowlistSource`
   * (referencing the shared type instead of a second inline union avoids
   * drift). Passed through to the typed failure message rendering as an
   * observation surface only; never participates in decisions. Producers:
   * assembly = builtin / persisted tiers, the bash factory wrapper's fallback
   * = session tier; default = provenance unstated (never fabricated).
   */
  readonly allowlistSource?: EgressAllowlistSource;
  /**
   * First-time domain approval gate — when `decideEgress` hits
   * `not-in-allowlist` and the host is in neither `allowedDomains` nor
   * `deniedDomains`, the filter callback calls `gate.askIfUnknown(host)` to
   * route through the interactive entry point.
   *
   * Default = no ask surface (fail-closed for non-interactive entry points
   * meeting a new domain: violation recorded as `no-approval-inlet` + blocked).
   * When present, the bash handler derives this gate from
   * `CreateBashToolOptions.askApproval`; the build engine / CLI assembly layer
   * transcribes the existing AskUser into `(host) => ask({...})`.
   *
   * The gate instance is created once in the bash tool factory's closure and
   * shared across calls; session-level allowed/denied sets accumulate in that
   * closure.
   */
  readonly approvalGate?: EgressApprovalGate;
  /**
   * Credential roster (the built-in github entries plus the full set after
   * user-tier `isolation.credentials` narrowing/appending) — injected as a
   * pure data shape, constructed by the assembly layer
   * (assembly.ts → credential-assembly.ts). Consumed by the session: present
   * = mint fake values into the fence (Step 1.5); absent = no roster (no
   * minting, no CA loading).
   */
  readonly credentials?: EgressCredentialRoster;
}

/**
 * Per-call policy — the call-scoped half of the egress decision input.
 *
 * It is `EgressPolicyInput` **without** the credential roster: the roster is
 * session-level (one mint per session, see the agent profile), so a per-call
 * policy must not be able to carry one. The approval gate stays in the
 * per-call policy because the gate instance itself is session-level (the bash
 * tool factory creates it once and every call passes the same instance — the
 * session-scoped approval set accumulates inside it).
 *
 * The command label is the per-call half: it rides into every violation
 * record produced by THAT call, which is what makes the attribution exact.
 */
export type EgressCallPolicy = Omit<EgressPolicyInput, "credentials">;

/**
 * Optional factory inputs. Relay resolution / socket path / server factory /
 * violation sink are all injectable so tests do not depend on the host node
 * layout or real asset placement (ADR-0107: no host package surface to probe).
 */
export interface EgressSessionOptions {
  readonly policy: EgressPolicyInput;
  /**
   * Credential availability branch (default **off**): absolute host SSH agent
   * socket path. Passing it explicitly = open state — the session hands it to
   * the fence via `EgressFenceSpec.sshAuthSockPath` for a same-segment
   * `--bind` and injects `SSH_AUTH_SOCK` into `spec.env`; default = closed,
   * neither appears (host agent values never enter the fence). Missing path /
   * stale-to-nonexistent → fail-closed, throwing `SshAgentUnavailableError`
   * (infra-classified, with guidance; the relay never starts and no half-open
   * shape remains). The agent socket is not session-owned — dispose never
   * deletes that path.
   */
  readonly sshAuthSockPath?: string;
  /**
   * Relay dependency resolver (default: the production `resolveEgressRelay`).
   * Test seam: inject a fixed fake path set so unit tests skip the host node
   * layout / asset placement; inject `() => undefined` to simulate the
   * fail-closed "product dependency missing" path.
   */
  readonly relayResolver?: () => EgressRelayPaths | undefined;
  /**
   * Unix socket path factory — default `join(tmpdir(), iknow-egress-<id>.sock)`;
   * tests may inject a fixed path. The proxy server listens on this path
   * directly (host side: no TCP, no bridge process).
   */
  readonly socketPathFactory?: (id: string) => string;
  /**
   * Violation recorder for the current command — default: the session creates
   * its own. The bash handler may inject a shared sink (multi-session merged
   * observation).
   */
  readonly violationSink?: EgressViolationSink;
  /**
   * Test seam: inject the `createHttpProxyServer` factory so unit tests
   * capture the `filter` callback and drive it directly
   * (gate.askIfUnknown → filter behaviour) without a real HTTP proxy server,
   * real CONNECT protocol, or auth token negotiation. Production assembly
   * **does not pass it** (the default `createHttpProxyServer` is used).
   *
   * Why needed: the approval-flow decision-side tests want to verify "filter
   * calls the gate on not-in-allowlist + approve/deny branches → sink records
   * the matching reason" without real egress dials / DNS / proxyAuthToken
   * negotiation. The injection point mirrors `relayResolver` /
   * `socketPathFactory` (complexity gate; a pure injection point that adds no
   * logic branch).
   */
  readonly createHttpProxyServer?: (
    opts: Parameters<typeof createHttpProxyServer>[0]
  ) => Server;
  /**
   * Test seam: inject the persistent CA loader (default
   * `ca-store.loadEgressCa` — RSA-2048 generation sits on the cold path, unit
   * tests do not really build a CA). Never called when
   * `policy.credentials` is absent.
   */
  readonly loadEgressCa?: (opts?: {
    readonly caDir?: string;
    readonly onWarn?: (message: string) => void;
  }) => EgressCaLoad;
  /** Persistent CA directory (test injection point, passed to loadEgressCa). Default = host default. */
  readonly caDir?: string;
  /**
   * Host env source for reading real values during minting (default
   * `process.env`) — test seam: fake credential fixtures are injected here so
   * real values / `.env*` never pass through the test surface.
   */
  readonly hostEnv?: Record<string, string | undefined>;
  /**
   * Domain-pattern set exempt from TLS termination (input to the
   * `shouldTerminateTLS` exemption hook) — the operator escape hatch left
   * open by the unresolved question. Default empty = terminate all allowed
   * domains. If an injectable credential entry exists for an exempt domain →
   * record a `tls-exempt-injectable` diagnostic trace (substitution necessarily
   * fails on that domain; fail-safe direction). Whether to make this a setting
   * is an open question; this slice only leaves the injection point.
   */
  readonly tlsExemptHosts?: readonly string[];
  /**
   * Test seam: after a successful mint, observe the session-private
   * registry / masked store / CA (used for the three-resource release
   * assertions). Production assembly does not pass it.
   */
  readonly onCredentialMint?: (cred: EgressCredentialResources) => void;
}

/**
 * The spec assembled into the bwrap fence — once the fence receives this
 * shape it hangs the socket bind + relay assets ro-bind + proxy env injection
 * (see the `egress` field of `createBwrapFence`).
 *
 * last-mount-wins ordering discipline (bwrap.ts comments):
 *  socket / relay bind placement = after workspaceMounts, before cwdReadonly.
 *  The --setenv keys go through the fence env injection.
 */
export interface EgressFenceSpec {
  /** Absolute host socket path (the fence uses it as `--bind src dest`, dest = same value). The proxy server listens here directly. */
  readonly unixSocketPath: string;
  /**
   * **Fixed in-sandbox listen port** (= `SANDBOX_HTTP_PROXY_PORT`). The
   * semantics changed from "same number as the host proxy TCP port" to a fixed
   * value — host/sandbox same-number was coincidental coupling; a fixed port
   * lets the env and the later `GIT_SSH_COMMAND` be pre-assembled. The fence
   * injects env such as `HTTP_PROXY=http://<user>:<token>@127.0.0.1:<port>`.
   */
  readonly sandboxLocalPort: number;
  /**
   * Env delta already containing the proxy keys (embedded auth userinfo) +
   * the NO_PROXY family + `GIT_SSH_COMMAND` (ssh bridge), and since the
   * credential-sentinel slice also the fake credential env and
   * `CA_TRUST_VARS` — the fence splices it into its own envArgs.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Masked-file cover binds + masked store directory ro-bind + trust bundle
   * ro-bind + the deny tier's `/dev/null` cover binds. The fence emits
   * everything into the egressBind segment (after workspaceMounts, before
   * cwdReadonly); absent / empty = no extra binds. The real source of the
   * constraint: this fence does not emit `--tmpfs /tmp` (global tier per
   *
   // (ADR-0092)
   * resource-limits.ts), so the host tmpdir holding the masked store / socket
   * enters the fence via "explicit per-path ro-bind + last-mount-wins covering
   * the real path under the root bind" — failing to emit means unreachable
   * from inside the fence.
   */
  readonly binds?: readonly EgressFenceBind[];
  /**
   * The in-sandbox half-bridge's preamble script (computed at session assembly
   * time): the bundled node relay forwards `127.0.0.1:<sandboxLocalPort>` to
   * `unixSocketPath` + trap cleanup (ADR-0107 retrofit:
   * `<absolute node path> <absolute relay script path> <sock> <port> &`).
   * Consumer = bash.ts foreground command chain
   * (`bash -c "<script>\n<command>"`); background / verify wiring lands in a
   * later slice.
   */
  readonly innerBridgeScript: string;
  /**
   * ADR-0107 bundled relay assets directory (absolute host path). The fence
   * emits `--ro-bind <dir> <dir>` (src=dest) for it in the existing egress
   * bind segment so the script paths referenced by `innerBridgeScript` /
   * `GIT_SSH_COMMAND` resolve inside the fence — no dependence on the install
   * root happening to sit inside some default-visible subtree.
   */
  readonly relayAssetsDir: string;
  /**
   * Conditional shape (default = closed, field absent): absolute host SSH
   * agent socket path. When present the fence appends
   * `--bind <path> <path>` to the existing egress bind segment (src=dest,
   * same placement discipline as the `unixSocketPath` bind: after
   * workspaceMounts, before cwdReadonly), and `spec.env` carries
   * `SSH_AUTH_SOCK` (value = the same path — after the bind the in-sandbox
   * path is unchanged). The path is not session-owned: the dispose channel
   * only closes the server and its own socket, never deletes this.
   */
  readonly sshAuthSockPath?: string;
}

/**
 * Session-private credential resource bundle: the mint product
 * (`EgressCredentialMint`) + the `MitmCA` it consumed (the CA reference must
 * outlive the proxy options wiring and the dispose bundle cleanup).
 */
export interface EgressCredentialResources {
  readonly mint: EgressCredentialMint;
  readonly ca: MitmCA;
}

/**
 * Session shape — consumed by the caller (bash handler); `spec` feeds fence
 * assembly, `dispose()` runs in the finally.
 */
export interface EgressSession {
  readonly id: string;
  readonly spec: EgressFenceSpec;
  readonly violationSink: EgressViolationSink;
  /**
   * Teardown: close the proxy server + delete the socket. **Idempotent**,
   * safe to call repeatedly (finally-safe); any error is swallowed (never
   * pollutes the caller's finally).
   */
  dispose(): Promise<void>;
}

/**
 * The session-resident egress **profile** — the expensive, long-lived half of
 * the seam (plan T4 "出口代理会话级常驻").
 *
 * What lives here (loaded ONCE per session):
 *   - the bundled relay dependency set (node runtime + relay assets);
 *   - the proxy auth token (one token per session, as before);
 *   - the durable CA load + the fresh trust-bundle write and the credential
 *     mint (sentinel registry / masked store / bind table / env delta);
 *   - the ssh-agent availability verdict;
 *   - the domain-matcher decision functions.
 *
 * What does NOT live here (per call, see `EgressCallEndpoint`): the unix
 * socket, the proxy-server instance (its filter closure carries the call's
 * policy + the call's sink), the violation sink and the fence spec.
 */
export interface EgressProfile {
  /** Session id (16 hex chars) — the profile's identity in logs / socket names. */
  readonly id: string;
  /** The resolved bundled relay dependency set. */
  readonly relay: EgressRelayPaths;
  /** The per-session proxy auth token (embedded in the proxy URL userinfo). */
  readonly token: string;
  /** Absolute host SSH agent socket path (open state) or undefined (closed). */
  readonly sshAuthSockPath: string | undefined;
  /** The minted credential resources (registry / store / CA), when a roster is present. */
  readonly credential: EgressCredentialResources | undefined;
  /** The domain decision function (dynamic import of the matcher). */
  readonly decideEgress: typeof import("./domain-matcher.js").decideEgress;
  /** The default denied address tiers (domain-matcher's private ranges). */
  readonly defaultDeniedRanges: readonly string[];
}

/**
 * Minting inputs — the credential half of the profile resolution. Split out
 * because the mint is session-level: the roster is minted once and its
 * resources (registry / masked store / trust bundle) live as long as the
 * profile does.
 */
export interface EgressMintOptions {
  /** Credential roster — present = mint the masked credential layer. */
  readonly credentials?: EgressCredentialRoster;
  /** Test seam: inject the persistent CA loader (default `ca-store.loadEgressCa`). */
  readonly loadEgressCa?: (opts?: {
    readonly caDir?: string;
    readonly onWarn?: (message: string) => void;
  }) => EgressCaLoad;
  /** Persistent CA directory (test injection point, passed to loadEgressCa). */
  readonly caDir?: string;
  /** Host env source for reading real values during minting (default `process.env`). */
  readonly hostEnv?: Record<string, string | undefined>;
  /** Observation seam: after a successful mint, observe the mint product. */
  readonly onCredentialMint?: (cred: EgressCredentialResources) => void;
}

/**
 * Profile resolution inputs — the session-resident half of the seam.
 */
export interface EgressProfileOptions extends EgressMintOptions {
  /**
   * Credential availability branch (default **off**): absolute host SSH agent
   * socket path. Missing path / stale-to-nonexistent → fail-closed, throwing
   * `SshAgentUnavailableError` (infra-classified, with guidance).
   */
  readonly sshAuthSockPath?: string;
  /** Relay dependency resolver (default: the production `resolveEgressRelay`). */
  readonly relayResolver?: () => EgressRelayPaths | undefined;
  /**
   * Pre-assigned session id (default: a fresh random 16-hex id). The agent
   * assigns its id at factory time so the id is stable before the lazy start.
   */
  readonly id?: string;
}

/**
 * The per-call egress **endpoint** — one socket, one proxy-server instance,
 * one violation sink, one fence spec (plan T5 "按调用子 socket").
 *
 * The endpoint is created and disposed inside the call; the session-resident
 * profile behind it outlives the call.
 */
export interface EgressCallEndpoint {
  /** The one-shot call id (16 hex chars) — carried by the socket path. */
  readonly id: string;
  /** The endpoint's own unix socket path (mode 0600, bound into this call's fence). */
  readonly socketPath: string;
  /** The fence spec for THIS call (socket path + bridge script are call-scoped). */
  readonly spec: EgressFenceSpec;
  /** The call's own violation sink — holds only the violations THIS call produced. */
  readonly violationSink: EgressViolationSink;
  /**
   * Teardown: drop this call's live connections (the upgraded CONNECT tunnels
   * included) + close this call's proxy server + delete this call's socket.
   * **Idempotent** (finally-safe). The credential layer is NOT released here —
   * it belongs to the session-resident profile.
   */
  dispose(): Promise<void>;
}

/**
 * The legacy per-call session as a call endpoint.
 *
 * The two callers that still own a legacy session — the foreground bash path
 * and the background task path — need the same projection, and the projection
 * belongs to the egress domain (it bridges two of its own types), so it lives
 * here rather than being written twice. One copy, one shape: the day
 * `EgressCallEndpoint` gains a field, this adapter is the single place that
 * has to learn about it.
 */
export function adaptEgressSessionToEndpoint(
  session: EgressSession
): EgressCallEndpoint {
  return {
    id: session.id,
    socketPath: session.spec.unixSocketPath,
    spec: session.spec,
    violationSink: session.violationSink,
    dispose: () => session.dispose(),
  };
}

/**
 * Endpoint construction inputs — the injectable seams of one call's seam.
 */
export interface EgressEndpointDeps {
  /** The proxy-server factory (test seam; production uses the upstream one). */
  readonly createHttpProxy: (opts: HttpProxyServerOptions) => Server;
  /** Unix socket path factory — receives the one-shot call id. */
  readonly socketPathFactory: (id: string) => string;
  /** Domain-pattern set exempt from TLS termination (agent-level setting). */
  readonly tlsExemptHosts: readonly string[];
  /** Optional sink injection (the caller owns the observation channel). */
  readonly violationSink?: EgressViolationSink;
}

/**
 * Typed error for a missing product dependency: the node runtime or the
 * repo-bundled relay assets cannot be resolved (missing relay = egress
 * fail-closed, guidance names this product's dependency rather than socat).
 * **The message must not contain socat / apt install wording** (pinned in
 * reverse by tests).
 *
 * Acceptance point: when the bash assembly layer receives this error it
 * treats the call as "no egress seam at all", never silently degrading to
 * "seam present but unusable".
 */
export class EgressRelayUnavailableError extends ToolExecutionError {
  override readonly name: string = "EgressRelayUnavailableError";
  /** What is missing (node runtime / bundled relay assets); observation surface field. */
  readonly detail: string;
  /** Product dependency guidance (reinstall iknow / repair the install root), not system package text. */
  readonly remediationHint: string;
  constructor(detail: string, remediationHint: string, cause?: unknown) {
    super(`egress relay unavailable: ${detail}. ${remediationHint}`);
    this.detail = detail;
    this.remediationHint = remediationHint;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Typed error for "open state but the host agent socket is unusable" (missing
 * / path does not exist) — **infra-classified, not a domain denial** (same
 * shape as the agent-unreachable rule: connection failure records no egress
 * violation and never goes through the filter). The message carries the
 * pinned guidance line: passphrase-protected key + no agent = in-fence ssh
 * prompts for a passphrase but the fence has no tty, so it must fail; this
 * spec ships no passphrase-return channel, and the only fix is host-side —
 * hand the key to an agent (`ssh-add`) or switch to a key without a passphrase.
 */
export class SshAgentUnavailableError extends ToolExecutionError {
  override readonly name: string = "SshAgentUnavailableError";
  readonly sshAuthSockPath: string;
  constructor(sshAuthSockPath: string) {
    super(
      `egress: SSH agent socket "${sshAuthSockPath}" not found (agent absent or stale path; infra failure, not a domain denial). ` +
        "指引：宿主侧 `ssh-add` 或无口令 key（passphrase 私钥 + 无 agent 在围栏内必败——fence 无 tty 可输口令）。"
    );
    this.sshAuthSockPath = sshAuthSockPath;
  }
}

/**
 * Per-session random id (16 hex chars, 64 bits of entropy).
 *
 * Why not crypto.randomUUID: the socket file name must stay short with no
 * hyphens / path separators.
 */
export function newSessionId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Default unix socket path factory — one path per call id. The id is
 * one-shot (a fresh random value per endpoint), so two calls of the same
 * session never share a socket; the stale-socket cleanup before listen covers
 * the "a previous run never released it" case.
 */
export function defaultSocketPathFactory(id: string): string {
  return join(tmpdir(), `iknow-egress-${id}.sock`);
}

/**
 * Fixed in-sandbox proxy listen port (HTTP surface). Why fixed: the sandbox
 * netns port space is private, and a fixed port lets the proxy env and the
 * later `GIT_SSH_COMMAND` be pre-assembled at assembly time, breaking the
 * "host/sandbox same number" coincidental coupling. After the ADR-0107
 * retrofit the host side has no TCP listener — the server listens on the unix
 * socket directly and the bundled relay forwards to it from the fixed inner
 * port.
 */
export const SANDBOX_HTTP_PROXY_PORT = 3128;

/**
 * Proxy auth username — a pure label; the credential is the token (password
 * slot). Upstream `checkAuth` (http-proxy.js) only verifies password ==
 * proxyAuthToken with a non-empty username. The dependency package's shape is
 * `PROXY_AUTH_USER = 'srt'` (+ an optional encodedCommand suffix for
 * attribution); attribution here already has the `commandLabel` sink channel,
 * so this uses the fixed suffix-free name.
 */
export const PROXY_AUTH_USER = "iknow";

/**
 * POSIX single-quoting — embedded `'` is split and rejoined as `'\''`. The
 * inner preamble script goes whole into the `bash -c` double-quoted payload,
 * so the node / relay script / host socket paths must pass through this escape
 * to keep the command chain intact (same semantics as upstream `quote()`).
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the in-sandbox half-bridge preamble script (ADR-0107 retrofit: the
 * relay = bundled node pieces).
 *
 * Shape = the retrofitted single-bridge-trim equivalent of the old dependency
 * package's `buildSandboxCommand`:
 * `<node> <egress-tcp-relay.mjs> <sock> <port> >/dev/null 2>&1 &` +
 * `trap kill EXIT` (relay = TCP-LISTEN <port> → UNIX-CONNECT <sock> bidirected
 * pipe; concurrent connections are naturally supported by net.Server). The
 * 1080/SOCKS segment was ruled out of the current branch by the operator. The
 * preamble and the user command are joined with `\n` into the same
 * `bash -c` payload (consumer: bash.ts; background / verify wiring lands in a
 * later slice).
 *
 * Why the readiness poll at the end: T5 live TUI testing found that running
 * the user command immediately after `bridge &` inside the fence races the
 * node relay's cold start — the first bare curl gets ECONNREFUSED (exit 7);
 * after sleeping 1s it goes through. The `/dev/tcp` poll absorbs the race,
 * same precedent as the port wait in scripts/sandbox-probe.ts. An exhausted
 * probe never blocks the payload (fail-closed semantics unchanged).
 */
export function buildInnerBridgeScript(
  nodePath: string,
  relayScriptPath: string,
  socketPath: string,
  sandboxPort: number = SANDBOX_HTTP_PROXY_PORT
): string {
  const parts = [nodePath, relayScriptPath, socketPath].map(shellSingleQuote);
  return [
    `${parts[0]} ${parts[1]} ${parts[2]} ${sandboxPort} >/dev/null 2>&1 &`,
    `trap "kill %1 2>/dev/null; exit" EXIT`,
    `for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/${sandboxPort}) ` +
      "2>/dev/null && break; sleep 0.1; done",
  ].join("\n");
}

/**
 * Single-point helper for the inner preamble concatenation (the convergence
 * point for the three consumer surfaces + probe that used to copy the same
 * code). Semantics on the argv surface:
 *   - spec present → `<spec.innerBridgeScript>\n<command>` (the in-sandbox
 *     half-bridge is the seam's back half; without the preamble the whole seam
 *     only has its host half);
 *   - spec absent (undefined, for any seamless reason) → **byte-identical
 *     return of the original command** ("no seam = no bridge" regression
 *     baseline, nothing residual is injected).
 * Consumers: bash.ts foreground / background manager spawn / verify
 * sandbox-run / sandbox-probe — the concatenation form is defined exactly once
 * here.
 */
export function wrapCommandWithInnerBridge(
  spec: EgressFenceSpec | undefined,
  command: string
): string {
  return spec === undefined ? command : `${spec.innerBridgeScript}\n${command}`;
}

/**
 * Build the fence env delta — HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY
 * (with lowercase aliases, covering curl / wget / npm read differences) +
 * GIT_SSH_COMMAND (see the shape notes below).
 *
 * - All keys point at `http://<PROXY_AUTH_USER>:<token>@127.0.0.1:<sandboxLocalPort>`:
 *   the bundled relay listens on that in-sandbox port and forwards traffic
 *   back to the unix socket → host proxy; embedding auth userinfo in the URL
 *   settles the 407 dead-end — once the host proxy has a proxyAuthToken it
 *   unconditionally checks Proxy-Authorization, and credential-free URLs make
 *   every egress request 407. The token is hex, URL-safe, no percent-encoding.
 * - NO_PROXY includes `127.0.0.1,localhost` by default (the proxy's own
 *   loopback reference should not route through itself) and never overrides a
 *   user's existing NO_PROXY — callers may extend it; this repo sets the
 *   minimum. Cost: requests literally targeting loopback bypass the proxy and
 *   connect directly (always failing inside the sandbox netns) — so the
 *   positive sample of the egress reachability probe must use a **non
 *   loopback** addressable fixture (scripts/sandbox-probe.ts egress
 *   end-to-end comment).
 * - `GIT_SSH_COMMAND` is injected at the same point (the env-injection SSOT
 *   single point — sharing one session's proxy env with the proxy keys, zero
 *   copies across bash / background / verify). Newly frozen shape =
 *   `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none ` +
 *   `-o ProxyCommand='<absolute node path> <absolute egress-http-connect.mjs path> %h %p'`:
 *   ssh tunnels through the in-sandbox 3128 relay via HTTP CONNECT; credential
 *   material **never enters argv** — the tunnel piece reads userinfo from the
 *   inherited `HTTP_PROXY` env (token stays off `ps`).
 *   `-F /dev/null` because in-fence /etc/ssh/ssh_config.d/* reports "Bad owner
 *   or permissions"; ControlMaster/ControlPath=none neutralise mux (the
 *   in-sandbox user ControlPath cannot bind; it would exit right after auth).
 *   ProxyCommand path quoting follows the same policy as
 *   `buildInnerBridgeScript`: node / script paths each go through
 *   `shellSingleQuote`; git's `split_cmdline` strips the outer double quotes
 *   and ssh's ProxyCommand /bin/sh handles the inner single quotes — install
 *   root paths with spaces / quotes no longer shatter apart. The token still
 *   stays out of argv (same discipline as the URL userinfo). When a user
 *   command inside the fence **explicitly inlines** `GIT_SSH_COMMAND=... git
 *   ...`, the latter wins — a POSIX prefix assignment overrides the inherited
 *   value (shell semantics; per the merge strategy, no defensive handling).
 */
export function buildProxyEnv(
  sandboxLocalPort: number,
  proxyAuthToken: string,
  relay: EgressRelayPaths,
  extraNoProxy: readonly string[] = []
): Record<string, string> {
  const proxyUrl = `http://${PROXY_AUTH_USER}:${proxyAuthToken}@127.0.0.1:${sandboxLocalPort}`;
  const noProxy = ["127.0.0.1", "localhost", ...extraNoProxy].join(",");
  const gitSshCommand =
    `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none ` +
    `-o ProxyCommand="${shellSingleQuote(relay.nodePath)} ${shellSingleQuote(relay.connectScriptPath)} %h %p"`;
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: noProxy,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    no_proxy: noProxy,
    GIT_SSH_COMMAND: gitSshCommand,
  };
}

/**
 * The resolved "effective denied address tiers" — falls back to the caller
 * supplied `defaultDeniedRanges` when unset. policyInput.deniedResolvedAddresses
 * is consumed at two sites (address guard / filter callback), so a helper keeps
 * one source (DRY): callers must guarantee defaultDeniedRanges = domain-matcher's
 * DEFAULT_PRIVATE_DENIED_RANGES (passed in after the dynamic import).
 */
function effectiveDeniedRanges(
  policyInput: EgressCallPolicy,
  defaultDeniedRanges: readonly string[]
): readonly string[] {
  return policyInput.deniedResolvedAddresses ?? defaultDeniedRanges;
}

/**
 * Factory: build the filter callback — decideEgress domain decision +
 * violation trace + optional first-time domain approval gate.
 *
 * Extracted to keep `createEgressSession` under the complexity gate, and so
 * tests can drive the filter independently without a real HTTP proxy (via the
 * `createHttpProxyServer` injection seam).
 *
 * The closure is **per call**: it carries the call's policy and the call's
 * violation sink, so the violations it records belong to exactly that call
 * (the per-call attribution the plan's T5 asks for — the upstream proxy binds
 * one filter per server instance, and the endpoint owns one instance).
 *
 * Returning `Promise<boolean>` matches upstream's awaited
 * `options.filter(...)` signature. Synchronous denials (denied /
 * allowlist-empty / allowlist-malformed / address-denied) stay synchronous;
 * `not-in-allowlist` + a present gate is async.
 */
export function createFilterCallback(
  policyInput: EgressCallPolicy,
  defaultDeniedRanges: readonly string[],
  sink: EgressViolationSink,
  decideEgress: typeof import("./domain-matcher.js").decideEgress
): (port: number, host: string) => Promise<boolean> {
  const commandLabel = policyInput.commandLabel;
  const deniedRanges = effectiveDeniedRanges(policyInput, defaultDeniedRanges);
  return async (port: number, host: string): Promise<boolean> => {
    // Domain decision — host:port alone decides pass-through to the resolution
    // layer. Already-resolved addresses get rejected downstream in `lookupFor`
    // (address-denied), where no callback records violations, so this callback
    // carries both the domain decision and the violation trace.
    const result = decideEgress({
      host,
      port,
      allowedDomains: policyInput.allowedDomains,
      deniedDomains: policyInput.deniedDomains,
      deniedResolvedAddresses: deniedRanges,
    });
    if (result.outcome === "allow") return true;

    // Denial path — `reason` is non-empty (decideEgress denials always carry
    // one). First-time approval: only `not-in-allowlist` (host present in
    // neither allowed nor denied sets) may try the gate; every other reason
    // (denied / allowlist-empty / allowlist-malformed / address-denied) keeps
    // its original semantics — "asking the user" must not route around
    // deny-priority or configuration-layer errors.
    if (result.reason === "not-in-allowlist") {
      if (policyInput.approvalGate === undefined) {
        // Fail-closed for a non-interactive entry point meeting a new domain:
        // no ask surface, first sight = deny, reason = `no-approval-inlet`.
        sink.record({
          kind: "egress_violation",
          host,
          port,
          reason: "no-approval-inlet",
          command: commandLabel,
        });
        return false;
      }
      const approved = await policyInput.approvalGate.askIfUnknown(host);
      if (approved) {
        // Approval = session-scoped pass-through (must succeed once asked);
        // (ADR-0097)
        // this filter call returns true, and later requests for the same host
        // hit the allowed set without asking again. allowlistSource is
        // `session` on "approval succeeded" (the allowlist provenance rides in
        // from policyInput.allowlistSource; the `session` literal's meaning is
        // preserved — the bash assembly layer writes
        // policyInput.allowlistSource = "session" after approval).
        return true;
      }
      // User denied (or askApproval threw → fail-closed) → record violation +
      // block. Reason split: gate present but decision failed →
      // `denied-by-user` (the user's call); no gate → the branch above already
      // recorded `no-approval-inlet`.
      sink.record({
        kind: "egress_violation",
        host,
        port,
        reason: "denied-by-user",
        command: commandLabel,
      });
      return false;
    }

    sink.record({
      kind: "egress_violation",
      host,
      port,
      // reason is non-empty (decideEgress denials always carry one); narrows the discriminated union.
      reason: result.reason ?? "not-in-allowlist",
      command: commandLabel,
    });
    return false;
  };
}

/**
 * Credential substitution wiring for the proxy. The wiring shape = this repo's
 * equivalent self-assembly of the dependency package manager's existing
 * closure hooks. The returned partial options merge into the proxy only when
 * credential resources are present:
 *   - `mitmCA`: the session-loaded persistent CA (if the CA were absent the
 *     credential layer already failed typed at Step 1.5, so this is unreachable);
 *   - `shouldTerminateTLS`: terminate everything by default; a
 *     `tlsExemptHosts` hit → fall to the opaque tunnel, and if that domain has
 *     injectable credentials, record `tls-exempt-injectable` (via this repo's
 *     violationSink, not the package-private logger);
 *   - `mutateHeaders` = `registry.substituteInHeaders` (the per-sentinel
 *     injectHosts gate lives inside the registry); before calling, mirror the
 *     package's skip criteria into a diagnostic trace (Content-Encoding ∧
 *     declared body ∧ the domain has injection pairs);
 *   - `getBodySubstitutions` = `registry.sentinelsForHost`.
 *
 * Deliberately not configured: `mutateHeadersPlaintext` /
 * `getBodySubstitutionsPlaintext` (the plaintext arm `allowPlaintextInject`
 * stays permanently false), `planSigv4` (far future), `getMitmSocketPath`
 * (non-TLS CONNECT bytes → the opaque tunnel arm stays untouched — a declared
 * dependency of the parallel ssh-bridge work). The host→port map is captured
 * via `shouldTerminateTLS` (called per CONNECT before the forwarding leg, in
 * upstream order) so the diagnostic trace carries the real port; unknown hosts
 * fall to 0 (never fabricated).
 */
export function buildCredentialProxyOptions(
  cred: EgressCredentialResources,
  sink: EgressViolationSink,
  commandLabel: string,
  tlsExemptHosts: readonly string[]
): Partial<HttpProxyServerOptions> {
  const { registry } = cred.mint;
  const portByHost = new Map<string, number>();
  return {
    mitmCA: cred.ca,
    shouldTerminateTLS: (hostname: string, port: number): boolean => {
      portByHost.set(hostname, port);
      const exempt = tlsExemptHosts.some((pattern) =>
        matchesDomainPattern(hostname, pattern)
      );
      // Trace = "exempt ∧ the domain has credentials configured for injection" — the exemption itself is not a violation.
      if (
        exempt &&
        registry.namesInjectableAt(hostname, matchesDomainPattern).length > 0
      ) {
        sink.record({
          kind: "egress_violation",
          host: hostname,
          port,
          reason: "tls-exempt-injectable",
          command: commandLabel,
        });
      }
      return !exempt;
    },
    mutateHeaders: (headers: IncomingHttpHeaders, destHost: string): void => {
      // Diagnostic (mirror of the package's body-substitution skip criteria:
      // declared body ∧ Content-Encoding ∧ the domain has injection pairs →
      // body substitution is skipped and fake values reach upstream verbatim).
      if (
        headers["content-encoding"] !== undefined &&
        (headers["content-length"] !== undefined ||
          headers["transfer-encoding"] !== undefined) &&
        registry.sentinelsForHost(destHost, matchesDomainPattern).length > 0
      ) {
        sink.record({
          kind: "egress_violation",
          host: destHost,
          port: portByHost.get(destHost) ?? 0,
          reason: "substitution-skipped",
          command: commandLabel,
        });
      }
      registry.substituteInHeaders(headers, destHost, matchesDomainPattern);
    },
    getBodySubstitutions: (destHost: string) =>
      registry.sentinelsForHost(destHost, matchesDomainPattern),
  };
}

/**
 * Step 2: start the HTTP proxy server (filter = decideEgress domain decision;
 * lookupFor = the upstream ResolvedAddressGuard doing the DNS resolution guard).
 *
 * Extracted to keep `createEgressSession` under the complexity gate. Returns
 * the server instance for the caller to `listenOnUnixSocket` directly (ADR-0107:
 * no host TCP, no bridge process).
 *
 * When credential resources are present, the substitution wiring options merge
 * in (the filter callback stays untouched — violation ownership; substitution
 * only happens on the forwarding leg after a pass).
 */
export function startHttpProxyStep(
  policyInput: EgressCallPolicy,
  token: string,
  sink: EgressViolationSink,
  decideDeps: {
    readonly defaultDeniedRanges: readonly string[];
    readonly decideEgress: typeof import("./domain-matcher.js").decideEgress;
    readonly createHttpProxy: (
      proxyOpts: Parameters<typeof createHttpProxyServer>[0]
    ) => Server;
    readonly credential?: EgressCredentialResources;
    readonly tlsExemptHosts?: readonly string[];
  }
): Server {
  // Address guard (DNS resolution + rejecting loopback / private / metadata
  // etc.). Injected via the proxy's `lookupFor` option; an address landing in
  // deniedResolvedAddresses during resolution throws
  // `ResolvedAddressDeniedError`, which the proxy translates into 403.
  const guard = createResolvedAddressGuard({
    allowedDomains: policyInput.allowedDomains,
    deniedDomains: policyInput.deniedDomains,
    deniedResolvedAddresses: effectiveDeniedRanges(
      policyInput,
      decideDeps.defaultDeniedRanges
    ),
    // Local interface addresses stay empty (treating "local NIC addresses" as
    // a private tier is not required here;
    // DEFAULT_PRIVATE_DENIED_RANGES + upstream's default DENIED_CLASSES suffice).
    localAddresses: () => [],
  });

  const credentialOptions =
    decideDeps.credential !== undefined
      ? buildCredentialProxyOptions(
          decideDeps.credential,
          sink,
          policyInput.commandLabel,
          decideDeps.tlsExemptHosts ?? []
        )
      : {};

  return decideDeps.createHttpProxy({
    filter: createFilterCallback(
      policyInput,
      decideDeps.defaultDeniedRanges,
      sink,
      decideDeps.decideEgress
    ),
    proxyAuthToken: token,
    lookupFor: (port: number) => guard.lookupFor(port),
    ...credentialOptions,
  });
}

/**
 * Step 4: assemble the bwrap fence spec.
 *
 * Extracted to keep `createEgressSession` under the complexity gate. The
 * in-sandbox listen port = fixed `SANDBOX_HTTP_PROXY_PORT` (the host no longer
 * has a TCP port — the proxy server listens on the unix socket directly and the
 * same-number coupling disappears with ADR-0107); the in-sandbox half-bridge
 * rides the `innerBridgeScript` preamble (consumer: bash.ts command chain); the
 * relay assets directory goes to the fence ro-bind via `relayAssetsDir`.
 *
 * `SSH_AUTH_SOCK` env and the spec field are added only when
 * `sshAuthSockPath` is present (open state) — env injection still goes through
 * the single `assembleFenceSpec` point (proxy env and credential env share one
 * construction site, zero copies across the three consumer surfaces); the bind
 * emission surface lives in bwrap.ts's `egressBindArgs` (same segment
 * placement). Default = closed state, neither appears.
 *
 * Env delta = `buildProxyEnv` plus the credential fake values and
 * `CA_TRUST_VARS` (mint.envVars); binds = masked store / trust bundle /
 * masked-file covers / deny covers (the fence emits them into the egressBind
 * segment).
 */
export function assembleFenceSpec(
  socketPath: string,
  relay: EgressRelayPaths,
  token: string,
  sshAuthSockPath: string | undefined,
  credential: EgressCredentialResources | undefined
): EgressFenceSpec {
  const mint = credential?.mint;
  const env = {
    ...buildProxyEnv(SANDBOX_HTTP_PROXY_PORT, token, relay),
    ...(mint?.envVars ?? {}),
  };
  const innerBridgeScript = buildInnerBridgeScript(
    relay.nodePath,
    relay.bridgeScriptPath,
    socketPath
  );
  const spec: EgressFenceSpec = {
    unixSocketPath: socketPath,
    sandboxLocalPort: SANDBOX_HTTP_PROXY_PORT,
    env,
    innerBridgeScript,
    relayAssetsDir: relay.relayDir,
    ...(mint !== undefined && mint.binds.length > 0
      ? { binds: mint.binds }
      : {}),
  };
  if (sshAuthSockPath === undefined) {
    return spec;
  }
  return {
    ...spec,
    env: { ...env, SSH_AUTH_SOCK: sshAuthSockPath },
    sshAuthSockPath,
  };
}

/**
 * Step 1.5: startup-time minting — extracted to keep `createEgressSession`
 * under the complexity gate. Roster present → load the persistent CA + mint
 * fake values through the credential assembly entry `mintEgressCredentialLayer`
 * at the `fenced` posture (registry / masked store / bind table / env delta); a
 * session exists ⇔ a fence exists, so the posture is always `fenced` (yolo /
 * isolation OFF have no session; the skipped trace belongs to the assembly
 * entry's `no-fence` posture). Roster absent → undefined (no CA load, no mint).
 * Assembly-time defense failures throw typed errors upward, and the caller must
 * not start the proxy after this step ("never run a session with partial
 * substitution"). The returned bundle carries the CA reference (consumed by
 * the proxy mitmCA wiring and the dispose bundle cleanup).
 *
 * The inputs are the **session-level** mint options (not the per-call
 * policy): the roster is minted once per session and the minted resources
 * (registry / masked store / trust bundle) live as long as the profile does.
 */
export function mintCredentialsStep(
  opts: EgressMintOptions
): EgressCredentialResources | undefined {
  if (opts.credentials === undefined) return undefined;
  const loadCa = opts.loadEgressCa ?? loadEgressCa;
  const caLoad = loadCa({ caDir: opts.caDir });
  const mint = mintEgressCredentialLayer({
    posture: "fenced",
    roster: opts.credentials,
    ca: caLoad.ca,
    env: opts.hostEnv ?? process.env,
  });
  const resources: EgressCredentialResources = { mint, ca: caLoad.ca };
  // Observation seam (tests only): report right after a successful mint; the
  // spawn-failure path observes the three-resource release through this too.
  opts.onCredentialMint?.(resources);
  return resources;
}

/**
 * Dispose for the credential layer ("normal / abnormal paths share one release
 * channel", taken verbatim from the lifecycle table): `registry.clear()` +
 * `MaskedFileStore.dispose()` + trust bundle temp cleanup (`disposeMitmCA`: the
 * bundle directory is always deleted; the persistent CA is non-ephemeral and
 * unaffected). Each step swallows errors best-effort — the release channel
 * must not throw into the caller's finally / must not skip later resources
 * because one step failed.
 */
export async function releaseCredentialResources(
  cred: EgressCredentialResources | undefined
): Promise<void> {
  if (cred === undefined) return;
  try {
    cred.mint.registry.clear();
  } catch {
    // best-effort
  }
  try {
    cred.mint.store.dispose();
  } catch {
    // best-effort
  }
  try {
    await disposeMitmCA(cred.ca);
  } catch {
    // best-effort
  }
}

/**
 * Step 1 of the session-resident profile: resolve the bundled relay
 * dependencies (node + vendor/egress-relay assets; the resolver is
 * injectable).
 *
 * Fail-closed: unresolvable = no seam available, a product-semantics typed
 * error is thrown (ADR-0107). The relay set is session-level — every call of
 * the session rides the same relay assets.
 */
function resolveRelayOrThrow(
  relayResolver: () => EgressRelayPaths | undefined
): EgressRelayPaths {
  const relay = relayResolver();
  if (relay === undefined) {
    throw new EgressRelayUnavailableError(
      "this install cannot resolve its bundled egress relay (a Node runtime plus vendor/egress-relay assets)",
      "The relay ships with iknow; repair or reinstall the iknow install root (npm) so vendor/egress-relay and a Node >=20 runtime are present — no extra system package is part of this product."
    );
  }
  return relay;
}

/**
 * Step 1b of the profile: the credential availability branch (default off).
 *
 * In open state, verify the agent socket's existence first — missing =
 * fail-closed infra-class error, raised before anything is started (no
 * "bind without seam" half-open shape). Stale-but-present (file exists, agent
 * dead) cannot be probed cheaply; it is left to in-fence ssh reporting "agent
 * refused" — classified infra, this seam never goes through the filter and
 * produces no domain-denial record.
 */
function resolveSshAuthSock(
  sshAuthSockPath: string | undefined
): string | undefined {
  if (sshAuthSockPath === undefined) return undefined;
  if (!existsSync(sshAuthSockPath)) {
    throw new SshAgentUnavailableError(sshAuthSockPath);
  }
  return sshAuthSockPath;
}

/**
 * Resolve the **session-resident profile** — the expensive, long-lived half of
 * the egress seam (plan T4 "出口代理会话级常驻").
 *
 * Loaded exactly once per session:
 *   1) the bundled relay dependencies (injectable so tests can simulate
 *      "product dependency missing");
 *   1b) the ssh-agent availability verdict (fail-closed, infra-class);
 *   1.5) the durable CA load + the credential mint (registry / masked store /
 *        bind table / env delta) — assembly-time defense failure = throw
 *        directly, nothing started ("never run a session with partial
 *        substitution");
 *   2) the shared proxy auth token (prevents other host processes from
 *      connecting to the proxy directly and bypassing the filter);
 *   3) the domain-matcher decision functions (dynamic import — one-way
 *      references within the egress domain, no cycle).
 *
 * The per-call half (socket / proxy instance / sink / spec) lives in
 * `startEgressCallEndpoint`.
 */
export async function resolveEgressProfile(
  opts: EgressProfileOptions
): Promise<EgressProfile> {
  const relay = resolveRelayOrThrow(opts.relayResolver ?? resolveEgressRelay);
  const sshAuthSockPath = resolveSshAuthSock(opts.sshAuthSockPath);
  const id = opts.id ?? newSessionId();
  // Shared token — prevents other host processes from connecting to the proxy
  // (ADR-0097) directly and bypassing the filter.
  const token = randomBytes(32).toString("hex");
  // Dynamic import of domain-matcher (avoids a cycle; one-way references within the egress domain).
  const { decideEgress, DEFAULT_PRIVATE_DENIED_RANGES } =
    await import("./domain-matcher.js");
  const credential = mintCredentialsStep(opts);
  return {
    id,
    relay,
    token,
    sshAuthSockPath,
    credential,
    decideEgress,
    defaultDeniedRanges: DEFAULT_PRIVATE_DENIED_RANGES,
  };
}

/**
 * Start ONE call's endpoint — the per-call half of the egress seam (plan T5
 * "按调用子 socket").
 *
 * Steps:
 *   1) a fresh one-shot call id → the socket path (the path carries the call
 *      id, so two calls of one session never share a socket);
 *   1b) stale-socket cleanup (a residual socket = a previous run that never
 *      released it — delete it to avoid mis-connection; same semantics as
 *      unlink-before-listen, in-package mux-proxy.js precedent);
 *   2) start the HTTP proxy server for THIS call — the filter closure carries
 *      this call's policy and this call's violation sink, so the violations
 *      belong to exactly this call (the upstream proxy binds one filter per
 *      server instance, and the endpoint owns one instance);
 *   3) the server listens on the unix socket directly (ADR-0107: no socat
 *      bridge);
 *   4) build the fence spec for this call.
 *
 * The credential layer is NOT released here — it belongs to the session-level
 * profile (the endpoint only borrows the registry / CA).
 */
export async function startEgressCallEndpoint(
  profile: EgressProfile,
  policy: EgressCallPolicy,
  deps: EgressEndpointDeps
): Promise<EgressCallEndpoint> {
  const callId = newSessionId();
  const socketPath = deps.socketPathFactory(callId);
  removeSocketFile(socketPath);
  const sink = deps.violationSink ?? createEgressViolationSink();

  const httpServer = startHttpProxyStep(policy, profile.token, sink, {
    defaultDeniedRanges: profile.defaultDeniedRanges,
    decideEgress: profile.decideEgress,
    createHttpProxy: deps.createHttpProxy,
    credential: profile.credential,
    tlsExemptHosts: deps.tlsExemptHosts,
  });
  // The endpoint owns the live connections of THIS proxy instance — the
  // teardown drops them (the upgraded CONNECT tunnels included).
  const connections = trackProxyConnections(httpServer);

  // The listen failure = cleanup leaves no half resources (the abnormal path
  // uses the same release channel: server closed + socket file removed).
  try {
    await listenOnUnixSocket(httpServer, socketPath);
  } catch (err) {
    connections.dropAll();
    closeServerQuietly(httpServer);
    removeSocketFile(socketPath);
    throw err;
  }

  const spec = assembleFenceSpec(
    socketPath,
    profile.relay,
    profile.token,
    profile.sshAuthSockPath,
    profile.credential
  );

  let disposed = false;
  const dispose = async (): Promise<void> => {
    // Idempotent: repeated dispose neither throws nor errors.
    if (disposed) return;
    disposed = true;
    // Teardown order (plan T5 "断开其全部连接"): the live connections go
    // FIRST (a CONNECT tunnel is an upgraded socket the HTTP server no longer
    // tracks, so it survives a bare close()), then the listener closes, then
    // the socket file is deleted.
    connections.dropAll();
    closeServerQuietly(httpServer);
    removeSocketFile(socketPath);
  };

  return Object.freeze({
    id: callId,
    socketPath,
    spec,
    violationSink: sink,
    dispose,
  });
}

/**
 * Project the session-level policy input onto the per-call policy shape: the
 * credential roster is dropped (the mint is session-level — the roster rides
 * the profile, not the call).
 *
 * Public because the assembly layer needs the same projection: the bash tool
 * and the background manager hand a FULL policy (roster included) to their
 * own policy factory, and the per-call endpoint must receive the call policy
 * only — the roster belongs to the agent's profile.
 */
export function toEgressCallPolicy(
  policy: EgressPolicyInput
): EgressCallPolicy {
  return {
    allowedDomains: policy.allowedDomains,
    deniedDomains: policy.deniedDomains,
    deniedResolvedAddresses: policy.deniedResolvedAddresses,
    commandLabel: policy.commandLabel,
    allowlistSource: policy.allowlistSource,
    approvalGate: policy.approvalGate,
  };
}

/**
 * Compatibility entry: create a per-call egress session.
 *
 * This is the **legacy shape** kept for the three existing consumers (the
 * bash tool, the background manager, the verify runner) until they migrate to
 * the session-resident agent (`egress/agent.ts`): one session = one profile
 * (relay / CA / mint / token / ssh-agent verdict) + exactly one endpoint
 * (socket / proxy instance / sink / spec), released together on dispose.
 *
 * Steps (abnormal and normal paths share one release channel):
 *   1) resolve the session-resident profile (relay + ssh-agent + CA + mint +
 *      token);
 *   2) start this call's endpoint (proxy server + unix socket + spec);
 *   3) the server listens on the unix socket directly (ADR-0107: no socat bridge).
 *
 * Any step failing → clean up what was started + throw a typed error (never silent).
 */
export async function createEgressSession(
  opts: EgressSessionOptions
): Promise<EgressSession> {
  const profile = await resolveEgressProfile({
    credentials: opts.policy.credentials,
    sshAuthSockPath: opts.sshAuthSockPath,
    relayResolver: opts.relayResolver,
    loadEgressCa: opts.loadEgressCa,
    caDir: opts.caDir,
    hostEnv: opts.hostEnv,
    onCredentialMint: opts.onCredentialMint,
  });
  return startLegacySession(profile, opts);
}

/**
 * The legacy session assembly: one profile + one endpoint, released together.
 */
async function startLegacySession(
  profile: EgressProfile,
  opts: EgressSessionOptions
): Promise<EgressSession> {
  let endpoint: EgressCallEndpoint;
  try {
    endpoint = await startEgressCallEndpoint(
      profile,
      toEgressCallPolicy(opts.policy),
      {
        createHttpProxy: opts.createHttpProxyServer ?? createHttpProxyServer,
        socketPathFactory: opts.socketPathFactory ?? defaultSocketPathFactory,
        tlsExemptHosts: opts.tlsExemptHosts ?? [],
        violationSink: opts.violationSink,
      }
    );
  } catch (err) {
    // The endpoint never came up → the profile's credential layer is released
    // through the same channel (no half-injected state left behind).
    // EXIT: the endpoint could not start → its credential layer is released
    // through the same channel, so no half-injected state is left behind; the
    // original typed error propagates unchanged.
    await releaseCredentialResources(profile.credential);
    throw err;
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    // Idempotent: repeated dispose neither throws nor errors.
    if (disposed) return;
    disposed = true;
    await endpoint.dispose();
    // Credential layer releases through the same channel (registry.clear + store.dispose + bundle cleanup).
    await releaseCredentialResources(profile.credential);
  };

  return Object.freeze({
    id: profile.id,
    spec: endpoint.spec,
    violationSink: endpoint.violationSink,
    dispose,
  });
}

/**
 * Socket file cleanup — unlink + rmSync double coverage (the teardown side of
 * the stale-socket defense). Split into its own function for the complexity
 * gate.
 */
export function removeSocketFile(socketPath: string): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    // best-effort
  }
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Internal helper — make the bare node:http server listen on the unix socket
 * path directly (ADR-0107: socat bridge removed from the host side; in-package
 * precedent: mux-proxy.js listenHttpBackend).
 *
 * chmod 0600 immediately after a successful listen: under shared /tmp, node's
 * default socket mode (0777 & ~umask) is connectable by local other users, and
 * combined with the "token briefly visible via --setenv argv" residual surface
 * that would be a filter-bypass hole (see the threat-model registration in the
 * file header). A chmod failure is treated like a listen failure (reject → the
 * caller's same cleanup channel) — never run unprotected.
 */
export function listenOnUnixSocket(
  server: Server,
  socketPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      try {
        chmodSync(socketPath, 0o600);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export function closeServerQuietly(server: Server): void {
  // The live connections go FIRST, then the listener: `closeAllConnections()`
  // (Node >= 18.2) tears down the requests the server still tracks, and
  // `close()` alone would keep them alive until the peers hang up. The
  // upgraded CONNECT sockets are NOT covered by it (the server stops tracking
  // an upgraded socket) — `trackProxyConnections` owns those.
  try {
    server.closeAllConnections();
  } catch {
    // EXIT: best-effort teardown — the tracked connections are dropped by
    // `trackProxyConnections` regardless, so a failure here must not skip the
    // listener close below.
  }
  try {
    server.close();
  } catch {
    // EXIT: best-effort teardown — the listener is already unreachable for
    // new connections once the tracked sockets are dropped, so a failure here
    // must not throw into the endpoint's dispose.
  }
}

/**
 * Track the sockets one proxy-server instance accepted, so the endpoint's
 * teardown can DROP its connections — not just close the listener.
 *
 * `server.closeAllConnections()` reaches only the connections the HTTP server
 * still tracks. A CONNECT tunnel is an **upgraded** socket: once the request
 * is upgraded the server hands the raw socket to the 'connect' handler and
 * stops tracking it, so a live tunnel survives `server.close()` (and
 * `closeAllConnections()`) — the tunnel would outlive the call that opened it.
 * The 'connection' event is the one place that still sees EVERY accepted
 * socket (tunnel or not), so the endpoint keeps its own registry and destroys
 * the sockets itself at teardown.
 */
function trackProxyConnections(server: Server): {
  readonly dropAll: () => void;
} {
  const sockets = new Set<Socket>();
  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", onConnection);
  return {
    dropAll: (): void => {
      server.off("connection", onConnection);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
