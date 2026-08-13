/**
 * src/harness/secret-roundtrip/registry.ts — per-engine secret registry.
 *
 * #406 secret-roundtrip: maps each detected secret VALUE to a unique
 * `<<<SECRET_N>>>` placeholder. Identifies the roundtrip-mask spine:
 *   - recognize() registers matched values via `register()`
 *   - bash tool calls `restore(command, registry)` BEFORE spawning bwrap
 *   - output mask layers feed on `registry.values()` via currentSecretValues
 *   - cross-turn reuse: same value → same placeholder, no ID churn
 *
 * In-memory only (NOT persisted to disk): a session restart loses the
 * mapping, so historical messages containing placeholders cannot be
 * restored — documented limitation in plan #406 §5.1. The constraint is
 * honest: registry state is a session-scoped side effect, not a durable
 * store.
 */

import {
  createCompiledPatterns,
  type CompiledSecretPattern,
} from "./patterns.js";

export interface SecretRegistry {
  /** Idempotent. First call for a value mints `<<<SECRET_N>>>` (N monotonic
   *  from 1, never reused within this instance); subsequent calls return the
   *  existing placeholder. */
  register(value: string): string;
  /** Resolve placeholder → original value. Returns undefined for unknown
   *  placeholders (cross-registry / session-restored text). */
  resolve(placeholder: string): string | undefined;
  /** Has this value been registered? Used by recognize to differentiate
   *  newly-discovered vs already-known values for the `matched` count. */
  has(value: string): boolean;
  /** Frozen compiled patterns the registry uses for scanning. Exposed so
   *  recognize can iterate without re-compiling. */
  readonly patterns: ReadonlyArray<CompiledSecretPattern>;
  /** All (placeholder, value) pairs as immutable entries. `restore()` walks
   *  this to substitute placeholders back to values. */
  entries(): ReadonlyArray<{
    readonly placeholder: string;
    readonly value: string;
  }>;
  /** All values the registry knows. Fed to currentSecretValues so output
   *  masking covers registry-tracked secrets even when they don't appear
   *  in env (e.g. user-pasted keys). */
  values(): ReadonlyArray<string>;
  /** Number of (placeholder → value) pairs registered. */
  readonly size: number;
}

export function createSecretRegistry(opts?: {
  readonly patterns?: ReadonlyArray<string>;
}): SecretRegistry {
  // Patterns are compiled ONCE at construction (plan §5.1 risk #4:
  // scanning every turn is fine; re-compiling is not). The registry is
  // built per-engine in build-engine.ts and lives for the engine lifetime.
  const patterns = createCompiledPatterns(opts?.patterns);
  const byValue = new Map<string, string>();
  const byPlaceholder = new Map<string, string>();
  let nextId = 1;

  const registry: SecretRegistry = Object.freeze({
    patterns,
    register(value: string): string {
      const existing = byValue.get(value);
      if (existing !== undefined) return existing;
      const placeholder = `<<<SECRET_${nextId++}>>>`;
      byValue.set(value, placeholder);
      byPlaceholder.set(placeholder, value);
      return placeholder;
    },
    resolve(placeholder: string): string | undefined {
      return byPlaceholder.get(placeholder);
    },
    has(value: string): boolean {
      return byValue.has(value);
    },
    entries(): ReadonlyArray<{
      readonly placeholder: string;
      readonly value: string;
    }> {
      return Object.freeze(
        [...byPlaceholder.entries()].map(([placeholder, value]) =>
          Object.freeze({ placeholder, value })
        )
      );
    },
    values(): ReadonlyArray<string> {
      return Object.freeze([...byValue.keys()]);
    },
    get size(): number {
      return byPlaceholder.size;
    },
  });

  return registry;
}

/**
 * Replace every `<<<SECRET_N>>>` in `text` with its registered value.
 *
 * - Unknown placeholders pass through unchanged (graceful degradation
 *   across session-restart boundaries — bash receives the literal
 *   `<<<SECRET_N>>>` and fails naturally; documented limitation).
 * - Placeholders are exact literals (`<<<SECRET_1>>>`, `<<<SECRET_10>>>`,
 *   `>>>` always closes); split/join by the full literal never
 *   partially overlaps with siblings (`<<<SECRET_1>>>` is NOT a substring
 *   of `<<<SECRET_10>>>` because the trailing `>>>` breaks the match).
 * - Returns the original string when the registry is empty.
 *
 * Used by the bash tool handler before spawning bwrap (T3).
 */
export function restore(text: string, registry: SecretRegistry): string {
  let out = text;
  for (const { placeholder, value } of registry.entries()) {
    if (out.includes(placeholder)) out = out.split(placeholder).join(value);
  }
  return out;
}
