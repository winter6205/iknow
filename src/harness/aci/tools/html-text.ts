/**
 * html-text: shared HTML→text primitives for the ACI web tools (SSOT).
 *
 * web_fetch uses `htmlToText` (whole-page extraction); web_search uses
 * `cleanHtml` (fragment scrubbing); both share `decodeEntities`. They
 * previously each carried a copy (duplication + SSOT violation), so the
 * primitives live here in one source (following the helpers.ts sharing
 * precedent).
 */

/** HTML → compact text: skip script/style blocks, strip tags, decode
 *  entities, collapse whitespace, trim the edges.
 *
 *  Edge trimming: stripping leading/trailing tags often leaves stray
 *  whitespace (e.g. "<div>x</div>" degrades to " x "). web_fetch used to
 *  .trim() at the call site; as a shared SSOT primitive htmlToText trims
 *  itself so every caller doesn't have to (a gap surfaced by pathological
 *  HTML tests). */
export function htmlToText(html: string): string {
  const withoutBlocks = html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " "
  );
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(/[ \t\r\f\v]+/g, " ").trim();
}

/**
 * Extract the page's main content: prefer article/main (or role=main)
 * semantic containers; otherwise strip common navigation chrome from the
 * full document before running htmlToText.
 *
 * An empty string means the document has no visible main content; parse
 * failures are handled by the caller falling back to htmlToText to keep the
 * old whole-page behavior.
 */
export function extractMainContent(html: string): string {
  const semanticCandidates = [
    ...collectElementContents(html, "article"),
    ...collectElementContents(html, "main"),
    ...collectRoleMainContents(html),
  ];
  const semanticText = semanticCandidates
    .map((candidate) => htmlToText(removeBoilerplate(candidate)))
    .sort((a, b) => b.length - a.length)[0];
  if (semanticText) return semanticText;

  return htmlToText(removeBoilerplate(html));
}

function collectElementContents(html: string, tag: string): string[] {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`,
    "gi"
  );
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

function collectRoleMainContents(html: string): string[] {
  const pattern =
    /<([a-z][\w:-]*)\b[^>]*\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/\1\s*>/gi;
  return [...html.matchAll(pattern)].map((match) => match[2] ?? "");
}

function removeBoilerplate(html: string): string {
  return html.replace(
    /<(script|style|nav|header|footer|aside|noscript|template|svg|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " "
  );
}

/** Fragment scrubbing: strip tags + decode entities + collapse whitespace (for search-result title/snippet). */
export function cleanHtml(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Common HTML entity decoding (upstream's four + generic &#N; / &#xN;). */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
