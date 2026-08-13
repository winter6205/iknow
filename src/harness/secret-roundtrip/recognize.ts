/**
 * src/harness/secret-roundtrip/recognize.ts — per-text secret scan + replace.
 *
 * #406 secret-roundtrip: the user-text entry point. Scans a string for
 * shapes matching the registry's compiled patterns, registers each
 * unique value (idempotent within the registry), and returns the
 * placeholder-substituted text. The bash restore layer (T3) reverses the
 * substitution right before spawning the sandboxed subprocess.
 *
 * Boundary contract (plan §1.3):
 *   - User text → recognize() → placeholder text → model
 *   - Model emits bash command with placeholders → restore() → real value
 *     → bash spawn (real value only lives in process at that instant)
 *   - Output → mask covers the same value via currentSecretValues(registry.values())
 */

import { createSecretRegistry, type SecretRegistry } from "./registry.js";

export interface RecognizeResult {
  /** Values newly registered during this call (registry-deduped). Empty
   *  when every matched value was already in the registry (A2 dedup
   *  verification in plan §3 T1). */
  readonly matched: ReadonlyArray<string>;
  /** Full input text with every matched secret value replaced by its
   *  `<<<SECRET_N>>>` placeholder. Unknown placeholders are NOT
   *  substituted here — that's `restore()`'s job. */
  readonly replaced: string;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

/**
 * Scan `text` for secret values matching the registry's compiled patterns.
 * Idempotent `register(value)` produces the placeholder; matched substrings
 * are replaced in source order. `matched` only counts NEW values.
 *
 * When `registry` is omitted, a fresh `createSecretRegistry()` is created
 * internally — convenient for one-shot scanning where the caller doesn't
 * intend to restore (e.g. diagnostic smoke). For the production loop-engine
 * wiring, build-engine constructs the registry and loop-engine passes it
 * in (T2).
 */
export function recognize(
  text: string,
  registry?: SecretRegistry
): RecognizeResult {
  const reg = registry ?? createSecretRegistry();
  const matched: string[] = [];
  const replacements: Replacement[] = [];

  for (const { re } of reg.patterns) {
    // `g`-flag regex is stateful — reset lastIndex so the same compiled
    // pattern can be reused across multiple recognize() calls without
    // leaking the previous run's position (re-entrancy contract).
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (value.length === 0) {
        // Zero-width match would loop forever — guard.
        re.lastIndex++;
        continue;
      }
      if (!reg.has(value)) matched.push(value);
      const placeholder = reg.register(value);
      replacements.push({
        start: m.index,
        end: m.index + value.length,
        placeholder,
      });
    }
  }

  if (replacements.length === 0) {
    return Object.freeze({
      matched: Object.freeze(matched),
      replaced: text,
    });
  }

  // Dedup by exact (start, end): multiple patterns matching the same
  // substring (e.g. sk- prefix covered by both DEFAULT and a custom
  // pattern) collapse to one replacement. Since register is idempotent
  // on value, the placeholder is necessarily the same.
  const seen = new Set<string>();
  const sorted = replacements
    .filter((r) => {
      const key = `${r.start}:${r.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  // Apply non-overlapping. Defensive against malicious / overlapping
  // patterns: a later replacement overlapping an applied region is
  // skipped (the earlier one wins).
  let out = "";
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue;
    out += text.slice(cursor, r.start) + r.placeholder;
    cursor = r.end;
  }
  out += text.slice(cursor);

  return Object.freeze({
    matched: Object.freeze(matched),
    replaced: out,
  });
}
