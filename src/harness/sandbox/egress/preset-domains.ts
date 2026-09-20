/**
 * src/harness/sandbox/egress/preset-domains.ts
 *
 * Code-borne default pre-allowlist (builtin preset) for high-frequency build
 *
 // (ADR-0104)
 * traffic, extended for self-hosted relay egress per ADR-0107.
 *
 * **This list is the single source of truth**: merging happens only in
 * assembly.ts; no consumer may re-append the preset itself.
 *
 * Semantics:
 *   - apex and `*.x` are listed side by side — the matcher treats `*.x` as
 *
 // (ADR-0097)
 *     strict subdomains excluding the apex (verified behavior), so dropping
 *     either loses coverage;
 *   - model-provider APIs / container registries / GitLab·Bitbucket are
 *
 // (ADR-0104)
 *     deliberately excluded: keys live inside the fence, so pre-allowing them
 *     would open a direct secret-exfiltration channel (reaffirmed by
 *
 // (ADR-0104)
 *     ADR-0107). The egress-assembly tests pin this exclusion;
 *   - inclusion principle: only git main paths, mainstream package managers,
 *     and this repo's Playwright browser downloads. New entries must be
 *     argued against that principle via code review — not a config toggle
 *     (escape hatch = user `deniedDomains` per entry, deny wins).
 */

/** Builtin pre-allowlist: HTTPS git / PR APIs / mainstream package-manager main paths / webui test browser binaries. */
export const BUILTIN_PRESET_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "playwright.download.prss.microsoft.com",
  "cdn.playwright.dev",
]);
