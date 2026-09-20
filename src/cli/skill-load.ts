/**
 * CLI-side skill-load surface. CLI shares the same slash-entry semantics as
 * TUI / Web: the loadable skill set includes description-less and
 * `disable-model-invocation` entries, resolution goes through the catalog,
 * the remainder is sliced by typed token length, the static command list
 * takes precedence, and agents stay out of slash.
 *
 * Relationship to TUI: `src/tui/slash.ts::parseSkillLoad` implements the
 * same semantics there, but `src/cli` and `src/tui` are sibling hosts that
 * must not import each other (both are host surfaces; either direction
 * creates a false dependency). This module depends only on the pure
 * function surface (`harness/skill/body.ts` assembly SSOT + minimal
 * parsing/projection), no readline / React / OpenTUI, so chat-session and
 * tests can consume it directly.
 *
 * The envelope shape has a single home in `buildSkillLoadText`
 * (src/harness/skill/body.ts) — this module never assembles strings itself;
 * byte-level equality across TUI / Web / CLI is that function's guarantee.
 */
import { buildSkillLoadText, createSkillBody } from "../harness/skill/body.js";
import {
  projectSlashEntries,
  slashHeadPrefix,
  slashTailRemainder,
} from "../harness/skill/catalog.js";
import type { SkillCatalog, SkillEntry } from "../harness/skill/catalog.js";

/**
 * Minimal skill projection (same shape as the TUI's `SkillEntryLike` — each
 * host keeps a local type to decouple slash parsing from harness catalog
 * types).
 *
 * `aliases` holds the only bare-name aliases of plugin skills (the catalog
 * already dropped conflicting ones); callers project from the catalog before
 * passing in. This module consumes them as-is and never splits `:` itself.
 */
export interface CliSkillEntryLike {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
}

/**
 * CLI static command set (same source as the `applySlashCommand` dispatch
 * table in `src/cli/slash.ts`). Command names only, used for the
 * static-wins check — help copy stays in slash.ts (HELP_TEXT / apply*
 * handlers).
 *
 * Not derived by importing slash.ts's switch: that is dispatch
 * implementation, not a decidable name set, and back-deriving names from a
 * switch silently misses future commands. This set is an explicit
 * declaration; new CLI commands must be added here in lockstep (a test
 * pins the static-precedence contract).
 */
export const CLI_STATIC_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "?",
  "status",
  "quit",
  "exit",
  "json",
  "reset",
  "continue",
  "permissions",
  "graph",
  "config",
  "goal",
]);

/** Lowercased first token (`/Echo` and `/echo` match alike). Algorithm SSOT
 *  in harness (`slashHeadPrefix`); this name is the CLI host's existing
 *  export (consumed by tests). */
export function slashPrefix(text: string): string {
  return slashHeadPrefix(text);
}

/**
 * Remainder after the first token (trimmed). Sliced by the **typed token**
 * length — slicing with `skill.name.length` would swallow the remainder
 * prefix on bare-name input. Algorithm SSOT in harness
 * (`slashTailRemainder`).
 */
export function slashRemainder(raw: string): string {
  return slashTailRemainder(raw);
}

/** All matchable lowercased heads: canonical name + unique bare-name aliases. */
function headLowers(skill: CliSkillEntryLike): ReadonlyArray<string> {
  return [skill.name, ...(skill.aliases ?? [])].map((head) =>
    head.toLowerCase()
  );
}

/**
 * Exact skill-name hit -> `{name, remainder}`; static-list hit or miss ->
 * undefined.
 *
 * `name` is always the **canonical name** (catalog entry's `name`), never
 * the user-typed bare alias — downstream `catalog.get` and the persisted
 * envelope converge on one form.
 */
export function parseSkillLoad(
  raw: string,
  skills: ReadonlyArray<CliSkillEntryLike>
): { name: string; remainder: string } | undefined {
  const text = raw.trim();
  const prefix = slashPrefix(text);
  if (prefix === "") return undefined;
  if (CLI_STATIC_COMMANDS.has(prefix)) return undefined;
  for (const skill of skills) {
    if (headLowers(skill).includes(prefix)) {
      return { name: skill.name, remainder: slashRemainder(text) };
    }
  }
  return undefined;
}

/**
 * Catalog projection: loadable skill surface + unique bare-name aliases.
 * The algorithm itself lives in harness (`projectSlashEntries`), shared by
 * TUI / CLI / hub; this function only keeps the CLI host's name and shape.
 */
export function toCliSkillEntries(
  catalog: SkillCatalog
): ReadonlyArray<CliSkillEntryLike> {
  return projectSlashEntries(catalog);
}

/**
 * Assemble one skill-load message text. `entry === undefined` (catalog
 * miss) -> `undefined`; body read failures rethrow (no swallowing — same
 * policy as TUI / hub: a read error is a real fault, not disguised as
 * success).
 */
export async function buildCliSkillLoad(opts: {
  readonly name: string;
  readonly remainder: string;
  readonly entry: SkillEntry;
}): Promise<string> {
  const { name, remainder, entry } = opts;
  const body = await createSkillBody({ entry, dir: entry.dir });
  return buildSkillLoadText(
    name,
    body,
    remainder.length > 0 ? remainder : undefined
  );
}
