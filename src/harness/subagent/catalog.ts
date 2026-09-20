/**
 * Builtin subagent catalog (resolver + entries).
 *
 * Single source of truth: builtin subagent role definitions = frozen array
 * `BUILTIN_CATALOG`, exposed through the `resolveAgentCatalog()` /
 * `getAgentEntry(id)` resolver pair.
 *
 * Design notes:
 *   - `AgentCatalogEntry { id, description, body, bashMode?, disallowedTools? }`
 *     is the additive field carrier for worker assembly (persona injects via
 *     envelope.role; bashMode has its own channel; disallowedTools merges
 *     through the existing buildWorkerToolSurface — no new abstraction).
 *   - explore = read-only exploration agent: disallowedTools denies
 *     FILE_WRITE_TOOL_NAMES (edit_file / write_file + symbol mutate),
 *     bashMode="readonly", body is persona text injected into the worker
 *     system prompt.
 *   - general-purpose = full tool surface, no extra deny (the default deny of
 *     spawn_subagent is auto-added by buildWorkerToolSurface and stays
 *     silent since the worker toolset never contains it).
 *   - Array + each entry + disallowedTools all Object.freeze, guarding
 *     against accidental downstream mutation.
 *
 * Errors: unknown id → AgentCatalogLookupError (typed, local — mirrors the
 * manager.ts SubAgentCapacityError precedent, not moved into errors.ts).
 * Worker assembly catches this error and falls back to V1 behavior (no
 * persona / no extra deny / bashMode="any", byte-for-byte V1).
 */
/**
 * Write-class tools disabled for the explore agent (SSOT inlined in this
 * file, same set as FILE_WRITE_TOOL_NAMES in aci/tools/symbol-mutate.js —
 * inlined so catalog deny keeps working standalone after symbol-mutate.js
 * is retired).
 *
 * Exported so capability.ts reuses the same truth without back-referencing
 * the deprecated symbol-mutate.js.
 */
export const FILE_WRITE_TOOL_NAMES = Object.freeze([
  "edit_file",
  "write_file",
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
] as const);

export interface AgentCatalogEntry {
  readonly id: string;
  readonly description: string;
  readonly body: string;
  readonly bashMode?: "any" | "readonly";
  readonly disallowedTools?: ReadonlyArray<string>;
  /**
   * Bare-name alias of a plugin agent (the basename with the `<plugin>:`
   * prefix stripped). Indexed by the catalog only when no builtin / user /
   * other plugin claims the bare name, so `resolver.get(bare)` hits this
   * entry; on collision the whole field is stripped (no field left, canonical
   * lookup unaffected). Not rendered into the spawn enum / prose list
   * (spawn-subagent-tool uses id + description only), so the extra field is
   * externally invisible.
   */
  readonly bareAlias?: string;
}

/**
 * Typed fail-fast error for unknown catalog ids (guards the worker-assembly
 * fallback path).
 *
 * Local error class — mirrors the manager.ts SubAgentCapacityError /
 * SubAgentAbortError precedent (manager-local, not in errors.ts). The message
 * includes the id so the fallback path can log it; no context field, since a
 * lookup error carries no extra diagnostics.
 */
export class AgentCatalogLookupError extends Error {
  override readonly name = "AgentCatalogLookupError";
  readonly id: string;
  constructor(id: string) {
    super(`subagent catalog: unknown agent id '${id}'`);
    this.id = id;
  }
}

/** explore — read-only exploration agent; persona body injected into the worker system prompt. */
const EXPLORE_ENTRY: AgentCatalogEntry = Object.freeze({
  id: "explore",
  description:
    "Read-only exploration agent: searches code, reads files, and gathers information without modifying anything.",
  body: "You are an explore agent. Your role is read-only exploration and information gathering: search the codebase, read files, and report findings. Do not modify any files. Use read_file, grep, glob, and lsp_* tools to investigate. When asked to make changes, recommend instead that the caller perform the edits.",
  bashMode: "readonly",
  disallowedTools: Object.freeze([...FILE_WRITE_TOOL_NAMES]),
});

/** general-purpose — full-tool-surface agent; persona body injected into the worker system prompt. */
const GENERAL_PURPOSE_ENTRY: AgentCatalogEntry = Object.freeze({
  id: "general-purpose",
  description:
    "General-purpose agent for multi-step tasks that may use any available tool.",
  body: "You are a general-purpose agent. Use any available tool to accomplish the task delegated by the parent. Keep handoffs short, list relevant file paths, and do not paste entire files into the final draft. Prefer concise, evidence-backed results and return a structured summary.",
});

/** Single authoritative builtin catalog source (frozen array singleton). */
const BUILTIN_CATALOG: ReadonlyArray<AgentCatalogEntry> = Object.freeze([
  EXPLORE_ENTRY,
  GENERAL_PURPOSE_ENTRY,
]);

/**
 * Return all builtin catalog entries (frozen array singleton).
 *
 * Callers may safely hold the returned reference (frozen → unwritable, same
 * reference → equal across calls); each entry and its disallowedTools are
 * also fully frozen.
 */
export function resolveAgentCatalog(): ReadonlyArray<AgentCatalogEntry> {
  return BUILTIN_CATALOG;
}

/**
 * Look up an entry by id. Unknown id throws AgentCatalogLookupError (typed,
 * fail-fast).
 *
 * Fallback path: worker assembly catches this error and uses the V1 baseline
 * (no persona section / no extra deny / bashMode defaults to "any").
 */
export function getAgentEntry(id: string): AgentCatalogEntry {
  const entry = BUILTIN_CATALOG.find((e) => e.id === id);
  if (entry === undefined) {
    throw new AgentCatalogLookupError(id);
  }
  return entry;
}

/**
 * Catalog resolver with two surfaces (list + get): the spawn_subagent factory
 * consumes list for the enum + prose list and get for single-id validation.
 *
 * builtin = frozen singleton; the closure's list/get point at BUILTIN_CATALOG
 * / getAgentEntry. Production assembly (registry.ts) does not inject
 * explicitly — the spawn-subagent-tool factory defaults to the builtin
 * resolver (registry's job is the tool surface, not agent routing —
 * registry.ts untouched).
 *
 * Tests can inject a fake resolver (list returns a fixed array + get yields
 * entries on demand) to verify both consumption surfaces.
 */
export interface AgentCatalogResolver {
  readonly list: () => ReadonlyArray<AgentCatalogEntry>;
  readonly get: (id: string) => AgentCatalogEntry;
}

/** Builtin catalog resolver (frozen singleton, list + get surfaces). */
export const builtinCatalogResolver: AgentCatalogResolver = Object.freeze({
  list: () => BUILTIN_CATALOG,
  get: (id: string) => getAgentEntry(id),
});
