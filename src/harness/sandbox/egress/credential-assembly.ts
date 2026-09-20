/**
 * src/harness/sandbox/egress/credential-assembly.ts
 *
 * Credential roster SSOT + assembly + entry posture branch.
 *
 * Single responsibility: the builtin github roster (code constant) merged
 * with the user-layer `isolation.credentials` section (narrow/append),
 * producing the pure-data `EgressCredentialRoster`; the entry point
 * delegates by posture to minting (`credential-mint.ts`) or registers a
 * skipped trace. The minting implementation (registry fake values / masked
 * store / bind table / fence env increments + assembly-time asserts) lives in
 * `credential-mint.ts`; substitution wiring / dispose live in `session.ts`,
 * and the persistent CA layer in `ca-store.ts`.
 *
 * Dependency discipline: this domain never imports config back — the user
 * section arrives as a structured input (`UserCredentialSection`), and the
 * settings-side entry types are structurally compatible with it.
 *
 * Leak-through protection in the signature: the assembly function eats only
 * the two sources "builtin constants + user section" — **no** allowedDomains /
 * approval-set parameter — so freshly approved hosts cannot reach any entry's
 * injectHosts even at the type level.
 *
 * injectHosts static-pinning: an entry with undeclared / empty injectHosts →
 * not minted + warn trace (we do not take the package's "default = all
 * allowedDomains" trade-off; the settings layer already drops such entries,
 * this layer defends against direct callers — no silence allowed).
 */

import {
  mintEgressCredentials,
  type EgressCredentialMint,
  type MintEgressCredentialsArgs,
} from "./credential-mint.js";

/** One credential file entry (egress-side data shape). */
export interface EgressCredentialFileEntry {
  readonly path: string;
  /** Extraction regex source, must contain capture group 1 (group 1 = the credential value to mask). */
  readonly extract?: string;
  readonly decode?: "jwt";
  readonly injectHosts: readonly string[];
}

/** One credential env-var entry (whole-value masking form). */
export interface EgressCredentialEnvVarEntry {
  readonly name: string;
  readonly injectHosts: readonly string[];
}

/** Assembly output: the full entry set consumed by minting (builtin + user narrow/append). */
export interface EgressCredentialRoster {
  readonly files: readonly EgressCredentialFileEntry[];
  readonly envVars: readonly EgressCredentialEnvVarEntry[];
}

/**
 * User-section input shape — structurally compatible with
 * `IknowSettingsIsolationCredentials` (mutable string[] assignable to
 * readonly string[]), avoiding a config import in the egress domain.
 */
export interface UserCredentialSection {
  readonly files?: readonly EgressCredentialFileEntry[];
  readonly envVars?: readonly EgressCredentialEnvVarEntry[];
}

/** GitHub entries' static injection hosts (pinned; never expands). */
const GITHUB_INJECT_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
]);

function deepFreezeRoster<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreezeRoster((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Builtin github roster (single-file SSOT; host env `GH_TOKEN` + `gh`
 * hosts.yml). The hosts.yml entry uses structured-extract masking: YAML
 * `oauth_token:` capture group 1, every other byte of the file preserved
 * verbatim (gh parsing must not break).
 */
export const BUILTIN_GITHUB_CREDENTIAL_ROSTER: EgressCredentialRoster =
  deepFreezeRoster({
    files: [
      {
        path: "~/.config/gh/hosts.yml",
        extract: "oauth_token:\\s*(\\S+)",
        injectHosts: GITHUB_INJECT_HOSTS,
      },
    ],
    envVars: [
      {
        name: "GH_TOKEN",
        injectHosts: GITHUB_INJECT_HOSTS,
      },
    ],
  });

/** Mintability test for injectHosts: non-empty array with non-empty strings (explicit values required). */
function isMintable(entry: unknown): boolean {
  const hosts = (entry as { readonly injectHosts?: unknown }).injectHosts;
  return (
    Array.isArray(hosts) &&
    hosts.length > 0 &&
    hosts.every((h) => typeof h === "string" && h.trim().length > 0)
  );
}

function identity(entry: {
  readonly path?: string;
  readonly name?: string;
}): string {
  return entry.path ?? entry.name ?? "(unidentified)";
}

/** Narrow/append merge: an entry with the same identity (path / name) replaces in place, others append. */
function mergeEntries<
  T extends { readonly path?: string; readonly name?: string },
>(
  builtin: readonly T[],
  incoming: readonly T[],
  onWarn: ((message: string) => void) | undefined,
  list: "files" | "envVars"
): T[] {
  const out = [...builtin];
  for (const entry of incoming) {
    if (!isMintable(entry)) {
      onWarn?.(
        `[egress] credential ${list} entry "${identity(entry)}" not minted: missing or empty injectHosts (no allowedDomains default)`
      );
      continue;
    }
    const key = identity(entry);
    const idx = out.findIndex((e) => identity(e) === key);
    if (idx === -1) out.push(entry);
    else out[idx] = entry;
  }
  return out;
}

/**
 * Assemble the credential roster consumed by minting: the two builtin github
 * entries as baseline; the user section only narrows (same-identity entry
 * replacement) or appends (new entries). Absent user section → return the
 * builtin constant directly (reference-stable, read-only across sessions).
 * Output is deep-frozen.
 */
export function assembleEgressCredentials(
  userSection: UserCredentialSection | undefined,
  onWarn?: (message: string) => void
): EgressCredentialRoster {
  if (userSection === undefined) return BUILTIN_GITHUB_CREDENTIAL_ROSTER;
  const files = mergeEntries(
    BUILTIN_GITHUB_CREDENTIAL_ROSTER.files,
    userSection.files ?? [],
    onWarn,
    "files"
  );
  const envVars = mergeEntries(
    BUILTIN_GITHUB_CREDENTIAL_ROSTER.envVars,
    userSection.envVars ?? [],
    onWarn,
    "envVars"
  );
  if (
    files.length === BUILTIN_GITHUB_CREDENTIAL_ROSTER.files.length &&
    envVars.length === BUILTIN_GITHUB_CREDENTIAL_ROSTER.envVars.length &&
    files.every((f, i) => f === BUILTIN_GITHUB_CREDENTIAL_ROSTER.files[i]) &&
    envVars.every((e, i) => e === BUILTIN_GITHUB_CREDENTIAL_ROSTER.envVars[i])
  ) {
    // The user section produced no effective change (all refused minting) → back to the builtin constant.
    return BUILTIN_GITHUB_CREDENTIAL_ROSTER;
  }
  return deepFreezeRoster({ files, envVars });
}

// ── Assembly entry posture branch (yolo / isolation OFF → no minting, no injection)

/**
 * Fence posture: `fenced` = normal minting tier; `no-fence` = yolo /
 * isolation OFF (the fence exits entirely) — the entry branches explicitly to
 * "do not mint, do not inject" and returns a `skipped` trace into
 * diagnostics/logs, so it is verifiable offline that "host real values reach
 * children directly with no existence-plane protection". The posture
 * difference is registered explicitly, never silent.
 */
export type EgressFencePosture = "fenced" | "no-fence";

/** `no-fence` output: the skipped marker is itself the offline evidence (no registry/store/envVars). */
export interface EgressCredentialSkipped {
  readonly skipped: "no-fence";
}

/** Entry return union: consumers must handle the skipped tier explicitly (no silent degradation). */
export type EgressCredentialLayer =
  EgressCredentialMint | EgressCredentialSkipped;

/** `fenced` inputs = minting args + posture declaration. */
export interface MintEgressCredentialLayerFencedArgs extends MintEgressCredentialsArgs {
  readonly posture: "fenced";
  readonly onDiagnostic?: (message: string) => void;
}

/** `no-fence` inputs: structurally cannot take roster / CA — nothing to mint against real values. */
export interface MintEgressCredentialLayerNoFenceArgs {
  readonly posture: "no-fence";
  readonly onDiagnostic?: (message: string) => void;
}

export type MintEgressCredentialLayerArgs =
  MintEgressCredentialLayerFencedArgs | MintEgressCredentialLayerNoFenceArgs;

/**
 * no-fence trace text SSOT — used only by the yolo / isolation-OFF wiring
 * (`mintEgressCredentialLayer` no-fence posture tier). Production assembly
 * with the network section absent now goes through the builtin preset policy
 * (fence in play), so this trace is no longer registered there. Offline grep
 * of `skipped: no-fence` verifies the posture. The text contains no credential
 * material.
 */
export function noFenceCredentialTrace(): string {
  return (
    `[egress-credential] skipped: no-fence — credential layer not minted and ` +
    `not injected; with the fence absent host real values reach children ` +
    `directly with no existence-plane protection (declared posture per spec ` +
    `F9 / Assumption 9 — registered, not silent)`
  );
}

/**
 * Credential assembly entry: the three assembly points reach minting via
 * `createEgressSession` and delegate with the `fenced` posture to
 * `mintEgressCredentials`; yolo / isolation-OFF wiring calls with
 * `no-fence` — no registry / store constructed, no CA loaded, no env
 * increments produced; it returns the `skipped` trace on the diagnostic
 * channel (silence forbidden). Additive shape: future ssh-bridge wiring can
 * hook into the same entry.
 */
export function mintEgressCredentialLayer(
  args: MintEgressCredentialLayerFencedArgs
): EgressCredentialMint;
export function mintEgressCredentialLayer(
  args: MintEgressCredentialLayerNoFenceArgs
): EgressCredentialSkipped;
export function mintEgressCredentialLayer(
  args: MintEgressCredentialLayerArgs
): EgressCredentialLayer {
  if (args.posture === "no-fence") {
    const onDiagnostic =
      args.onDiagnostic ?? ((m: string): void => console.warn(m));
    onDiagnostic(noFenceCredentialTrace());
    return Object.freeze({ skipped: "no-fence" });
  }
  return mintEgressCredentials(args);
}
