/**
 * rg stdout 解析（SC12「行解析」）。
 *
 * 输入形状由 `argv.ts` 固定：`--null` → `path\0line:text\n`。NUL 定界把
 * 「路径含冒号」从分列问题里彻底移除 —— D3 的 `:` / `-` / `--` 分列只在
 * **content + context** 的渲染侧才有意义（那条路径由 `rg-output-context.ts`
 * 解析，见该文件注释）。
 *
 * 旧契约保持：单行内容 > MAX_MATCH_LINE_COLUMNS 截断 + `...[truncated]`，
 * 按 **code point** 切（不拆 surrogate pair，ADR-0004 修订）。
 */

import { truncateByCodePoint } from "../../sandbox/runner.js";
import type { LineHit } from "./types.js";

export const MAX_MATCH_LINE_COLUMNS = 2_000;
export const RG_TRUNCATION_MARKER = "...[truncated]";

/**
 * rg `--max-columns-preview` 追加的省略标记（实测 15.1.0 原文）。
 *
 * 它**不是**本工具的省略标记：正文里出现这串字符时，模型看到的是 rg 传输层
 * 的收口痕迹，而不是 D2 的展示口径。解析层必须先把它剥掉，再按 code point
 * 走唯一一道闸 —— 否则 rg 路径的正文尾巴会多出这段文本，而 Node 路径没有。
 */
export const RG_PREVIEW_MARKER = " [... omitted end of long line]";

/**
 * 传输预算 / 权威口径之比：UTF-8 一个 code point 最多 4 字节。
 *
 * `--max-columns` 的**触发**按字节、**切片**按 code point（实测 15.1.0），而
 * `truncateMatchContent` 只认 code point，两者单位不同。预算取到 4 倍才让
 * 「rg 加过标记」不蕴含「内容被切掉」：
 *   - 超限行（> 2000 cp）必然 >= 2001 字节 ⟹ 必然触发；切到 8000 cp 时正文
 *     远在权威上限之上，剥标记后再由 code point 闸收口，形状一致。
 *   - 未超限行最多 2000 cp ⟹ 最多 8000 字节；触发线上的行 rg 至多切到
 *     8000 cp（切点落在字符中间时干脆不切，实测 15.1.0），所以正文一个字符
 *     都不会丢。预算小于 4 倍时，`漢`×1000（3003 字节 / 1003 cp）这类行会被
 *     真的切掉一截，而 Node 侧认为它没超列原样保留 —— 同一行的字节数、正文、
 *     可复制内容全不同（D6/SC9）。
 *
 * 所以本工具从不让 rg 的传输预算充当展示口径：它只用来限制传输量，最终形状
 * 由 `truncateMatchContent` 唯一决定。
 */
export const MAX_COLUMN_BYTES_PER_CODE_POINT = 4;

/** 传给 rg `--max-columns` 的字节预算（`argv.ts` 与解析层共用同一算式）。 */
export function rgTransportBudgetBytes(maxColumns: number): number {
  return maxColumns * MAX_COLUMN_BYTES_PER_CODE_POINT;
}

/**
 * 剥掉 rg 传输层的省略标记（只在**确定是 rg 加的**时候剥）。
 *
 * rg 15.1.0 的实测语义（两个单位不同，见 `MAX_COLUMN_BYTES_PER_CODE_POINT`）：
 *   - **触发**：行字节数 >= 预算就追加本标记；
 *   - **切片**：正文切成前 `预算` 个 **code point**，不足则原样。
 * 于是标记出现时正文未必被切过（恰好等于预算、或切割点落在多字节字符中间时
 * 都不切，实测 15.1.0），而「去标记后的字节数 >= 预算」与「rg 加过标记」等价：
 *   - 切过的行，去掉的前缀正好是 `预算` 个 code point，至少 `预算` 字节；
 *   - 没切的整行本来就有 >= 预算 字节。
 * 正文里恰好以这串文本结尾的真实行因此不会被误剥：它的字节数若 >= 预算，rg
 * 也会给它追加自己的标记，剥掉末尾那一个正好还原。
 *
 * `strippedTailBytes` = 调用方在**原始记录尾部**剥掉的字节数（`--crlf` 下 rg
 * 回显的尾随 `\r` 即 1）：它计入 rg 的触发基数，少了它 7999 字节的 CRLF 行会
 * 漏剥（实测 15.1.0：7999 + `\r` 恰好达线）。调用方必须传「记录原样长度 -
 * 传入内容长度」，不能先扣再猜。
 */
export function stripRgPreviewMarker(
  content: string,
  strippedTailBytes = 0
): string {
  if (!content.endsWith(RG_PREVIEW_MARKER)) return content;
  const head = content.slice(0, -RG_PREVIEW_MARKER.length);
  return Buffer.byteLength(head, "utf8") + strippedTailBytes >=
    rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS)
    ? head
    : content;
}

/**
 * 解析 `--null` content 输出的命中行。
 *
 * 形状损坏的记录（无 NUL、行号非十进制）整条跳过 —— 不猜、不产生假命中。
 */
export function parseRgNullLines(stdout: string): LineHit[] {
  const hits: LineHit[] = [];
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    // 二进制提示不是命中行（见 `isRgBinaryNotice`）：它的「路径:」段与
    // `path:line:text` 同形，不显式排除就会被解析成一条假命中。
    if (isRgBinaryNotice(record)) continue;
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) continue;
    const path = stripDotSlash(record.slice(0, nulIdx));
    const rest = record.slice(nulIdx + 1);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) continue;
    const line = Number(rest.slice(0, colonIdx));
    if (!Number.isInteger(line) || line < 1) continue;
    hits.push({
      path,
      line,
      text: truncateRgContent(rest.slice(colonIdx + 1)),
    });
  }
  return hits;
}

/**
 * rg 的二进制提示记录（**不是命中行**）。
 *
 * 实测 15.1.0 的两种原文（`--null -H` 下路径段以 NUL 收尾，故 NUL 之后是
 * 提示正文）：
 *   - `path\0 binary file matches (found "\0" byte around offset 8)`
 *   - `path\0 WARNING: stopped searching binary file after match (found "\0" byte around offset 70008)`
 *   - `path: binary file matches (...)` —— `--null` 下 rg 只在**真正输出内容
 *     记录**时用 NUL 定界，提示行走的是无 NUL 的 `path: ` 形态（实测 15.1.0）。
 *
 * 它们长得像记录（有路径、有冒号），若不识别就会被 `parseRgNullLines` 一类
 * 解析器当成命中或整条丢弃；`-l` / `--count` 出法下 rg 甚至**不吐**这些提示，
 * 于是同一个含 NUL 的文件 `-l` 列出、`content` 报提示（实测 15.1.0：远距离
 * NUL 的文件 `-l` rc=0 带路径、`--count` rc=0 不带、`content` 吐 WARNING）。
 * 这是 rg 自身检测窗口（64 KiB）的副作用，不是一条可复刻的口径，所以两条
 * 引擎统一按「二进制文件不搜」处理，这里只负责把提示识别出来。
 *
 * 判据必须**锚在记录位置**：命中行的正文里完全可能出现同一串字（拿
 * `binary file matches` 当 pattern 自指查询时就会），按子串判会把真命中一起
 * 丢掉。两种原文的姿态固定 —— 提示正文紧跟路径段（`path\0 ` 或 `path: `），
 * 且**没有行号段**（命中记录必然是 `path\0<十进制>:正文`，分隔符是 `:`）。
 */
const RG_BINARY_NOTICE_BODY =
  /^(?:WARNING: )?(?:binary file matches|stopped searching binary file)/;

/** 该记录是否是 rg 的二进制提示（而非命中）。 */
export function isRgBinaryNotice(record: string): boolean {
  const nul = record.indexOf("\0");
  if (nul !== -1) {
    const rest = record.slice(nul + 1);
    // `path\0<十进制>:` 是命中记录 —— 正文里出现同样的字也不得被当提示丢掉。
    if (/^\d+:/.test(rest)) return false;
    return RG_BINARY_NOTICE_BODY.test(rest.replace(/^ /, ""));
  }
  // 无 NUL 的只有两种可能：提示行（`path: 提示正文`）或形状损坏的记录。
  const colon = record.indexOf(": ");
  return colon !== -1 && RG_BINARY_NOTICE_BODY.test(record.slice(colon + 2));
}

/**
 * 剥尾随 `\r`（rg stdout 的每一条内容记录都要过这道）。
 *
 * `argv.ts` 带了 `--crlf`：rg 按 CRLF 判行边界（`foo$` 因此能命中 CRLF 行），
 * 但**回显的行内容仍带 `\r`**（实测 15.1.0，`--null` 与否都一样）。Node 侧按
 * `\n` 切行后已剥 `\r`（见 `file-lines.splitLines`），这里不剥就是同一查询两条
 * 引擎输出差一个不可见字符 —— 模型看不到它，但字节比较与后续 `edit_file` 的
 * `old_str` 都会撞上。
 *
 * 剥除由 `truncateRgContent` 统一执行（本函数不对外）：`\r` 是 rg 判定「行
 * 超长」的字节基数的一部分（见 `stripRgPreviewMarker`），调用方若先剥再交进
 * 来，那一个字节就永久丢失、标记剥取随之判错。
 */
function stripCr(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * `--null` 下 `--count` 的输出形状：`path\0count\n`。
 *
 * count 出法不需要行号；路径用同款 NUL 定界。
 */
export function parseRgNullCounts(
  stdout: string
): ReadonlyArray<{ path: string; count: number }> {
  const counts: Array<{ path: string; count: number }> = [];
  for (const record of stdout.split("\n")) {
    if (record.length === 0) continue;
    // 二进制提示同 `parseRgNullLines`：它不是计数记录，形状判定必须一致 ——
    // 少了这道，`--count` 下的提示会被当 `path:0` 之类的假计数收下。
    if (isRgBinaryNotice(record)) continue;
    const nulIdx = record.indexOf("\0");
    if (nulIdx === -1) continue;
    const path = stripDotSlash(record.slice(0, nulIdx));
    const count = Number(record.slice(nulIdx + 1));
    if (!Number.isInteger(count) || count < 0) continue;
    counts.push({ path, count });
  }
  return counts;
}

/** `--files-with-matches --null` → `path\0` 序列。 */
export function parseRgNullPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    // 最后一段可能带尾随 \n（rg 每条记录以 \0 收尾后仍会有换行以外的
    // 空白），剥掉后再剥 `./`。
    const cleaned = stripDotSlash(record.replace(/\n+$/, ""));
    if (cleaned.length > 0) paths.push(cleaned);
  }
  return paths;
}

/**
 * 单行内容收口：按 **code point** 收到 MAX_MATCH_LINE_COLUMNS，超出加标记。
 *
 * 与 `sandbox/runner.ts` 的 `truncateByCodePoint` 是同一件事 —— 这里只是
 * 套上本层的省略标记与上限常量，切法不另写一份（旧实现的 `Array.from` +
 * `slice` 是第二份实现，漂移风险白担）。
 *
 * 纯展示闸，**不含传输层痕迹的处理**（见 `truncateRgContent`）：两条引擎的
 * 最终形状因此只由这一处决定，任何一条引擎都不多截一刀。
 */
export function truncateMatchContent(content: string): string {
  if (Array.from(content).length <= MAX_MATCH_LINE_COLUMNS) return content;
  return `${truncateByCodePoint(content, MAX_MATCH_LINE_COLUMNS)}${RG_TRUNCATION_MARKER}`;
}

/**
 * rg 解析路径的入口：先洗掉传输层痕迹，再过共用展示闸。
 *
 * 清洗必须**只在 rg 路径**做：`stripRgPreviewMarker` 的判据是「去标记后字节数
 * >= 预算」，一个真实文件里恰好那么长、又恰好以该文本结尾的行，在 Node 路径
 * 会被白白削掉一截（Node 没有传输层，那种结尾就是内容本身）—— 两条引擎对
 * 同一文件给出不同正文（D6/SC9）。所以 Node 路径只走 `truncateMatchContent`。
 *
 * 尾随 `\r` 在此剥掉（rg 回显它、Node 侧已由 `splitLines` 剥），但它的字节数
 * 要交给标记剥取当触发基数 —— 顺序不能反。
 */
export function truncateRgContent(raw: string): string {
  const hasCr = raw.endsWith("\r");
  const body = stripCr(raw);
  return truncateMatchContent(stripRgPreviewMarker(body, hasCr ? 1 : 0));
}

function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}
