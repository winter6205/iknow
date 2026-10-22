import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ToolExecutionError } from "../errors.js";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
} from "./fs-policy.js";

/**
 * Protected-target inventory (specs/effect-boundary-protection.md): the one
 * resolved-path SSOT of filesystem targets and credential sources that must
 * stay protected across languages. The hard wall's text roster and the fence's
 * protected-target layers are two consumers of this structure — the mount
 * layer asks "which bind paths do I emit", the read side asks "is this path a
 * credential source of which class" — and neither maintains its own copy.
 *
 * Targets are held RESOLVED (the operator's decision on Open Question 1):
 * home-relative seeds are expanded against the inventory's resolved home so
 * membership is a pure comparable-path check, never a command-text substring.
 * The structure is pure data + functions: no existence probing here (an
 * absent host target is a mount-assembly concern, skipped with a typed
 * warning), and an empty/blank target is a typed fail-loud at assembly —
 * never a silently dropped entry, never a half-formed bind token.
 */

/**
 * Which consumer arm a target serves. `credential` marks sources whose read
 * side must resolve to masked-value-or-nothing; both arms live in the same
 * entries array — the arm is a field of one structure, not a parallel list.
 */
export type ProtectedTargetArm = "credential" | "filesystem";

/** Stable class id used by refusal wording ("named from the inventory"). */
export type ProtectedTargetClassId =
  | "ssh_key_material"
  | "cloud_credential"
  | "gpg_key_material"
  | "github_cli_credential"
  | "kube_config"
  | "docker_config"
  | "netrc_credential"
  | "dotenv_file"
  | "tls_key_material"
  | "process_environ"
  | "system_identity_file"
  | "system_readonly_tree";

/**
 * Basename family matched under a resolved root subtree. `extension` /
 * `stem` / `basename` are the resolved-path forms of the roster's suffix
 * arms (`\\.pem$`, `\\.env\\.`, `id_rsa`); a name pattern has no single bind
 * path, which is why it is a rule shape and not a fabricated file entry.
 */
export type ProtectedNamePattern =
  | { readonly shape: "basename"; readonly basename: string }
  | { readonly shape: "stem"; readonly stem: string }
  | { readonly shape: "extension"; readonly extension: string };

export type ProtectedTargetRule =
  /** the target and everything below it (a resolved directory subtree) */
  | { readonly kind: "subtree"; readonly path: string }
  /** the target exactly (a resolved file path) */
  | { readonly kind: "exact"; readonly path: string }
  /** a basename family under a resolved root, exclusive of the root itself */
  | {
      readonly kind: "name";
      readonly root: string;
      readonly pattern: ProtectedNamePattern;
    };

export interface ProtectedTargetEntry {
  readonly targetClass: ProtectedTargetClassId;
  readonly arm: ProtectedTargetArm;
  readonly rule: ProtectedTargetRule;
  /**
   * The single mount source when the rule has one (subtree / exact), or
   * `undefined` for basename families. `protectedTargetRoBindArgs` emits only
   * from this field, so a rule without a comparable path can never become a
   * half-formed bind pair.
   */
  readonly bindPath: string | undefined;
}

/** Caller-supplied target (e.g. a config value) resolved like the seeds. */
export interface ProtectedTargetExtra {
  readonly targetClass: string;
  readonly arm: ProtectedTargetArm;
  readonly path: string;
}

export interface ProtectedTargetInventoryOptions {
  /** Home root the seed roster is expanded against. Blank → typed fail-loud. */
  readonly home: string;
  /**
   * The name-pattern scan scope (specs/effect-boundary-protection.md "Scan
   * scope"): the workspace directory the roster's name rules enumerate at each
   * fence assembly — ONE root, shared by both fs modes, never derived from
   * global mode's `/` mounts, `HOME`, or a runtime tmp. Blank / absent /
   * not-a-directory → typed fail-loud at assembly, never a silently skipped
   * scan arm.
   *
   * The check is the inventory's own because `resolveWorkspaceRoot` verifies
   * existence only and its cwd arm verifies nothing — a caller that passes a
   * file path would otherwise yield a zero-match "all clear" fence.
   */
  readonly scanRoot?: string;
  readonly extraTargets?: readonly ProtectedTargetExtra[];
}

export interface ProtectedTargetInventory {
  readonly entries: readonly ProtectedTargetEntry[];
  /**
   * The most specific entry covering `path`, or `undefined`. Blank input is
   * a typed fail-loud: answering "not protected" for an unresolvable query
   * would be the silent-drop hazard this structure exists to close.
   */
  protectedTargetFor(path: string): ProtectedTargetEntry | undefined;
  isProtected(path: string): boolean;
}

const RULE_PRIORITY: Record<ProtectedTargetRule["kind"], number> = {
  exact: 3,
  name: 2,
  subtree: 1,
};

function failLoud(detail: string): never {
  throw new ToolExecutionError(`protected-targets: ${detail}`);
}

/** Expand `~` / `$HOME` leads against the inventory home. */
function expandHome(path: string, home: string): string {
  if (path === "~" || path === "$HOME") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  if (path.startsWith("$HOME/")) return `${home}/${path.slice(6)}`;
  return path;
}

/** Resolve a query/config path to its comparable absolute target form. */
function resolveTarget(path: string, home: string): string {
  const expanded = expandHome(path, home);
  const resolved = resolve(expanded);
  if (resolved.length > 1 && resolved.endsWith("/"))
    return resolved.slice(0, -1);
  return resolved;
}

function assertNonBlank(path: string, role: string): void {
  if (path.trim().length === 0) {
    failLoud(
      `${role} is blank; refusing to build an inventory with an unresolvable target`
    );
  }
}

function isInside(resolved: string, root: string): boolean {
  return resolved.startsWith(`${root}/`);
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function namePatternHits(
  basename: string,
  pattern: ProtectedNamePattern
): boolean {
  switch (pattern.shape) {
    case "basename":
      return basename === pattern.basename;
    case "stem":
      // the roster's pair of arms for one dotted name: `\.env$` (basename
      // ends with it) and `\.env\.` (basename opens with it + a dot)
      return (
        basename === pattern.stem ||
        basename.startsWith(`${pattern.stem}.`) ||
        basename.endsWith(pattern.stem)
      );
    case "extension":
      return (
        basename.endsWith(pattern.extension) &&
        basename.length > pattern.extension.length
      );
  }
}

function entryCovers(entry: ProtectedTargetEntry, resolved: string): boolean {
  const { rule } = entry;
  switch (rule.kind) {
    case "exact":
      return resolved === rule.path;
    case "subtree":
      return resolved === rule.path || isInside(resolved, rule.path);
    case "name":
      return (
        isInside(resolved, rule.root) &&
        namePatternHits(basenameOf(resolved), rule.pattern)
      );
  }
}

/** Longer covering path = narrower subtree = more specific; ties follow seeds. */
function specificity(entry: ProtectedTargetEntry): number {
  const base = entry.rule.kind === "name" ? entry.rule.root : entry.rule.path;
  return RULE_PRIORITY[entry.rule.kind] * 10000 + base.length;
}

function makeEntry(
  targetClass: string,
  arm: ProtectedTargetArm,
  rule: ProtectedTargetRule
): ProtectedTargetEntry {
  const bindPath = rule.kind === "name" ? undefined : rule.path;
  return Object.freeze({
    targetClass: targetClass as ProtectedTargetClassId,
    arm,
    rule: Object.freeze(rule),
    bindPath,
  });
}

/** Seed roster shapes: a path expanded against the home, or a name family. */
type SeedSpec =
  | {
      readonly kind: "subtree" | "exact";
      readonly targetClass: ProtectedTargetClassId;
      readonly segments: readonly string[];
    }
  | {
      readonly kind: "name";
      readonly targetClass: ProtectedTargetClassId;
      readonly pattern: ProtectedNamePattern;
    };

// Credential arm — the shell roster's names in resolved-path form.
const CREDENTIAL_SEEDS: readonly SeedSpec[] = Object.freeze([
  { kind: "subtree", targetClass: "ssh_key_material", segments: [".ssh"] },
  { kind: "subtree", targetClass: "cloud_credential", segments: [".aws"] },
  { kind: "subtree", targetClass: "gpg_key_material", segments: [".gnupg"] },
  {
    kind: "subtree",
    targetClass: "github_cli_credential",
    segments: [".config", "gh"],
  },
  { kind: "subtree", targetClass: "kube_config", segments: [".kube"] },
  {
    kind: "exact",
    targetClass: "docker_config",
    segments: [".docker", "config.json"],
  },
  { kind: "exact", targetClass: "netrc_credential", segments: [".netrc"] },
  {
    kind: "exact",
    targetClass: "process_environ",
    segments: ["/proc/self/environ"],
  },
  {
    kind: "name",
    targetClass: "dotenv_file",
    pattern: { shape: "stem", stem: ".env" },
  },
  {
    kind: "name",
    targetClass: "tls_key_material",
    pattern: { shape: "extension", extension: ".pem" },
  },
  {
    kind: "name",
    targetClass: "tls_key_material",
    pattern: { shape: "extension", extension: ".key" },
  },
  {
    kind: "name",
    targetClass: "tls_key_material",
    pattern: { shape: "extension", extension: ".p12" },
  },
  {
    kind: "name",
    targetClass: "ssh_key_material",
    pattern: { shape: "basename", basename: "id_rsa" },
  },
  {
    kind: "name",
    targetClass: "ssh_key_material",
    pattern: { shape: "basename", basename: "id_ed25519" },
  },
]);

// Filesystem arm — identity files; the system read-only prefix lists follow.
const FILESYSTEM_SEEDS: readonly SeedSpec[] = Object.freeze([
  {
    kind: "exact",
    targetClass: "system_identity_file",
    segments: ["/etc/passwd"],
  },
  {
    kind: "exact",
    targetClass: "system_identity_file",
    segments: ["/etc/shadow"],
  },
]);

function seedEntries(
  home: string,
  nameScanRoot: string
): ProtectedTargetEntry[] {
  const at = (...segments: string[]): string => resolve(home, ...segments);
  const expand = (arm: ProtectedTargetArm, seeds: readonly SeedSpec[]) =>
    seeds.map((seed) =>
      seed.kind === "name"
        ? makeEntry(seed.targetClass, arm, {
            kind: "name",
            root: nameScanRoot,
            pattern: seed.pattern,
          })
        : makeEntry(seed.targetClass, arm, {
            kind: seed.kind,
            path: at(...seed.segments),
          })
    );
  return [
    ...expand("credential", CREDENTIAL_SEEDS),
    ...expand("filesystem", FILESYSTEM_SEEDS),
    ...READ_ONLY_SYSTEM_PATHS.map((path) =>
      makeEntry("system_readonly_tree", "filesystem", { kind: "subtree", path })
    ),
    ...OPTIONAL_HOST_RO_PREFIXES.map((path) =>
      makeEntry("system_readonly_tree", "filesystem", { kind: "subtree", path })
    ),
  ];
}

/**
 * The name-pattern scan scope, resolved and validated ONCE per inventory.
 *
 * The scan is fail-closed in the SC7(a) direction: a blank, absent, or
 * non-directory root refuses at assembly with a typed error rather than
 * assembling a fence whose name arm silently matched nothing. Existence alone
 * is not enough — `resolveWorkspaceRoot`'s `assertAbsoluteExists` accepts a
 * regular file, and a file as "scan scope" would enumerate zero entries and
 * report the fence as fully materialized.
 */
function resolveScanRoot(scanRoot: string | undefined): string {
  if (scanRoot === undefined) {
    failLoud(
      "no name-pattern scan scope was supplied; refusing to assemble an inventory whose name rules (`*.pem` / `id_rsa` / `.env*`) protect nothing (the scope is the workspace directory, not HOME)"
    );
  }
  assertNonBlank(scanRoot, "name-pattern scan root");
  const resolved = resolveTarget(scanRoot, scanRoot);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    failLoud(
      `name-pattern scan root ${resolved} does not exist; refusing to assemble an inventory whose name rules would enumerate nothing (refused, not skipped)`
    );
  }
  if (!stats.isDirectory()) {
    failLoud(
      `name-pattern scan root ${resolved} is not a directory; refusing to assemble an inventory whose name rules would enumerate nothing (refused, not skipped)`
    );
  }
  return resolved;
}

/**
 * Assemble the inventory for one host home. Every seed and every caller-supplied
 * target is validated and resolved at assembly: a blank home or blank extra
 * target throws `ToolExecutionError` (the bwrap empty-contract-root
 * discipline) — the inventory can never hold or lose an unresolvable entry.
 *
 * The name-pattern scan scope (`scanRoot`, the workspace directory) is
 * validated here for the same reason: an absent or non-directory scope is a
 * typed refusal, never a fence that assembles with the name arm missing while
 * reporting success.
 */
export function createProtectedTargetInventory(
  options: ProtectedTargetInventoryOptions
): ProtectedTargetInventory {
  assertNonBlank(options.home, "home");
  const home = resolveTarget(options.home, options.home);
  const scanRoot = resolveScanRoot(options.scanRoot);
  const extras = (options.extraTargets ?? []).map((extra) => {
    assertNonBlank(extra.path, `extra target ${extra.targetClass}`);
    return makeEntry(extra.targetClass, extra.arm, {
      kind: "subtree",
      path: resolveTarget(extra.path, home),
    });
  });
  const entries: readonly ProtectedTargetEntry[] = Object.freeze([
    ...seedEntries(home, scanRoot),
    ...extras,
  ]);

  function protectedTargetFor(path: string): ProtectedTargetEntry | undefined {
    assertNonBlank(path, "membership query");
    const resolved = resolveTarget(path, home);
    let best: ProtectedTargetEntry | undefined;
    let bestScore = -1;
    for (const entry of entries) {
      if (!entryCovers(entry, resolved)) continue;
      const score = specificity(entry);
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  return Object.freeze({
    entries,
    protectedTargetFor,
    isProtected: (path: string): boolean =>
      protectedTargetFor(path) !== undefined,
  });
}

/**
 * One mountable bind path with its class attribution: the per-entry form the
 * mount layer consumes so a skip warning can name the class, not just the
 * path, and so the write block can tell a credential-arm target (which also
 * takes a per-file read mask) from a plain filesystem-arm one.
 */
export interface ProtectedTargetBindPath {
  readonly path: string;
  readonly targetClass: ProtectedTargetClassId;
  readonly arm: ProtectedTargetArm;
}

/**
 * The inventory's mountable bind paths in entry order, deduplicated by path.
 * Existence filtering and last-mount-wins placement stay the mount layer's
 * concern; this guarantees every item carries a non-blank resolved path and a
 * class, so no entry can surface as a half-formed bind pair or a path-only
 * warning without attribution.
 */
export function protectedTargetBindPaths(
  inventory: ProtectedTargetInventory
): readonly ProtectedTargetBindPath[] {
  const seen = new Set<string>();
  const out: ProtectedTargetBindPath[] = [];
  for (const entry of inventory.entries) {
    const path = entry.bindPath;
    if (path === undefined || seen.has(path)) continue;
    if (path.trim().length === 0) {
      failLoud(
        `entry ${entry.targetClass} resolved to a blank bind path; refusing to emit a half-formed --ro-bind pair`
      );
    }
    seen.add(path);
    out.push({ path, targetClass: entry.targetClass, arm: entry.arm });
  }
  return out;
}

/**
 * The `--ro-bind` token block for the inventory's mountable targets, in entry
 * order, deduplicated: one complete `--ro-bind <src> <src>` triple per bind
 * path. Existence filtering and last-mount-wins placement are the mount
 * layer's concern; this builder guarantees only that no entry can surface as
 * a half-formed pair.
 */
export function protectedTargetRoBindArgs(
  inventory: ProtectedTargetInventory
): readonly string[] {
  return protectedTargetBindPaths(inventory).flatMap(({ path }) => [
    "--ro-bind",
    path,
    path,
  ]);
}

/* ------------------------------------------------------------------------- *
 * Name-pattern materialization (specs/effect-boundary-protection.md "Name
 * patterns: materialization at each fence assembly", issue #1155).
 *
 * A name rule has no bind path of its own, so without this step the roster's
 * `*.pem` / `id_rsa` / `.env*` arms classify membership and protect NOTHING at
 * the kernel layer. Materialization resolves them to the concrete matches
 * present under the declared root AT THIS ASSEMBLY, and every match that has
 * no ancestor coverage becomes an effective physical target the mount layer
 * already knows how to bind.
 *
 * Membership is not coverage: a match already behind an ancestor concrete
 * rule's `--ro-bind` (`~/.ssh/id_rsa` under the `.ssh` subtree) gains nothing
 * from a bind of its own and must not disturb the ancestor's mount, so it is
 * reported as covered rather than bound a second time.
 * ------------------------------------------------------------------------- */

/** Walk-depth bound, same traversal idiom as the read mask's per-subtree walk
 *  (`MAX_SUBTREE_WALK_DEPTH`); exceeding it is a typed refusal naming the bound,
 *  never a silently truncated enumeration. */
const MAX_MATERIALIZE_WALK_DEPTH = 64;
/** Entries one materialization pass may enumerate. Every seed name rule shares
 *  ONE root, so this bounds a single walk of that root, not one walk per rule.
 *  Sized above a real developer home (which runs to several hundred thousand
 *  entries across caches and checkouts): the bound's purpose is to stop a
 *  runaway tree, and a bound that refuses ordinary homes would trade the
 *  product's usability for a limit no operator would ever hit deliberately. */
const MAX_MATERIALIZE_ENTRIES = 2_000_000;

function failMaterialization(detail: string): never {
  throw new ToolExecutionError(`protected-targets: materialization ${detail}`);
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** Bounds a materialization pass; the defaults are the production limits, and
 *  the mount layer exposes them so the fixture surface can exercise the
 *  limit-exhaustion refusal without a 20k-entry tree. */
export interface ProtectedTargetMaterializationLimits {
  readonly maxWalkDepth: number;
  readonly maxEntries: number;
}

const DEFAULT_LIMITS: ProtectedTargetMaterializationLimits = Object.freeze({
  maxWalkDepth: MAX_MATERIALIZE_WALK_DEPTH,
  maxEntries: MAX_MATERIALIZE_ENTRIES,
});

/**
 * One enumerated object identity (`dev`/`ino` at discovery). Protection is
 * scoped to the object the roster enumerated, not to a pathname that happens
 * to be spelled correctly, so the identity is what the bind is authorized for.
 */
export interface MaterializedTargetIdentity {
  readonly dev: bigint | number;
  readonly ino: bigint | number;
}

interface DiscoveredObjectIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface DiscoveredMatchIdentity {
  /** Identity at the matching pathname, including a symlink itself. */
  readonly path: DiscoveredObjectIdentity | undefined;
  /** Identity of the resolved bind source, when it was a regular file. */
  readonly bind: DiscoveredObjectIdentity | undefined;
}

export interface ProtectedTargetMaterialization {
  /** Present, in-scope matches with no ancestor coverage — bind each one. */
  readonly targets: readonly ProtectedTargetBindPath[];
  /** Matches whose physical protection already comes from an ancestor
   *  concrete rule; reported for observability, never given a second bind. */
  readonly coveredByAncestor: readonly ProtectedTargetBindPath[];
  /** Matches that vanished between enumeration and identity — the
   *  absent-target warn direction, so the mount layer can diagnose them. */
  readonly vanished: readonly ProtectedTargetBindPath[];
  /** Object identities of `targets`, positionally aligned with `targets`. */
  readonly identities: readonly MaterializedTargetIdentity[];
}

/**
 * Re-check the enumerated identities right before the binds are composed.
 * A match whose `dev`/`ino` changed since discovery was swapped for a
 * different object, which is the TOCTOU class: a typed refusal, never an
 * accept-and-bind.
 */
export function assertMaterializedTargetsUnchanged(
  result: ProtectedTargetMaterialization
): void {
  for (let i = 0; i < result.targets.length; i += 1) {
    const target = result.targets[i]!;
    const identity = result.identities[i]!;
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(target.path);
    } catch {
      // EXIT: a probe that cannot answer is treated as "no object here", which
      // the check below refuses. Falling through instead would bind a target
      // whose identity this pass could not confirm.
      current = undefined;
    }
    if (
      current === undefined ||
      !current.isFile() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      failMaterialization(
        `bind source ${target.path} was replaced or vanished between enumeration and bind; refusing (protection is scoped to an enumerated object identity, not to a pathname)`
      );
    }
  }
}

/** One name-rule match found by the walk, before any bind decision. */
interface ProtectedTargetMatch {
  readonly entry: ProtectedTargetEntry;
  readonly path: string;
  discovered?: DiscoveredMatchIdentity;
}

type MatchesByRoot = Map<string, ProtectedTargetMatch[]>;

/** The walk's only request: read this directory, hand the outcome back. */
interface WalkReadRequest {
  readonly dir: string;
  readonly root: string;
}

interface WalkState {
  visited: number;
  /** This root's hit list, filled by the enumerator and read back by
   *  `openWalk`'s caller. Carried in the state so the per-item work stays a
   *  helper call instead of a fifth positional parameter. */
  readonly hits: ProtectedTargetMatch[];
  readonly captureMatch?: (match: ProtectedTargetMatch) => void;
}

/** Identity and change markers captured immediately before an awaited read. */
interface WalkedDirectory {
  readonly path: string;
  readonly root: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  /** What this read contributed to the walk's entry accounting, charged forward
   *  by `consumedEntriesByRoot` so revalidation starts from what the walk already
   *  spent. It is a SPEND record, not a ceiling: a later listing longer than this
   *  number is not itself a refusal (see `readChangedDirectory`). */
  readonly entryCount: number;
}

/**
 * A directory read expressed as data instead of as a syscall: the walk asks, the
 * driver answers with either the entries or the error. The refusal decision
 * stays in the generator, which is what lets the synchronous and the awaited
 * walk share one enumerator — `specs/effect-boundary-protection.md` pins the
 * enumeration contract (scope, coverage, bounds, fail-closed direction) and
 * deliberately not the enumerator's threading.
 */
type WalkReadOutcome =
  | {
      readonly items: readonly Dirent[];
      readonly directory?: WalkedDirectory;
    }
  | {
      readonly error: unknown;
      /** Only the unchanged synchronous walk treats a missing root as empty. */
      readonly missingRootIsEmpty: boolean;
    }
  | { readonly notDirectory: true };

type WalkDriver = Generator<WalkReadRequest, void, WalkReadOutcome>;

function readDirectorySync(dir: string): WalkReadOutcome {
  try {
    return { items: readdirSync(dir, { withFileTypes: true }) };
  } catch (error) {
    return { error, missingRootIsEmpty: true };
  }
}

async function readDirectoryAwaited(
  dir: string,
  root: string
): Promise<WalkReadOutcome> {
  let stats: BigIntStats;
  try {
    // Capture the path's own identity (without following a substituted symlink)
    // immediately before the real read. Nanosecond timestamps catch restored
    // mtimes through ctimeNs.
    stats = lstatSync(dir, { bigint: true });
  } catch (error) {
    return { error, missingRootIsEmpty: false };
  }
  if (!stats.isDirectory()) return { notDirectory: true };
  try {
    // `withFileTypes` gets the entry kind from the directory read itself: a
    // stat per entry on a real home costs several times the whole walk.
    const items = await readdir(dir, { withFileTypes: true });
    return {
      items,
      directory: {
        path: dir,
        root,
        dev: stats.dev,
        ino: stats.ino,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
        entryCount: items.length,
      },
    };
  } catch (error) {
    return { error, missingRootIsEmpty: false };
  }
}

/** Runs the walk without ever releasing the thread — the fence's own path. */
function driveWalkSync(driver: WalkDriver): void {
  let step = driver.next();
  while (!step.done) {
    step = driver.next(readDirectorySync(step.value.dir));
  }
}

/**
 * Runs the walk one awaited read per directory, so the thread returns to the
 * event loop between directories. Under the TUI this is the difference between
 * a turn that renders and a whole-UI freeze: the renderer, the keystroke echo
 * and the walk share the single Bun thread.
 */
async function driveWalkAwaited(
  driver: WalkDriver,
  directories: WalkedDirectory[]
): Promise<void> {
  let step = driver.next();
  while (!step.done) {
    const read = await readDirectoryAwaited(step.value.dir, step.value.root);
    if ("items" in read && read.directory !== undefined) {
      directories.push(read.directory);
    }
    step = driver.next(read);
  }
}

/**
 * The entries of one answered directory read, or the typed refusal of a read
 * that could not be answered. Only the unchanged synchronous walk treats root
 * ENOENT as an empty listing. An awaited walk must refuse a missing root,
 * because disappearance during the asynchronous scan is an incomplete snapshot.
 * Anywhere else the subtree could not be enumerated, so matches may exist in
 * it: refusing is the only fail-closed direction, never "protect the ones we
 * reached".
 */
function directoryItems(
  read: WalkReadOutcome,
  dir: string,
  root: string,
  depth: number
): readonly Dirent[] {
  if ("items" in read) return read.items;
  if ("notDirectory" in read) {
    failMaterialization(
      `walk path ${dir} under root ${root} is no longer a directory; refusing`
    );
  }
  const code = errorCodeOf(read.error);
  // EXIT: the unchanged synchronous walk's historical "missing root is an empty
  // listing" answer. `missingRootIsEmpty` is only ever set by that driver, so
  // the awaited walk cannot land here and a root that vanished mid-scan stays
  // the refusal above.
  if (code === "ENOENT" && depth === 0 && read.missingRootIsEmpty) return [];
  failMaterialization(
    `could not enumerate ${dir} under root ${root} (${code}); refusing because an unenumerated subtree may hold matches`
  );
}

/**
 * One shared walk of the name rules' common root, classifying each visited
 * basename against every rule of that root in the same pass — the roster's six
 * name arms all share one root, so walking per rule would multiply a real
 * home's traversal cost by the roster size.
 *
 * A generator, so that the traversal order, the single per-root `visited`
 * accounting the bounds read, and every typed refusal hold identically under
 * both drivers: the descent is `yield*` delegation rather than a queue, so
 * handing the thread back between directories cannot reorder what a bound
 * counts.
 *
 * The pass over one answered listing is split in two ON PURPOSE. Everything
 * that must belong to the read itself — bound accounting, and each match's
 * discovered identity — happens in the first, fully synchronous pass; only then
 * does the walk descend into the subdirectories it collected, which is where
 * the awaited reads release the thread. A single interleaved pass would capture
 * a match that is ordered after a subdirectory only after that subtree's every
 * awaited read, i.e. after many event-loop turns, and a replacement landing
 * inside that window would then BE the discovered identity — the exact
 * accept-and-bind of a different object that
 * `specs/effect-boundary-protection.md` refusal class 5 refuses. readdir order
 * is filesystem-dependent, so that would be luck rather than a contract.
 */
function* enumerateRootMatches(
  dir: string,
  depth: number,
  root: string,
  rootRules: readonly ProtectedTargetEntry[],
  limits: ProtectedTargetMaterializationLimits,
  state: WalkState
): WalkDriver {
  if (depth > limits.maxWalkDepth) {
    failMaterialization(
      `exceeded the walk-depth bound of ${limits.maxWalkDepth} under ${root}; refusing to enumerate an unbounded tree (refused, not partially skipped)`
    );
  }
  const read = yield { dir, root };
  const items = directoryItems(read, dir, root, depth);
  const subdirectories: string[] = [];
  for (const item of items) {
    state.visited += 1;
    if (state.visited > limits.maxEntries) {
      failMaterialization(
        `exceeded the enumeration bound of ${limits.maxEntries} entries under ${root}; refusing (refused, not truncated)`
      );
    }
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      subdirectories.push(path);
      continue;
    }
    recordRootMatches(item.name, path, rootRules, state);
  }
  for (const path of subdirectories) {
    // Symlinks are never followed: a match reachable only through a link that
    // leaves the declared root is the symlink-escape refusal in the
    // materializer, not something to clamp back inside.
    yield* enumerateRootMatches(
      path,
      depth + 1,
      root,
      rootRules,
      limits,
      state
    );
  }
}

/**
 * Classify one non-directory entry against this root's name rules and record
 * every rule it hits, capturing the discovered identity in the same
 * synchronous step — see the two-pass note on `enumerateRootMatches`.
 */
function recordRootMatches(
  name: string,
  path: string,
  rootRules: readonly ProtectedTargetEntry[],
  state: WalkState
): void {
  for (const entry of rootRules) {
    if (entry.rule.kind !== "name") continue;
    if (!namePatternHits(name, entry.rule.pattern)) continue;
    const match: ProtectedTargetMatch = { entry, path };
    state.hits.push(match);
    state.captureMatch?.(match);
  }
}

function bucketNameRulesByRoot(
  rules: readonly ProtectedTargetEntry[]
): Map<string, ProtectedTargetEntry[]> {
  const byRoot = new Map<string, ProtectedTargetEntry[]>();
  for (const entry of rules) {
    if (entry.rule.kind !== "name") continue;
    const bucket = byRoot.get(entry.rule.root);
    if (bucket === undefined) byRoot.set(entry.rule.root, [entry]);
    else bucket.push(entry);
  }
  return byRoot;
}

/**
 * Opens one root's walk: the generator the driver runs, plus the hit list it
 * fills. Both drivers share this and the sort below, so the order the mount
 * layer pins is one declaration.
 */
function openWalk(
  root: string,
  rootRules: readonly ProtectedTargetEntry[],
  limits: ProtectedTargetMaterializationLimits,
  captureMatches = false
): {
  readonly driver: WalkDriver;
  readonly hits: ProtectedTargetMatch[];
} {
  const hits: ProtectedTargetMatch[] = [];
  return {
    hits,
    driver: enumerateRootMatches(root, 0, root, rootRules, limits, {
      visited: 0,
      hits,
      captureMatch: captureMatches
        ? (match) => {
            match.discovered = captureDiscoveredMatchIdentity(match.path);
          }
        : undefined,
    }),
  };
}

function sortMatches(hits: ProtectedTargetMatch[]): ProtectedTargetMatch[] {
  return hits.sort((a, b) =>
    a.path === b.path
      ? a.entry.targetClass.localeCompare(b.entry.targetClass)
      : a.path.localeCompare(b.path)
  );
}

function collectMatchesByRoot(
  rules: readonly ProtectedTargetEntry[],
  limits: ProtectedTargetMaterializationLimits
): MatchesByRoot {
  const out: MatchesByRoot = new Map();
  for (const [root, rootRules] of bucketNameRulesByRoot(rules)) {
    const walk = openWalk(root, rootRules, limits);
    driveWalkSync(walk.driver);
    out.set(root, sortMatches(walk.hits));
  }
  return out;
}

async function collectMatchesByRootAwaited(
  rules: readonly ProtectedTargetEntry[],
  limits: ProtectedTargetMaterializationLimits
): Promise<{
  readonly matches: MatchesByRoot;
  readonly directories: readonly WalkedDirectory[];
}> {
  const matches: MatchesByRoot = new Map();
  const directories: WalkedDirectory[] = [];
  for (const [root, rootRules] of bucketNameRulesByRoot(rules)) {
    const walk = openWalk(root, rootRules, limits, true);
    await driveWalkAwaited(walk.driver, directories);
    matches.set(root, sortMatches(walk.hits));
  }
  return { matches, directories };
}

/** The identity a match is authorized for, or `undefined` when it is no
 *  longer a plain file at that path (symlink swap, replacement, or a plain
 *  disappearance) — the discovery-time object is what protection covers. */
function identityOfMatch(path: string): MaterializedTargetIdentity | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    // EXIT: an unprobeable path answers "no identity here"; the caller turns
    // that into the not-a-bindable-object refusal, so absence never binds.
    return undefined;
  }
  // EXIT: a non-file (directory, socket, or a swapped-in object that cannot be
  // bound read-only as a credential) has no bind identity to authorize; the
  // caller refuses rather than binding something the roster never enumerated.
  if (!stat.isFile()) return undefined;
  return { dev: stat.dev, ino: stat.ino };
}

function identityFromBigIntStats(stats: BigIntStats): DiscoveredObjectIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

/** Capture only matching objects; unrelated entries keep the walk stat-free. */
function captureDiscoveredMatchIdentity(path: string): DiscoveredMatchIdentity {
  let pathStats: BigIntStats;
  try {
    pathStats = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      // EXIT: the enumerated directory entry vanished before identity capture;
      // if it reappears, validation refuses the uncaptured object.
      return { path: undefined, bind: undefined };
    }
    failMaterialization(
      `could not capture match identity for ${path} (${errorCodeOf(error)}); refusing`
    );
  }
  let bind: DiscoveredObjectIdentity | undefined;
  try {
    const real = realpathSync(path);
    const bindPath = pathStats.isSymbolicLink() ? real : path;
    const bindStats = lstatSync(bindPath, { bigint: true });
    if (bindStats.isFile()) bind = identityFromBigIntStats(bindStats);
  } catch (error) {
    const code = errorCodeOf(error);
    // EXIT: ENOENT is the absent-target warning path; ELOOP remains for the
    // existing materializer to refuse if the same unresolved link survives.
    if (code !== "ENOENT" && code !== "ELOOP") {
      failMaterialization(
        `could not capture resolved match identity for ${path} (${code}); refusing`
      );
    }
  }
  return { path: identityFromBigIntStats(pathStats), bind };
}

function sameIdentity(
  left: DiscoveredObjectIdentity | undefined,
  right: DiscoveredObjectIdentity | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function currentMatchPathStats(
  match: ProtectedTargetMatch
): BigIntStats | undefined {
  let pathStats: BigIntStats;
  try {
    pathStats = lstatSync(match.path, { bigint: true });
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      // EXIT: the target is absent and will flow through the existing warning.
      return undefined;
    }
    failMaterialization(
      `could not revalidate match ${match.path} (${errorCodeOf(error)}); refusing`
    );
  }
  return pathStats;
}

function assertResolvedMatchIdentity(
  match: ProtectedTargetMatch,
  pathStats: BigIntStats,
  discovered: DiscoveredMatchIdentity
): void {
  let bindStats: BigIntStats;
  try {
    const real = realpathSync(match.path);
    const bindPath = pathStats.isSymbolicLink() ? real : match.path;
    bindStats = lstatSync(bindPath, { bigint: true });
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ENOENT") {
      // EXIT: a missing resolved target is diagnosed by materialization.
      return;
    }
    if (code === "ELOOP" && discovered.bind === undefined) {
      // EXIT: keep the existing typed cycle refusal in materialization.
      return;
    }
    failMaterialization(
      `could not revalidate resolved match ${match.path} (${code}); refusing`
    );
  }
  if (!bindStats.isFile()) {
    if (discovered.bind !== undefined) {
      failMaterialization(
        `resolved bind source for ${match.path} is no longer a file; refusing`
      );
    }
    // EXIT: nothing was bindable at discovery and nothing is bindable now, so
    // there is no object identity to have swapped. The materializer's own
    // not-a-bindable-object refusal is the typed decision for that shape.
    return;
  }
  const currentBind = identityFromBigIntStats(bindStats);
  if (
    discovered.bind === undefined ||
    !sameIdentity(discovered.bind, currentBind)
  ) {
    failMaterialization(
      `resolved bind source for ${match.path} was replaced since awaited enumeration; refusing`
    );
  }
}

/** A vanished match is allowed; survivors keep their discovered pathname and
 *  resolved bind-source identities. */
function assertDiscoveredMatchUnchanged(match: ProtectedTargetMatch): void {
  const discovered = match.discovered;
  // EXIT: a synchronous walk records no discovered identity, so there is no
  // object this check could compare against; the pathname-scoped refusals below
  // still apply. An awaited walk always captures, empty or not.
  if (discovered === undefined) return;
  const pathStats = currentMatchPathStats(match);
  // EXIT: ENOENT on the revalidation is PROVEN ABSENCE, which takes SC10 / class
  // 4's warn-and-continue direction, not class 5's refusal: there are no bytes
  // left to protect at this pathname, so the match goes to `vanished` for the
  // mount layer's typed warning while every present sibling still gets its bind.
  // Refusing here would turn an ordinary concurrent `rm` into a dead bash call.
  // Any other probe error already refused inside `currentMatchPathStats`.
  if (pathStats === undefined) return;
  if (!sameIdentity(discovered.path, identityFromBigIntStats(pathStats))) {
    failMaterialization(
      `match ${match.path} was replaced since awaited enumeration; refusing instead of binding a different object`
    );
  }
  assertResolvedMatchIdentity(match, pathStats, discovered);
}

type KnownMatchesByRoot = Map<string, Map<string, Set<ProtectedTargetEntry>>>;

function indexKnownMatches(matches: MatchesByRoot): KnownMatchesByRoot {
  const known = new Map<string, Map<string, Set<ProtectedTargetEntry>>>();
  for (const [root, rootMatches] of matches) {
    const byMatchPath = new Map<string, Set<ProtectedTargetEntry>>();
    for (const match of rootMatches) {
      const atPath = byMatchPath.get(match.path);
      if (atPath === undefined)
        byMatchPath.set(match.path, new Set([match.entry]));
      else atPath.add(match.entry);
    }
    known.set(root, byMatchPath);
  }
  return known;
}

function currentDirectoryIdentity(
  directory: WalkedDirectory
): BigIntStats | undefined {
  try {
    return lstatSync(directory.path, { bigint: true });
  } catch (error) {
    // EXIT: ENOENT defers the disappearance decision to the caller, which only
    // accepts a removal its parent's current listing proves; any other probe
    // failure cannot tell an absent directory from an unreadable one, so it
    // refuses here.
    if (errorCodeOf(error) === "ENOENT") return undefined;
    failMaterialization(
      `walk directory ${directory.path} could not be revalidated (${errorCodeOf(error)}); refusing`
    );
  }
}

/** Entries the parked walk charged per root: the recorded listings' entry
 *  counts, which is exactly the accounting the walk's own bound was read
 *  against. Revalidation starts from what the walk already spent. */
function consumedEntriesByRoot(
  directories: readonly WalkedDirectory[]
): Map<string, number> {
  const consumed = new Map<string, number>();
  for (const directory of directories) {
    const spent = consumed.get(directory.root) ?? 0;
    consumed.set(directory.root, spent + directory.entryCount);
  }
  return consumed;
}

/** One root's revalidation inputs, resolved once per changed directory. */
interface RootMatchIndex {
  readonly rootRules: readonly ProtectedTargetEntry[];
  readonly knownAtPath: ReadonlyMap<string, Set<ProtectedTargetEntry>>;
}

/** What the changed-listing pass shares: the parked walk's index, the rules and
 *  matches bucketed per root, and the enumeration bound BOTH the walk and this
 *  re-read are charged to. One context object instead of a fifth or sixth
 *  positional parameter on every helper below. */
interface SnapshotValidation {
  readonly directoriesByPath: ReadonlyMap<string, WalkedDirectory>;
  readonly rulesByRoot: ReadonlyMap<string, ProtectedTargetEntry[]>;
  readonly knownMatches: KnownMatchesByRoot;
  readonly limits: ProtectedTargetMaterializationLimits;
  readonly consumedEntries: Map<string, number>;
}

/** The rules and the known-match index of one directory's root. The parked walk
 *  must have bucketed that root; the refusal is the typed guard that keeps it
 *  that way. */
function matchIndexForRoot(
  directory: WalkedDirectory,
  context: SnapshotValidation
): RootMatchIndex {
  const rootRules = context.rulesByRoot.get(directory.root);
  const knownAtPath = context.knownMatches.get(directory.root);
  if (rootRules === undefined || knownAtPath === undefined) {
    failMaterialization(
      `the awaited walk has no match index for root ${directory.root}; refusing`
    );
  }
  return { rootRules, knownAtPath };
}

/** Spec refusal class 6: revalidating a listing is traversal work too, so every
 *  entry this pass rereads is charged on top of what the parked walk already
 *  spent for that root. `prepareProtectedFenceWiring`'s contract — changed
 *  listings are reread WITHIN the original enumeration bound — is enforced here
 *  rather than merely claimed. The operator-facing noun is the walk's own
 *  ("enumeration bound of N entries"): one bound, one phrase, so the two
 *  refusals name the same limit the operator has to widen. */
function assertRevalidationWithinEntryBound(
  directory: WalkedDirectory,
  rereadEntries: number,
  context: SnapshotValidation
): void {
  const spent =
    (context.consumedEntries.get(directory.root) ?? 0) + rereadEntries;
  context.consumedEntries.set(directory.root, spent);
  if (spent > context.limits.maxEntries) {
    failMaterialization(
      `exceeded the enumeration bound of ${context.limits.maxEntries} entries under ${directory.root} while revalidating changed listings; refusing (refused, not truncated)`
    );
  }
}

function readChangedDirectory(
  directory: WalkedDirectory,
  context: SnapshotValidation
): readonly Dirent[] {
  let items: Dirent[];
  try {
    items = readdirSync(directory.path, { withFileTypes: true });
  } catch (error) {
    failMaterialization(
      `changed walk directory ${directory.path} could not be re-enumerated (${errorCodeOf(error)}); refusing`
    );
  }
  // No length comparison here, deliberately. The shapes that can hide a match
  // are refused one by one by `assertNoUnseenMatchOrSubtree` (a new match, a new
  // subtree) and by the identity revalidation (a replaced object), and an
  // ordinary non-matching addition hides nothing — so a "current listing is
  // longer than the recorded one" refusal would add no protection while making
  // every bash call die on `npm install`, a fetch, a build watcher, or an editor
  // lock file landing in the walk window. That is none of the spec's six refusal
  // classes, and SC10 says the opposite: the fence assembles and runs, with
  // every match present at the moment of assembly bound.
  assertRevalidationWithinEntryBound(directory, items.length, context);
  return items;
}

/**
 * Decide whether one entry of a changed directory's CURRENT listing could carry
 * protection the parked walk never recorded. It is not a "was this entry
 * enumerated?" check — a new non-matching file passes, and must: nothing about
 * it needs a bind. Two shapes refuse, and each names what it refused:
 *   - a subdirectory the walk never scanned, whose whole subtree is unenumerated
 *     and may hold matches (class 1's fail-closed direction);
 *   - a name-rule match the parked listing did not have, which would otherwise
 *     assemble with that credential unbound (the per-assembly rule).
 */
function assertNoUnseenMatchOrSubtree(
  directory: WalkedDirectory,
  item: Dirent,
  index: RootMatchIndex,
  context: SnapshotValidation
): void {
  const path = join(directory.path, item.name);
  if (item.isDirectory()) {
    if (!context.directoriesByPath.has(path)) {
      failMaterialization(
        `changed walk directory ${directory.path} contains an unscanned child directory ${path}; refusing`
      );
    }
    return;
  }
  for (const rule of index.rootRules) {
    if (
      rule.rule.kind === "name" &&
      namePatternHits(item.name, rule.rule.pattern) &&
      !index.knownAtPath.get(path)?.has(rule)
    ) {
      failMaterialization(
        `changed walk directory ${directory.path} contains a new protected match ${path}; refusing`
      );
    }
  }
}

function validateChangedDirectory(
  directory: WalkedDirectory,
  context: SnapshotValidation
): Set<string> {
  const index = matchIndexForRoot(directory, context);
  const items = readChangedDirectory(directory, context);
  const currentChildren = new Set<string>();
  for (const item of items) {
    assertNoUnseenMatchOrSubtree(directory, item, index, context);
    if (item.isDirectory()) {
      currentChildren.add(join(directory.path, item.name));
    }
  }
  return currentChildren;
}

function isUnderRemovedDirectory(
  path: string,
  removedDirectories: readonly string[]
): boolean {
  return removedDirectories.some(
    (removed) => path === removed || isInside(path, removed)
  );
}

type WalkedDirectoryValidation =
  | { readonly kind: "unchanged" }
  | { readonly kind: "removed" }
  | { readonly kind: "changed"; readonly children: Set<string> };

function validateWalkedDirectory(
  directory: WalkedDirectory,
  changedChildren: ReadonlyMap<string, Set<string>>,
  context: SnapshotValidation
): WalkedDirectoryValidation {
  const current = currentDirectoryIdentity(directory);
  if (current === undefined) {
    const parentChildren = changedChildren.get(dirname(directory.path));
    if (
      directory.path !== directory.root &&
      parentChildren !== undefined &&
      !parentChildren.has(directory.path)
    ) {
      return { kind: "removed" };
    }
    failMaterialization(
      `walk directory ${directory.path} disappeared since awaited enumeration; refusing`
    );
  }
  if (
    !current.isDirectory() ||
    current.dev !== directory.dev ||
    current.ino !== directory.ino
  ) {
    failMaterialization(
      `walk directory ${directory.path} was replaced since awaited enumeration; refusing`
    );
  }
  if (
    current.mtimeNs === directory.mtimeNs &&
    current.ctimeNs === directory.ctimeNs
  ) {
    return { kind: "unchanged" };
  }
  return {
    kind: "changed",
    children: validateChangedDirectory(directory, context),
  };
}

/** Permit proven shrinkage (vanished targets) and ordinary, non-matching growth
 *  while refusing what could leave a match unrepresented: an unseen new match,
 *  an unscanned subdirectory, a replaced object or directory. Only changed
 *  directories are reread, and the entries this pass rereads are charged to the
 *  walk's own enumeration bound per root — a bound the walk satisfied is not a
 *  licence to enumerate the tree again for free. */
function assertWalkedSnapshotSafe(
  directories: readonly WalkedDirectory[],
  matches: MatchesByRoot,
  nameRules: readonly ProtectedTargetEntry[],
  limits: ProtectedTargetMaterializationLimits
): void {
  const context: SnapshotValidation = {
    directoriesByPath: new Map(
      directories.map((directory) => [directory.path, directory])
    ),
    rulesByRoot: bucketNameRulesByRoot(nameRules),
    knownMatches: indexKnownMatches(matches),
    limits,
    consumedEntries: consumedEntriesByRoot(directories),
  };
  const changedChildren = new Map<string, Set<string>>();
  const removedDirectories: string[] = [];

  for (const directory of directories) {
    if (isUnderRemovedDirectory(directory.path, removedDirectories)) {
      continue;
    }
    const validation = validateWalkedDirectory(
      directory,
      changedChildren,
      context
    );
    if (validation.kind === "removed") {
      removedDirectories.push(directory.path);
    } else if (validation.kind === "changed") {
      changedChildren.set(directory.path, validation.children);
    }
  }
}

/**
 * A walk that was awaited ahead of an assembly, keyed by the inventory it was
 * walked for. Keyed on the inventory object and consumed on read, so one
 * pre-walk can only ever feed one assembly: an assembly with nothing pre-walked
 * enumerates synchronously exactly as before, and the assembly after a consumed
 * pre-walk re-enumerates and therefore still covers a file created in between.
 */
type AwaitedWalkState =
  | { readonly kind: "walking" }
  | {
      readonly kind: "ready";
      readonly limits: ProtectedTargetMaterializationLimits;
      readonly matches: MatchesByRoot;
      readonly directories: readonly WalkedDirectory[];
      /**
       * True when this snapshot was REUSED from the session holder rather than
       * walked for this assembly. A reused snapshot is checked by the stat-only
       * identity pass (an unchanged tree is provably the tree the snapshot was
       * walked from, so the match set still holds) and NOT by the fresh walk's
       * listing re-read: a reused snapshot must never REFUSE where the fresh
       * path would simply walk again and mask the credential that appeared.
       */
      readonly reused: boolean;
    };

const awaitedWalks = new WeakMap<ProtectedTargetInventory, AwaitedWalkState>();

function sameLimits(
  a: ProtectedTargetMaterializationLimits,
  b: ProtectedTargetMaterializationLimits
): boolean {
  return a.maxWalkDepth === b.maxWalkDepth && a.maxEntries === b.maxEntries;
}

/**
 * One walked snapshot of the protected-target enumeration: the matches the
 * walk found, plus the directory identities it recorded. The directories
 * carry the fs identity (`dev`/`ino`/`mtimeNs`/`ctimeNs`) the identity pass
 * compares, so a snapshot can be CHECKED for freshness instead of trusted.
 */
interface WalkedSnapshot {
  readonly limits: ProtectedTargetMaterializationLimits;
  readonly matches: MatchesByRoot;
  readonly directories: readonly WalkedDirectory[];
}

/**
 * Park a walked snapshot for the next assembly, keyed by the inventory it
 * belongs to. The parked state is consumed on read, so it feeds exactly ONE
 * assembly. `reused` marks a snapshot the session holder served (checked by
 * the stat-only identity pass) against one walked for this assembly (checked
 * by the fresh walk's listing re-read).
 */
function parkWalkedSnapshot(
  inventory: ProtectedTargetInventory,
  snapshot: WalkedSnapshot,
  reused: boolean
): void {
  awaitedWalks.set(inventory, {
    kind: "ready",
    limits: snapshot.limits,
    matches: snapshot.matches,
    directories: snapshot.directories,
    reused,
  });
}

/**
 * One walked directory's identity, as the walk recorded it versus as it is
 * now. The comparison is the walk's own notion of "changed" (`dev`/`ino` for
 * a replaced directory, `mtimeNs`/`ctimeNs` for a changed listing), read with
 * the same `lstat` the fresh path's re-validation uses.
 */
function sameDirectoryIdentity(directory: WalkedDirectory): boolean {
  let current: BigIntStats;
  try {
    current = lstatSync(directory.path, { bigint: true });
  } catch {
    // EXIT: a directory that cannot be stat'd (gone, unreadable) is a CHANGED
    // tree, not a reason to refuse: the snapshot is stale and the caller
    // walks fresh.
    return false;
  }
  return (
    current.isDirectory() &&
    current.dev === directory.dev &&
    current.ino === directory.ino &&
    current.mtimeNs === directory.mtimeNs &&
    current.ctimeNs === directory.ctimeNs
  );
}

/**
 * The stat-only identity pass over a walked snapshot's directories.
 *
 * A directory whose identity is unchanged has an unchanged listing, so the
 * whole tree is provably the tree the snapshot was walked from and the
 * snapshot's match set is exactly what a fresh walk would produce. Any
 * difference (a changed listing, a replaced directory, one that vanished)
 * makes the snapshot STALE: the caller discards it and walks fresh, which is
 * the path the fence takes without a session holder. Nothing is refused here —
 * a stale snapshot is a reason to re-walk, never a reason to fail an
 * assembly, so a credential that appeared since the walk is masked by the
 * fresh walk instead of failing the call.
 */
function walkedDirectoriesUnchanged(
  directories: readonly WalkedDirectory[]
): boolean {
  for (const directory of directories) {
    if (!sameDirectoryIdentity(directory)) return false;
  }
  return true;
}

/**
 * The snapshot parked for this inventory, read WITHOUT consuming it: the
 * assembly that follows consumes it, and the session holder captures it to
 * serve the next assembly.
 */
function captureWalkedSnapshot(
  inventory: ProtectedTargetInventory
): WalkedSnapshot | undefined {
  const state = awaitedWalks.get(inventory);
  if (state === undefined || state.kind !== "ready") return undefined;
  return {
    limits: state.limits,
    matches: state.matches,
    directories: state.directories,
  };
}

/**
 * Enumerates the name rules' matches with awaited directory reads, so a caller
 * already on an `async` path can hand the thread back between directories
 * instead of holding it for the whole workspace. The assembly that follows
 * consumes this walk through `materializeProtectedTargets`; nothing about the
 * enumeration changes — same coverage, same bounds, same typed refusals. The
 * product reason for the seam is in `prepareProtectedFenceWiring`.
 *
 * Refusals surface as a rejected promise here rather than a synchronous throw,
 * which is the same fail-closed class the synchronous walk raises: the caller
 * gets no inventory of matches back and the fence never assembles with the name
 * arm silently missing.
 */
export async function prewalkProtectedTargets(
  inventory: ProtectedTargetInventory,
  limits: ProtectedTargetMaterializationLimits = DEFAULT_LIMITS
): Promise<void> {
  const nameRules = inventory.entries.filter(
    (entry) => entry.rule.kind === "name"
  );
  if (nameRules.length === 0) return;
  if (awaitedWalks.get(inventory)?.kind === "walking") {
    failMaterialization(
      "an awaited pre-walk is already in progress for this inventory; refusing overlapping walks"
    );
  }
  // EXIT: starting a new walk invalidates any older parked enumeration before
  // filesystem reads begin; a failed replacement must never expose stale hits.
  awaitedWalks.delete(inventory);
  const pending: AwaitedWalkState = { kind: "walking" };
  awaitedWalks.set(inventory, pending);
  try {
    const walked = await collectMatchesByRootAwaited(nameRules, limits);
    if (awaitedWalks.get(inventory) !== pending) {
      failMaterialization(
        "the awaited pre-walk was invalidated before completion; refusing to park its result"
      );
    }
    parkWalkedSnapshot(
      inventory,
      {
        limits,
        matches: walked.matches,
        directories: walked.directories,
      },
      // EXIT: a snapshot walked for THIS assembly is checked by the fresh
      // walk's own listing re-read, not by the stat-only identity pass a
      // reused snapshot goes through.
      false
    );
  } catch (error) {
    if (awaitedWalks.get(inventory) === pending) {
      awaitedWalks.delete(inventory);
    }
    throw error;
  }
}

/**
 * The roots a walk of these rules MUST have covered — the same bucketing the
 * synchronous walk walks, so the requirement has one declaration.
 */
function nameRuleRoots(
  nameRules: readonly ProtectedTargetEntry[]
): Iterable<string> {
  return bucketNameRulesByRoot(nameRules).keys();
}

/**
 * This assembly's matches, from the awaited pre-walk when there is one for this
 * exact inventory and these exact limits (consumed once per assembly, so it
 * can never feed two assemblies at once), or from a synchronous walk of the
 * same contract when there is not. A session holder may re-park a PREVIOUSLY
 * walked snapshot for this assembly; a reused snapshot is checked by the
 * stat-only identity pass (freshness, not refusal), and a stale one is
 * re-enumerated rather than served.
 *
 * A parked walk is only acceptable if it enumerated EVERY name rule's root: the
 * assembly below reads matches out of this map by root, so a walk that was short
 * one root would report success while protecting nothing under it — the
 * "assembles with the name arm silently missing" the spec refuses. Unreachable
 * while both arms share `nameRuleRoots`; it is the typed refusal that keeps it
 * that way if the two sides ever filter differently.
 */
function takeMatchesByRoot(
  inventory: ProtectedTargetInventory,
  nameRules: readonly ProtectedTargetEntry[],
  limits: ProtectedTargetMaterializationLimits
): MatchesByRoot {
  const prewalked = awaitedWalks.get(inventory);
  if (prewalked === undefined) {
    // EXIT: no completed walk is parked, so preserve the original synchronous
    // enumeration path for this assembly.
    return collectMatchesByRoot(nameRules, limits);
  }
  if (prewalked.kind === "walking") {
    awaitedWalks.delete(inventory);
    failMaterialization(
      "cannot materialize while an awaited pre-walk is in progress; refusing concurrent consume"
    );
  }
  // Consume before checking limits or validating metadata. Every attempt to
  // assemble spends this one-shot result, including refusals and fallbacks.
  awaitedWalks.delete(inventory);
  if (!sameLimits(prewalked.limits, limits)) {
    // EXIT: different bounds cannot trust this walk; re-enumerate under the
    // limits requested by the current assembly.
    return collectMatchesByRoot(nameRules, limits);
  }
  // Root coverage first, and it stays cheap: a Map lookup per root, no filesystem
  // work. Left AFTER `assertWalkedSnapshotSafe`, this diagnostic is the one an
  // operator can never read: a walk that recorded directories for a root whose
  // hit list was never parked is answered by `matchIndexForRoot`'s refusal from
  // inside the snapshot pass first, which names the snapshot instead of the root
  // this assembly's enumeration never covered. Both typed refusals stay.
  for (const root of nameRuleRoots(nameRules)) {
    if (!prewalked.matches.has(root)) {
      failMaterialization(
        `the awaited pre-walk carries no enumeration for root ${root}; refusing instead of assembling with that root's matches missing`
      );
    }
  }
  if (prewalked.reused) {
    // A snapshot the session holder served. Its freshness is the STAT-ONLY
    // identity pass, not the fresh walk's listing re-read: an unchanged tree
    // is provably the tree the snapshot was walked from, so the match set
    // still holds — and a CHANGED tree is not a refusal but a stale snapshot,
    // so the assembly re-enumerates and masks whatever appeared since the
    // walk, exactly as it does without a holder.
    if (!walkedDirectoriesUnchanged(prewalked.directories)) {
      // EXIT: the tree changed between the holder's check and this assembly
      // (a race no stat pass can close). Re-enumerate now: the credential
      // that appeared is masked by THIS assembly, not by the next one.
      return collectMatchesByRoot(nameRules, limits);
    }
    return prewalked.matches;
  }
  assertWalkedSnapshotSafe(
    prewalked.directories,
    prewalked.matches,
    nameRules,
    limits
  );
  return prewalked.matches;
}

/** One cached snapshot: its key, the inventory it was walked for, the walk. */
interface SnapshotCacheEntry {
  readonly key: string;
  readonly inventory: ProtectedTargetInventory;
  readonly snapshot: WalkedSnapshot;
}

/**
 * The cache key: the inputs the walked snapshot depends on — the frozen home
 * root, the frozen workspace root (the name-rule scan scope) and the
 * enumeration bounds the walk ran under. A different home or workspace is a
 * different enumeration, and a walk under different bounds cannot be reused
 * (the `sameLimits` check at the consume site enforces the same rule).
 *
 * There is deliberately NO secret-registry version in this key, for the same
 * reason the mask plan's key has none: the secret registry is a VALUE map
 * (command restore + output mask) and never influences which paths the
 * enumeration protects. There is no runtime credential-path registry to
 * version.
 */
function snapshotKey(
  homeRoot: string,
  workspaceRoot: string,
  limits: ProtectedTargetMaterializationLimits
): string {
  return [
    "protected-target-snapshot/v1",
    `home=${homeRoot}`,
    `workspace=${workspaceRoot}`,
    `depth=${limits.maxWalkDepth}`,
    `entries=${limits.maxEntries}`,
  ].join("\n");
}

/**
 * A session-scoped holder for the protected-target enumeration's walked
 * snapshot.
 *
 * NOT a module-level cache: the holder is created once per bash-tool instance
 * (i.e. per session) and passed explicitly to the fence wiring, so two
 * sessions never share a snapshot and no snapshot outlives the session that
 * produced it.
 */
export interface ProtectedTargetSnapshotCache {
  /**
   * The enumeration bounds this holder walks under. They must be the bounds
   * the assembly materializes under (`materializeProtectedTargets`' default),
   * or the consume site's `sameLimits` check refuses the snapshot and the
   * assembly re-enumerates — correct, but not cached.
   */
  readonly limits: ProtectedTargetMaterializationLimits;
  /**
   * The cached snapshot for these inputs, re-parked for THIS assembly — or
   * `undefined` when the caller must create a fresh inventory and walk it.
   */
  readonly take: (input: {
    readonly homeRoot: string;
    readonly workspaceRoot: string;
  }) => ProtectedTargetInventory | undefined;
  /**
   * Park the freshly walked snapshot of `inventory` for the next assembly.
   */
  readonly put: (input: {
    readonly homeRoot: string;
    readonly workspaceRoot: string;
    readonly inventory: ProtectedTargetInventory;
  }) => void;
  /** Drop the cached snapshot: any doubt → rebuild. */
  readonly invalidate: () => void;
}

/**
 * A fresh, empty protected-target snapshot holder. One per session (the bash
 * tool's factory closure), never a module-level singleton.
 *
 * The holder caches the WALKED SNAPSHOT only — the matches the enumeration
 * found plus the directory identities it recorded. It never caches a decision:
 * a reused snapshot is checked for FRESHNESS (the stat-only identity pass),
 * and a stale snapshot is DISCARDED, never served and never refused — the
 * assembly walks fresh instead, exactly as the fence does without a holder. So
 * a credential that appeared under the scan scope is masked by the very call
 * that noticed it, not refused and not masked one call later.
 *
 * The holder hands back the INVENTORY it walked, not a fresh one: the
 * materialization compares the snapshot's matches against the assembly's own
 * name-rule objects by identity, so the two must be the same objects for that
 * comparison to mean what it was written to mean.
 */
export function createProtectedTargetSnapshotCache(
  limits: ProtectedTargetMaterializationLimits = DEFAULT_LIMITS
): ProtectedTargetSnapshotCache {
  let cached: SnapshotCacheEntry | undefined;
  const drop = (): void => {
    cached = undefined;
  };
  return {
    limits,
    take: (input) => {
      const entry = cached;
      if (entry === undefined) return undefined;
      if (
        entry.key !== snapshotKey(input.homeRoot, input.workspaceRoot, limits)
      ) {
        // EXIT: the entry belongs to other inputs, so it can never serve this
        // assembly; drop it rather than keep a snapshot nobody may reuse.
        drop();
        return undefined;
      }
      if (!walkedDirectoriesUnchanged(entry.snapshot.directories)) {
        // EXIT: the tree changed since the walk, so the snapshot is STALE. Drop
        // it and let the caller walk fresh: the credential that appeared is
        // then found by that walk and masked by THIS assembly — the same
        // behaviour the fence has without a session holder.
        drop();
        return undefined;
      }
      // Re-park the snapshot for THIS assembly: the parked state is consumed on
      // read, so one snapshot still feeds exactly one assembly at a time, and
      // the assembly checks its freshness before it trusts a single match.
      parkWalkedSnapshot(entry.inventory, entry.snapshot, true);
      return entry.inventory;
    },
    put: (input) => {
      const snapshot = captureWalkedSnapshot(input.inventory);
      // EXIT: nothing was walked for this inventory, or the walk ran under
      // different bounds than this holder's — either way there is no snapshot
      // this holder may serve.
      if (snapshot === undefined) return;
      if (!sameLimits(snapshot.limits, limits)) return;
      cached = {
        key: snapshotKey(input.homeRoot, input.workspaceRoot, limits),
        inventory: input.inventory,
        snapshot,
      };
    },
    invalidate: drop,
  };
}

/**
 * Materialize the inventory's name rules into this assembly's effective
 * physical targets.
 *
 * Explicit external concrete targets are untouched by this step: only name
 * rules are enumerated, and only under their own declared root, so a protected
 * location outside home still requires an inventory entry naming it
 * concretely. A match covered by an ancestor concrete rule contributes no bind
 * and does not alter that ancestor's mount.
 *
 * Every unenforceable enumeration (unreadable subtree, walk-depth or entry
 * exhaustion, symlink escape) is a typed refusal that fails the whole pass, so
 * a fence never assembles with fewer protections than the roster implies.
 *
 * The enumeration itself is this assembly's, either performed here or taken
 * from a `prewalkProtectedTargets` of the same inventory and the same limits —
 * never from a walk kept around for a later assembly. A session holder may
 * re-park a PREVIOUSLY walked snapshot for this assembly; such a snapshot is
 * checked for FRESHNESS by the stat-only identity pass (an unchanged tree is
 * provably the tree the snapshot was walked from), and a stale one is
 * re-enumerated here rather than served or refused.
 */
export function materializeProtectedTargets(
  inventory: ProtectedTargetInventory,
  limits: ProtectedTargetMaterializationLimits = DEFAULT_LIMITS
): ProtectedTargetMaterialization {
  const nameRules = inventory.entries.filter(
    (entry) => entry.rule.kind === "name"
  );
  if (nameRules.length === 0) {
    return Object.freeze({
      targets: Object.freeze([]),
      coveredByAncestor: Object.freeze([]),
      vanished: Object.freeze([]),
      identities: Object.freeze([]),
    });
  }
  const byRoot = takeMatchesByRoot(inventory, nameRules, limits);

  const coverRoots = inventory.entries
    .map((entry) => entry.bindPath)
    .filter((path): path is string => path !== undefined)
    .sort((a, b) => b.length - a.length);
  const isCovered = (path: string): boolean =>
    coverRoots.some((root) => path === root || isInside(path, root));

  const targets: ProtectedTargetBindPath[] = [];
  const coveredByAncestor: ProtectedTargetBindPath[] = [];
  const vanished: ProtectedTargetBindPath[] = [];
  const identities: MaterializedTargetIdentity[] = [];
  const seen = new Set<string>();
  for (const [root, hits] of byRoot) {
    for (const match of hits) {
      const { entry, path } = match;
      assertDiscoveredMatchUnchanged(match);
      const gone = (): void => {
        vanished.push({
          path,
          targetClass: entry.targetClass,
          arm: entry.arm,
        });
      };
      let real: string;
      try {
        real = realpathSync(path);
      } catch (error) {
        // Provably absent between enumeration and this resolution: there are no
        // bytes to protect, so it takes the absent-target warn direction rather
        // than the refusal classes' direction. This arm and the `existsSync`
        // arm below must agree — a bare `continue` here used to make the
        // `vanished` array unreachable, so the typed warning never fired.
        if (errorCodeOf(error) === "ENOENT") {
          gone();
          continue;
        }
        failMaterialization(
          `could not resolve match ${path} under root ${root} (${errorCodeOf(error)}); refusing`
        );
      }
      if (real !== root && !isInside(real, root)) {
        failMaterialization(
          `match ${path} resolves to ${real}, which escapes the declared root ${root}; refusing (a protected location outside the root needs an explicit concrete target)`
        );
      }
      // A match removed between the directory read and this resolution is the
      // same absence, reached through the other syscall ordering.
      if (!existsSync(path)) {
        gone();
        continue;
      }
      // A symlink match is protected at the object it resolves to — bwrap binds
      // the resolved source anyway, so binding the link path would protect the
      // link rather than the credential. A link whose target is still a link
      // (a cycle) cannot be resolved to an object at all, which is the ELOOP
      // case and is refused rather than cut off by a link-count heuristic.
      const bindPath = lstatSync(path).isSymbolicLink() ? real : path;
      const identity = identityOfMatch(bindPath);
      if (identity === undefined) {
        failMaterialization(
          `match ${path} resolves to ${real}, which is not a bindable object; refusing rather than binding something the roster never enumerated`
        );
      }
      if (seen.has(bindPath)) continue;
      seen.add(bindPath);
      if (isCovered(bindPath)) {
        coveredByAncestor.push({
          path: bindPath,
          targetClass: entry.targetClass,
          arm: entry.arm,
        });
        continue;
      }
      targets.push({
        path: bindPath,
        targetClass: entry.targetClass,
        arm: entry.arm,
      });
      identities.push(identity);
    }
  }
  return Object.freeze({
    targets: Object.freeze([...targets].sort((a, b) => bindPathOrder(a, b))),
    coveredByAncestor: Object.freeze(
      [...coveredByAncestor].sort((a, b) => bindPathOrder(a, b))
    ),
    vanished: Object.freeze([...vanished].sort((a, b) => bindPathOrder(a, b))),
    // Re-sorted with `targets`, so identities follow positionally.
    identities: Object.freeze(
      [...targets]
        .map((target, i) => ({ target, identity: identities[i]! }))
        .sort((a, b) => bindPathOrder(a.target, b.target))
        .map((pair) => pair.identity)
    ),
  });
}

/** Deterministic argv order: path, then class (one path can match two arms). */
function bindPathOrder(
  a: ProtectedTargetBindPath,
  b: ProtectedTargetBindPath
): number {
  return a.path === b.path
    ? a.targetClass.localeCompare(b.targetClass)
    : a.path.localeCompare(b.path);
}
