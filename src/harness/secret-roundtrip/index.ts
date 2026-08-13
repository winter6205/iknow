/**
 * src/harness/secret-roundtrip/index.ts — barrel for the secret-roundtrip
 * bounded context (#406). All public API of the roundtrip-mask layer lives
 * here so callers (loop-engine T2, build-engine T2/T4, bash tool T3) only
 * ever depend on this one module boundary.
 *
 * Layered surface:
 *   - patterns.ts: SSOT secret regex sources + compile helpers
 *   - registry.ts: per-engine value→placeholder map + restore()
 *   - recognize.ts: per-text scan → placeholder-substituted output
 *
 * Re-exports are flat — composition over coupling (no nested module
 * references leak into the public surface).
 */
export * from "./patterns.js";
export * from "./registry.js";
export * from "./recognize.js";
