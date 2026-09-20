/**
 * src/harness/sandbox/egress/ca-store.ts
 *
 * Persistent CA layer and trust-chain assembly surface.
 *
 * Single responsibility: host-level persistent MITM CA "load / self-check /
 * refuse / regenerate" lives here, consumed by credential minting assembly.
 * The trust bundle itself is written fresh per call by the package's
 * `createMitmCA` (funneled through `upstream.ts`, not replicated).
 *
 * Pinned contract:
 *   - persistent location = `~/.config/iknow/egress-mitm-ca/`
 *     (`defaultEgressCaDir()`) — a host-level persistent singleton, not
 *     per-call ephemeral: RSA-2048 generation sits on the cold path (upstream
 *     performance note);
 *   - dir 0700 / key 0600; mode mismatch = **refuse + warn before
 *     regenerate**; a failing `validateCaPair` = refuse + warn + regenerate,
 *     and the session can load afterwards;
 *   - notice traces (`CaStoreNotice`) carry only file names / modes /
 *     validation reasons — **never PEM or key material** (no key leakage into
 *     observable surfaces);
 *   - the CA private key path never enters any bind table —
 *     `egressCaBindSources()` is the single SSOT for trust-chain bind
 *     candidates, containing only the trust bundle path;
 *   - no silent degradation here — every deviation takes the real dual
 *
 // (ADR-0105)
 *     channel: live trace via `onWarn` (default `console.warn`) before
 *     regeneration (inside `regenerate`), plus `PersistentCaState.notice`
 *     returned for offline accountability by the caller. The assembly point
 *     `mintCredentialsStep` currently does not wire a violationSink; sink
 *     consumption for notice/denyTraces is a registered follow-up.
 *
 * typed-error discipline: notices use a kind-discriminated union and
 * renderers check `kind` first; this module never throws on "odd disk
 * state" — only genuine write failures (hard FS errors) surface from below.
 * CA unavailable = no mitm session started; the caller decides what to do.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createMitmCA,
  generateCa,
  validateCaPair,
  type MitmCA,
} from "./upstream.js";

/** File names inside the persistent CA dir (private layout; consumers only use returned paths). */
const CA_CERT_FILE = "cert.pem";
const CA_KEY_FILE = "key.pem";
const CA_DIR_MODE = 0o700;
const CA_KEY_MODE = 0o600;
/** Fixed CN; leaf cache dies with the session, so regeneration swaps the anchor. */
const CA_SUBJECT_CN = "iknow egress mitm CA";

/**
 * Per-client trust roster constants (constants only here; wiring happens at
 * the minting/assembly layer): gh is a Go binary → honors `SSL_CERT_FILE`;
 * git-over-https → `GIT_SSL_CAINFO`; curl → `CURL_CA_BUNDLE`.
 */
export const CLIENT_TRUST_VARS = Object.freeze({
  gh: "SSL_CERT_FILE",
  git: "GIT_SSL_CAINFO",
  curl: "CURL_CA_BUNDLE",
} as const);

/** Three-way load action: direct load / first generation / regenerate after refusal. */
export type PersistentCaAction = "loaded" | "generated" | "regenerated";

/**
 * Notice traces (all refusal branches + the degradation-trace surface).
 * detail/reason are operator-readable short strings: file names, octal modes,
 * package validation reasons only — no key material.
 */
export type CaStoreNotice =
  | {
      readonly kind: "ca_permissions";
      readonly detail: string;
    }
  | {
      readonly kind: "ca_pair_invalid";
      readonly reason: string;
    }
  | {
      readonly kind: "ca_pair_incomplete";
      readonly detail: string;
    };

export interface PersistentCaState {
  readonly certPath: string;
  readonly keyPath: string;
  readonly action: PersistentCaAction;
  /** Non-null = this pass involved a "refusal + regeneration" or half-pair repair; the caller leaves an infra trace accordingly. */
  readonly notice: CaStoreNotice | null;
}

export interface EgressCaLoad {
  readonly ca: MitmCA;
  readonly state: PersistentCaState;
}

/** Trust-chain bind candidate (pinned surface): readonly bind shape, trust bundle only. */
export interface EgressCaBindSource {
  readonly src: string;
  readonly readonly: true;
}

/** Default location: `~/.config/iknow/egress-mitm-ca/`. */
export function defaultEgressCaDir(home: string = homedir()): string {
  return join(home, ".config", "iknow", "egress-mitm-ca");
}

/**
 * Load or self-heal the persistent CA. Ordering discipline ("mode mismatch =
 * refuse" precedes content validation): dir existence and mode → pair
 * completeness → key mode → validateCaPair. Every refusal branch collects the
 * notice before regenerating; regeneration uniformly restores 0700/0600.
 */
export function ensurePersistentCa(opts: {
  readonly caDir: string;
  /** Notice bypass channel ("warn before regenerate"); defaults to console.warn, same as settings discipline. */
  readonly onWarn?: (message: string) => void;
}): PersistentCaState {
  const { caDir, onWarn = (message: string) => console.warn(message) } = opts;
  const paths: CaPairPaths = {
    caDir,
    certPath: join(caDir, CA_CERT_FILE),
    keyPath: join(caDir, CA_KEY_FILE),
  };

  const dirNotice = ensureCaDirMode(caDir);
  if (dirNotice) {
    return regenerate(paths, dirNotice, onWarn);
  }

  const cert = readOptional(paths.certPath);
  const key = readOptional(paths.keyPath);
  if (cert === null && key === null) {
    writeCaPair(paths);
    return persistentCaState(paths, "generated", null);
  }
  if (cert === null || key === null) {
    return regenerate(
      paths,
      {
        kind: "ca_pair_incomplete",
        detail: `CA pair half-missing in ${caDir} (${cert === null ? CA_CERT_FILE : CA_KEY_FILE} absent) — regenerating`,
      },
      onWarn
    );
  }

  const keyMode = modeOfOrThrow(paths.keyPath);
  if (keyMode !== CA_KEY_MODE) {
    return regenerate(
      paths,
      {
        kind: "ca_permissions",
        detail: `CA key file mode is ${octal(keyMode)} (required ${octal(CA_KEY_MODE)}) — refused, regenerating`,
      },
      onWarn
    );
  }

  const validation = validateCaPair(cert, key);
  if (!validation.ok) {
    return regenerate(
      paths,
      {
        kind: "ca_pair_invalid",
        reason: `validateCaPair failed for ${caDir}: ${validation.reason} — regenerating`,
      },
      onWarn
    );
  }
  return persistentCaState(paths, "loaded", null);
}

/**
 * Session loading entry: ensure (with self-heal) → `createMitmCA` loads from
 * the persistent store and writes this session's trust bundle on the spot.
 * The returned `notice` is the refusal/warn trace from this pass.
 */
export function loadEgressCa(opts?: {
  readonly caDir?: string;
  readonly onWarn?: (message: string) => void;
}): EgressCaLoad {
  const caDir = opts?.caDir ?? defaultEgressCaDir();
  const state = ensurePersistentCa({ caDir, onWarn: opts?.onWarn });
  const ca = createMitmCA({
    caCertPath: state.certPath,
    caKeyPath: state.keyPath,
  });
  return Object.freeze({ ca, state });
}

/**
 * Trust-chain bind candidates — the SSOT tests pin: only the trust bundle
 * enters the fence (CERTIFICATE blocks only, filtered inside the package);
 * the CA key path never appears in this table. dest placement and ro-bind
 * assembly happen at the minting layer.
 */
export function egressCaBindSources(ca: MitmCA): readonly EgressCaBindSource[] {
  return Object.freeze([
    Object.freeze({ src: ca.trustBundlePath, readonly: true as const }),
  ]);
}

// ── Private helpers ─────────────────────────────────────────────────────

/** Persistent CA path bundle (private layout, passed around whole to respect the max-params lint gate). */
interface CaPairPaths {
  readonly caDir: string;
  readonly certPath: string;
  readonly keyPath: string;
}

function persistentCaState(
  paths: CaPairPaths,
  action: PersistentCaAction,
  notice: CaStoreNotice | null
): PersistentCaState {
  return {
    certPath: paths.certPath,
    keyPath: paths.keyPath,
    action,
    notice,
  };
}

function regenerate(
  paths: CaPairPaths,
  notice: CaStoreNotice,
  onWarn: (message: string) => void
): PersistentCaState {
  onWarn(`[egress-ca-store] ${describeNotice(notice)}`);
  ensureCaDirMode(paths.caDir);
  writeCaPair(paths);
  return persistentCaState(paths, "regenerated", notice);
}

/**
 * Verify / restore the dir mode. Return value = a permission deviation was
 * found this pass (for the refusal notice); missing dir → create (0700;
 * recursive parents are not a deviation — parent dirs belong to home).
 */
function ensureCaDirMode(caDir: string): CaStoreNotice | null {
  let notice: CaStoreNotice | null = null;
  const st = statOrNull(caDir);
  if (st !== null) {
    const mode = st.mode & 0o777;
    if (mode !== CA_DIR_MODE) {
      notice = {
        kind: "ca_permissions",
        detail: `CA dir mode is ${octal(mode)} at ${caDir} (required ${octal(CA_DIR_MODE)}) — refused, regenerating`,
      };
    }
  } else {
    mkdirSync(caDir, { recursive: true, mode: CA_DIR_MODE });
  }
  // New or old, unify to 0700 (mkdir's mode is pruned by umask; chmod is the backstop).
  chmodSync(caDir, CA_DIR_MODE);
  return notice;
}

function writeCaPair(paths: CaPairPaths): void {
  const pair = generateCa({ cn: CA_SUBJECT_CN });
  writeSecretFile(paths.certPath, pair.certPem);
  writeSecretFile(paths.keyPath, pair.keyPem);
}

/**
 * Secret file write: clear obstacles first (an old file may have an
 * over-broad mode, or the entry may have been swapped for a directory — if
 * unlink/rm fails, let writeFileSync surface the hard error). writeFileSync's
 * mode only applies to a new file, so chmod backstops to guarantee 0600.
 */
function writeSecretFile(path: string, content: string): void {
  const st = statOrNull(path);
  if (st !== null) {
    if (st.isDirectory()) {
      rmRecursive(path);
    } else {
      try {
        unlinkSync(path);
      } catch {
        /* race delete / permission: let the following writeFileSync report it */
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: CA_DIR_MODE });
  writeFileSync(path, content, { mode: CA_KEY_MODE });
  chmodSync(path, CA_KEY_MODE);
}

function describeNotice(n: CaStoreNotice): string {
  switch (n.kind) {
    case "ca_permissions":
      return n.detail;
    case "ca_pair_invalid":
      return n.reason;
    case "ca_pair_incomplete":
      return n.detail;
  }
}

function readOptional(path: string): string | null {
  const st = statOrNull(path);
  if (st === null) return null;
  if (st.isDirectory()) return null; // broken entry → treated as absent, cleared during regeneration
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null; // unreadable = absent; the regeneration path rebuilds it at 0600
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function rmRecursive(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function modeOfOrThrow(path: string): number {
  return statSync(path).mode & 0o777;
}

function octal(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}
