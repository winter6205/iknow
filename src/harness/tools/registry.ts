/**
 * Tool registry.
 *
 * Boundaries:
 *   - construction-time validation: duplicate names / bad JSON Schema /
 *     validator compile failure → RegistryConstructionError (never runtime);
 *   - immutable after construction (Object.freeze); list() returns a frozen copy;
 *   - lookup by name returns ToolDef / undefined;
 *   - exposes the compiled ajv ValidateFunction (getValidator) so the
 *     Executor reuses the same validator and never recompiles (same-source
 *     schema enforcement);
 *   - the Registry knows no Loop, executes nothing, and exposes no native
 *     details to the Model Adapter.
 *
 * ajv config: strict: true + ajv-formats — no implicit coercion, no stripping
 * of unknown fields, no guessing missing values; one schema serves model and
 * Executor alike.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { RegistryConstructionError } from "../errors.js";
import type { ToolDef } from "./types.js";

export interface RegistryImpl {
  readonly list: () => ReadonlyArray<ToolDef>;
  readonly get: (name: string) => ToolDef | undefined;
  /** Construction-time compiled ajv validator; undefined when unregistered (same-source reuse). */
  readonly getValidator: (name: string) => ValidateFunction | undefined;
}

function makeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/**
 * Build the Registry. Failure modes (all RegistryConstructionError):
 *   - duplicate tool name → "duplicate tool name: <n>"
 *   - missing / non-string name → "tool entry missing name"
 *   - invalid JSON Schema → "invalid schema for tool <n>: <msg>"
 *   - ajv compile failure → "validator compile failed for <n>: <msg>"
 */
export function createRegistry(tools: ReadonlyArray<ToolDef>): RegistryImpl {
  const ajv = makeAjv();
  const seen = new Set<string>();
  const byName = new Map<string, ToolDef>();
  const validators = new Map<string, ValidateFunction>();

  for (const def of tools) {
    if (typeof def?.name !== "string" || def.name.length === 0) {
      throw new RegistryConstructionError("tool entry missing or empty name");
    }
    if (seen.has(def.name)) {
      throw new RegistryConstructionError(`duplicate tool name: ${def.name}`);
    }
    seen.add(def.name);
    if (!def.inputSchema || typeof def.inputSchema !== "object") {
      throw new RegistryConstructionError(
        `tool ${def.name}: inputSchema must be an object`
      );
    }
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(def.inputSchema);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RegistryConstructionError(
        `validator compile failed for ${def.name}: ${msg}`
      );
    }
    const frozenDef = Object.freeze({ ...def }) as ToolDef;
    byName.set(def.name, frozenDef);
    validators.set(def.name, validate);
  }

  const list = Object.freeze(
    Array.from(byName.values())
  ) as ReadonlyArray<ToolDef>;

  const registry: RegistryImpl = Object.freeze({
    list: () => list,
    get: (name: string) => byName.get(name),
    getValidator: (name: string) => validators.get(name),
  });
  return registry;
}
