/**
 * src/tui/pangu.ts
 *
 * 盘古之白（pangu spacing）：CJK 字符与 ASCII 字母/数字相邻处插一个半角
 * 空格（"美股4月" → "美股 4 月"）。
 *
 * WHY 纯渲染层变换：只在 Markdown 渲染入口调用，绝不回写会话数据——历史
 * 消息与流式草稿的原始文本保持不变，仅显示形态变化。
 * WHY 排除全角字母数字（\uFF00-\uFFEF）：全角 Ａ１２３ 视觉上自带宽度、
 * 与 CJK 天然分界，纳入会在「美股１２３月」这类文本误插空格。
 * 全角标点（。，、「」）不在 CJK 字符类内，因此标点旁不会被插空格。
 * WHY 相邻行内 token 跨边界不插：`价格**100**元` 的 text/strong/text 接缝
 * 处（text「价格」+ strong「100」+ text「元」）逐 token 变换看不到邻接，
 * 接受不插——跨 token 补空格会把空格插进样式边界内，视觉代价更大。
 * WHY 表格不插是刻意的：列宽按内容自适应紧凑排版，插空格会无谓撑宽列。
 */

/** 参与边界的 CJK 字符：统一表意 + 扩展 A + 兼容表意 + 〇。 */
const CJK = "\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF\\u3007";

const CJK_TO_ASCII = new RegExp(`([${CJK}])([A-Za-z0-9])`, "g");
const ASCII_TO_CJK = new RegExp(`([A-Za-z0-9])([${CJK}])`, "g");

/** CJK ↔ ASCII 字母/数字边界插半角空格；幂等（已有空格不重复插）。 */
export function panguSpacing(text: string): string {
  return text
    .replace(CJK_TO_ASCII, "$1 $2")
    .replace(ASCII_TO_CJK, "$1 $2");
}

/** 行内 `` `...` `` codespan 段（含定界反引号）：占位符保护用。 */
const CODESPAN_RE = /`[^`]*`/g;

/** 占位符边界字符（私有区码位）：非 CJK 非 ASCII，不与外围文本产生
 *  新的插空格边界；占位序号数字被 \uE000 隔开，同理不参与边界。 */
const PH = "\uE000";

/**
 * codespan 保护的盘古之白：blockquote 原始行专用——行内还带未解析的
 * 反引号语法，先占位保护 `` `...` `` 段再插空格、最后还原，保证「代码
 * 内容不碰」契约。未闭合反引号按普通文本处理（与 marked codespan 语义
 * 一致：不成对不构成 codespan）。
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
