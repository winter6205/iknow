/**
 * tool_search: searches the registered tool catalog by name/substring and
 * returns full ToolDef JSON.
 *
 * Behavioral truth:
 *   - Input `query` (case-insensitive substring over name/description,
 *     emptiness checked **after trim**) or `names` (exact tool-name list);
 *     both fields optional. The "at least one" semantics is decided at the
 *     handler entry — empty / whitespace-only `query` returns
 *     `"(no matches) Rephrase ..."` (a legal result, not an error, with
 *     rephrase guidance); this is deliberately not pushed to ajv.
 *   - Matching = scan catalog.all(): if `names` is non-empty → exact-name
 *     includes; otherwise → case-insensitive substring over
 *     name/description.
 *   - Each hit then goes through `getRegistry().discover(name)` as a side
 *     effect: lazy tools marked as searched enter promptTools() from the
 *     next round onward (the engine consumes the discovered set).
 *     discover shares the same boundary as the output — hits dropped by the
 *     cap never enter the discovered set.
 *   - Wire shape: one JSON per line, explicit three-field projection
 *     `{ name, description, inputSchema }` — `aci` metadata and handlers
 *     must not leak into the wire JSON (plain-string-only contract).
 *   - Bounded output: optional `limit` (default 20, max 100; illegal values
 *     rejected by ajv) plus a character self-cap (`OUTPUT_SELF_CAP`).
 *     Overflow drops **whole lines** (every line is always JSON.parse-able)
 *     and appends one plain-text guidance line. The executor remains the
 *     sole truncation authority, so this tool emitting less than the cap is
 *     compliance, not circumvention; the guidance line is plain data, not
 *     truncated/total metafields — it reuses the precedent of the non-JSON
 *     `NO_MATCHES` line's line-parseable carve-out.
 *
 * **Dependency-injection shape (lazy self-reference)**: what tool_search
 * needs is the assembled registry's catalog (search target) + discover
 * (marking side effect). Because the registry itself contains tool_search,
 * holding a direct registry reference would form a self-reference cycle, so
 * deps take a lazy closure `getRegistry: () => AciRegistry` — assembly
 * stores only the function; dereferencing happens at call time (when the
 * model actually invokes tool_search), by which point
 * createDefaultAciRegistry has finished assigning `assembled.reg`. Called
 * before assembly completes → throws ToolExecutionError (fail-fast, never
 * silent).
 *
 * ACI metadata: read-only / concurrency-safe / cancel / fast tier (5s, pure
 * in-memory catalog scan). **lazy is deliberately not set** (default false;
 * the bootstrap guard is fail-safe — zero lazy tools in this layer, so
 * tool_search is always resident in the prompt).
 */

import type { AciToolDef } from "../types.js";
import type { AciRegistry } from "../aci-registry.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";

/**
 * Dependency injection: `getRegistry` lazily dereferences the assembled
 * registry. Calling before assembly completes → ToolExecutionError
 * (fail-fast against the self-reference cycle).
 */
export interface ToolSearchDeps {
  readonly getRegistry: () => AciRegistry;
}

interface ToolSearchInput {
  readonly query?: unknown;
  readonly names?: unknown;
  readonly limit?: unknown;
}

/**
 * Legal return for no-matches / empty input: missing arguments = no results.
 * Follows the guidance-text precedent of `skill.ts` (after skill_search was
 * removed, `skill` guides back to the `<available_skills>` listing or
 * `read_file`; this NO_MATCHES does not depend on any removed search tool).
 * The return is not a bare marker but carries rephrase guidance (search
 * again with a different keyword, or fetch exact tools via `names`).
 */
export const NO_MATCHES =
  "(no matches) Rephrase `query` with a different keyword, or pass exact tool names via `names`.";

/** Default hit cap; an explicit `limit` overrides it, bounded by MAX_LIMIT. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Character self-cap threshold, mirroring OUTPUT_HARD_CAP (20000) in
 * `tools/executor.ts`. The executor is the sole truncation authority; this
 * tool's self-cap sits beneath it so the executor's fallback truncation is
 * always a no-op on this output (`memory/tools/recall.ts` is the same-shape
 * precedent).
 */
const OUTPUT_SELF_CAP = 20_000;

/**
 * Factory: createToolSearchTool(deps) — the tool-search tool.
 *
 * The returned AciToolDef satisfies:
 *   - name === "tool_search"
 *   - inputSchema: { query? substring + names? exact names + limit? hit cap },
 *     all optional, additionalProperties:false
 *   - aci metadata: read-only / concurrency-safe / cancel / fast tier
 */
export function createToolSearchTool(deps: ToolSearchDeps): AciToolDef {
  const handler = (input: unknown, _ctx?: ToolExecutionContext): string => {
    const { query, names, limit } = (input ?? {}) as ToolSearchInput;
    const q = typeof query === "string" ? query.trim() : "";
    const nameList = Array.isArray(names) ? names : [];

    // "At least one" semantics: non-empty query string or non-empty names
    // array; otherwise no results.
    if (q.length === 0 && nameList.length === 0) {
      return NO_MATCHES;
    }

    const registry = resolveRegistry(deps);
    const all = registry.catalog.all();

    const matches =
      nameList.length > 0
        ? all.filter((t) => nameList.includes(t.name))
        : (() => {
            const norm = q.toLowerCase();
            return all.filter(
              (t) =>
                t.name.toLowerCase().includes(norm) ||
                t.description.toLowerCase().includes(norm)
            );
          })();

    if (matches.length === 0) {
      return NO_MATCHES;
    }

    const kept = takeWithinBudget(matches, resolveLimit(limit));

    // Side effect: mark the returned tools as discovered (lazy tools then
    // enter promptTools from the next round on).
    // Only cover hits actually emitted — a tool the model never saw should
    // not take prompt budget in the next round.
    for (const m of kept) {
      registry.discover(m.name);
    }

    const lines = kept.map(projectLine);
    if (kept.length === matches.length) return lines.join("\n");
    return [...lines, guidanceLine(kept.length, matches.length)].join("\n");
  };

  return Object.freeze({
    name: "tool_search",
    description:
      "Use only when a tool's directory entry has no description (full schema unavailable). Search scope covers all registered tools, including `mcp__`-prefixed MCP tools. Pass `query` (case-insensitive substring on tool name / description) or `names` (exact list) to pull ToolDef JSON. Returns one JSON object per line `(name, description, inputSchema)`, at most `limit` hits (default 20, max 100) plus a trailing plain-text line when hits are left out; empty or whitespace-only input, or no match → `(no matches)` with guidance to rephrase `query` or pass exact `names`. Side effect: marks returned tools as discovered so they surface in the next prompt.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description:
            "case-insensitive substring matched against tool name and description",
        },
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "exact tool names to retrieve",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: "max hits to return (default 20)",
        },
      },
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
      // lazy deliberately unset (default false) — tool_search is always
      // resident in the prompt; the bootstrap guard covers it.
    },
  });
}

/** Wire shape: explicit three-field projection; never leaks aci metadata / handler. */
function projectLine(t: AciToolDef): string {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  });
}

/**
 * Cap guidance line (plain text, not JSON — same line-parseable carve-out
 * precedent as `NO_MATCHES`). Reports plain data only, no
 * truncated/total metafields.
 */
function guidanceLine(shown: number, matched: number): string {
  return `(showing ${shown} of ${matched} matches) Narrow \`query\`, pass exact tool names via \`names\`, or raise \`limit\` (max ${MAX_LIMIT}).`;
}

/**
 * ajv is the rejection layer for `limit` (0 / negative / non-integer are
 * rejected at the schema level); the handler only does a lenient fallback
 * (illegal values on direct handler calls revert to the default), adding no
 * new failure path.
 */
function resolveLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(value, MAX_LIMIT);
}

/**
 * Bounded projection: take a prefix within the hit count and character
 * budget, dropping whole lines (never emit half a JSON line). The budget
 * reserves room for the guidance line so the total output including it
 * stays ≤ OUTPUT_SELF_CAP.
 */
function takeWithinBudget(
  matches: ReadonlyArray<AciToolDef>,
  limit: number
): ReadonlyArray<AciToolDef> {
  // Reserve estimated at shown = matched (shown ≤ matched, so the digit
  // count is never larger).
  const reserve = guidanceLine(matches.length, matches.length).length + 1;
  const kept: AciToolDef[] = [];
  let used = 0;
  for (const t of matches) {
    if (kept.length >= limit) break;
    const next = used + projectLine(t).length + (kept.length > 0 ? 1 : 0);
    if (next + reserve > OUTPUT_SELF_CAP) break;
    kept.push(t);
    used = next;
  }
  return kept;
}

/** Dereference the assembled registry; not yet assembled → ToolExecutionError (fail-fast). */
function resolveRegistry(deps: ToolSearchDeps): AciRegistry {
  const reg = deps.getRegistry();
  if (!reg) {
    throw new ToolExecutionError("tool_search: registry not assembled");
  }
  return reg;
}
