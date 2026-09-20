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

export {
  createHttpProxyServer,
  type HttpProxyServerOptions,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js";

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
