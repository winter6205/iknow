import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ProtectedTargetBindPath,
  ProtectedTargetEntry,
  ProtectedTargetInventory,
} from "./protected-targets.js";

/**
 * Credential read-side control (specs/effect-boundary-protection.md SC4,
 * "for reads at credential sources, a process/capability-layer control so a
 * protected credential is only ever reachable as a masked value or not at
 * all").
 *
 * Layer choice — mount level, not an execution-path capability check: the
 * fence admits arbitrary interpreters, and a check in the bash/runner exec
 * path is bypassable by exactly the class of event ADR-0129 recorded (the
 * interpreter spelling of the same read). A cover mount is interpreter-
 * independent: every process in the namespace sees the same namespace view.
 *
 * COORDINATED PLAN (part of the protected-write block in bwrap.ts — the two
 * are one mount plan, never two independently-stacked blocks): the credential
 * subtrees stay mounted as their REAL directories, read-only (the protected
 * write layer's `--ro-bind`), and every regular file under them is masked
 * individually with `--ro-bind /dev/null <file>` stacked ON the read-only
 * subtree. That combination is what makes a deletion attempt truthful for
 * every spelling:
 *   - unlink of an existing credential file → EROFS from the read-only
 *     subtree mount, whatever program issues it (`rm -f` exits NON-ZERO with
 *     "Read-only file system" on stderr — the [fs_denied] guidance trigger;
 *     verified empirically against bwrap: an unlink in a read-only mount is
 *     refused even when the name is itself a mount point);
 *   - reading the masked file → the fence's binds carry nodev, so opening the
 *     /dev/null cover refuses outright (EACCES); where a device read does
 *     resolve, it yields zero bytes. Either way the real value is unreachable;
 *   - creating anything inside the subtree still meets EROFS — the write
 *     guarantee never degrades into a silently-succeeding tmpfs.
 * An earlier shape covered whole subtrees with an empty read-only mount; it
 * hid presence but made `rm -f <credential>` exit 0 on the hidden name (a
 * vacuous success with no refusal signal), which broke the SC1/SC3 refusal
 * shape. Presence (file names) is now visible under the subtree — the
 * content-reachability guarantee is what the mask carries; the vacuous-success
 * refusal-shape break is not tolerated. A bounded fallback keeps the empty-
 * subtree cover ONLY when a subtree holds more files than the mask budget
 * (contents hidden, per-file tokens would bloat argv toward the kernel
 * limit; deletion stays truthful for every name the fallback does not hide).
 *   - exact-file credential sources → `--ro-bind /dev/null <path>` (the same
 *     per-file mask, the subtree is their parent mount);
 *   - absent sources contribute no tokens (bwrap rejects a missing bind
 *     source; their read is the ordinary ENOENT, never a fabricated success),
 *     `/proc` paths are skipped (guest `/proc` is remounted by `--proc` and
 *     the in-fence environ is already the clearenv'd one), and name-pattern
 *     rules have no bind source — files under a masked subtree are covered
 *     by that subtree's per-file masks.
 *
 * Egress coordination (ADR-0105/0107, "where it already masks before the
 * fence, do not contradict"): the sentinel layer binds masked files at real
 * credential paths inside the egress segment, which sits EARLIER in the mount
 * chain than this block — without re-emission both the protected-write
 * ro-bind and these masks would stomp the masked values (the ro-bind alone
 * re-exposes the real file — the leak this coordination closes). For every
 * egress bind whose dest lands under a covered subtree, the bind is
 * re-emitted after the masks: the masked value stays reachable, the real
 * value never is. The mask leaves the real (read-only) parent in place, so
 * the dest is always findable as a mount point — no placeholder plumbing.
 *
 * The fallback cover dir lives under the session tmp contract root
 * (`fsPolicy.tmpRoot()` — exists, session-owned, cleaned with the session) at
 * a path DETERMINISTIC in the covered path so foreground / background /
 * rebind assemblies of one session produce identical argv. Per-file masks
 * are deterministic in the subtree's on-disk state (sorted enumeration), the
 * same vintage discipline as the existence checks in the write block.
 */

/** The bind-pair shape this layer consumes from the egress fence spec. */
export interface CredentialMaskFenceBind {
  readonly src: string;
  readonly dest: string;
}

export interface CredentialReadMaskArgs {
  readonly inventory: ProtectedTargetInventory;
  /** Session tmp contract root (`fsPolicy.tmpRoot()`) — fallback cover parent. */
  readonly sessionTmpRoot: string;
  /** Egress fence bind table; absent/empty = sentinel layer not in play. */
  readonly egressBinds?: readonly CredentialMaskFenceBind[];
  /**
   * This assembly's materialized name-pattern matches. A match is read by the
   * same standard as any other credential source, so it takes the same
   * per-file `/dev/null` cover; without this the protected-write block would
   * keep it read-only but its bytes would stay readable.
   */
  readonly materializedTargets?: readonly ProtectedTargetBindPath[];
}

const COVER_ROOT_NAME = "protected-credential-cover";

/**
 * The fs identity of ONE path the mask plan depends on.
 *
 * Identity = (dev, ino, mtimeNs, ctimeNs, size), read with `lstatSync(path,
 * { bigint: true })` — NEVER `stat`: the mask never follows symlinks (a
 * link's TARGET is not an observable of the plan — `listRegularFiles` skips
 * symlinks, and the file's own doc comment says so), so `lstat` is the
 * correct tool: a substituted symlink is caught by ITS OWN identity rather
 * than by the identity of whatever it happens to point at. A symlink
 * retarget mutates the CONTAINING directory, and the containing directory
 * is what the plan records (see `MaskBuildState`).
 *
 * Nanosecond stamps, not second-resolution `mtime`: an add / remove inside
 * a traversed directory within the same second is invisible to a coarse
 * stamp, and the plan would keep serving a file set the host no longer
 * has. `ctimeNs` additionally catches a restored mtime and a permission
 * change (chmod bumps ctime, not mtime).
 */
interface FsIdentity {
  readonly path: string;
  /** The path did not exist when the plan was built. */
  readonly absent: boolean;
  /**
   * The path could NOT be read when the plan was built (a non-ENOENT lstat
   * error — EACCES / EIO / ENOTDIR …). Such an identity is an UNKNOWN
   * observable, never "absent": it never validates as unchanged, so the
   * plan is rebuilt instead of being served on top of an unreadable path.
   */
  readonly unreadable: boolean;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly size: bigint;
  readonly directory: boolean;
}

/**
 * The fs identities ONE mask-plan build depends on, keyed by path.
 *
 * DIRECTORY GRANULARITY (the soundness argument for the cache): a subtree
 * rule's plan is "every regular file under this root", and that file SET is
 * determined by the CONTENTS of the directories the walk traversed. Any
 * add / remove / type-change / retarget inside a traversed directory
 * mutates that directory's own mtime+ctime — so recording the traversed
 * DIRECTORIES (not every file under them) is enough to detect the change.
 * That is also what makes the cache pay off: validation costs
 * O(#traversed-dirs + #exact-files) stats instead of O(#files).
 *
 * Per-file identities are recorded only where the FILE itself is the
 * observable: an exact-rule entry (the plan masks it only while it is a
 * regular file) and a generated cover source (the plan mounts it only
 * while it exists, and its CONTENT is what the tamper check reads).
 */
interface MaskBuildState {
  readonly identities: Map<string, FsIdentity>;
}

/**
 * The outcome of one `lstat` of a path: its own stat, "absent" (ENOENT — the
 * path does not exist), or "unreadable" (any other errno: EACCES / EIO /
 * ENOTDIR …).
 *
 * "Unreadable" is NOT "absent": a path that cannot be stat'ed is an UNKNOWN
 * observable. The cache treats an unknown observable as CHANGED (the plan is
 * rebuilt), never as "the path is gone".
 */
type LstatOutcome =
  | { readonly kind: "present"; readonly stat: BigIntStats }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/** The path's own stat (never following a symlink), or its absence / unreadability. */
function lstatOutcome(path: string): LstatOutcome {
  try {
    return { kind: "present", stat: lstatSync(path, { bigint: true }) };
  } catch (err) {
    // EXIT: the stat failed. ENOENT is the "the path does not exist"
    // observable; every other errno (EACCES / EIO / ENOTDIR …) means the path
    // could NOT be read — an UNKNOWN observable, never "absent", so the cache
    // rebuilds the plan instead of serving one built on an unreadable path.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "unreadable" };
  }
}

function identityFromStat(path: string, stat: BigIntStats): FsIdentity {
  return {
    path,
    absent: false,
    unreadable: false,
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    size: stat.size,
    directory: stat.isDirectory(),
  };
}

function absentIdentity(path: string): FsIdentity {
  return {
    path,
    absent: true,
    unreadable: false,
    dev: 0n,
    ino: 0n,
    mtimeNs: 0n,
    ctimeNs: 0n,
    size: 0n,
    directory: false,
  };
}

/** The identity of a path that could not be read — an UNKNOWN observable. */
function unreadableIdentity(path: string): FsIdentity {
  return {
    path,
    absent: false,
    unreadable: true,
    dev: 0n,
    ino: 0n,
    mtimeNs: 0n,
    ctimeNs: 0n,
    size: 0n,
    directory: false,
  };
}

function captureIdentity(path: string): FsIdentity {
  const outcome = lstatOutcome(path);
  if (outcome.kind === "present") return identityFromStat(path, outcome.stat);
  if (outcome.kind === "absent") return absentIdentity(path);
  return unreadableIdentity(path);
}

/**
 * Record an identity. LAST write wins: the identity captured at the END of
 * a build is the one the next call must still match, and a build that
 * creates a child inside a recorded directory (the cover root) must not
 * look like a change to it.
 */
function recordIdentity(state: MaskBuildState, identity: FsIdentity): void {
  state.identities.set(identity.path, identity);
}

/** Is the recorded identity still the identity of that path? */
function identityUnchanged(recorded: FsIdentity): boolean {
  // An unreadable path is an UNKNOWN observable, never "unchanged": the plan
  // is rebuilt (fail-safe direction — any doubt → rebuild). This covers both
  // sides: a plan built on an unreadable path, and a path that became
  // unreadable since the plan was built.
  if (recorded.unreadable) return false;
  const current = captureIdentity(recorded.path);
  if (current.unreadable) return false;
  if (recorded.absent) return current.absent;
  if (current.absent) return false;
  return (
    recorded.dev === current.dev &&
    recorded.ino === current.ino &&
    recorded.mtimeNs === current.mtimeNs &&
    recorded.ctimeNs === current.ctimeNs &&
    recorded.size === current.size &&
    recorded.directory === current.directory
  );
}

/** Every recorded identity still holds? (the cache's validation step) */
function identitiesUnchanged(identities: readonly FsIdentity[]): boolean {
  for (const identity of identities) {
    if (!identityUnchanged(identity)) return false;
  }
  return true;
}

/**
 * Trust check for a REUSED placeholder directory: it must be a real
 * directory (never a symlink — `lstat`, not `stat`), owned by THIS process,
 * and private (mode exactly 0700).
 *
 * A directory that fails any of these is FOREIGN: it is never reused (so
 * its content is never read as a config source and never mounted), and it
 * is never mutated (no chmod, no delete) — the caller mints a fresh private
 * directory instead. The owner comparison is skipped where the platform has
 * no `process.getuid` (non-POSIX); the mode check still applies there.
 */
function isTrustedPlaceholderDir(dir: string): boolean {
  const outcome = lstatOutcome(dir);
  if (outcome.kind !== "present" || !outcome.stat.isDirectory()) return false;
  if ((outcome.stat.mode & 0o777n) !== 0o700n) return false;
  const uid = process.getuid?.();
  if (uid !== undefined && outcome.stat.uid !== BigInt(uid)) return false;
  return true;
}

/** Per-subtree mask budget: more regular files than this flips the subtree
 *  to the empty-cover fallback instead of bloating argv toward ARG_MAX. */
const MAX_MASKED_FILES_PER_SUBTREE = 512;
/** Walk depth cap for hostile/deep fixture trees; exceeding it counts as an
 *  overflow (fallback branch), never as a silent partial mask. */
const MAX_SUBTREE_WALK_DEPTH = 8;

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** dest is at `path` (exact/file cover) or strictly inside its subtree. */
function coveredBy(dest: string, path: string, subtree: boolean): boolean {
  if (!subtree) return dest === path;
  return dest.startsWith(`${path}/`);
}

/**
 * The regular files under one subtree, sorted (deterministic argv). Returns
 * `null` when the tree exceeds the mask budget or depth cap — the caller then
 * takes the empty-cover fallback branch. Symlinks are never followed and
 * never listed: unlinking them inside the read-only subtree already meets
 * EROFS, and a link's read target resolves through mounts this layer pins
 * independently.
 *
 * The walk records the identity of every directory it traverses (the
 * directory-granularity argument in `MaskBuildState`): the file SET is
 * determined by those directories' contents, so their mtime+ctime is what
 * tells the next call that the set changed. The identity is taken from the
 * listing lstat that already happened — no extra syscall — and it is taken
 * BEFORE the directory is read, so a change that races the read is caught
 * as a difference (fail toward rebuild, never toward a stale plan).
 */
function listRegularFiles(
  root: string,
  depth: number,
  state: MaskBuildState
): string[] | null {
  if (depth > MAX_SUBTREE_WALK_DEPTH) return null;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (out.length >= MAX_MASKED_FILES_PER_SUBTREE) return null;
    const path = join(root, name);
    let stat: BigIntStats;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch {
      continue; // raced away: nothing to mask, nothing to unlink
    }
    if (stat.isDirectory()) {
      recordIdentity(state, identityFromStat(path, stat));
      const nested = listRegularFiles(path, depth + 1, state);
      if (nested === null) return null;
      out.push(...nested);
    } else if (stat.isFile()) {
      out.push(path);
    }
  }
  return out;
}

/** The cover decision for one credential-arm entry. */
type CredentialCoverPlan =
  | { readonly kind: "skip" }
  | { readonly kind: "mask-files"; readonly paths: readonly string[] }
  | { readonly kind: "fallback-cover"; readonly coverDir: string };

function relUnderSubtree(dest: string, root: string): string {
  return dest.slice(root.length + 1);
}

/**
 * Deterministic, tamper-checked fallback cover dir (empty-subtree branch):
 * carries empty placeholders at the relative paths of colliding egress dests
 * (the re-mounted masked values need their mount points UNDER the read-only
 * cover), and is abandoned for a fresh mkdtemp when a predicted path
 * deviates from the expected entry set (planted content), so the fence never
 * surfaces planted content through a predicted cover path.
 *
 * The placeholder directory is PRIVATE (mode exactly 0700) and is only
 * reused when it still is a directory THIS process owns with exactly that
 * mode: a foreign or wrongly-permissioned directory is neither reused nor
 * mutated — a fresh private directory is minted instead.
 */
function ensureFallbackCoverDir(
  coverParent: string,
  path: string,
  colliding: readonly CredentialMaskFenceBind[],
  state: MaskBuildState
): string {
  mkdirSync(coverParent, { recursive: true });
  const relToSrc = new Map(
    colliding.map((bind) => [relUnderSubtree(bind.dest, path), bind.src])
  );
  const rels = [...relToSrc.keys()].sort();
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 24);
  const deterministic = join(coverParent, digest);
  let dir = deterministic;
  if (existsSync(deterministic)) {
    if (
      !isTrustedPlaceholderDir(deterministic) ||
      !topLevelMatches(deterministic, topSegments(rels))
    ) {
      // EXIT: a foreign, wrongly-permissioned or tampered placeholder is
      // never reused and never mutated — a fresh private directory is
      // minted next to it instead. The deterministic name is kept for the
      // directory this process owns, so argv stays stable across the
      // foreground / background / rebind assemblies of one session.
      dir = mkdtempSync(join(coverParent, `${digest}-`));
    }
  } else {
    // The placeholder is private: its contents are the mount points of the
    // covered subtree and nothing outside this process may read or plant
    // them. `mode` is masked by the process umask, so the private mode is
    // asserted explicitly on the directory this process just created.
    mkdirSync(deterministic, { recursive: true, mode: 0o700 });
    chmodSync(deterministic, 0o700);
  }
  writePlaceholders(dir, rels, relToSrc, state);
  recordIdentity(state, captureIdentity(dir));
  return dir;
}

function topLevelMatches(dir: string, expected: readonly string[]): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length !== expected.length) return false;
  return expected.every(
    (name) =>
      entries.includes(name) &&
      (isRegularFile(join(dir, name)) || isDirectory(join(dir, name)))
  );
}

function topSegments(rels: readonly string[]): string[] {
  return [
    ...new Set(
      rels.map((rel) => rel.split("/")[0]!).filter((seg) => seg.length > 0)
    ),
  ].sort();
}

function writePlaceholders(
  coverDir: string,
  rels: readonly string[],
  srcByRel: ReadonlyMap<string, string>,
  state: MaskBuildState
): void {
  for (const rel of rels) {
    if (rel.length === 0) continue; // dest === subtree path: the mount point
    const placeholder = join(coverDir, rel);
    const parent = dirname(placeholder);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const src = srcByRel.get(rel);
    if (src !== undefined && isDirectory(src)) {
      mkdirSync(placeholder, { recursive: true, mode: 0o700 });
    } else if (!existsSync(placeholder)) {
      try {
        writeFileSync(placeholder, "", { flag: "wx" });
      } catch {
        // EEXIST race (parallel assembly of the same deterministic dir):
        // the file is there, which is all the mount layer needs.
      }
    }
    // The placeholder's own directory is recorded: a removed placeholder
    // mutates that directory's mtime, which is what tells the next call
    // that the plan's mount points are gone.
    recordIdentity(state, captureIdentity(parent));
  }
}

/**
 * Record the identity of one path the plan depends on: its own stat, the
 * "absent" identity when the path does not exist, or the "unreadable"
 * identity when the path could not be read at all.
 */
function recordPathIdentity(
  state: MaskBuildState,
  path: string,
  outcome: LstatOutcome
): void {
  if (outcome.kind === "present") {
    recordIdentity(state, identityFromStat(path, outcome.stat));
    return;
  }
  if (outcome.kind === "absent") {
    recordIdentity(state, absentIdentity(path));
    return;
  }
  recordIdentity(state, unreadableIdentity(path));
}

/**
 * The exact-file cover plan. It depends on ONE observable: the path is a
 * regular file right now. Its own identity is the record of that observation.
 */
function planExactCover(
  path: string,
  outcome: LstatOutcome,
  state: MaskBuildState
): CredentialCoverPlan {
  recordPathIdentity(state, path, outcome);
  return outcome.kind === "present" && outcome.stat.isFile()
    ? { kind: "mask-files", paths: [path] }
    : { kind: "skip" };
}

/**
 * The subtree cover plan: every regular file under the root is masked
 * individually, unless a colliding sentinel dest has no real mount point to
 * land on — then the empty-subtree fallback takes over.
 *
 * The subtree's dependencies are the directories the walk traverses (their
 * identities) plus, in the fallback branch, the sentinel dests' presence
 * (their identities — the walk did not run in that branch, so nothing else
 * would carry them).
 */
function planSubtreeCover(
  path: string,
  coverRoot: string,
  colliding: readonly CredentialMaskFenceBind[],
  state: MaskBuildState
): CredentialCoverPlan {
  const sentinelDestsPresent = colliding.every(
    (bind) => bind.dest === path || existsSync(bind.dest)
  );
  const files = sentinelDestsPresent ? listRegularFiles(path, 0, state) : null;
  if (files !== null) return { kind: "mask-files", paths: files };
  // The fallback branch was taken because a sentinel dest has no mount
  // point: the branch decision itself depends on that dest's presence, and
  // the walk did not run here — so the dests' own identities are recorded.
  for (const bind of colliding) {
    recordIdentity(state, captureIdentity(bind.dest));
  }
  return {
    kind: "fallback-cover",
    coverDir: ensureFallbackCoverDir(coverRoot, path, colliding, state),
  };
}

/**
 * Choose the cover branch for one entry. The per-file mask is the default;
 * the empty-subtree fallback is taken when the file budget is exceeded OR a
 * colliding sentinel dest has no real mount point to land on (the fallback's
 * placeholder dir carries it — under the read-only real subtree a missing
 * dest could not be mount-pointed, and re-emitting there would abort bwrap).
 */
function planCredentialCover(
  entry: ProtectedTargetEntry,
  coverRoot: string,
  colliding: readonly CredentialMaskFenceBind[],
  state: MaskBuildState
): CredentialCoverPlan {
  const path = entry.bindPath;
  if (path === undefined) return { kind: "skip" };
  const outcome = lstatOutcome(path);
  if (entry.rule.kind !== "subtree") {
    return planExactCover(path, outcome, state);
  }
  if (outcome.kind !== "present" || !outcome.stat.isDirectory()) {
    recordPathIdentity(state, path, outcome);
    return { kind: "skip" };
  }
  recordPathIdentity(state, path, outcome);
  return planSubtreeCover(path, coverRoot, colliding, state);
}

/**
 * The maskable credential entries of the inventory, deduplicated by path,
 * plus this assembly's materialized credential-arm matches (each a plain
 * regular file, so it takes the exact-file `/dev/null` cover).
 */
function credentialMaskEntries(
  inventory: ProtectedTargetInventory,
  materialized: readonly ProtectedTargetBindPath[]
): ProtectedTargetEntry[] {
  const seen = new Set<string>();
  const out: ProtectedTargetEntry[] = [];
  for (const entry of inventory.entries) {
    if (entry.arm !== "credential") continue;
    const path = entry.bindPath;
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    if (path === "/proc" || path.startsWith("/proc/")) continue;
    out.push(entry);
  }
  for (const match of materialized) {
    if (match.arm !== "credential" || seen.has(match.path)) continue;
    seen.add(match.path);
    out.push({
      targetClass: match.targetClass,
      arm: match.arm,
      rule: { kind: "exact", path: match.path },
      bindPath: match.path,
    });
  }
  return out;
}

/** Reuse only an intact, private regular file created in the session cover.
 * A planted symlink/hardlink or arbitrary content is never a config source. */
function hasDefaultGhConfig(directory: string): boolean {
  if (!isDirectory(directory) || !topLevelMatches(directory, ["config.yml"])) {
    return false;
  }
  const source = join(directory, "config.yml");
  if (!isRegularFile(source)) return false;
  const stat = lstatSync(source);
  return (
    stat.nlink === 1 &&
    stat.size === 3 &&
    readFileSync(source, "utf8") === "{}\n"
  );
}

/** GitHub CLI reads config.yml before it can consume the masked hosts.yml.
 * Supply defaults, never host configuration or aliases. The source is
 * session-owned and its directory is rebound read-only before it is exposed.
 * Symlinks and non-regular config paths receive no compatibility override.
 *
 * The generated directory is PRIVATE (mode exactly 0700) and is reused only
 * while it still is a directory THIS process owns with exactly that mode:
 * a foreign or tampered directory is neither reused nor mutated — the fresh
 * mkdtemp path takes over. */
function defaultGhConfigBind(
  entry: ProtectedTargetEntry,
  coverRoot: string,
  state: MaskBuildState
): CredentialMaskFenceBind | undefined {
  if (
    entry.targetClass !== "github_cli_credential" ||
    entry.rule.kind !== "subtree" ||
    entry.bindPath === undefined
  )
    return undefined;
  const dest = join(entry.bindPath, "config.yml");
  if (!isRegularFile(dest)) return undefined;
  mkdirSync(coverRoot, { recursive: true });
  const digest = createHash("sha256").update(dest).digest("hex").slice(0, 24);
  let directory = join(coverRoot, `gh-default-config-${digest}`);
  if (existsSync(directory)) {
    if (isTrustedPlaceholderDir(directory) && hasDefaultGhConfig(directory)) {
      // EXIT: intact session-owned defaults preserve the stable mount path.
      recordIdentity(state, captureIdentity(directory));
      recordIdentity(state, captureIdentity(join(directory, "config.yml")));
      return { src: join(directory, "config.yml"), dest };
    }
    // EXIT: a tampered or foreign source stays untouched; mint a fresh safe
    // view instead (mkdtemp is private and ours by construction).
    directory = mkdtempSync(join(coverRoot, "gh-default-config-"));
  } else {
    // `mode` is masked by the process umask, so the private mode is asserted
    // explicitly on the directory this process just created.
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const src = join(directory, "config.yml");
  writeFileSync(src, "{}\n", { mode: 0o600, flag: "wx" });
  recordIdentity(state, captureIdentity(directory));
  recordIdentity(state, captureIdentity(src));
  return { src, dest };
}

/** Tokens masking one planned entry: per-file `/dev/null` covers or the
 *  empty-subtree fallback. Deduplicated across entries via `masked`; every
 *  dest that actually reaches argv is appended to `emittedExactFileMasks`,
 *  the observable list the EBUSY boundary feedback correlates against
 *  (`protected-target-feedback.ts`). The dedupe set IS the correlation set's
 *  source of truth: a file skipped here emitted no token, so it can never be
 *  named in guidance either. */
function coverTokensForPlan(
  plan: CredentialCoverPlan,
  path: string,
  masked: Set<string>,
  emittedExactFileMasks: string[]
): string[] {
  if (plan.kind === "fallback-cover") {
    return ["--ro-bind", plan.coverDir, path];
  }
  if (plan.kind !== "mask-files") return [];
  const tokens: string[] = [];
  for (const file of plan.paths) {
    if (masked.has(file)) continue;
    masked.add(file);
    emittedExactFileMasks.push(file);
    tokens.push("--ro-bind", "/dev/null", file);
  }
  return tokens;
}

/** The `/dev/null` mask dests one assembly emitted, in argv order.
 *
 * EVERY per-file mask is listed, not only the ones an `exact` rule produced:
 * a subtree seed (`.ssh`, `.aws`, `.gnupg`) contributes one mask per regular
 * file it discovered, and those files are the majority of the emitted set.
 *
 * Deliberately NOT included:
 *   - the empty-subtree fallback bind (`--ro-bind <coverDir> <subtree>`) — a
 *     directory mount, not a per-file mask; an unlink inside it meets EROFS,
 *     not EBUSY;
 *   - the egress sentinel deny covers (`/dev/null` at a credential path
 *     assembled in `egress/credential-mint.ts`) — a separate layer, emitted
 *     BELOW the boundary block in `writableSegments` and re-emitted above the
 *     masks as a masked-value rebind, not a fresh per-file mask of this
 *     assembly. Naming them here would attribute a refusal to a layer this
 *     assembly did not mask.
 */
export interface CredentialReadMaskArgsResult {
  readonly args: string[];
  readonly exactFileMaskPaths: readonly string[];
}

/**
 * The credential read-mask mount block for one fence assembly, plus the
 * observable `/dev/null` mask dests it emitted. Existence decisions mirror the
 * protected-write layer (absent source → no token → ordinary ENOENT read),
 * placement and the kernel-limit checks stay in `createBwrapFence`.
 *
 * The mask-path list exists so the EBUSY boundary refusal
 * (`protected-target-feedback.ts`) can be correlated against the masks THIS
 * assembly actually emitted — the same one-snapshot discipline as the EROFS
 * guidance's inventory. Without it an unrelated "Device or resource busy"
 * anywhere on the host would be relabelled a protected-target refusal.
 *
 * This entry point computes the plan FRESH on every call. A session that
 * wants the plan reused passes a `MaskPlanCache` holder to the fence
 * factory (`BwrapFenceOptions.maskCache`); with no holder the behaviour is
 * exactly this function's.
 */
export function credentialReadMaskArgs(
  args: CredentialReadMaskArgs
): CredentialReadMaskArgsResult {
  return buildMaskPlan(args).result;
}

/** One built plan plus the fs identities it depends on. */
interface BuiltMaskPlan {
  readonly result: CredentialReadMaskArgsResult;
  readonly identities: readonly FsIdentity[];
}

/**
 * Build the mask plan for one assembly, recording the fs identities the
 * plan depends on (see `MaskBuildState`).
 */
function buildMaskPlan(args: CredentialReadMaskArgs): BuiltMaskPlan {
  const state: MaskBuildState = { identities: new Map() };
  const binds = args.egressBinds ?? [];
  const coverRoot = join(args.sessionTmpRoot, COVER_ROOT_NAME);
  const covers: string[] = [];
  const rebinds: string[] = [];
  const masked = new Set<string>();
  const exactFileMaskPaths: string[] = [];
  for (const entry of credentialMaskEntries(
    args.inventory,
    args.materializedTargets ?? []
  )) {
    const path = entry.bindPath;
    if (path === undefined) continue;
    const subtree = entry.rule.kind === "subtree";
    const colliding = binds.filter((bind) =>
      coveredBy(bind.dest, path, subtree)
    );
    const defaultConfig = defaultGhConfigBind(entry, coverRoot, state);
    if (defaultConfig !== undefined) {
      // The source must not be writable through its session-scratch spelling.
      rebinds.push("--ro-bind", coverRoot, coverRoot);
      // Explicit egress overrides retain their existing final-mount priority.
      colliding.unshift(defaultConfig);
    }
    const plan = planCredentialCover(entry, coverRoot, colliding, state);
    covers.push(...coverTokensForPlan(plan, path, masked, exactFileMaskPaths));
    // Re-emit the sentinel binds above the masks so the masked value stays
    // reachable (coordination, not contradiction). Under the fallback cover
    // the placeholder dir already carries each dest's mount point.
    for (const bind of colliding) {
      rebinds.push("--ro-bind", bind.src, bind.dest);
    }
  }
  // The cover root's own identity is captured LAST: the build creates
  // children inside it (the gh default-config dir, the fallback cover dir),
  // and those creations mutate the root's mtime. Capturing after them keeps
  // the build's own writes from looking like a change on the next call —
  // which would rebuild the plan on every call, the exact cost the cache
  // exists to remove.
  recordIdentity(state, captureIdentity(coverRoot));
  return {
    result: {
      args: [...covers, ...rebinds],
      exactFileMaskPaths: Object.freeze(exactFileMaskPaths),
    },
    identities: [...state.identities.values()],
  };
}

/**
 * The cache key: a digest of the mask plan's REAL inputs.
 *
 * The plan depends on (a) the inventory's credential-arm entries (resolved
 * path, rule kind, target class), (b) this assembly's materialized
 * name-pattern matches (path + class), (c) the egress bind table (src +
 * dest — a bind whose dest lands under a covered subtree changes the cover
 * branch), and (d) the session tmp root (the cover root lives under it). A
 * change in any of them yields a different digest → a cache miss → the plan
 * is rebuilt, so a changed inventory or a changed materialized-target set can
 * never be served from a stale plan.
 *
 * There is deliberately NO secret-registry version in this key: the secret
 * registry is a VALUE map (command restore + output mask) and never
 * influences which paths get masked — there is no runtime credential-path
 * registry to version. The fs identities cover the rest.
 */
function maskPlanKey(args: CredentialReadMaskArgs): string {
  const hash = createHash("sha256");
  hash.update("credential-read-mask/v1\n");
  hash.update(`sessionTmpRoot=${args.sessionTmpRoot}\n`);
  for (const entry of credentialMaskEntries(
    args.inventory,
    args.materializedTargets ?? []
  )) {
    hash.update(
      `entry=${entry.bindPath ?? ""}|${entry.rule.kind}|${entry.targetClass}\n`
    );
  }
  for (const bind of args.egressBinds ?? []) {
    hash.update(`bind=${bind.src}|${bind.dest}\n`);
  }
  return hash.digest("hex");
}

/** One cached plan: its key, its result, and the fs identities it holds on. */
interface MaskCacheEntry {
  readonly key: string;
  readonly result: CredentialReadMaskArgsResult;
  readonly identities: readonly FsIdentity[];
}

/**
 * A session-scoped holder for the credential read-mask plan.
 *
 * NOT a module-level cache: the holder is created once per bash-tool
 * instance (i.e. per session) and passed explicitly down to the fence
 * factory, so two sessions never share a plan and no plan outlives the
 * session that produced it.
 */
export interface MaskPlanCache {
  /**
   * The mask plan for these inputs: the cached plan when it still holds
   * (same key AND every recorded fs identity unchanged), a freshly built
   * one otherwise.
   */
  readonly resolve: (
    args: CredentialReadMaskArgs
  ) => CredentialReadMaskArgsResult;
}

/**
 * A fresh, empty mask-plan holder. One per session (the bash tool's factory
 * closure), never a module-level singleton.
 *
 * The holder caches the PLAN only — never the inventory and never the
 * materialized targets. Those two are re-derived per assembly on purpose:
 * the inventory carries the one-shot awaited name-rule pre-walk (caching it
 * would silently drop that walk into the blocking synchronous fallback and
 * break its one-shot contract), and the materialized targets are what make
 * "a newly appearing credential file is protected on the next call" true —
 * a cached copy would keep serving the old match set. The plan's own
 * invalidation (the fs identities) is what keeps a stale file set from
 * being reused.
 */
export function createMaskPlanCache(): MaskPlanCache {
  let cached: MaskCacheEntry | undefined;
  return {
    resolve: (args: CredentialReadMaskArgs): CredentialReadMaskArgsResult => {
      const key = maskPlanKey(args);
      if (
        cached !== undefined &&
        cached.key === key &&
        identitiesUnchanged(cached.identities)
      ) {
        return cached.result;
      }
      const built = buildMaskPlan(args);
      cached = {
        key,
        result: built.result,
        identities: built.identities,
      };
      return built.result;
    },
  };
}
