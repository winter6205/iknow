import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join, resolve } from "node:path";
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

/**
 * One shared walk of the name rules' common root, classifying each visited
 * basename against every rule of that root in the same pass — the roster's six
 * name arms all share one root, so walking per rule would multiply a real
 * home's traversal cost by the roster size.
 */
function collectMatchesByRoot(
  rules: readonly ProtectedTargetEntry[],
  limits: ProtectedTargetMaterializationLimits
): Map<string, { entry: ProtectedTargetEntry; path: string }[]> {
  const byRoot = new Map<string, ProtectedTargetEntry[]>();
  for (const entry of rules) {
    if (entry.rule.kind !== "name") continue;
    const bucket = byRoot.get(entry.rule.root);
    if (bucket === undefined) byRoot.set(entry.rule.root, [entry]);
    else bucket.push(entry);
  }
  const out = new Map<
    string,
    { entry: ProtectedTargetEntry; path: string }[]
  >();
  for (const [root, rootRules] of byRoot) {
    const hits: { entry: ProtectedTargetEntry; path: string }[] = [];
    let visited = 0;
    const walk = (dir: string, depth: number): void => {
      if (depth > limits.maxWalkDepth) {
        failMaterialization(
          `exceeded the walk-depth bound of ${limits.maxWalkDepth} under ${root}; refusing to enumerate an unbounded tree (refused, not partially skipped)`
        );
      }
      let items: Dirent[];
      try {
        // `withFileTypes` gets the entry kind from the directory read itself:
        // a stat per entry on a real home costs several times the whole walk.
        items = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        const code = errorCodeOf(error);
        // ENOENT at the root is the zero-match case (a home that has no such
        // tree at all), not a fault. Anywhere else the subtree could not be
        // enumerated, so matches may exist in it: refusing is the only
        // fail-closed direction, never "protect the ones we reached".
        if (code === "ENOENT" && depth === 0) return;
        failMaterialization(
          `could not enumerate ${dir} under root ${root} (${code}); refusing because an unenumerated subtree may hold matches`
        );
      }
      for (const item of items) {
        visited += 1;
        if (visited > limits.maxEntries) {
          failMaterialization(
            `exceeded the enumeration bound of ${limits.maxEntries} entries under ${root}; refusing (refused, not truncated)`
          );
        }
        const path = join(dir, item.name);
        if (item.isDirectory()) {
          // Symlinks are never followed: a match reachable only through a link
          // that leaves the declared root is the symlink-escape refusal below,
          // not something to clamp back inside.
          walk(path, depth + 1);
          continue;
        }
        for (const entry of rootRules) {
          if (entry.rule.kind !== "name") continue;
          if (namePatternHits(item.name, entry.rule.pattern)) {
            hits.push({ entry, path });
          }
        }
      }
    };
    walk(root, 0);
    out.set(
      root,
      hits.sort((a, b) =>
        a.path === b.path
          ? a.entry.targetClass.localeCompare(b.entry.targetClass)
          : a.path.localeCompare(b.path)
      )
    );
  }
  return out;
}

/** The identity a match is authorized for, or `undefined` when it is no
 *  longer a plain file at that path (symlink swap, replacement, or a plain
 *  disappearance) — the discovery-time object is what protection covers. */
function identityOfMatch(path: string): MaterializedTargetIdentity | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  return { dev: stat.dev, ino: stat.ino };
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
  const byRoot = collectMatchesByRoot(nameRules, limits);

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
    for (const { entry, path } of hits) {
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
