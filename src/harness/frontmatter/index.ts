/**
 * src/harness/frontmatter/index.ts — barrel for the shared frontmatter leaf
 * module (ADR-0123). Two functions, one per contract, plus the field-map type:
 *
 *   - `stripFence`: the `---` fence slice that is content-independent, never
 *     throws and slices byte-identically (the frontmatter fence strip contract in CONTEXT);
 *   - `parseFrontmatter`: real YAML parse of the block with the scalar coerce
 *     boundary, returning `FrontmatterFields` + warnings + a block-rejection
 *     flag (the frontmatter coercion boundary in CONTEXT).
 *
 * Consumers import only this boundary — no second fence regex or coerce rule
 * lives in `skill/`, `subagent/` or `memory/`.
 */
export { stripFence } from "./strip.js";
export type { FenceStrip } from "./strip.js";
export { parseFrontmatter } from "./parse.js";
export type { FrontmatterFields, FrontmatterParse } from "./parse.js";
