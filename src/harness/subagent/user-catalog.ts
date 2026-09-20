/**
 * User agents catalog — custom subagent role files under `~/.iknow/agents/`.
 *
 * Role files follow the AGENTS.md convention (mirroring `<dir>/SKILL.md` for
 * skills), in two layouts:
 *   - `~/.iknow/agents/<id>/AGENTS.md` (one directory per role)
 *   - `~/.iknow/agents/<id>.md` (flat file, id = basename)
 *
 * Format: optional `---` frontmatter with keys `description` (string),
 * `bashMode` ("any" | "readonly"), `disallowedTools` (comma-separated tool
 * names); the text after frontmatter is the persona body, injected into the
 * worker system prompt through the same channel as builtin catalog bodies.
 * No frontmatter → the whole file is body, description falls back to
 * `User-defined subagent role '<id>'.`.
 *
 * Scanning must be **synchronous**: the spawn_subagent factory derives its
 * inputSchema enum and prose list from `catalog.list()` during assembly, so
 * an async scan would miss the enum build window. The directory is small, so
 * readdirSync cost is negligible.
 *
 * Merge semantics (createMergedCatalogResolver):
 *   - builtins first (explore, general-purpose); user / plugin entries are
 *     appended in merged order; an id colliding with a builtin → warn + skip
 *     (builtin is authoritative — explore's readonly isolation and similar
 *     guarantees must not be silently replaced by user/plugin entries);
 *   - caching memoizes per resolved agentsDir (one scan per process); tests
 *     call resetUserAgentsCache(), which also clears the plugin cache.
 *
 * Plugin agents: ROLE_ID_PATTERN allows `:` so canonical ids take the
 * `<plugin>:<basename>` form from `<pluginRoot>/agents/*.md`. Bare-name
 * aliases are registered only when unclaimed by builtin / user / other-plugin
 * bare names; collisions → drop alias + warn. Id pass-through invariant: the
 * enum is derived from list(), the model passes ids verbatim, and handler /
 * capability forward them verbatim — zero normalize / trim / case-folding.
 *
 * Defensive contract: missing directory (ENOENT) → empty array (unconfigured
 * = pure builtin, byte-equivalent to prior behavior); empty body / invalid
 * frontmatter values / invalid id → warn + degrade (description fallback /
 * key treated as undefined / skip the file), never throw — hand-written role
 * files must not break the spawn assembly chain.
 */
import { basename, join, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  AgentCatalogLookupError,
  resolveAgentCatalog,
  type AgentCatalogEntry,
  type AgentCatalogResolver,
} from "./catalog.js";
import {
  enumeratePluginAgentDirs,
  resolvePluginRoots,
} from "../plugin/roots.js";

/** Global agents directory name (`<home>/.iknow/<dirname>`). */
const USER_AGENTS_DIRNAME = "agents";
/** Role file name (required inside a directory-layout role dir). */
const ROLE_FILENAME = "AGENTS.md";
/** Description truncation limit (aligned with the skill scanner's DESCRIPTION_LIMIT). */
const DESCRIPTION_LIMIT = 1536;
/**
 * Valid role id: starts alphanumeric, contains only alnum - _ : (the surface
 * that reaches the enum + prose list). `:` carries the `<plugin>:<id>`
 * namespace form.
 */
const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MD_SUFFIX = /\.md$/i;

type Warn = (message: string) => void;

export interface UserAgentScanOptions {
  /** User home, defaults to os.homedir(). Test seam: tmp fixtures isolate the real user dir. */
  readonly home?: string;
  /** Explicit override of the whole agents dir path (test seam), takes precedence over home. */
  readonly agentsDir?: string;
  /** Warn channel, defaults to console.warn. */
  readonly warn?: Warn;
  /**
   * Plugin agent directories (absolute `<pluginRoot>/agents` paths). When
   * omitted, createMergedCatalogResolver() self-resolves them via
   * plugin/roots.ts (env IKNOW_PLUGIN_ROOTS > settings.plugins.roots >
   * ~/.iknow/plugins), keeping the spawn tool surface and the capability
   * resolution surface same-sourced — tests inject explicitly to isolate
   * real plugin directories.
   */
  readonly pluginAgentDirs?: readonly string[];
  /**
   * Plugin namespace mapping (pluginDir → pluginName), positionally aligned
   * with pluginAgentDirs. When omitted, inferred from each dir's parent
   * basename (the `<pluginRoot>` name, directory-scan shape); tests can
   * inject to decouple from fixture temp-dir basenames.
   */
  readonly pluginNames?: readonly string[];
}

export function resolveUserAgentsDir(opts: UserAgentScanOptions = {}): string {
  if (opts.agentsDir !== undefined) return resolve(opts.agentsDir);
  return join(opts.home ?? homedir(), ".iknow", USER_AGENTS_DIRNAME);
}

/** Parsed (frontmatter, body) of one role file; frontmatter is empty when absent. */
function splitFrontmatter(
  raw: string,
  filePath: string,
  warn: Warn
): { frontmatter: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }
  return {
    frontmatter: parseFrontmatterBlock(match[1], filePath, warn),
    body: raw.slice(match[0].length).trim(),
  };
}

/**
 * Frontmatter key-value parsing: `key: scalar` per line (same shape as the
 * skill scanner's parseFrontmatter). All keys here are string-valued — no
 * number/boolean coercion, since bashMode/disallowedTools are string
 * literals.
 */
function parseFrontmatterBlock(
  block: string,
  filePath: string,
  warn: Warn
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!key) {
      if (line.trim()) {
        warn(`user agent skipped malformed frontmatter line: ${filePath}`);
      }
      continue;
    }
    parsed[key] = line.slice(separator + 1).trim();
  }
  return parsed;
}

function parseDescription(
  frontmatter: Record<string, string>,
  filePath: string,
  warn: Warn
): string | undefined {
  const raw = frontmatter.description;
  if (raw === undefined || raw === "") return undefined;
  if (raw.length <= DESCRIPTION_LIMIT) return raw;
  warn(`user agent description truncated: ${filePath}`);
  return raw.slice(0, DESCRIPTION_LIMIT);
}

function parseBashMode(
  frontmatter: Record<string, string>,
  filePath: string,
  warn: Warn
): AgentCatalogEntry["bashMode"] {
  const raw = frontmatter.bashMode;
  if (raw === "readonly" || raw === "any") return raw;
  if (raw !== undefined) {
    warn(`user agent ignored invalid bashMode '${raw}': ${filePath}`);
  }
  return undefined;
}

function parseDisallowedTools(
  frontmatter: Record<string, string>,
  filePath: string,
  warn: Warn
): ReadonlyArray<string> | undefined {
  const raw = frontmatter.disallowedTools;
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    warn(`user agent ignored empty disallowedTools: ${filePath}`);
    return undefined;
  }
  return Object.freeze(names);
}

/** One role file → entry. Unparseable (empty body) → undefined (caller skips). */
function parseRoleFile(
  id: string,
  raw: string,
  filePath: string,
  warn: Warn
): AgentCatalogEntry | undefined {
  const { frontmatter, body } = splitFrontmatter(raw, filePath, warn);
  if (body.length === 0) {
    warn(`user agent skipped empty body: ${filePath}`);
    return undefined;
  }
  const description =
    parseDescription(frontmatter, filePath, warn) ??
    `User-defined subagent role '${id}'.`;
  const bashMode = parseBashMode(frontmatter, filePath, warn);
  const disallowedTools = parseDisallowedTools(frontmatter, filePath, warn);
  return Object.freeze({
    id,
    description,
    body,
    ...(bashMode !== undefined ? { bashMode } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
  });
}

/**
 * Read one role file. `missingIsSilent`: in directory layout a missing
 * AGENTS.md = not a role dir, skip silently (same tolerance the skill
 * scanner shows for dirs without SKILL.md); a failed flat-file read warns.
 * All other read errors warn.
 */
function readRoleSource(
  filePath: string,
  missingIsSilent: boolean,
  warn: Warn
): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (!(isMissing(error) && missingIsSilent)) {
      warn(`user agent skipped unreadable file: ${filePath}`);
    }
    return undefined;
  }
}

/** dirent → role location (id + file path). Non-role shapes (dirs are handled by the reader's missing-file tolerance; non-md files) → undefined. */
function childRoleLocation(
  root: string,
  child: { isDirectory(): boolean; isFile(): boolean; name: string }
): { id: string; filePath: string } | undefined {
  if (child.isDirectory()) {
    return { id: child.name, filePath: join(root, child.name, ROLE_FILENAME) };
  }
  if (child.isFile() && MD_SUFFIX.test(child.name)) {
    return {
      id: child.name.replace(MD_SUFFIX, ""),
      filePath: join(root, child.name),
    };
  }
  return undefined;
}

/**
 * Synchronous scan of `~/.iknow/agents/`. Missing dir → [] (silent); other
 * readdir errors → warn + []. Dirents sorted by name keep results
 * deterministic when a directory and a flat file collide on id (first wins,
 * the later one warn-dropped).
 */
export function loadUserAgentEntries(
  opts: UserAgentScanOptions = {}
): ReadonlyArray<AgentCatalogEntry> {
  const warn = opts.warn ?? console.warn;
  const root = resolveUserAgentsDir(opts);
  let children;
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    warn(`user agents scan skipped directory: ${root}`);
    return [];
  }

  const entries: AgentCatalogEntry[] = [];
  const seenIds = new Set<string>();
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sorted) {
    const location = childRoleLocation(root, child);
    if (location === undefined) continue;
    if (!ROLE_ID_PATTERN.test(location.id)) {
      warn(`user agent skipped invalid role id '${location.id}'`);
      continue;
    }
    if (seenIds.has(location.id)) {
      warn(
        `user agent id '${location.id}' already defined; skipped: ${location.filePath}`
      );
      continue;
    }
    const raw = readRoleSource(location.filePath, child.isDirectory(), warn);
    if (raw === undefined) continue;
    const entry = parseRoleFile(location.id, raw, location.filePath, warn);
    if (entry === undefined) continue;
    seenIds.add(location.id);
    entries.push(entry);
  }
  return entries;
}

/**
 * In-process memoization keyed by resolved agentsDir: the directory is read
 * once per process lifetime (spawn assembly / worker assembly each hit once);
 * directory changes take effect only after a restart. Tests must call
 * resetUserAgentsCache() after writing fixtures.
 */
const userAgentsCache = new Map<string, ReadonlyArray<AgentCatalogEntry>>();

export function resetUserAgentsCache(): void {
  userAgentsCache.clear();
  // Clear the plugin agent cache too, otherwise fixture writes stay
  // invisible to a second createMergedCatalogResolver() in the same process.
  pluginAgentsCache.clear();
}

function cachedUserEntries(
  opts: UserAgentScanOptions
): ReadonlyArray<AgentCatalogEntry> {
  const root = resolveUserAgentsDir(opts);
  const cached = userAgentsCache.get(root);
  if (cached !== undefined) return cached;
  const entries = loadUserAgentEntries(opts);
  userAgentsCache.set(root, entries);
  return entries;
}

/**
 * builtin + user + plugin merged resolver (the default catalog source
 * shared by the spawn tool / capability / worker).
 *
 * Merge order: builtin < user < plugin. builtin is authoritative — any
 * builtin-colliding id → warn + skip (same rule for user and plugin). Bare
 * aliases are registered only when unclaimed by builtin / user / other
 * plugins.
 *
 * Id pass-through invariant: between list() → model → handler / capability
 * there is **zero normalize, zero trim, zero case-folding**. get(id) is a
 * reference compare + strict equality over the array — any leading/trailing
 * whitespace or case difference in the id string hits
 * AgentCatalogLookupError (fail-fast). The invariant is pinned by the
 * `whitespace id not accepted` test.
 *
 * Default resolution: when opts omit pluginAgentDirs / pluginNames,
 * createMergedCatalogResolver self-resolves plugin roots (plugin/roots.ts →
 * env > settings > ~/.iknow/plugins), so the spawn tool surface and the
 * capability resolution surface stay same-sourced — callers passing no opts
 * still see plugins.
 *
 * Memoization: user and plugin each cache by resolved agentsDir / plugin
 * root set. resetUserAgentsCache() clears both.
 */
/**
 * Append entries deduped by canonical id (user surface): builtin-occupied →
 * warn + skip (builtin authoritative); occupied by an earlier user / plugin
 * entry → warn + skip (first wins); otherwise register the id and append.
 * Returns the appended entries for the caller to push into merged.
 */
function appendUniqueById(
  entries: ReadonlyArray<AgentCatalogEntry>,
  source: "user" | "plugin",
  builtinIds: ReadonlySet<string>,
  seenIds: Set<string>,
  warn: Warn
): AgentCatalogEntry[] {
  const appended: AgentCatalogEntry[] = [];
  for (const entry of entries) {
    if (builtinIds.has(entry.id)) {
      warn(
        `${source} agent '${entry.id}' collides with builtin catalog entry; builtin kept`
      );
      continue;
    }
    if (seenIds.has(entry.id)) {
      warn(
        `${source} agent '${entry.id}' collides with earlier entry; earlier kept`
      );
      continue;
    }
    seenIds.add(entry.id);
    appended.push(entry);
  }
  return appended;
}

/**
 * Plugin entry append: canonical ids follow the same discipline as
 * appendUniqueById, plus a bare-alias occupancy check — if the bare name is
 * already taken by builtin / user / another plugin, drop the alias
 * (stripBareAlias rebuilds the entry, since frozen objects can't delete);
 * if free, register the alias in seenIds first, so a later canonical
 * collision is detected directly.
 */
function appendPluginEntries(
  entries: ReadonlyArray<AgentCatalogEntry>,
  builtinIds: ReadonlySet<string>,
  seenIds: Set<string>,
  warn: Warn
): AgentCatalogEntry[] {
  const appended: AgentCatalogEntry[] = [];
  for (const entry of entries) {
    if (builtinIds.has(entry.id)) {
      warn(
        `plugin agent '${entry.id}' collides with builtin catalog entry; builtin kept`
      );
      continue;
    }
    if (seenIds.has(entry.id)) {
      warn(
        `plugin agent '${entry.id}' collides with earlier entry; earlier kept`
      );
      continue;
    }
    seenIds.add(entry.id);
    appended.push(keepAliasOrStrip(entry, builtinIds, seenIds, warn));
  }
  return appended;
}

/** Bare-alias occupancy check for one plugin entry (see appendPluginEntries). */
function keepAliasOrStrip(
  entry: AgentCatalogEntry,
  builtinIds: ReadonlySet<string>,
  seenIds: Set<string>,
  warn: Warn
): AgentCatalogEntry {
  const alias = entry.bareAlias;
  if (alias === undefined || alias.length === 0) return entry;
  if (builtinIds.has(alias) || seenIds.has(alias)) {
    warn(
      `plugin agent bare alias '${alias}' (canonical '${entry.id}') collides with earlier entry; alias dropped`
    );
    return stripBareAlias(entry);
  }
  seenIds.add(alias);
  return entry;
}

export function createMergedCatalogResolver(
  opts: UserAgentScanOptions = {}
): AgentCatalogResolver {
  const warn = opts.warn ?? console.warn;
  const userEntries = cachedUserEntries(opts);
  const pluginSources = resolvePluginAgentSources(opts);
  const pluginEntries = pluginSources.flatMap((source) =>
    cachedPluginEntries(source, warn)
  );
  const builtinIds = new Set(resolveAgentCatalog().map((e) => e.id));

  // Collision resolution (builtin authoritative + bare aliases): first
  // exclude builtin clashes by canonical id, then dedupe bare names across
  // the remaining plugin / user entries.
  const seenIds = new Set<string>();
  const merged: AgentCatalogEntry[] = [...resolveAgentCatalog()];

  merged.push(
    ...appendUniqueById(userEntries, "user", builtinIds, seenIds, warn)
  );

  // Plugin entries already carry a canonical id ("<plugin>:<basename>") and
  // an optional bareAlias typed field (AgentCatalogEntry.bareAlias).
  merged.push(...appendPluginEntries(pluginEntries, builtinIds, seenIds, warn));

  const frozen: ReadonlyArray<AgentCatalogEntry> = Object.freeze(merged);
  return Object.freeze({
    list: () => frozen,
    get: (id: string) => {
      // Strict canonical-id lookup: list already contains canonical entries
      // (some carrying a bareAlias). The alias path is a linear fallback
      // only when the canonical find misses, in merge order
      // (builtin < user < plugin) — first wins on alias collision.
      const direct = frozen.find((e) => e.id === id);
      if (direct !== undefined) return direct;
      const aliased = frozen.find((e) => e.bareAlias === id);
      if (aliased !== undefined) return aliased;
      throw new AgentCatalogLookupError(id);
    },
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// ─── plugin agent sources ────────────────────────────────────────────────────

/**
 * Resolve plugin agent sources — test injection wins; otherwise delegate to
 * plugin/roots.ts (env / settings / default-root chain), keeping the spawn
 * tool surface and the capability resolution surface same-sourced: two
 * default createMergedCatalogResolver() calls see the same plugin set.
 *
 * The default path uses enumeratePluginAgentDirs (sync, ledger-first with
 * directory-scan fallback). The ledger read is synchronized (readFileSync +
 * the same validation), with no reliance on an assembly-time awaited cache.
 * When the ledger is present, its key prefix (before `@`) is the namespace;
 * the directory-scan fallback only kicks in when the ledger is missing or
 * corrupt → the spawn enum and capability surfaces share one source and the
 * namespace cannot drift.
 */
function resolvePluginAgentSources(
  opts: UserAgentScanOptions
): ReadonlyArray<PluginAgentSource> {
  if (opts.pluginAgentDirs !== undefined) {
    return opts.pluginAgentDirs.map((dir, i) => ({
      dir,
      plugin: opts.pluginNames?.[i] ?? basename(resolve(dir)),
    }));
  }
  const rootsOpts: Parameters<typeof resolvePluginRoots>[0] = {
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
    ...(opts.home !== undefined ? { userHome: opts.home } : {}),
  };
  const pluginRoots = resolvePluginRoots(rootsOpts);
  if (pluginRoots.length === 0) return [];
  return enumeratePluginAgentDirs(pluginRoots, {
    ...(opts.warn !== undefined ? { warn: opts.warn } : {}),
  });
}

/** Plugin agent source: dir = <pluginRoot>/agents; plugin = namespace. */
interface PluginAgentSource {
  readonly dir: string;
  readonly plugin: string;
}

/** In-process memoization keyed by resolved pluginDir. resetUserAgentsCache clears both caches. */
const pluginAgentsCache = new Map<string, ReadonlyArray<AgentCatalogEntry>>();

function cachedPluginEntries(
  source: PluginAgentSource,
  warn: Warn
): ReadonlyArray<AgentCatalogEntry> {
  const cached = pluginAgentsCache.get(source.dir);
  if (cached !== undefined) return cached;
  const entries = loadPluginAgentEntries(source, warn);
  pluginAgentsCache.set(source.dir, entries);
  return entries;
}

/**
 * Scan role files under `<pluginDir>` (i.e. `<pluginRoot>/agents`): same
 * shape as loadUserAgentEntries (dir / flat dual forms) but flat-only —
 * plugins use flat `<basename>.md` files, not the user directory layout.
 */
function loadPluginAgentEntries(
  source: PluginAgentSource,
  warn: Warn
): ReadonlyArray<AgentCatalogEntry> {
  let children;
  try {
    children = readdirSync(source.dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return Object.freeze([]);
    warn(`plugin agents scan skipped directory: ${source.dir}`);
    return Object.freeze([]);
  }

  const entries: AgentCatalogEntry[] = [];
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sorted) {
    // Plugin agents are flat .md files only; the directory layout is
    // exclusive to user agents. Directories under a plugin agents dir are
    // silently skipped.
    if (!child.isFile() || !MD_SUFFIX.test(child.name)) continue;
    const bare = child.name.replace(MD_SUFFIX, "");
    const canonicalId = `${source.plugin}:${bare}`;
    if (!ROLE_ID_PATTERN.test(canonicalId)) {
      warn(`plugin agent skipped invalid role id '${canonicalId}'`);
      continue;
    }
    const filePath = join(source.dir, child.name);
    const raw = readRoleSource(filePath, false, warn);
    if (raw === undefined) continue;
    const entry = parseRoleFile(canonicalId, raw, filePath, warn);
    if (entry === undefined) continue;
    // Bare alias as the typed field `AgentCatalogEntry.bareAlias`, attached
    // before freezing (assigning after Object.freeze would throw TypeError).
    const withAlias = Object.freeze({
      ...entry,
      bareAlias: bare,
    }) as AgentCatalogEntry;
    entries.push(withAlias);
  }
  return Object.freeze(entries);
}

/**
 * Drop the bare alias by rebuilding the entry via spread without the field
 * and re-freezing — the entry is already frozen, so delete is not possible.
 */
function stripBareAlias(entry: AgentCatalogEntry): AgentCatalogEntry {
  const { bareAlias: _stripped, ...rest } = entry;
  void _stripped;
  return Object.freeze(rest) as AgentCatalogEntry;
}
