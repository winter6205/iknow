/**
 * src/harness/sandbox/egress/upstream.ts
 *
 * Upstream adapter layer — file-carrier discipline: version upgrades touch
 * only this file, never spread outward.
 *
 * Single responsibility: centralize the network half of
 * `@anthropic-ai/sandbox-runtime` behind re-exports — no other module in
 * this repo (including domain-matcher / session / bwrap) may import package
 * paths directly.
 *
 * Reused surface (verified on 0.0.76):
 *   - http-proxy / socks-proxy: proxy servers with symmetric filter-callback
 *     semantics;
 *   - domain-pattern (consumed by domain-matcher.ts), address, parent-proxy
 *     are already re-exported by their own adapter layers; this file adds
 *     only what session assembly needs.
 *
 * The package has no `exports` field (verified): deep imports work but carry
 * no contract stability — keep every package-path import funneled here.
 */

import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  createHttpProxyServer as createUpstreamHttpProxyServer,
  type HttpProxyServerOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";

export type { HttpProxyServerOptions };

/**
 * The HTTP proxy, with one adapter-level correction: the 407 challenge frame.
 *
 * The upstream package answers a CONNECT without valid `Proxy-Authorization`
 * with a **header-only** 407 frame and then closes the socket
 * (0.0.76: `dist/sandbox/http-proxy.js:219-223` writes the frame, `:192-206`
 * (`endWithStatus`) ends the socket). The frame carries neither
 * `Content-Length` nor `Connection: close`, so a client cannot tell that the
 * body is empty and that the connection is finished.
 *
 * That breaks git over HTTPS: git's transport is libcurl, whose default
 * `http.proxyAuthMethod=anyauth` sends the first CONNECT *without*
 * credentials and, on a 407, retries *with* credentials. HTTP/1.1 keep-alive
 * semantics make libcurl reuse the same connection for that retry — but the
 * proxy has already closed it, so git fails with `Proxy CONNECT aborted`. The
 * curl CLI is unaffected: its credentials ride in the proxy URL userinfo, so
 * its first CONNECT already carries them.
 *
 * The correction is confined to that one frame: the 407 challenge is
 * rewritten to declare an empty body (`Content-Length: 0`) and a finished
 * connection (`Connection: close`), so the client reconnects and retries with
 * credentials. Authentication is **not** relaxed — a CONNECT without valid
 * credentials still gets 407 — and the allowlist still decides which domains
 * may be reached. Every other frame (403 deny, 400 bad request, 502 bad
 * gateway, the 200 tunnel response, tunnel payload) passes through
 * byte-identical: only the first outbound frame of a CONNECT socket is even
 * inspected, and only a 407 challenge matches.
 */
export function createHttpProxyServer(options: HttpProxyServerOptions): Server {
  const server = createUpstreamHttpProxyServer(options);
  // `prependListener` runs before the upstream's own CONNECT handler, so the
  // frame wrapper is in place before the upstream writes its verdict.
  server.prependListener("connect", (_req, socket) => {
    installProxyAuthChallengeFraming(socket);
  });
  return server;
}

/** The status line prefix of the upstream's proxy-auth challenge. */
const PROXY_AUTH_CHALLENGE_PREFIX = "HTTP/1.1 407 ";

/**
 * Rewrite the 407 challenge frame so the client can read it as "empty body,
 * connection finished". Returns `undefined` for every other frame — the
 * rewrite must never touch a 403 deny, a 400, a 502, the 200 tunnel response
 * or tunnel payload.
 */
function withProxyAuthChallengeFraming(frame: string): string | undefined {
  if (!frame.startsWith(PROXY_AUTH_CHALLENGE_PREFIX)) return undefined;
  const headerEnd = frame.indexOf("\r\n\r\n");
  // Not a complete header block, or a frame that carries a body: not the
  // header-only challenge frame.
  if (headerEnd < 0) return undefined;
  if (frame.length > headerEnd + 4) return undefined;
  const head = frame.slice(0, headerEnd);
  // Already framed (a newer upstream): leave the bytes alone.
  if (/(^|\r\n)content-length:/i.test(head)) return undefined;
  if (/(^|\r\n)connection:/i.test(head)) return undefined;
  return `${head}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
}

/**
 * Wrap one CONNECT socket so that its first outbound frame can be rewritten
 * (the challenge frame above). After that first frame the original
 * `write`/`end` are restored, so tunnel payload is never inspected and the
 * socket behaves exactly like the upstream's otherwise.
 *
 * The credential itself is never read here — only the status line and the
 * header names of the proxy's own answer are looked at.
 */
function installProxyAuthChallengeFraming(socket: Duplex): void {
  const originalWrite = socket.write.bind(socket) as unknown as (
    ...args: unknown[]
  ) => boolean;
  const originalEnd = socket.end.bind(socket) as unknown as (
    ...args: unknown[]
  ) => unknown;
  let firstFrame = true;

  const restore = (): void => {
    socket.write = originalWrite as unknown as typeof socket.write;
    socket.end = originalEnd as unknown as typeof socket.end;
  };

  const framedArgs = (args: unknown[]): unknown[] => {
    if (!firstFrame) return args;
    firstFrame = false;
    const [chunk] = args;
    if (typeof chunk === "string") {
      const framed = withProxyAuthChallengeFraming(chunk);
      return framed === undefined ? args : [framed, ...args.slice(1)];
    }
    if (Buffer.isBuffer(chunk)) {
      const framed = withProxyAuthChallengeFraming(chunk.toString("latin1"));
      return framed === undefined
        ? args
        : [Buffer.from(framed, "latin1"), ...args.slice(1)];
    }
    return args;
  };

  socket.write = ((...args: unknown[]): boolean => {
    const next = framedArgs(args);
    const written = originalWrite(...next);
    restore();
    return written;
  }) as unknown as typeof socket.write;

  socket.end = ((...args: unknown[]): unknown => {
    const next = framedArgs(args);
    const ended = originalEnd(...next);
    restore();
    return ended;
  }) as unknown as typeof socket.end;
}

// The SOCKS5 / git-over-SOCKS surface is ruled out of the current branch:
// the ssh transport (ADR-0107) is pinned to exactly one form — HTTP CONNECT
// (the frozen `GIT_SSH_COMMAND` shape in session.ts). Keep this re-export so
// a future multiplexed socket consumes it here instead of new deep imports
// into the package.
export {
  createSocksProxyServer,
  type SocksProxyServerOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/socks-proxy.js";

export {
  createResolvedAddressGuard,
  isResolvedAddressDenied,
  ResolvedAddressDeniedError,
  type ResolvedAddressGuard,
  type ResolvedAddressGuardOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";

/**
 * Domain-pattern matcher funnel. `domain-matcher.ts` was the existing deep
 * import site; merged into this adapter layer under the same file-carrier
 * discipline so that upstream.ts is the only package deep-path import left in
 * `src/`. `matchesDomainPattern` (no-port form) = the HostMatcher used by the
 * sentinel registry and by the sandbox-manager internally;
 * `matchesDomainPatternWithPort` = allowlist decisions.
 */
export {
  matchesDomainPattern,
  matchesDomainPatternWithPort,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";

/**
 * MITM CA pieces: `createMitmCA({caCertPath, caKeyPath})` loads the durable
 * CA and **also writes a fresh trust bundle** (`trustBundlePath` = the
 * package's writeTrustBundle output, a new temp file per call; the
 * CERTIFICATE-block-only PEM filter lives in the package, not replicated
 * here). `generateCa` is a pure generation primitive (no FS side effects);
 * persisting it to disk is this repo's `ca-store.ts`. `disposeMitmCA` = the
 * trust-bundle temp cleanup channel (the bundle dir is always deleted; the
 * durable CA is not ephemeral and stays untouched).
 */
export {
  createMitmCA,
  disposeMitmCA,
  generateCa,
  validateCaPair,
  type CaPairValidation,
  type GeneratedCa,
  type MitmCA,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";

/**
 * Full roster of trust-injection vars (the env injection surface = every
 * entry, all pointing at the trust bundle). Per-client three-arm constants
 * are pinned separately in `ca-store.ts`.
 * `normalizePathForSandbox` = tilde expansion + realpath normalization for
 * credential entry paths, so the pre-check here and the package's masking
 * agree on the same normalized form and deny/binding land in one place.
 */
export {
  CA_TRUST_VARS,
  normalizePathForSandbox,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

/**
 * Sentinel minting and masking flow pieces — `SentinelRegistry` (fake-value
 * space, per-session), `buildMaskedEnvVars` / `buildMaskedFileBinds` (env /
 * file masking flows). This repo's deviations are all at assembly inputs:
 * `onExtractNoMatch` is explicitly `"deny"` (do not eat the package default
 * `"warn"` fail-open); `allowedDomains` is always `[]` (entry injectHosts
 * must be explicit, no default expansion). The package silently skips
 * non-UTF-8 / binary files (fail-open); this repo pre-checks and degrades to
 * deny before calling — see `credential-assembly.ts`.
 */
export {
  SentinelRegistry,
  SENTINEL_PREFIX,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-sentinel.js";

export {
  buildMaskedEnvVars,
  type MaskedEnvBuildResult,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-mask-env.js";

export {
  buildMaskedFileBinds,
  MaskedFileStore,
  type MaskedFileBind,
  type MaskedFileBuildResult,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-mask-files.js";

export type {
  CredentialEnvVarConfig,
  CredentialFileConfig,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
