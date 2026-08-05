/**
 * Minimal structural types for the hast (hypertext abstract syntax tree)
 * subset that react-markdown passes to its component overrides.
 *
 * Defined locally so `web/src/lib/hast.ts` does not depend on @types/hast
 * (which is a transitive dep of react-markdown, not a direct web dep). This
 * mirrors the shape of the `node` prop on `code` / `pre` / `p` / etc. —
 * root + element nodes recurse via `children`; text nodes contribute
 * `value`; comment nodes contribute nothing.
 */
export type HastNodeLike = {
  type: string;
  value?: string;
  children?: ReadonlyArray<HastNodeLike>;
};

/**
 * Recursively extract plain text from a hast tree.
 *
 * Used by the markdown `code` component to recover the raw source text
 * from react-markdown's `node` prop. react-markdown's rendered React
 * children go through rehype-highlight's hljs spans, and React does not
 * preserve a plain text projection through that wrapping — see
 * `MarkdownBody`'s comment for the empirical "const x = 1;" → " :  = ;"
 * copy regression that this helper fixes.
 *
 * - text nodes contribute `value`
 * - root / element nodes recurse into `children` (order preserved)
 * - comment nodes contribute nothing
 * - missing / null / undefined → ""
 * - element nodes without children → ""
 */
export function hastText(node: HastNodeLike | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  const children = node.children;
  if (!children) return "";
  let out = "";
  for (const child of children) out += hastText(child);
  return out;
}
