/**
 * Rendering contract: node-execution throwables → `error` strings. Prefer
 * the typed discriminated union `{kind, context}`; unknown shapes fall back
 * to `err.message`; plain non-array objects get a safe JSON rendering
 * (constructor-name description when unserializable); everything else uses
 * `String(err)`.
 *
 * Forbidden: `err instanceof Error ? err.message : String(err)` — plain
 * typed objects would render as `[object Object]`, hiding kind/context
 * entirely.
 *
 * Boundary: pure function, no imports of scheduler / ledger / node-executor;
 * shared by both scheduler lines so the two implementations cannot drift.
 */

/**
 * Last fallback for kind-less plain objects: JSON-serialize; on failure
 * (circular refs / BigInt and other unserializable values) fall back to a
 * constructor-name description — guarantees never emitting
 * `[object Object]`, never throwing.
 */
function safeObjectString(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    const ctorName = (value as { constructor?: { name?: string } }).constructor
      ?.name;
    return `unrenderable object: ${
      typeof ctorName === "string" && ctorName ? ctorName : "unknown"
    } (circular or non-serializable)`;
  }
}

export function formatNodeError(err: unknown): string {
  if (err && typeof err === "object" && "kind" in err) {
    const e = err as { kind?: unknown; context?: unknown };
    const kind = typeof e.kind === "string" ? e.kind : "unknown";
    const ctxStr =
      e.context !== undefined ? JSON.stringify(e.context) : JSON.stringify(err);
    return `${kind}: ${ctxStr}`;
  }
  if (err instanceof Error) return err.message;
  // Non-array objects without a kind go through safe JSON; arrays and
  // primitives keep String() (arrays already read as "1,2,3", a primitive's
  // String form is itself readable).
  if (typeof err === "object" && err !== null && !Array.isArray(err)) {
    return safeObjectString(err);
  }
  return String(err);
}
