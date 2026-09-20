/**
 * PROTOTYPE (throwaway) — ACI prototype tool layer: lazily-loaded registry.
 *
 * Question under validation: can lazy loading (lazy tools stay out of the
 * prompt schema until discover() injects them) be implemented as an
 * additive decorating layer without modifying the frozen Registry
 * interface.
 * inner = createRegistry(tools): AciToolDef is structurally a ToolDef, and
 * the extra `aci` field carried by spread is harmless to ajv compilation
 * (the additionalProperties constraint lives inside inputSchema, not at the
 * top level).
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createRegistry } from "../tools/registry.js";
import type { RegistryImpl } from "../tools/registry.js";
import type { ToolDef } from "../tools/types.js";
import type { AciCatalog, AciToolDef } from "./types.js";
import { RegistryConstructionError } from "../errors.js";

export interface AciRegistry {
  /** Frozen protocol registry (handed to createExecutor). */
  readonly inner: RegistryImpl;
  readonly catalog: AciCatalog;
  /** Append MCP-extension tools dynamically without changing inner's construction-time snapshot. */
  readonly registerExternal: (defs: ReadonlyArray<AciToolDef>) => void;
  /**
   * Remove dynamically-registered extension tools by name (reload unregisters
   * before re-registering).
   * Touches only the externalByExt Map; inner's frozen snapshot and the
   * Gate-2 collision check stay untouched (a same-name register still
   * throws). Unknown names are silently ignored (idempotent — the reload
   * path must not throw on stale config names).
   */
  readonly unregisterExternal: (names: ReadonlyArray<string>) => void;
  /**
   * ADR-0043: overflow-governance retirement seam — stamps `aci.lazy: true`
   * onto builtin deferrable tools (entering the lazy-tail discipline:
   * `visibleSchemas` filters them, the index section keeps name +
   * description resident, and a direct call hydrates the schema back onto
   * the tail). **Operates only on the construction-time `tools` array + the
   * matching `byName` slot**; inner's frozen snapshot stays untouched (the
   * executor can still resolve the name via the byName fallback). Applies
   * only to names present in `byName` (builtins + already-registered ones
   * are unaffected — the latter are already marked `lazy: true`). Unknown
   * names are silently ignored (idempotent, same shape as
   * `unregisterExternal`).
   *
   * This is the **only** write seam for builtin retirement: build-engine
   * calls it once at assembly, after `await mcpManager.start()` (first-turn
   * decision, constant for the session); a builtin that should stay is
   * simply not passed. The core seven never retire (guaranteed upstream by
   * `deriveCandidateOrder` in `tool-overflow.ts`, which filters them out at
   * the candidate-derivation layer).
   */
  readonly retireBuiltin: (names: ReadonlyArray<string>) => void;
  /**
   * The set entering the prompt: all non-lazy tools (registration order) +
   * discovered lazy tools (appended in discovery order, keeping the prefix
   * stable).
   */
  readonly visibleSchemas: () => ReadonlyArray<ToolDef>;
  /** Lazy loading: fetch one tool's schema on demand (lazy ones included); undefined for unregistered names. */
  readonly discover: (name: string) => ToolDef | undefined;
  /**
   * ADR-0043: check whether a name has been marked "retrieved by the model"
   * via `discover()`. Assembly layer / gate use: calling an `mcp__` tool that
   * was never discovered = not loaded, and should throw ToolExecutionError
   * (pinned by template) instead of really running the handler. A def
   * missing from the registry returns false; registered-but-undiscovered
   * also returns false.
   */
  readonly isDiscovered: (name: string) => boolean;
}

/**
 * ADR-0083 structural gate: MCP tools **may not self-declare** the
 * `exemptFromOutputCap` exemption.
 *
 * The production path never lands the declaration anyway
 * (`toAciToolDef` in `src/harness/mcp/adapter.ts` maps only name /
 * description / inputSchema / aci / handler); this function guards against
 * hand-built in-process defs sneaking it in — external sources are by
 * nature third-party data, and the exemption is reserved for the single
 * builtin `createSkillTool` set at assembly time.
 *
 * A def without the declaration is returned as-is (zero-copy, preserving
 * the object-identity contract of the earlier `Map.set(def)`:
 * `catalog.get(name)` yields the same reference that was registered); only
 * a def carrying it is rebuilt as a frozen copy.
 */
function stripOutputCapExemption(def: AciToolDef): AciToolDef {
  if (def.exemptFromOutputCap !== true) return def;
  const { exemptFromOutputCap: _stripped, ...rest } = def;
  return Object.freeze(rest);
}

/**
 * Build the ACI registry:
 *   - inner = createRegistry(tools) (protocol registry, handed to
 *     createExecutor);
 *   - catalog holds every AciToolDef (shared by the permission layer and
 *     lazy loading);
 *   - visibleSchemas = all non-lazy tools (registration order, bit-stable)
 *     + discovered lazy tools appended in discovery order (tail-append
 *     preserves the KV-cache prefix); discover() marks on call, so the next
 *     round's promptTools() includes it — the discovered set is closure
 *     state inside createAciRegistry, never persisted across sessions (a
 *     spec "Boundaries Never" guard);
 *   - discover returns by name (lazy tools included), recording the
 *     discovered mark on a hit;
 *     undefined for unregistered names.
 *
 * **Assembly-time fail-fast gates (spec Boundaries Always)**:
 *   - Gate 1 bootstrap guard: tool_search is the discovery tool itself and
 *     may not be marked lazy (it would mark itself pending discovery — a
 *     bootstrap deadlock).
 *   - Gate 2 namespace collision: the mcp__ prefix is reserved for MCP
 *     tools; an ACI tool may not use it, throwing at assembly time.
 *   Both gates share the same front-loaded for-loop check (createRegistry
 *   has not run yet, so a failure leaves no partial state).
 */
export function createAciRegistry(
  tools: ReadonlyArray<AciToolDef>
): AciRegistry {
  // Gates 1 + 2: assembly-time fail-fast, completed before createRegistry is
  // called so a failure leaves no partial state. Single pass over tools to
  // avoid double scanning.
  for (const t of tools) {
    // Bootstrap guard — tool_search is the discovery tool itself and may
    // not be marked lazy (it would mark itself pending discovery, a
    // bootstrap deadlock).
    if (t.name === "tool_search" && t.aci.lazy === true) {
      throw new RegistryConstructionError(
        "tool_search is the bootstrap discovery tool — lazy=true is forbidden"
      );
    }
    // Namespace collision — the mcp__ prefix is reserved for MCP tools;
    // ACI tools may not use it.
    if (t.name.startsWith("mcp__")) {
      throw new RegistryConstructionError(
        `tool name '${t.name}' uses reserved mcp__ namespace`
      );
    }
  }

  const inner = createRegistry(tools);
  const externalAjv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(externalAjv);

  const byName = new Map<string, AciToolDef>();
  for (const t of tools) {
    byName.set(t.name, t);
  }
  const externalByExt = new Map<string, AciToolDef>();

  // Discovered set: tool names retrieved during this run (closure state,
  // never persisted across sessions). discover() adds on a hit;
  // visibleSchemas() = all non-lazy tools (registration order, bit-stable) +
  // discovered lazy tools appended in discovery order. Tail-append rather
  // than reinserting into registration order: with no new discovery between
  // adjacent rounds the visible prefix stays bit-identical, preserving the
  // KV-cache prefix hit. ADR-0043: `isDiscovered` is the catalog / gate-side
  // entry point for the "already loaded" check (permission-executor uses it
  // to reject mcp__ tool calls made without prior discover()).
  const discovered = new Set<string>();
  const isDiscovered = (name: string): boolean => discovered.has(name);

  const catalog: AciCatalog = Object.freeze({
    get: (name: string) => byName.get(name) ?? externalByExt.get(name),
    // Live read from byName (registration order = the construction-time
    // tools order; byName and tools are filled from the same source):
    // retireBuiltin only updates the byName slot, and the live read keeps
    // catalog.all() and catalog.get() from ever diverging (a frozen
    // construction-time snapshot once left a stale def after retire).
    all: () =>
      Object.freeze([
        ...byName.values(),
        ...externalByExt.values(),
      ]) as ReadonlyArray<AciToolDef>,
    // ADR-0043: expose the discovered check to the gate side —
    // permission-executor uses it to reject "call without discover" on
    // mcp__ tools.
    isDiscovered,
  });

  const registerExternal = (defs: ReadonlyArray<AciToolDef>): void => {
    const pending = new Map<string, AciToolDef>();
    for (const def of defs) {
      if (!def.name.startsWith("mcp__")) {
        throw new RegistryConstructionError(
          `external tool name '${def.name}' must use mcp__ namespace`
        );
      }
      if (
        byName.has(def.name) ||
        externalByExt.has(def.name) ||
        pending.has(def.name)
      ) {
        throw new RegistryConstructionError(`duplicate tool name: ${def.name}`);
      }
      try {
        externalAjv.compile(def.inputSchema);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new RegistryConstructionError(
          `validator compile failed for ${def.name}: ${msg}`
        );
      }
      // Strip the exemption declaration instead of rejecting the whole
      // registration: after dropping the declaration the tool works
      // unchanged (it just falls back to the default cap), while rejecting
      // would let one bad external def punish its whole batch and leave an
      // assembly-time error for the MCP connection path to handle. Stripping
      // is a structural gate — the stored def no longer carries the field,
      // so downstream consumers (executor's safeContent) cannot read it
      // structurally, even if a caller hand-forwards `catalog.get()` output
      // to an executor.
      pending.set(def.name, stripOutputCapExemption(def));
    }
    for (const [name, def] of pending) {
      externalByExt.set(name, def);
    }
  };

  // Reload seam: withdraw external tools by name; no ajv compilation here
  // (registerExternal already compiled them). catalog / visibleSchemas /
  // discover all read externalByExt live, so downstream views converge
  // automatically after deletion.
  const unregisterExternal = (names: ReadonlyArray<string>): void => {
    for (const name of names) {
      externalByExt.delete(name);
    }
  };

  // Retirement seam (ADR-0043) — replace named elements of the
  // construction-time `tools` array with new defs stamped `aci.lazy: true`;
  // byName points at the new def too (catalog and visibleSchemas read from
  // byName / tools, so one replacement keeps both views consistent).
  // Already-lazy defs are untouched (idempotent); names absent from byName
  // are silently ignored (same shape as unregisterExternal — retirement
  // callers are expected to pass exactly the builtin deferrable pool, with
  // no unknown names).
  const retireBuiltin = (names: ReadonlyArray<string>): void => {
    for (const name of names) {
      const existing = byName.get(name);
      if (existing === undefined) continue;
      if (existing.aci.lazy === true) continue;
      const retired = Object.freeze({
        ...existing,
        aci: Object.freeze({ ...existing.aci, lazy: true }),
      }) as AciToolDef;
      byName.set(name, retired);
      // Replace the `tools` array slot in sync (visibleSchemas uses
      // `[...tools, ...]`, and the closure reads this array's current
      // content)
      for (let i = 0; i < tools.length; i += 1) {
        if (tools[i]?.name === name) {
          (tools as AciToolDef[])[i] = retired;
          break;
        }
      }
    }
  };

  const visibleSchemas = (): ReadonlyArray<ToolDef> => {
    const all = [...tools, ...externalByExt.values()];
    // Invariant: the non-lazy registration-order prefix stays bit-stable —
    // even if a non-lazy tool gets discover()ed (tool_search covers the full
    // set), it does not move. The tail only appends discovered **lazy**
    // tools (in discovery order); lazy tools are not in the prefix, so no
    // dedup is needed.
    const prefix = all.filter((t) => !t.aci.lazy);
    const discoveredTail = [...discovered].flatMap((name) => {
      const def = byName.get(name) ?? externalByExt.get(name);
      return def !== undefined && def.aci.lazy ? [def] : [];
    });
    return [...prefix, ...discoveredTail];
  };

  const discover = (name: string): ToolDef | undefined => {
    const hit = byName.get(name) ?? externalByExt.get(name);
    if (hit !== undefined) {
      discovered.add(name);
    }
    return hit;
  };

  return Object.freeze({
    inner,
    catalog,
    registerExternal,
    unregisterExternal,
    retireBuiltin,
    visibleSchemas,
    discover,
    isDiscovered,
  });
}
