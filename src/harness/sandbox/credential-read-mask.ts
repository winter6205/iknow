import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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
 */
function listRegularFiles(root: string, depth: number): string[] | null {
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
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue; // raced away: nothing to mask, nothing to unlink
    }
    if (stat.isDirectory()) {
      const nested = listRegularFiles(path, depth + 1);
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
 */
function ensureFallbackCoverDir(
  coverParent: string,
  path: string,
  colliding: readonly CredentialMaskFenceBind[]
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
      !isDirectory(deterministic) ||
      !topLevelMatches(deterministic, topSegments(rels))
    ) {
      dir = mkdtempSync(join(coverParent, `${digest}-`));
    }
  } else {
    mkdirSync(deterministic, { recursive: true });
  }
  writePlaceholders(dir, rels, relToSrc);
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
  srcByRel: ReadonlyMap<string, string>
): void {
  for (const rel of rels) {
    if (rel.length === 0) continue; // dest === subtree path: the mount point
    const placeholder = join(coverDir, rel);
    mkdirSync(dirname(placeholder), { recursive: true });
    const src = srcByRel.get(rel);
    if (src !== undefined && isDirectory(src)) {
      mkdirSync(placeholder, { recursive: true });
    } else if (!existsSync(placeholder)) {
      try {
        writeFileSync(placeholder, "", { flag: "wx" });
      } catch {
        // EEXIST race (parallel assembly of the same deterministic dir):
        // the file is there, which is all the mount layer needs.
      }
    }
  }
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
  colliding: readonly CredentialMaskFenceBind[]
): CredentialCoverPlan {
  const path = entry.bindPath;
  if (path === undefined) return { kind: "skip" };
  if (entry.rule.kind !== "subtree") {
    return isRegularFile(path)
      ? { kind: "mask-files", paths: [path] }
      : { kind: "skip" };
  }
  if (!isDirectory(path)) return { kind: "skip" };
  const sentinelDestsPresent = colliding.every(
    (bind) => bind.dest === path || existsSync(bind.dest)
  );
  const files = sentinelDestsPresent ? listRegularFiles(path, 0) : null;
  if (files !== null) return { kind: "mask-files", paths: files };
  return {
    kind: "fallback-cover",
    coverDir: ensureFallbackCoverDir(coverRoot, path, colliding),
  };
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
 */
export function credentialReadMaskArgs(
  args: CredentialReadMaskArgs
): CredentialReadMaskArgsResult {
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
    const plan = planCredentialCover(entry, coverRoot, colliding);
    covers.push(
      ...coverTokensForPlan(plan, path, masked, exactFileMaskPaths)
    );
    // Re-emit the sentinel binds above the masks so the masked value stays
    // reachable (coordination, not contradiction). Under the fallback cover
    // the placeholder dir already carries each dest's mount point.
    for (const bind of colliding) {
      rebinds.push("--ro-bind", bind.src, bind.dest);
    }
  }
  return {
    args: [...covers, ...rebinds],
    exactFileMaskPaths: Object.freeze(exactFileMaskPaths),
  };
}
