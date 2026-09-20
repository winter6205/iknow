import { join } from "node:path";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  source?: string;
  version?: string | number;
  tags?: string;
  author?: string;
  license?: string;
  metadata?: string;
}

export interface SkillEntry {
  name: string;
  description?: string;
  dir: string;
  disabled: boolean;
  source?: string;
  version?: string | number;
  tags?: string;
  author?: string;
  license?: string;
  metadata?: string;
  /**
   * Namespace of a plugin skill (= plugin name); undefined for plain skills.
   * The catalog prefers the canonical name over the bare alias; on conflict
   * the alias is dropped (the scanner warns when building entries — the
   * catalog interface exposes no warn channel).
   */
  namespace?: string;
}

export interface SkillCatalog {
  search(query: string): SkillEntry[];
  get(name: string): SkillEntry | undefined;
  all(): SkillEntry[];
  /**
   * Model-facing skill index: entries with a description and not disabled,
   * sorted by name — the set allowed into `<available_skills>` (frozen at
   * session start + in-session deltas) and allowed to load bodies via `skill()`.
   *
   * This is NOT the slash list: human slash candidates come from `loadable()`
   * (which includes description-less and disabled entries — the long-standing
   * availability semantics). Behavior here was never widened.
   *
   * @deprecated Prefer `modelIndex()` (same face, self-explaining name). Kept
   * for existing consumers (build-engine / hub / worker / TUI). ADR-0098.
   */
  available(): SkillEntry[];
  getBodyPath(name: string): string | undefined;
}

/**
 * ADR-0098 / `specs/skill-index-increment.md`: splitting `available()`, which
 * used to mean two things (model index AND slash list). Each face now has its
 * own name; `createSkillCatalog` returns this interface.
 *
 * The two methods are deliberately NOT added to `SkillCatalog` itself:
 * existing `SkillCatalog` object literals (e.g. the TUI's empty-catalog
 * fallback) would each need updating to typecheck. Instead the return type is
 * widened — structurally compatible with `SkillCatalog`, so existing
 * assignments are unaffected; consumers of the new faces widen their own
 * annotations to this type as needed.
 */
export interface SkillCatalogFaces extends SkillCatalog {
  /** Model-facing skill index (same face as `available()`). Returns a new array each call. */
  modelIndex(): SkillEntry[];
  /**
   * Loadable-skill face: every canonical entry with a loadable SKILL.md on
   * disk — including description-less and disabled ones; bare aliases are
   * never duplicated (`all()` is canonical-only). Human slash candidates for
   * TUI / Web / CLI derive from this.
   *
   * `get(name)` still resolves by name (canonical first, then bare, disabled
   * included), independent of this face. Returns a new array each call.
   */
  loadable(): SkillEntry[];
}

/**
 * Single authoritative predicate for model-index eligibility: has a
 * description and is not `disable-model-invocation`. Both `modelIndex()`'s
 * filter and the `skill()` tool gate call this, so the two can never drift.
 * `reason` distinguishes the two rejection kinds (different remedies).
 */
export function modelIndexIneligibility(
  entry: SkillEntry
): "disabled" | "no_description" | undefined {
  if (entry.disabled) return "disabled";
  if (entry.description === undefined) return "no_description";
  return undefined;
}

/** Convenience predicate: `modelIndexIneligibility(entry) === undefined`. */
export function isModelIndexEligible(entry: SkillEntry): boolean {
  return modelIndexIneligibility(entry) === undefined;
}

/**
 * Recover the bare name from `"<plugin>:<name>"` (only when the entry name
 * has that shape); no match → undefined. Consistent with the scanner's naming
 * contract: namespace must be a `<namespace>:` prefix of entry.name; an empty
 * bare part also counts as no match (a meaningless bare name).
 */
export function stripNamespace(
  entryName: string,
  namespace: string
): string | undefined {
  const prefix = `${namespace}:`;
  if (!entryName.startsWith(prefix)) return undefined;
  const bare = entryName.slice(prefix.length);
  return bare.length > 0 ? bare : undefined;
}

/** Shared sort for both faces: ascending by name. Sorting (instead of relying
 *  on `readdir` order, which is not lexicographic on ext4) keeps human
 *  candidates and the model index deterministic. */
const byName = (a: SkillEntry, b: SkillEntry): number =>
  a.name.localeCompare(b.name);

export function createSkillCatalog(
  entries: readonly SkillEntry[]
): SkillCatalogFaces {
  // Dual index: canonical = the full name (plugin skills: "<plugin>:<name>");
  // bare aliases are registered only when the canonical slot is free
  // (first-come wins; conflict → alias dropped). The index holds canonical
  // entries only, so all/modelIndex/loadable/search never double-count.
  const index = new Map<string, SkillEntry>();
  const bareIndex = new Map<string, SkillEntry>();
  for (const entry of entries) {
    if (index.has(entry.name)) continue;
    index.set(entry.name, entry);
    if (entry.namespace !== undefined && entry.namespace !== entry.name) {
      const bare = stripNamespace(entry.name, entry.namespace);
      if (bare !== undefined && !bareIndex.has(bare)) {
        bareIndex.set(bare, entry);
      }
    }
  }
  const all = (): SkillEntry[] => [...index.values()];
  const modelIndex = (): SkillEntry[] =>
    all().filter(isModelIndexEligible).sort(byName);
  const loadable = (): SkillEntry[] => all().sort(byName);

  return Object.freeze({
    search(query: string): SkillEntry[] {
      const needle = query.toLocaleLowerCase();
      return modelIndex().filter(
        (entry) =>
          entry.name.toLocaleLowerCase().includes(needle) ||
          (entry.description ?? "").toLocaleLowerCase().includes(needle)
      );
    },
    get(name: string): SkillEntry | undefined {
      return index.get(name) ?? bareIndex.get(name);
    },
    all,
    modelIndex,
    loadable,
    available: modelIndex,
    getBodyPath(name: string): string | undefined {
      const entry = index.get(name) ?? bareIndex.get(name);
      return entry ? join(entry.dir, "SKILL.md") : undefined;
    },
  });
}

/**
 * Slash projection — the single implementation shared by TUI / CLI / hub
 * (web keeps a local mirror due to its tsconfig include boundary).
 *
 * Semantics (verbatim-compatible with the three implementations it replaced):
 *   - candidate set = `loadableOf(catalog)`: the loadable face (description-
 *     less and disabled entries included), structurally compatible with
 *     lean test-injected catalogs (no `loadable` → falls back to `all()`);
 *   - alias = unique bare name only: `stripNamespace` + a
 *     `get(bare) === entry` registration check + case-folded occupancy table
 *     of all first tokens; a contested bare name drops the alias entirely for
 *     the whole group (unavailable is better than ambiguous);
 *   - output always uses the canonical name (display and completion both use
 *     `plugin:skill`).
 */
export interface SkillSlashEntry {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
}

/**
 * Structurally fetch the loadable face: real implementations use
 * `loadable()`; test-injected `SkillCatalog` literals fall back to `all()`.
 * Previously each of the three hosts wrote these 3 lines itself.
 */
export function loadableOf(catalog: SkillCatalog): ReadonlyArray<SkillEntry> {
  const withFaces = catalog as Partial<SkillCatalogFaces>;
  return withFaces.loadable?.() ?? catalog.all();
}

/**
 * Slash-candidate projection with the unique-bare-name alias algorithm.
 * Produces `SkillSlashEntry[]`; each host then slices it into its own minimal
 * shape (TUI `SkillEntryLike` / CLI `CliSkillEntryLike` are isomorphic —
 * hosts keep their local types and share only the algorithm).
 */
export function projectSlashEntries(
  catalog: SkillCatalog
): ReadonlyArray<SkillSlashEntry> {
  const entries = loadableOf(catalog);
  const bares = entries.map((entry) => {
    if (entry.namespace === undefined) return undefined;
    const bare = stripNamespace(entry.name, entry.namespace);
    return bare !== undefined && catalog.get(bare) === entry ? bare : undefined;
  });
  const claimants = new Map<string, ReadonlyArray<string>>();
  const claim = (name: string, owner: string): void => {
    const key = name.toLowerCase();
    const owners = claimants.get(key) ?? [];
    claimants.set(key, owners.includes(owner) ? owners : [...owners, owner]);
  };
  for (const entry of entries) claim(entry.name, entry.name);
  entries.forEach((entry, i) => {
    const bare = bares[i];
    if (bare !== undefined) claim(bare, entry.name);
  });
  return entries.map((entry, i) => {
    const bare = bares[i];
    const owners =
      bare === undefined ? undefined : claimants.get(bare.toLowerCase());
    const description =
      entry.description !== undefined ? { description: entry.description } : {};
    if (owners?.length !== 1 || owners[0] !== entry.name) {
      return { name: entry.name, ...description };
    }
    return { name: entry.name, ...description, aliases: [bare!] };
  });
}

/**
 * Lowercased first token of a slash input (`/xxx...` → `xxx`). `/Echo` and
 * `/echo` compare equal — the single case-folding point for human matching.
 */
export function slashHeadPrefix(text: string): string {
  if (!text.startsWith("/")) return "";
  return (text.slice(1).split(/\s+/, 1)[0] ?? "").toLowerCase();
}

/**
 * remainder = everything after the first token (trimmed). Split by the
 * *typed* token's length — using the skill's canonical name length would eat
 * the head of the remainder when a bare alias was typed (forbidden by spec).
 */
export function slashTailRemainder(raw: string): string {
  const text = raw.trim();
  const firstTok = text.split(/\s+/, 1)[0] ?? text;
  return text.slice(firstTok.length).trim();
}
