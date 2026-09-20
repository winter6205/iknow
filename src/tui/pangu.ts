/**
 * Pangu spacing: insert one half-width space where a CJK character touches
 * an ASCII letter/digit (e.g. a Chinese month label gains spaces around its
 * digits).
 *
 * WHY render-layer only: called at the Markdown render entry, never written
 * back to session data — stored messages and streaming drafts keep their
 * original text, only the display changes.
 * WHY fullwidth alphanumerics (\uFF00-\uFFEF) are excluded: they carry their
 * own visual width and separate naturally from CJK; including them would
 * wrongly insert spaces into fullwidth text. Fullwidth punctuation is not in
 * the CJK char classes either, so no spaces appear next to it.
 * WHY no spacing across adjacent inline token boundaries: at a text/strong/
 * text seam (e.g. bolded number inside Chinese prose) per-token transforms
 * cannot see the neighbor, so we accept no space — adding one across tokens
 * would inject it inside the style boundary, a worse visual cost.
 * WHY tables are skipped, deliberately: column widths auto-fit content for
 * compact layout; added spaces would inflate columns for nothing.
 */

/** CJK chars participating in the boundary: Unified + Ext-A + Compatibility Ideographs + U+3007. */
const CJK = "\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF\\u3007";

const CJK_TO_ASCII = new RegExp(`([${CJK}])([A-Za-z0-9])`, "g");
const ASCII_TO_CJK = new RegExp(`([A-Za-z0-9])([${CJK}])`, "g");

/** Insert a half-width space at CJK ↔ ASCII letter/digit boundaries; idempotent (an existing space is not doubled). */
export function panguSpacing(text: string): string {
  return text.replace(CJK_TO_ASCII, "$1 $2").replace(ASCII_TO_CJK, "$1 $2");
}

/** Inline `` `...` `` codespan spans (with delimiting backticks): used for placeholder protection. */
const CODESPAN_RE = /`[^`]*`/g;

/** Placeholder boundary char (Private Use area codepoint): neither CJK nor
 *  ASCII, so it creates no new spacing boundary with surrounding text; the
 *  index digits between two \uE000 are likewise excluded from boundaries. */
const PH = "\uE000";

/**
 * Codespan-protected pangu spacing, for raw blockquote lines — the line
 * still contains unresolved backtick syntax, so mask `` `...` `` spans
 * first, apply spacing, then restore: the "never touch code content"
 * contract holds. Unclosed backticks are treated as plain text (same
 * semantics as marked codespans: unpaired delimiters form no codespan).
 */
export function panguSpacingKeepingCodespans(text: string): string {
  const saved: string[] = [];
  const masked = text.replace(CODESPAN_RE, (m) => {
    saved.push(m);
    return `${PH}${saved.length - 1}${PH}`;
  });
  return panguSpacing(masked).replace(
    new RegExp(`${PH}(\\d+)${PH}`, "g"),
    (_, i: string) => saved[Number(i)] ?? ""
  );
}
