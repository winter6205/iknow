/**
 * Line-protocol representability (output discipline; shared by both engines).
 *
 * All three output modes are **line protocols**: `paths` is one path per
 * line, `content` is `path:line:text` per line, `count` is `path:count` per
 * line. A path containing `\n` splits one record into two (or swallows the
 * next record); a path containing `\0` collides with the `--null` delimiter.
 * Neither character **can** be losslessly represented in a line protocol.
 *
 * Verified (rg 15.0.0; see the `--null` notes in `argv.ts` and the re-check in
 * `rg-engine.ts`): on the rg side a `\n`-containing path splits its record in
 * two — the first half parses as a **fake hit** (shaped like
 * `name.txt:1:needle here`, though no such file exists on disk) and the
 * second half's real path matches no file. The Node side breaks differently
 * (emitting the newline-bearing path verbatim). The two sides break
 * differently, so they **cannot** be fixed separately.
 *
 * Rule: **paths containing `\n` / `\0` never appear in any output mode**,
 * removed uniformly by this module at the confluence shared by both engines.
 * No path rewriting (that would show the model a name different from disk,
 * and any follow-up `read_file` / `edit_file` must fail), and no escaping
 * newlines into the body.
 *
 * After removal, `head_limit` / `total:` stay consistent:
 *   - the rg side removes them first via `--glob` (see `argv.ts`), so they are
 *     absent from the `--count` denominator and the `-l` roster to begin with;
 *   - the confluence filters again with the same test (rg's `--glob` does not
 *     apply to **explicitly named file arguments**, so
 *     `path: "nl\nname.txt"` still reaches the confluence).
 */

/** Whether a path can be represented losslessly in the line protocol. */
export function isPathRepresentable(path: string): boolean {
  return !path.includes("\n") && !path.includes("\0");
}

/** Drop unrepresentable paths from a list (order kept, one test per item). */
export function keepRepresentablePaths<T>(
  items: ReadonlyArray<T>,
  pathOf: (item: T) => string
): T[] {
  return items.filter((item) => isPathRepresentable(pathOf(item)));
}

/**
 * Two exclusion globs that keep `\n`-containing paths out of rg's traversal
 * (`argv.ts` and tests share this constant).
 *
 * The first tests the **basename** (a pattern without `/` matches the basename
 * at any depth): it removes every file and directory whose own name contains a
 * newline.
 *
 * The second tests **ancestor prefixes**: a newline-named **directory** needs
 * its whole subtree removed — without this, a path like `sub/a\nb/inner.txt`
 * has a clean basename (`inner.txt`), the first glob misses it, yet its full
 * path still contains a newline and remains unrepresentable (verified: with
 * only the first glob such files still appear, split back into two fake
 * records).
 */
export const NEWLINE_PATH_EXCLUDES: ReadonlyArray<string> = [
  "!*\n*",
  "!*\n*/**",
];
