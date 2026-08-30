/**
 * html-text：ACI Web 类工具共享的 HTML→文本原语（SSOT，code-review 整改）。
 *
 * web_fetch 用 `htmlToText`（整页提纯）；web_search 用 `cleanHtml`（片段清洗）；
 * 两者共享 `decodeEntities` 实体解码——此前各自复制一份，review 判 Fowler #2
 * 重复 + SSOT 违背，抽到本模块单源（对齐 helpers.ts 共享先例）。
 */

/** HTML → 紧凑文本：跳过 script/style 块，去标签，实体解码，空白折叠，收边 trim。
 *
 * 收边说明：剥离首尾标签后常残留空白（如 "<div>x</div>" 退化为 " x "）。
 * 上游 web_fetch.renderBody 显式 .trim() 兜底；htmlToText 作为共享 SSOT
 * 原语自身收边，避免每个调用方各自兜底（pathological HTML 测试 RED
 * 暴露此契约缺口，2026-08 补强）。 */
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
 * 提取网页正文：优先使用 article/main（或 role=main）语义容器，
 * 否则从完整文档移除常见导航壳后再走 htmlToText。
 *
 * 返回空字符串表示文档没有可见正文；解析异常由调用方回退到
 * htmlToText，以保留旧的整页行为。
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
