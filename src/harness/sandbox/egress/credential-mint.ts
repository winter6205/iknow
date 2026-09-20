/**
 * src/harness/sandbox/egress/credential-mint.ts
 *
 * Startup-time minting (fake values into the fence).
 *
 * Single responsibility: roster entries (the pure-data
 * `EgressCredentialRoster` produced by `credential-assembly.ts`) → registry
 * fake values + masked store + bind table + fence env increments;
 * assembly-time defense lines double-asserted. Roster assembly / narrow merge
 * belongs to `credential-assembly.ts`, substitution wiring / dispose to
 * `session.ts`, the persistent CA layer to `ca-store.ts`.
 *
 * Leak-through protection in the signature: minting eats only "roster + CA +
 * env source" — **no** allowedDomains / approval-set parameter — so freshly
 * approved hosts cannot reach any entry's injectHosts even at the type level.
 *
 * injectHosts static-pinning: entries with undeclared / empty injectHosts are
 * already dropped by the settings layer; this layer defends against direct
 * callers (the `isMintable` test sits on the roster-assembly side), silence
 * forbidden.
 */

import { readFileSync, statSync } from "node:fs";
import { ToolExecutionError } from "../../errors.js";
import { egressCaBindSources } from "./ca-store.js";
import type {
  EgressCredentialEnvVarEntry,
  EgressCredentialFileEntry,
  EgressCredentialRoster,
} from "./credential-assembly.js";
import {
  buildMaskedEnvVars,
  buildMaskedFileBinds,
  CA_TRUST_VARS,
  MaskedFileStore,
  normalizePathForSandbox,
  SentinelRegistry,
  type CredentialEnvVarConfig,
  type CredentialFileConfig,
  type MaskedEnvBuildResult,
  type MaskedFileBind,
  type MitmCA,
} from "./upstream.js";

/**
 * bwrap fence bind table entry (an extension segment of `EgressFenceSpec.binds`):
 * masked-file cover bind (src=fake file, dest=real path), store dir / trust
 * bundle self-bind (src=dest), and the `/dev/null` cover bind for denied
 * paths. Emitted into the egressBind segment (after workspaceMounts, before
 * cwdReadonly), where last-mount-wins covers the real path under the root bind.
 */
export interface EgressFenceBind {
  readonly src: string;
  readonly dest: string;
  readonly readonly: true;
}

/**
 * Typed violation trace for deny downgrades (kind-discriminated union per the
 * typed-error contract). Contains only paths and human-readable text, never
 * credential material.
 */
export interface CredentialDenyTrace {
  readonly kind: "credential_mask_denied";
  readonly path: string;
  readonly reason: string;
}

/** Typed failure tiers of assembly-time defense lines: the two signals require different fixes. */
export type EgressCredentialMintErrorKind =
  /** Registered sentinels are substrings of each other → do not start a partially-substituting session. */
  | "sentinel_substring_contract"
  /** An injected credential env value ∉ registry fake-value space → session does not start. */
  | "env_fake_space_contract";

/**
 * Assembly-time defense-line violation — thrown before session startup (prior
 * to proxy start), on the same failure channel as createEgressSession (never
 * run a session "with partial substitution / half real values"). The message
 * contains only entry names / tiers, never echoes real values.
 */
export class EgressCredentialMintError extends ToolExecutionError {
  override readonly name: string = "EgressCredentialMintError";
  readonly kind: EgressCredentialMintErrorKind;
  constructor(kind: EgressCredentialMintErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Minting output: fence env increments + bind table + registry/store (consumption and release belong to session wiring). */
export interface EgressCredentialMint {
  readonly registry: SentinelRegistry;
  readonly store: MaskedFileStore;
  /** Fence env increments: credential fake values + all `CA_TRUST_VARS` pointing at the trust bundle. */
  readonly envVars: Readonly<Record<string, string>>;
  readonly binds: readonly EgressFenceBind[];
  readonly denyTraces: readonly CredentialDenyTrace[];
}

export interface MintEgressCredentialsArgs {
  readonly roster: EgressCredentialRoster;
  /** Output of the persistent CA layer (trust bundle written fresh by createMitmCA). */
  readonly ca: MitmCA;
  /** Host env source (default process.env) — real values are read in this process's memory only, never into the fence. */
  readonly env?: Record<string, string | undefined>;
  /** Skip traces (debug tier: "nothing protectable" is not a failure). */
  readonly onDebug?: (message: string) => void;
  /** Violation-trace bypass for denials (silence forbidden); default console.warn. */
  readonly onWarn?: (message: string) => void;
}

/** No registered sentinel may be a substring of another. */
export function assertSentinelSubstringContract(
  registry: SentinelRegistry
): void {
  const sentinels = [...registry.entries()].map(([s]) => s);
  for (let i = 0; i < sentinels.length; i++) {
    for (let j = 0; j < sentinels.length; j++) {
      if (i === j) continue;
      if (sentinels[j].includes(sentinels[i])) {
        throw new EgressCredentialMintError(
          "sentinel_substring_contract",
          `egress credential assembly: sentinel #${i} is a substring of sentinel #${j} (nested fakes make body substitution chunk-boundary-dependent). Refusing to start a partially-substituting session (spec F4).`
        );
      }
    }
  }
}

/**
 * Every credential entry env value injected into the fence must land in the
 * registry fake-value space — whole-value form = exactly some sentinel,
 * structured form = a synthesized alternating value containing some sentinel.
 * A violation = assembly defect (real values could reach the fence directly)
 * → typed failure, session does not start.
 */
export function assertInjectedEnvInFakeSpace(
  setEnvVars: Readonly<Record<string, string>>,
  registry: SentinelRegistry
): void {
  const sentinels = [...registry.entries()].map(([s]) => s);
  for (const [name, value] of Object.entries(setEnvVars)) {
    if (!sentinels.some((s) => value === s || value.includes(s))) {
      throw new EgressCredentialMintError(
        "env_fake_space_contract",
        `egress credential assembly: injected env "${name}" value is not in the registry fake-value space (invariant 1). Refusing to start the session.`
      );
    }
  }
}

/** Skip trace for unreadable files: host cannot read it = the fence cannot either; unreachability is not leakage, so no hard error. */
function f2SkipReason(path: string, cause: string): string {
  return `[egress-credential] file entry "${path}" skipped (${cause}) — nothing protectable on this host; entry passes through as absent`;
}

/**
 * Env entry minting (whole-value form): presence pre-check, then hand to the
 * package flow. Separate function for the lint complexity gate.
 */
function mintEnvEntries(
  entries: readonly EgressCredentialEnvVarEntry[],
  registry: SentinelRegistry,
  env: Record<string, string | undefined>,
  onDebug: (message: string) => void
): MaskedEnvBuildResult {
  const envConfigs: CredentialEnvVarConfig[] = [];
  for (const entry of entries) {
    const raw = env[entry.name];
    if (raw === undefined || raw.length === 0) {
      onDebug(
        `[egress-credential] env entry "${entry.name}" skipped: no real value on host (F1 — nothing to protect; no empty fake injected)`
      );
      continue;
    }
    envConfigs.push({
      name: entry.name,
      mode: "mask",
      injectHosts: [...entry.injectHosts],
    });
  }
  const result = buildMaskedEnvVars(envConfigs, [], registry, env);
  // This repo's env entry shape has no extract/decode → that tier is
  // structurally unreachable; keep the defensive branch: if it ever appears,
  // trace it and withhold from injection (fail-closed direction).
  for (const name of result.degradeToUnsetNames) {
    onDebug(
      `[egress-credential] env entry "${name}" degraded to unset (extract no match under deny policy) — withheld from fence env`
    );
  }
  return result;
}

/**
 * File entry pre-check: accountability for the deny downgrade lives in this
 * repo — the package silently skips non-UTF-8 input (fail-open), so the deny
 * downgrade must intercept before the package flow runs.
 * Returns the maskable config set + the denied-path set + typed deny traces.
 * Separate function for the lint complexity gate.
 */
function preflightFileEntries(
  entries: readonly EgressCredentialFileEntry[],
  onDebug: (message: string) => void
): {
  configs: CredentialFileConfig[];
  denyPaths: Set<string>;
  denyTraces: CredentialDenyTrace[];
} {
  const configs: CredentialFileConfig[] = [];
  const denyPaths = new Set<string>();
  const denyTraces: CredentialDenyTrace[] = [];
  for (const entry of entries) {
    const resolved = normalizePathForSandbox(entry.path);
    let raw: Buffer | null = null;
    let directory = false;
    try {
      directory = statSync(resolved).isDirectory();
      if (!directory) raw = readFileSync(resolved);
    } catch {
      // absent / unreadable — a unified skip trace follows.
    }
    if (directory || raw === null) {
      onDebug(
        f2SkipReason(
          entry.path,
          directory ? "resolves to a directory" : "absent or unreadable on host"
        )
      );
      continue;
    }
    // Non-UTF-8 test uses the same algorithm as the package's masking (utf8 round-trip byte length mismatch = binary).
    const text = raw.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== raw.length) {
      denyPaths.add(resolved);
      denyTraces.push({
        kind: "credential_mask_denied",
        path: resolved,
        reason:
          `non-UTF-8 (binary) credential file cannot be sentinel-masked — path denied inside the fence (Assumption 8 fail-closed, package default fail-open is not accepted). ` +
          `Fix: store the credential in a UTF-8 text file (mask applies) or move it to an env var entry.`,
      });
      continue;
    }
    configs.push({
      path: entry.path,
      mode: "mask",
      extract: entry.extract,
      decode: entry.decode,
      injectHosts: [...entry.injectHosts],
      onExtractNoMatch: "deny",
    });
  }
  return { configs, denyPaths, denyTraces };
}

/**
 * Bind-table assembly (placement is for the bwrap consumer): masked cover
 * binds → store dir → trust bundle (via the SSOT `egressCaBindSources`; the
 * CA key path never leaves the table) → /dev/null covers for denied paths.
 * Separate function for the lint complexity gate.
 */
function assembleFenceBinds(
  maskedBinds: readonly MaskedFileBind[],
  store: MaskedFileStore,
  ca: MitmCA,
  denyPaths: ReadonlySet<string>
): EgressFenceBind[] {
  const binds: EgressFenceBind[] = [];
  for (const b of maskedBinds) {
    binds.push({ src: b.fakePath, dest: b.realPath, readonly: true });
  }
  const storeDir = store.dirPath;
  if (storeDir !== undefined) {
    binds.push({ src: storeDir, dest: storeDir, readonly: true });
  }
  for (const s of egressCaBindSources(ca)) {
    binds.push({ src: s.src, dest: s.src, readonly: true });
  }
  for (const p of denyPaths) {
    binds.push({ src: "/dev/null", dest: p, readonly: true });
  }
  return binds;
}

/**
 * Startup-time minting: roster entries → registry fake values + masked store
 * + bind table + fence env increments. Each failure path is typed:
 *   - real-value env absent / empty string → skip the entry + debug trace,
 *     never inject an empty fake (the presence check does not invert);
 *   - file missing / unreadable / is-a-directory → skip + debug trace, no
 *     hard error;
 *   - non-UTF-8 / binary, or extract unmatched → **downgrade to deny**: a
 *     `/dev/null` cover bind makes the path unreadable inside the fence + a
 *     typed violation trace with fix guidance. We do not accept the package
 *     default of warn-and-include (fail-open);
 *   - post-registration double asserts; a violation = throw (session does
 *     not start).
 *
 * The `allowedDomains` argument is always `[]` (entry injectHosts must be
 * explicit values, no package default expansion); `onExtractNoMatch` is
 * pinned to `"deny"` per file entry.
 */
export function mintEgressCredentials(
  args: MintEgressCredentialsArgs
): EgressCredentialMint {
  const env = args.env ?? process.env;
  const onDebug = args.onDebug ?? ((m: string) => console.debug(m));
  const onWarn = args.onWarn ?? ((m: string) => console.warn(m));
  const registry = new SentinelRegistry();
  const store = new MaskedFileStore();

  const envResult = mintEnvEntries(args.roster.envVars, registry, env, onDebug);
  const preflight = preflightFileEntries(args.roster.files, onDebug);
  const fileResult = buildMaskedFileBinds(
    preflight.configs,
    [],
    registry,
    store
  );
  const denyTraces = [...preflight.denyTraces];
  const denyPaths = new Set(preflight.denyPaths);
  for (const path of fileResult.degradeToDenyPaths) {
    denyPaths.add(path);
    denyTraces.push({
      kind: "credential_mask_denied",
      path,
      reason:
        `mask-mode credential file matched no extract/decode candidate — degraded to deny (path unreadable inside the fence; Assumption 8, package "warn"-and-include not accepted). ` +
        `Fix: correct the entry's extract (capture group 1 = the credential value) or remove the entry.`,
    });
  }
  for (const t of denyTraces) onWarn(`[egress-credential] ${t.reason}`);

  // bind table + fence env increments (fake values + all CA_TRUST_VARS
  // pointing at the trust bundle).
  const binds = assembleFenceBinds(fileResult.binds, store, args.ca, denyPaths);
  const credEnv: Record<string, string> = { ...envResult.setEnvVars };
  for (const name of CA_TRUST_VARS) {
    credEnv[name] = args.ca.trustBundlePath;
  }

  // Assembly-time defense lines (after a throw the caller never receives
  // registry/store, so no half-injected state leaks). The asserts pin only
  // credential entry env values; CA_TRUST_VARS is trust-chain path injection,
  // not part of the fake-value space.
  assertSentinelSubstringContract(registry);
  assertInjectedEnvInFakeSpace(envResult.setEnvVars, registry);

  return Object.freeze({
    registry,
    store,
    envVars: Object.freeze(credEnv),
    binds: Object.freeze(binds),
    denyTraces: Object.freeze(denyTraces),
  });
}
