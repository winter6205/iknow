/**
 * Flag parsing / validation.
 *
 * Separate from the handler: this module only does "unknown → normalized
 * QuerySpec" plus typed rejection — no fs, no processes, no argv building. It
 * is the second line of defense beyond the schema (fail-closed even when the
 * schema is absent or the tool is called directly).
 */

import { ToolExecutionError } from "../../errors.js";
import { assertValidGlob } from "./glob-match.js";
import { resolveTypeName } from "./type-table.js";
import type { GrepOutput, QuerySpec } from "./types.js";

/** Default 50, hard cap 2000 (ADR-0006). */
export const DEFAULT_HEAD_LIMIT = 50;
export const MAX_HEAD_LIMIT = 2000;

/** Default line-window radius when `also` is present. */
export const DEFAULT_WITHIN_LINES = 5;

/** Hard cap for `context`: same order as the single-line truncation, so one request cannot blow up the context. */
export const MAX_CONTEXT = 50;

const OUTPUTS: ReadonlyArray<GrepOutput> = ["paths", "content", "count"];

/**
 * Input aliases: the label changes, the search behavior stays the target
 * mode. The schema enum accepts aliases, and `readOutput` normalizes before
 * entering the engine — so `QuerySpec.output` always has exactly three values
 * and an alias never becomes a fourth mode.
 */
const OUTPUT_ALIASES: ReadonlyMap<string, GrepOutput> = new Map([
  ["files_with_matches", "paths"],
]);

/**
 * Full set of `output` values a model may pass (real modes + aliases). SSOT:
 * the failure text and the schema's `enum` both derive from here (`grep.ts`
 * references it) — handwriting the two places would silently reintroduce
 * "alias added to the normalization table but forgotten in the schema" (the
 * alias would never reach `readOutput`).
 */
export const GREP_OUTPUT_VALUES: ReadonlyArray<string> = [
  ...OUTPUTS,
  ...OUTPUT_ALIASES.keys(),
];

/**
 * Parse handler input into a QuerySpec.
 *
 * Illegal input is uniformly typed-rejected (the **input** class of the two
 * typed error kinds). Bad regex and unknown `type` report separately in their
 * own compilers (do not merge them into one kind).
 */
export function parseQuerySpec(input: unknown): QuerySpec {
  if (input === null || typeof input !== "object") {
    throw new ToolExecutionError("grep: input must be an object");
  }
  const raw = input as Record<string, unknown>;
  const pattern = readNonEmptyString(raw.pattern, "pattern");
  const also = readOptionalNonEmptyString(raw.also, "also");
  const glob = readOptionalNonEmptyString(raw.glob, "glob");
  // A bad glob must be blocked at the entry (not treated as a literal only
  // inside the Node engine): rg fails the whole run with rc=2 on it, and
  // success/failure must not depend on which engine is running.
  if (glob !== undefined) assertValidGlob(glob);
  // Unknown `type` must likewise be blocked at the entry — but for a different
  // reason than bad globs: rg's own `--type` validation only runs inside argv
  // construction, and argv is only reached **when the bundled engine is
  // present**. Leaving validation in that layer would make
  // `{pattern,type:"nosuchtype"}` silently return an empty string when the
  // install root lacks the binary (the downgrade path) or the platform has no
  // asset, instead of the required typed error — whether the same input errors
  // would depend on which engine runs. Hoisting validation to the parsing
  // layer gives both engines one failure domain (`resolveTypeName` is the
  // single text source).
  const type = readOptionalNonEmptyString(raw.type, "type");
  if (type !== undefined) resolveTypeName(type);
  const output = readOutput(raw.output);
  const context = readBoundedInteger(raw.context, {
    name: "context",
    min: 0,
    max: MAX_CONTEXT,
    fallback: 0,
  });
  const offset = readBoundedInteger(raw.offset, {
    name: "offset",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  });
  const rawHeadLimit = readBoundedInteger(raw.head_limit, {
    name: "head_limit",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: DEFAULT_HEAD_LIMIT,
  });
  const withinLines =
    also === undefined
      ? DEFAULT_WITHIN_LINES
      : readBoundedInteger(raw.within_lines, {
          name: "within_lines",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          fallback: DEFAULT_WITHIN_LINES,
        });
  return {
    pattern,
    ...(also !== undefined ? { also } : {}),
    withinLines,
    ignoreCase: raw.ignoreCase === true,
    output,
    context: output === "content" ? context : 0,
    ...(glob !== undefined ? { glob } : {}),
    ...(type !== undefined ? { type } : {}),
    offset,
    headLimit: Math.min(rawHeadLimit, MAX_HEAD_LIMIT),
  };
}

/**
 * Retired names `limit` / `grep_limit`: their presence is typed-rejected,
 * blocking old-name confusion at the entry.
 *
 * Both names must be blocked: the contract says "not `limit`, **not
 * `grep_limit`**", and the schema's `additionalProperties: false` only
 * guarantees new assemblies reject them — direct tool calls / old assemblies
 * may still pass them. Blocking only `limit` would let `grep_limit` fail
 * silently (the model believes it capped the count but actually gets the
 * default 50).
 */
export function rejectRetiredLimitField(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  const raw = input as Record<string, unknown>;
  const retired = RETIRED_LIMIT_FIELDS.find((name) => raw[name] !== undefined);
  if (retired === undefined) return;
  throw new ToolExecutionError(
    `grep: \`${retired}\` is not a grep parameter; the result-list count is \`head_limit\` (read_file uses \`limit\` for its line window)`
  );
}

/** Retired count-field names (the error text names head_limit, see above). */
const RETIRED_LIMIT_FIELDS: ReadonlyArray<string> = ["limit", "grep_limit"];

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionError(`grep: ${name} must be a non-empty string`);
  }
  return value;
}

function readOptionalNonEmptyString(
  value: unknown,
  name: string
): string | undefined {
  if (value === undefined) return undefined;
  return readNonEmptyString(value, name);
}

function readOutput(value: unknown): GrepOutput {
  if (value === undefined) return "paths";
  if (typeof value === "string") {
    const alias = OUTPUT_ALIASES.get(value);
    if (alias !== undefined) return alias;
    if (OUTPUTS.includes(value as GrepOutput)) return value as GrepOutput;
  }
  throw new ToolExecutionError(
    `grep: output must be one of ${GREP_OUTPUT_VALUES.join(" / ")}`
  );
}

/** Bounds for an integer flag (one spec per flag; harder to transpose than 5 positional params). */
interface BoundedIntegerSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

/** Read a non-negative integer flag: absent → fallback; non-integer / below min → typed rejection; above max → clamp. */
function readBoundedInteger(value: unknown, spec: BoundedIntegerSpec): number {
  if (value === undefined) return spec.fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < spec.min
  ) {
    throw new ToolExecutionError(
      `grep: ${spec.name} must be an integer >= ${String(spec.min)}`
    );
  }
  return Math.min(value, spec.max);
}
