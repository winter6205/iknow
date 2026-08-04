/**
 * html-text：ACI Web 类工具共享的 HTML→文本原语（SSOT，code-review 整改）。
 *
 * web_fetch 用 `htmlToText`（整页提纯）；web_search 用 `cleanHtml`（片段清洗）；
 * 两者共享 `decodeEntities` 实体解码——此前各自复制一份，review 判 Fowler #2
 * 重复 + SSOT 违背，抽到本模块单源（对齐 helpers.ts 共享先例）。
 */

/** HTML → 紧凑文本：跳过 script/style 块，去标签，实体解码，空白折叠。 */
export function htmlToText(html: string): string {
  const withoutBlocks = html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " "
  );
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(/[ \t\r\f\v]+/g, " ");
}

/** 片段清洗：去标签 + 实体解码 + 空白折叠（搜索结果 title/snippet 用）。 */
export function cleanHtml(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** 常见 HTML 实体解码（对齐 upstream 四项 + 通用 &#N; / &#xN;）。 */
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
