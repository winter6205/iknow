import { readdir, readFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { parseFrontmatter, stripFence } from "../frontmatter/index.js";
import {
  stripNamespace,
  type SkillEntry,
  type SkillFrontmatter,
} from "./catalog.js";

const DESCRIPTION_LIMIT = 1536;
const ARCHIVED_KEYS = [
  "source",
  "version",
  "tags",
  "author",
  "license",
  "metadata",
] as const;

type SkillEnv = Readonly<Record<string, string | undefined>>;
type Warn = (message: string) => void;

/**
 * Plugin skill dir entry — the scanner must know which plugin root an entry
 * came from to tag `SkillEntry.namespace`. `dir` is the plugin's
 * `<root>/skills`; `plugin` is its namespace prefix (the plugin name).
 */
export interface PluginSkillDir {
  readonly dir: string;
  readonly plugin: string;
}

export interface SkillScannerOptions {
  userHome: string;
  /**
   * ADR-0037: the session's `projectIdentityRoot` — the project the user is
   * working on, pinned once at startup and stable across worktree rebinds.
   * Project skills are project identity, so a rebind must not move the scan
   * onto the gitignored task worktree (where the dir is simply absent).
   */
  projectIdentityRoot: string;
  env: SkillEnv;
  warn?: Warn;
  /**
   * Plugin skill dirs (absolute), each with its namespace. Scan order =
   * user < project < plugin < IKNOW_SKILL_DIRS — plugin skills register
   * after user/project but before env dirs, so a same-named skill in an env
   * dir overrides a plugin skill (higher priority).
   *
   * Default: empty array — behavior identical to before.
   */
  pluginSkillDirs?: readonly PluginSkillDir[];
  /**
   * Observer seam for real IO failures (non-ENOENT), fired once per failure
   * **after** the existing warn (warn surface unchanged). Without it, failures
   * just warn + skip and the scan never throws (assembly-time discipline).
   *
   * The injector (`skill/rescan.ts`) upgrades a partial scan to a typed
   * error — the opposite trade-off, since results pasted to the model must
   * not be misread as "these skills were deleted". Both disciplines coexist
   * through this seam.
   */
  onIoFailure?: (failure: SkillIoFailure) => void;
}

export interface SkillScanner {
  scan(): Promise<SkillEntry[]>;
}

/**
 * Observation channel for real IO failures (non-ENOENT).
 *
 * The scanner's standing discipline is "bad root / bad file → warn + skip,
 * never block the scan" (one unreadable dir must not sink a whole build).
 * The rescan path needs the opposite: a partial scan pasted to the model
 * could be misread as deleted skills, so failures must be visible to the
 * caller and treatable as a typed error. Both disciplines coexist by
 * separating "record it" from "react to it": the scanner still swallows IO
 * errors but reports each one verbatim through this callback. Without an
 * injector, behavior is byte-identical to the warn-only status quo.
 */
export interface SkillIoFailure {
  /**
   * `root_unreadable` = readdir of the skill root itself failed (whole root
   * missing); `file_unreadable` = one SKILL.md readFile failed (that skill
   * missing).
   */
  readonly kind: "root_unreadable" | "file_unreadable";
  /** The failing path: a root dir, or `<dir>/SKILL.md`. */
  readonly path: string;
  /** Underlying errno (`EACCES` / `EIO` …); undefined for non-errno throws. */
  readonly code: string | undefined;
  /** `Error#message` (or `String(err)` for non-Error throws). */
  readonly cause: string;
}

export function createSkillScanner(options: SkillScannerOptions): SkillScanner {
  return Object.freeze({ scan: () => scanSkillDirs(options) });
}

export async function scanSkillDirs(
  options: SkillScannerOptions
): Promise<SkillEntry[]> {
  const warn = options.warn ?? console.warn;
  /**
   * The single exit that turns IO failures into observation events: keep the
   * existing warn + skip discipline, then hand the raw fact to the optional
   * observer. Both — warn is the established assembly-time surface (tests and
   * logs depend on it); the callback is rescan's typed exit.
   */
  const reportIoFailure: ReportIoFailure = (failure, message) => {
    warn(message);
    options.onIoFailure?.(failure);
  };
  const index = new Map<string, SkillEntry>();
  // Bare alias → the entry that first claimed that bare name (bare-name
  // conflict → keep only the canonical name + warn). The scanner warns while
  // entries are built, keeping a single warn entry point and a clean catalog
  // interface; the catalog's internal bareIndex behavior is unchanged
  // (second set into the same map is a silent noop).
  const bareOwner = new Map<string, SkillEntry>();
  // Round 1: user / project / plugin → index (later same-name wins, so plugin overrides user/project)
  for (const root of scanRoots(options)) {
    for (const entry of await scanRoot(
      root.dir,
      root.namespace,
      warn,
      reportIoFailure
    )) {
      registerBareAlias(entry, bareOwner, warn);
      index.set(entry.name, entry);
    }
  }
  // Round 2: IKNOW_SKILL_DIRS (highest priority, last write overrides plugins)
  for (const dir of extrasDirs(options.env)) {
    for (const entry of await scanRoot(dir, undefined, warn, reportIoFailure))
      index.set(entry.name, entry);
  }
  return [...index.values()];
}

/**
 * Register bare-alias ownership (the scanner warns as entries land, keeping
 * one entry point). Only plugin entries reach here; user/project entries have
 * no namespace and return immediately.
 */
function registerBareAlias(
  entry: SkillEntry,
  bareOwner: Map<string, SkillEntry>,
  warn: Warn
): void {
  const namespace = entry.namespace;
  if (namespace === undefined) return;
  if (entry.namespace === entry.name) return;
  const bare = stripNamespace(entry.name, namespace);
  if (bare === undefined) return;
  if (!bareOwner.has(bare)) {
    bareOwner.set(bare, entry);
    return;
  }
  // EXIT: the bare alias was claimed by an earlier entry (builtin / user /
  // another plugin) → drop the alias (the catalog still indexes the canonical
  // name, but bareIndex no longer points here) + warn once. Canonical kept.
  const prior = bareOwner.get(bare)!;
  warn(
    `skill bare alias '${bare}' already taken by '${prior.name}'; namespace entry '${entry.name}' keeps canonical only`
  );
}

interface ScannedRoot {
  readonly dir: string;
  readonly namespace: string | undefined;
}

function scanRoots({
  userHome,
  projectIdentityRoot,
  pluginSkillDirs,
}: SkillScannerOptions): ReadonlyArray<ScannedRoot> {
  const plugins: ScannedRoot[] = (pluginSkillDirs ?? []).map((p) => ({
    dir: p.dir,
    namespace: p.plugin,
  }));
  return [
    { dir: join(userHome, ".iknow", "skills"), namespace: undefined },
    {
      dir: join(projectIdentityRoot, ".iknow", "skills"),
      namespace: undefined,
    },
    ...plugins,
  ];
}

/** Split env IKNOW_SKILL_DIRS, kept separate from the regular root order for priority control. */
function extrasDirs(env: SkillEnv): string[] {
  return (env.IKNOW_SKILL_DIRS ?? "")
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => resolve(dir));
}

/**
 * Scan a single root. `namespace` is undefined for regular user/project roots
 * (no namespace field; entry.name is the frontmatter name / dir basename).
 * Plugin roots pass a namespace: entry.name becomes the canonical
 * `<namespace>:<bare>`, and the namespace field lets the catalog index bare
 * aliases.
 */
async function scanRoot(
  root: string,
  namespace: string | undefined,
  warn: Warn,
  reportIoFailure: ReportIoFailure
): Promise<SkillEntry[]> {
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    reportIoFailure(
      toIoFailure("root_unreadable", root, error),
      `skill scan skipped directory: ${root}`
    );
    return [];
  }

  const entries: SkillEntry[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const dir = join(root, child.name);
    const parsed = await readSkill(dir, warn, reportIoFailure);
    if (parsed === undefined) continue;
    if (namespace !== undefined) {
      // Plugin skill: bare name from frontmatter (preferred) or dir basename;
      // the catalog index expects the canonical `<plugin>:<bare>` name.
      const bare = parsed.frontmatter.name
        ? parsed.frontmatter.name
        : basename(dir);
      const entry: SkillEntry = {
        ...parsed.entry,
        name: `${namespace}:${bare}`,
        namespace,
      };
      entries.push(entry);
    } else {
      entries.push(parsed.entry);
    }
  }
  return entries;
}

async function readSkill(
  dir: string,
  warn: Warn,
  reportIoFailure: ReportIoFailure
): Promise<{ entry: SkillEntry; frontmatter: SkillFrontmatter } | undefined> {
  const file = join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    reportIoFailure(
      toIoFailure("file_unreadable", file, error),
      `skill skipped unreadable file: ${file}`
    );
    return undefined;
  }

  const fence = stripFence(raw);
  if (!fence.found) {
    warn(`skill skipped malformed frontmatter: ${file}`);
    return undefined;
  }
  // Degradation is block-atomic and reported by the shared parser: a rejected
  // block yields no fields at all, so `toEntry` falls back to the directory
  // name and the skill stays indexed — never silent, never partly parsed.
  const { fields, warnings } = parseFrontmatter(fence.block);
  for (const warning of warnings)
    warn(`skill frontmatter degraded: ${file}: ${warning}`);
  return { entry: toEntry(fields, dir, warn), frontmatter: fields };
}

function toEntry(
  frontmatter: SkillFrontmatter,
  dir: string,
  warn: Warn
): SkillEntry {
  const file = join(dir, "SKILL.md");
  // description and when_to_use share the cap constant but each field gets
  // its own budget: neither one's length can shorten the other's.
  const truncate = (
    value: string | undefined,
    label: string
  ): string | undefined => {
    if (value === undefined || value.length <= DESCRIPTION_LIMIT) return value;
    warn(`skill ${label} truncated: ${file}`);
    return value.slice(0, DESCRIPTION_LIMIT);
  };
  const description = truncate(frontmatter.description, "description");
  const whenToUse = truncate(frontmatter.when_to_use, "when_to_use");
  const entry: SkillEntry = {
    name: frontmatter.name ? frontmatter.name : basename(dir),
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    dir,
    // The coerce boundary is string-only, so the YAML boolean arrives as "true".
    disabled: frontmatter["disable-model-invocation"] === "true",
  };
  for (const key of ARCHIVED_KEYS) {
    const value = frontmatter[key];
    if (value !== undefined)
      (entry as unknown as Record<string, unknown>)[key] = value;
  }
  return entry;
}

/** Internal seam signature: one failure yields both the structured fact and the existing warn text. */
type ReportIoFailure = (failure: SkillIoFailure, message: string) => void;

/**
 * Raw thrown value → `SkillIoFailure`. `code` is taken only from real Errors
 * carrying a `code` field (errno shape); everything else degrades to
 * undefined — callers classify by `kind` + `path`, never assuming a code.
 */
function toIoFailure(
  kind: SkillIoFailure["kind"],
  path: string,
  error: unknown
): SkillIoFailure {
  return {
    kind,
    path,
    code:
      error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined,
    cause: error instanceof Error ? error.message : String(error),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
