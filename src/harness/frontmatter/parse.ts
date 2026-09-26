/**
 * Frontmatter block parse + the scalar coerce boundary (ADR-0123).
 *
 * Contract (the frontmatter coercion boundary in docs/CONTEXT.md): string / number /
 * boolean / null → string; scalar array → folded with `", "`; mapping → key
 * skipped + warned, and a child key is never registered as a top-level key (the
 * #1128 silent-overwrite corruption path). A block-level syntax failure drops
 * the whole block to an empty map plus a warning and is reported separately as
 * `rejected`, because "the block is unreadable" and "the block was empty" look
 * identical in `fields` alone — and a consumer that writes what it read must
 * fail closed on the first, not persist defaults over the second.
 *
 * Nothing throws upward: `parseDocument` reports syntax problems on `doc.errors`
 * instead of throwing (unlike `yaml.parse`), and every node kind below has an
 * explicit total branch, so no input can escape as an exception.
 */
import { parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";

/**
 * What the coerce boundary hands a consumer: every frontmatter value already
 * flattened to its string form, keyed by the top-level key it was written
 * under. Named here so migrating consumers do not each restate the contract.
 */
export type FrontmatterFields = Readonly<Record<string, string>>;

/** Parsed frontmatter: string-valued fields plus what had to be dropped. */
export interface FrontmatterParse {
  readonly fields: FrontmatterFields;
  /** Human-readable reasons for a rejected block or a skipped key. */
  readonly warnings: readonly string[];
  /** True when the block as a whole yielded nothing — a syntax failure or a
   *  non-mapping document. A rejected block is not the same fact as an empty
   *  one: `fields` is `{}` for both, but only the rejected one means the file
   *  still holds data this module could not read. */
  readonly rejected: boolean;
}

/** Parse a fence block into scalar fields; never throws. */
export function parseFrontmatter(block: string): FrontmatterParse {
  const doc = parseDocument(block, { logLevel: "silent" });
  if (doc.errors.length > 0) {
    // EXIT: the block is not parseable YAML → empty fields, `rejected`, one
    // warning. The raw text stays the caller's to preserve or quarantine.
    return {
      fields: {},
      warnings: [
        oneLine(`frontmatter block is not valid YAML: ${firstError(doc)}`),
      ],
      rejected: true,
    };
  }
  const contents = doc.contents;
  // EXIT: nothing to read (an empty or comment-only block) → empty fields,
  // not rejected: an empty block is an authoring fact, not a parse failure.
  if (contents === null) return { fields: {}, warnings: [], rejected: false };
  if (!(contents instanceof YAMLMap)) {
    return {
      fields: {},
      warnings: ["frontmatter block is not a key/value mapping"],
      rejected: true,
    };
  }
  const warnings: string[] = [];
  const fields: Record<string, string> = {};
  for (const pair of contents.items) {
    const key = keyText(pair.key);
    if (key === undefined) {
      warnings.push("frontmatter skipped an entry with a non-scalar key");
      continue;
    }
    const value = coerceValue(pair.value, key, warnings);
    if (value !== undefined) fields[key] = value;
  }
  // EXIT: a readable mapping → per-key skips keep the block accepted, so a
  // consumer that writes back only loses what it was warned about.
  return { fields, warnings, rejected: false };
}

/** The first reported YAML problem, or a stand-in when the parser was terse. */
function firstError(doc: { errors: readonly { message: string }[] }): string {
  return doc.errors[0]?.message ?? "unknown error";
}

/**
 * Collapse an embedded multi-line message onto one line. `yaml` reports a
 * syntax error with the offending source quoted over several lines, and every
 * consumer forwards these warnings into a line-based channel (warn log, TUI
 * pane), where an embedded newline splits one degradation into several
 * unrelated-looking rows.
 */
function oneLine(message: string): string {
  return message.replace(/\s*\r?\n\s*/g, " ");
}

/** Key text of a scalar key; `undefined` for a complex (sequence/mapping) key. */
function keyText(key: unknown): string | undefined {
  if (!(key instanceof Scalar)) return undefined;
  const raw = key.value;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return undefined;
}

/**
 * Flatten one value to a string, or return `undefined` after pushing the skip
 * reason onto `warnings`.
 */
function coerceValue(
  value: unknown,
  key: string,
  warnings: string[]
): string | undefined {
  if (value instanceof Scalar) return scalarText(value);
  if (value instanceof YAMLSeq) {
    const scalars: Scalar[] = [];
    for (const item of value.items) {
      if (!(item instanceof Scalar)) {
        warnings.push(
          `frontmatter key "${key}" is not a scalar sequence and was skipped`
        );
        return undefined;
      }
      scalars.push(item);
    }
    // `", "` is the delimiter skill frontmatter already folds flow sequences
    // with, so migrating consumers keep their rendered bytes.
    return scalars.map(scalarText).join(", ");
  }
  if (value instanceof YAMLMap) {
    warnings.push(`frontmatter key "${key}" is a mapping and was skipped`);
    return undefined;
  }
  warnings.push(
    `frontmatter key "${key}" has an unsupported value and was skipped`
  );
  return undefined;
}

/**
 * A Scalar's string form. `title:` carries no source text and means `""`, while
 * `title: null` carries the literal token and must stay `"null"` for the memory
 * round-trip to survive.
 */
function scalarText(value: Scalar): string {
  if (value.value === null && value.source === "") return "";
  return String(value.value);
}
