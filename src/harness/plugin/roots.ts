/**
 * Global plugin loading — discovery layer (root resolution + plugin recognition).
 *
 * Boundaries:
 *   - This module produces data only; it never assembles (no imports from
 *     skill/ subagent/ hooks/ permission/). Dependencies point skill/subagent/
 *     hooks → plugin, never the reverse.
 *   - Orthogonal to `session-roots.ts`: these roots are component sources, not
 *     session roots — they take no part in fence computation and are unaffected
 *     by worktree rebind.
 *
 * Root resolution order (resolvePluginRoots):
 *   1. Explicit `opts.pluginRoots` (test seam);
 *   2. Env var `IKNOW_PLUGIN_ROOTS` (path.delimiter separated);
 *   3. User settings `plugins.roots`;
 *   4. Default `<userHome>/.iknow/plugins`.
 * Merged in order + deduped; missing roots are skipped silently (unconfigured
 * is a legal state, not a degradation).
 *
 * Plugin discovery (discoverPlugins) has two isomorphic paths, both producing
 * PluginInstallation[]:
 *   - Ledger first: `<root>/installed_plugins.json` gives exact names +
 *     installPaths at any depth; the key part before `@` = plugin namespace.
 *     Multiple records under one key: `scope === "user"` wins, otherwise the
 *     last entry. Missing / non-absolute / unreadable installPath → skip +
 *     warn. Corrupt JSON → whole file skipped, directory scan takes over.
 *   - Directory scan fallback: for each direct child dir D of the root, if D
 *     contains skills/agents/hooks → plugin = D, name = basename(D); else if D
 *     has exactly one child dir V containing component dirs → plugin = V,
 *     name still basename(D) (the dropped-in dir name is what the user sees).
 *
 * Skip rules (both paths): node_modules/, .git/, names starting with `.`,
 * names containing `:` (WSL shadow artifacts); symlinks are not followed.
 *
 * Enabled state: `plugins.disabled: string[]` skips plugins wholesale;
 * absent = enabled. The filtering itself happens in the assembly layer.
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type {
  IknowSettings,
  IknowSettingsPlugins,
} from "../../config/settings.js";
import { createPluginCatalog, type PluginCatalog } from "./catalog.js";

/**
 * Minimal fact about one installed plugin (discovery data carrier).
 * `marketplace` / `version` exist only for ledger-sourced entries — the
 * directory-scan fallback cannot infer them and does not guess.
 */
export interface PluginInstallation {
  /** Plugin name = namespace prefix (skills are addressed `<plugin>:<name>`). */
  readonly name: string;
  /** Plugin root dir (absolute, contains the skills/agents/hooks subtree). */
  readonly root: string;
  /** Marketplace parsed from the ledger; undefined for scan-sourced entries. */
  readonly marketplace?: string;
  /** Version parsed from the ledger; undefined for scan-sourced entries. */
  readonly version?: string;
}

/** Injection seams: default warn goes to console.warn; default home to os.homedir(). */
export type PluginWarn = (message: string) => void;

/** Injectable sources for resolvePluginRoots (tests set env / settings / home). */
export interface ResolvePluginRootsOptions {
  /** Explicit root list (highest priority, test seam); non-array → treated as absent. */
  readonly pluginRoots?: readonly string[];
  /** Environment source; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** User home; defaults to os.homedir(). */
  readonly userHome?: string;
  /** Resolved settings; only `plugins.roots` is read here. */
  readonly settings?: Pick<IknowSettings, "plugins">;
  /** Warn channel; defaults to console.warn. */
  readonly warn?: PluginWarn;
}

/**
 * Merge root sources in priority order (explicit > env IKNOW_PLUGIN_ROOTS >
 * settings plugins.roots > default), dedupe keeping the first occurrence, and
 * drop nonexistent dirs. When one plugin name appears in several roots, the
 * earliest root wins.
 */
export function resolvePluginRoots(
  opts: ResolvePluginRootsOptions = {}
): ReadonlyArray<string> {
  // Candidates concatenated by priority (explicit > env > settings > default);
  // each segment filters its own invalid/empty entries, so an unconfigured
  // segment contributes nothing without disturbing the rest.
  const env = opts.env ?? process.env;
  const candidates: string[] = [
    ...normalizeRootList(opts.pluginRoots),
    ...normalizeEnvRoots(env.IKNOW_PLUGIN_ROOTS),
    ...normalizeRootList(opts.settings?.plugins?.roots),
  ];

  const home = opts.userHome ?? homedir();
  candidates.push(resolve(join(home, ".iknow", "plugins")));

  return distinctExistingDirs(candidates);
}

/**
 * Normalize explicit/settings root lists: drop non-strings and blank entries,
 * resolve the rest to absolute paths. The raw value is never trimmed — trim
 * only detects blanks (a path may legitimately start with a space). Input
 * order is preserved, which is what makes "earliest root wins" work.
 */
function normalizeRootList(raw: readonly string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (value.trim().length === 0) continue;
    out.push(resolve(value));
  }
  return out;
}

/** env IKNOW_PLUGIN_ROOTS: split on path.delimiter, trim each segment, resolve. */
function normalizeEnvRoots(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const out: string[] = [];
  for (const segment of raw.split(delimiter)) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) out.push(resolve(trimmed));
  }
  return out;
}

/**
 * Dedupe preserving first occurrence (earliest root wins) + drop nonexistent
 * dirs. Result is frozen: callers must not rely on mutability.
 */
function distinctExistingDirs(
  candidates: readonly string[]
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    if (!existsSync(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return Object.freeze(out);
}

/**
 * Injection seams for discoverPlugins. `disabled` filtering is the assembly
 * layer's job (build-engine / worker each filter by
 * `settings.plugins.disabled` before calling) — this function only produces
 * data and never makes enable/disable decisions.
 */
export interface DiscoverPluginsOptions {
  /** Warn channel; defaults to console.warn. */
  readonly warn?: PluginWarn;
}

/**
 * Recognize plugins inside one root: ledger first, directory scan as
 * fallback. Missing / non-directory root → [] (silent, same behavior as
 * resolvePluginRoots). Enable/disable decisions live in the assembly layer.
 */
export async function discoverPlugins(
  root: string,
  opts: DiscoverPluginsOptions = {}
): Promise<ReadonlyArray<PluginInstallation>> {
  const warn = opts.warn ?? console.warn;
  if (!existsSync(root)) return Object.freeze([]);

  const fromLedger = await readLedger(root, warn);
  if (fromLedger !== undefined) {
    return Object.freeze(fromLedger.map(freezePlugin));
  }

  return Object.freeze((await scanRootDir(root, warn)).map(freezePlugin));
}

/**
 * Full assembly chain shared by build-engine / worker: resolve roots → scan
 * per root → drop disabled plugins → build catalog. Filtering lives at the
 * assembly layer (discoverPlugins only produces data), so both call sites
 * follow one "scan per root, then remove disabled" path and cannot drift.
 * A single root's scan failure never aborts the round (discoverPlugins
 * already degrades to warn + []); installations keep declaration order
 * (roots are concatenated in order).
 *
 * The input takes the raw `plugins` settings section (not a caller-built
 * Set): the two-level optionality (section absent / field absent) is handled
 * once here. `disabled` absent = everything enabled.
 *
 * Precondition: the caller resolved `roots` with its own settings source
 * (engine: settings; worker: workerSettings). Returns a frozen
 * {catalog, enabled}; `enabled` is exposed because hooks-file placeholder
 * substitution needs the plugin-name → root-dir mapping. The snapshot is
 * safe to reuse across assembly points.
 */
export async function resolvePluginCatalog(input: {
  readonly roots: readonly string[];
  readonly plugins?: IknowSettingsPlugins;
}): Promise<{
  readonly catalog: PluginCatalog;
  readonly enabled: ReadonlyArray<PluginInstallation>;
}> {
  const found: PluginInstallation[] = [];
  for (const root of input.roots) {
    found.push(...(await discoverPlugins(root)));
  }
  const disabled = new Set(input.plugins?.disabled ?? []);
  const enabled = found.filter((plugin) => !disabled.has(plugin.name));
  const frozen: ReadonlyArray<PluginInstallation> = Object.freeze(enabled);
  return Object.freeze({
    catalog: createPluginCatalog(frozen),
    enabled: frozen,
  });
}

// ─── ledger ──────────────────────────────────────────────────────────────────

interface LedgerEntry {
  scope?: unknown;
  installPath?: unknown;
  version?: unknown;
}

interface Ledger {
  version?: unknown;
  plugins?: Record<string, LedgerEntry[]>;
}

/**
 * Read `<root>/installed_plugins.json`, merging multi-record entries per key.
 * `undefined` = ledger absent or corrupt → caller falls back to directory
 * scan. A returned array means the ledger is usable and no scan happens.
 */
async function readLedger(
  root: string,
  warn: PluginWarn
): Promise<ReadonlyArray<PluginInstallation> | undefined> {
  const file = join(root, "installed_plugins.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    // EXIT: ledger read failed (non-ENOENT: permission / IO) → warn + fall
    // back to directory scan; assembly is never blocked. Note the async path
    // warns with the *root* while the sync path warns with the file — kept
    // byte-for-byte for observability parity.
    warn(`plugin-init: ledger read failed for ${root}: ${errorMessage(err)}`);
    return undefined;
  }
  const ledger = parseLedgerText(raw, file, warn);
  if (ledger === undefined) return undefined;
  return toPluginInstallations(ledger, warn);
}

/**
 * Parse + top-level-validate ledger text; any failure returns undefined
 * (caller falls back to directory scan). Shared by both the async and sync
 * read paths so the same corrupt ledger degrades identically at every
 * assembly point. Failure branches (each warns with its own reason):
 *   - corrupt JSON → warn + undefined (whole file skipped);
 *   - non-object root / non-object `ledger.plugins` → warn + undefined.
 * On success `plugins` is guaranteed an object (callers need no re-check,
 * though the Ledger type keeps it optional).
 */
function parseLedgerText(
  raw: string,
  file: string,
  warn: PluginWarn
): Ledger | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // EXIT: corrupt JSON → whole file skipped, directory scan takes over.
    warn(
      `plugin-init: ledger JSON corrupt at ${file}: ${errorMessage(err)} — falling back to directory scan`
    );
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    // EXIT: ledger root is not an object → directory-scan fallback.
    warn(
      `plugin-init: ledger root is not an object at ${file} — falling back to directory scan`
    );
    return undefined;
  }
  const ledger = parsed as Ledger;
  if (!isPlainObject(ledger.plugins)) {
    // EXIT: ledger.plugins is not an object → directory-scan fallback.
    warn(
      `plugin-init: ledger.plugins is not an object at ${file} — falling back to directory scan`
    );
    return undefined;
  }
  return ledger;
}

/**
 * Ledger records → PluginInstallation; each entry succeeds or is skipped
 * independently (see splitLedgerKey for namespace/marketplace rules). The
 * async path carries marketplace/version; the sync path only takes
 * {root, plugin}, so the two map stages are implemented separately.
 */
function toPluginInstallations(
  ledger: Ledger,
  warn: PluginWarn
): PluginInstallation[] {
  const out: PluginInstallation[] = [];
  for (const [key, records] of Object.entries(ledger.plugins ?? {})) {
    if (!Array.isArray(records)) continue;
    const { name, marketplace } = splitLedgerKey(key);
    if (name.length === 0) continue;
    const picked = pickLedgerRecord(records, warn);
    if (picked === undefined) continue;
    const installed = toPluginInstallation(name, marketplace, picked, warn);
    if (installed !== undefined) out.push(installed);
  }
  return out;
}

/**
 * Ledger key → {name, marketplace}. Convention: `<plugin>@<marketplace>`;
 * `@` may be absent (no marketplace), and everything after the first `@` is
 * the marketplace name (it may itself contain `@`). Empty name = dirty key,
 * caller skips.
 */
function splitLedgerKey(key: string): {
  readonly name: string;
  readonly marketplace: string | undefined;
} {
  return {
    name: key.split("@")[0]?.trim() ?? "",
    marketplace: key.includes("@")
      ? key.split("@").slice(1).join("@")
      : undefined,
  };
}

/**
 * `scope === "user"` wins; otherwise the last usable record. Empty array →
 * undefined (the caller already handles the skip + warn case).
 */
function pickLedgerRecord(
  records: ReadonlyArray<LedgerEntry>,
  warn: PluginWarn
): LedgerEntry | undefined {
  if (records.length === 0) return undefined;
  const userPref = records.find((r) => isPlainObject(r) && r.scope === "user");
  if (userPref !== undefined) return userPref;
  // Fallback: scan backwards for any plain object in the array.
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const candidate = records[i];
    if (isPlainObject(candidate)) return candidate;
  }
  warn(`plugin-init: ledger entry has no usable record`);
  return undefined;
}

function toPluginInstallation(
  name: string,
  marketplace: string | undefined,
  record: LedgerEntry,
  warn: PluginWarn
): PluginInstallation | undefined {
  if (!shouldKeepName(name)) {
    // EXIT: invalid plugin name (`:`, leading `.`, empty) → skip + warn.
    // A dirty namespace would break `<plugin>:<id>` addressing, so reject it.
    warn(`plugin-init: ledger entry name '${name}' rejected`);
    return undefined;
  }
  const installPath = record.installPath;
  if (typeof installPath !== "string" || installPath.length === 0) {
    // EXIT: record missing installPath → skip + warn. The ledger entry is
    // unanchored; an empty string at assembly time is unrecoverable.
    warn(`plugin-init: plugin '${name}' missing installPath`);
    return undefined;
  }
  if (!isAbsolute(installPath)) {
    // EXIT: installPath not absolute → skip + warn. Resolving a relative
    // path at spawn time would reintroduce CWD drift; it must be absolute.
    warn(
      `plugin-init: plugin '${name}' installPath is not absolute: ${installPath}`
    );
    return undefined;
  }
  if (!existsSync(installPath)) {
    // EXIT: installPath unreadable → skip + warn; spawn cannot navigate into it.
    warn(
      `plugin-init: plugin '${name}' installPath unreadable: ${installPath}`
    );
    return undefined;
  }
  const version =
    typeof record.version === "string" ? record.version : undefined;
  return {
    name,
    root: installPath,
    ...(marketplace !== undefined ? { marketplace } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

// ─── directory scan fallback ──────────────────────────────────────────────────

/**
 * For each direct child dir D of the root:
 *   - D contains skills/agents/hooks → plugin = D, name = basename(D);
 *   - else D has exactly one child dir V containing component dirs →
 *     plugin = V, name still basename(D) (the dropped-in dir name is what
 *     the user sees).
 * Skips node_modules/, .git/, dot-prefixed names, names with `:`, symlinks.
 */
async function scanRootDir(
  root: string,
  warn: PluginWarn
): Promise<ReadonlyArray<PluginInstallation>> {
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    // EXIT: root scan failed (non-ENOENT: permission / IO) → warn + [].
    // Assembly continues; this root simply contributes no plugins.
    warn(`plugin-init: plugin root scan failed: ${root}: ${errorMessage(err)}`);
    return [];
  }
  const out: PluginInstallation[] = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (child.isSymbolicLink()) continue;
    const name = child.name;
    if (!shouldKeepName(name)) continue;
    const direct = join(root, name);
    if (await hasAnyComponents(direct)) {
      out.push({ name, root: direct });
      continue;
    }
    // Nested layout: <root>/<plugin>/<version>/{skills|agents|hooks}
    const nested = await pickSingleNestedVersion(direct);
    if (nested !== undefined) {
      out.push({ name, root: nested });
    }
  }
  return out;
}

/**
 * Does D contain any component dir (skills/agents readable, or hooks
 * containing hooks.json)? Empty component dirs still count — a scaffolded
 * plugin may be filled in later; existence of the dir is the criterion
 * (exception: hooks requires hooks.json).
 */
async function hasAnyComponents(dir: string): Promise<boolean> {
  try {
    await readdir(join(dir, "skills"));
    return true;
  } catch {
    // not readable → try agents
  }
  try {
    await readdir(join(dir, "agents"));
    return true;
  } catch {
    // still not found → try hooks
  }
  try {
    const children = await readdir(join(dir, "hooks"));
    if (children.includes("hooks.json")) return true;
  } catch {
    // nothing found → false
  }
  return false;
}

/**
 * If D has exactly one eligible child dir V and V contains component dirs →
 * V's absolute path; zero or more than one → undefined.
 */
async function pickSingleNestedVersion(
  dir: string
): Promise<string | undefined> {
  let children;
  try {
    children = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return undefined;
    // EXIT: nested dir unreadable (non-ENOENT) → undefined; only this nested
    // candidate is skipped, the outer scan continues.
    return undefined;
  }
  const subdirs = children.filter(
    (c) => c.isDirectory() && !c.isSymbolicLink() && shouldKeepName(c.name)
  );
  if (subdirs.length !== 1) return undefined;
  const candidate = join(dir, subdirs[0]!.name);
  if (await hasAnyComponents(candidate)) return candidate;
  return undefined;
}

// ─── sync agent-dir enumeration (for sync catalog resolver) ─────────────────

/**
 * Synchronous enumeration of plugin agent dirs — ledger first with
 * directory-scan fallback, same semantics as async `discoverPlugins` but with
 * sync IO. Both paths emit {dir, plugin} and are mutually exclusive (a valid
 * ledger suppresses the scan). Namespaces must come from the ledger: the scan
 * can only guess basename, which may differ from the ledger key — mixing the
 * two would make plugin agents enumerable yet invisible to capability
 * lookup. Used by the default path of `createMergedCatalogResolver` in
 * `subagent/user-catalog.ts` (spawn factories need a synchronous list()).
 * Missing dirs are skipped; `disabled` names are filtered; a corrupt or
 * absent ledger falls back to the scan.
 */
export function enumeratePluginAgentDirs(
  pluginRoots: readonly string[],
  opts: {
    disabled?: ReadonlySet<string>;
    warn?: PluginWarn;
  } = {}
): ReadonlyArray<{ readonly dir: string; readonly plugin: string }> {
  const warn = opts.warn ?? console.warn;
  const out: { dir: string; plugin: string }[] = [];
  for (const root of pluginRoots) {
    if (!existsSync(root)) continue;
    // Ledger first: the default path must be ledger-aware, or ledger-only
    // layouts would put skills in the catalog but agents out of the enum.
    const ledgerEntries = readLedgerSync(root, warn);
    if (ledgerEntries !== undefined) {
      collectAgentDirsFromLedger(ledgerEntries, opts.disabled, out);
      continue;
    }
    // Directory-scan fallback (ledger absent or corrupt).
    collectAgentDirsFromScan(root, opts.disabled, out);
  }
  return out;
}

/**
 * Ledger entries → collected {dir, plugin}. Namespace = ledger key part;
 * plugins whose `agents` subdir doesn't exist are skipped.
 */
function collectAgentDirsFromLedger(
  entries: ReadonlyArray<{ readonly root: string; readonly plugin: string }>,
  disabled: ReadonlySet<string> | undefined,
  out: { dir: string; plugin: string }[]
): void {
  for (const entry of entries) {
    if (disabled?.has(entry.plugin)) continue;
    const agentsDir = join(entry.root, "agents");
    if (existsSync(agentsDir)) {
      out.push({ dir: agentsDir, plugin: entry.plugin });
    }
  }
}

/**
 * Single-root scan fallback: direct and nested layouts, one pass each.
 * The disabled check gates both layouts at this level. Namespace = basename.
 */
function collectAgentDirsFromScan(
  root: string,
  disabled: ReadonlySet<string> | undefined,
  out: { dir: string; plugin: string }[]
): void {
  const children = readdirSyncSafe(root);
  if (children === undefined) return;
  for (const child of children) {
    if (!isPluginDirCandidate(child)) continue;
    if (disabled?.has(child.name)) continue;
    const dir = resolvePluginAgentDir(join(root, child.name));
    if (dir !== undefined) out.push({ dir, plugin: child.name });
  }
}

/** readdirSync that never throws: unreadable dir (missing / permission) → undefined. */
function readdirSyncSafe(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/** Generic child filter for directory scans: real dir, not a symlink, legal name. */
function isPluginDirCandidate(child: Dirent): boolean {
  return (
    child.isDirectory() && !child.isSymbolicLink() && shouldKeepName(child.name)
  );
}

/**
 * Locate the agents dir under one plugin dir: direct `<dir>/agents` first;
 * else nested `<dir>/<version>/agents`, where the version dir is exactly one
 * eligible child. Component dir names are excluded as version candidates so
 * pseudo-nesting like `<plugin>/skills/agents` can't match.
 */
function resolvePluginAgentDir(dir: string): string | undefined {
  const direct = join(dir, "agents");
  if (existsSync(direct)) return direct;
  const subChildren = readdirSyncSafe(dir);
  if (subChildren === undefined) return undefined;
  const subdirs = subChildren.filter(
    (c) => isPluginDirCandidate(c) && !COMPONENT_DIR_NAMES.has(c.name)
  );
  if (subdirs.length !== 1) return undefined;
  const versioned = join(dir, subdirs[0]!.name, "agents");
  return existsSync(versioned) ? versioned : undefined;
}

/** Plugin component dir names — excluded during nested-version probing. */
const COMPONENT_DIR_NAMES: ReadonlySet<string> = new Set([
  "agents",
  "skills",
  "hooks",
]);

/**
 * Synchronous read of `<root>/installed_plugins.json` — spawn assembly must
 * be sync, so this mirrors async `readLedger` with readFileSync under the
 * same rules: corrupt JSON / non-object root / missing plugins → undefined
 * (caller falls back to the scan); per record, scope === "user" preferred
 * else last entry; missing / non-absolute / unreadable installPath → skip +
 * warn; key part before `@` = plugin namespace.
 */
function readLedgerSync(
  root: string,
  warn: PluginWarn
):
  | ReadonlyArray<{ readonly root: string; readonly plugin: string }>
  | undefined {
  const file = join(root, "installed_plugins.json");
  const parsed = readLedgerFileSync(file, warn);
  if (parsed === undefined) return undefined;
  return collectLedgerEntries(parsed, warn);
}

/**
 * Read + parse + top-level validation; any failure → undefined (caller falls
 * back to the scan). IO and JSON failures warn separately for pinpointing.
 */
function readLedgerFileSync(
  file: string,
  warn: PluginWarn
): Ledger | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return undefined;
    // EXIT: ledger read failed (non-ENOENT) → warn + directory-scan fallback;
    // assembly is not blocked. Rare in practice (permission / IO), never throws.
    warn(`plugin-init: ledger read failed for ${file}: ${errorMessage(err)}`);
    return undefined;
  }
  return parseLedgerText(raw, file, warn);
}

/**
 * Per-entry parse within one ledger: scope=user preferred / last-object
 * fallback / record validation → {root, plugin}[]. Each entry succeeds or is
 * skipped independently.
 */
function collectLedgerEntries(
  ledger: Ledger,
  warn: PluginWarn
): ReadonlyArray<{ readonly root: string; readonly plugin: string }> {
  // ledger.plugins was already isPlainObject-checked by readLedgerFileSync;
  // the ?? {} guard only satisfies the optional type.
  const plugins = (ledger.plugins ?? {}) as Record<string, LedgerEntry[]>;
  const out: { root: string; plugin: string }[] = [];
  for (const [key, records] of Object.entries(plugins)) {
    if (!Array.isArray(records)) continue;
    const { name, marketplace } = splitLedgerKey(key);
    if (name.length === 0) continue;
    const picked = pickLedgerRecord(records, warn);
    if (picked === undefined) {
      // EXIT: no usable record for this key → skip + warn; remaining keys
      // keep parsing (one bad key must not poison the whole file).
      continue;
    }
    const installed = ledgerRecordToDir(name, marketplace, picked, warn);
    if (installed !== undefined) out.push(installed);
  }
  return out;
}

function ledgerRecordToDir(
  name: string,
  marketplace: string | undefined,
  record: LedgerEntry,
  warn: PluginWarn
): { root: string; plugin: string } | undefined {
  if (!shouldKeepName(name)) {
    // EXIT: invalid plugin name (`:`, leading `.`, empty) → skip + warn.
    // A dirty namespace would break `<plugin>:<id>` addressing, so reject it.
    warn(`plugin-init: ledger entry name '${name}' rejected`);
    return undefined;
  }
  const installPath = record.installPath;
  if (typeof installPath !== "string" || installPath.length === 0) {
    // EXIT: record missing installPath → skip + warn. The ledger entry is
    // unanchored; an empty string at assembly time is unrecoverable.
    warn(`plugin-init: plugin '${name}' missing installPath`);
    return undefined;
  }
  if (!isAbsolute(installPath)) {
    // EXIT: installPath not absolute → skip + warn. Same rule as the async
    // path; relative paths are never resolved (users may pass cwd-relative).
    warn(
      `plugin-init: plugin '${name}' installPath is not absolute: ${installPath}`
    );
    return undefined;
  }
  if (!existsSync(installPath)) {
    // EXIT: installPath unreadable → skip + warn; spawn cannot navigate.
    warn(
      `plugin-init: plugin '${name}' installPath unreadable: ${installPath}`
    );
    return undefined;
  }
  // marketplace / version are not consumed on the sync path (callers take
  // {root, plugin} only); kept for type parity with the async path.
  void marketplace;
  return { root: installPath, plugin: name };
}

/**
 * Common name filter: skip empty, dot-prefixed, node_modules, .git, and
 * names containing `:` (WSL shadow artifacts). Symlinks are excluded by
 * callers via readdir withFileTypes.
 */
function shouldKeepName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith(".")) return false;
  if (name === "node_modules" || name === ".git") return false;
  if (name.includes(":")) return false;
  return true;
}

function freezePlugin(p: PluginInstallation): PluginInstallation {
  return Object.freeze({ ...p });
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
