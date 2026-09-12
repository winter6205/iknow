/**
 * 主 pattern 编译、可行性校验与 rg 正则模式选择（两引擎共用；D6 / SC9 / SC10）。
 *
 * 单点职责：
 *   - 把 `pattern` + `ignoreCase` 编译成 RegExp，坏正则 → typed 拒绝；
 *   - 把**无法让两条引擎给出同一答案**的构造 typed 拒绝（宁可入口报错，
 *     也不要同一个查询的答案取决于哪条引擎在跑）；
 *   - 给出 rg 侧要不要 `--no-unicode`（`rgNeedsUnicodeDisabled`）。
 *
 * Node 引擎直接用 `compilePattern`；rg 引擎用它做**前置**校验（rg 自己也会
 * 以 rc=2 报同类错误，前置校验让两条路径文案一致、且不必先花一次进程启动）。
 *
 * 与未知 `type` 的错误严格区分（SC10）：本模块文案均点名 `pattern`（或构造
 * 名），`argv.ts` 的 type 文案含 `type` 而不含 `pattern`，测试直接比对真实
 * message。三类构造各有一条文案，互不混同。
 *
 * ── 为什么要做模式选择（逐条实测，不是推断）──
 *
 * JS `RegExp` 不带 `u` flag 是 **UTF-16 code unit** 语义：`\d` / `\w` / `\b`
 * 只认 ASCII，但 `\s` 是 **Unicode 的**（NBSP / U+3000 都算）。Rust regex 默认
 * 是 **code point + Unicode 类**：`\d` 吃 ٣٤、`\w` 吃 CJK、`\b` 把 `é` 当词
 * 字符。两边在最常用的构造上就不同，实测分歧：
 *   - `\d` / `\w` / `\D` / `\W` / `\b`：rg 默认**多收**非 ASCII；
 *   - `\s` / `\S`：rg 默认**少**收 NBSP / U+3000（JS `\s` 收）。
 * `--no-unicode` 把 rg 切成字节语义，能对齐前者（这正是本工具要的），却会打坏
 * 后者 —— 实测 `a.c` 在 `--no-unicode` 下不匹配 `aéc`（`.` 退化成「一个
 * 字节」），`\s` 也不再匹配 NBSP。所以既不能常开也不能常关：**只在 pattern
 * 完全不含「匹配单位可能是多字节字符」的构造时**才加（此时两边逐字对齐），
 * 其余构造由 `assertEngineAlignable` / `assertIgnoreCaseAlignable` 在入口拒绝。
 */

import { ToolExecutionError } from "../../errors.js";

/**
 * Unicode property escape：`\p{...}` / `\P{...}` / `\pL` / `\P{L}`。
 *
 * rg 按 Unicode 属性选类；JS 无 `u` flag 时把 `\p` 读成字面 `p` —— 两条引擎
 * 必然给出不同答案，且**静默**：JS 侧会去命中含字面 `p{L}` 的行，不报错。
 */
const PROPERTY_ESCAPE = /\\[pP](?:\{[^}]*\}|[A-Za-z])/;

/**
 * 码点转义：`\u{...}` / `\x{...}` / `\N{...}`。
 *
 * 与 property escape 同类：rg 支持（`\u{6f22}` = 漢），JS 无 `u` flag 时按
 * 字面读（`u{6f22}`）。注意 `é` / `\xE9` 这类**定长**转义两边一致，不拒。
 */
const CODE_POINT_ESCAPE = /\\[uxN]\{/;

/** 去掉 `\x` 转义对，供方括号类扫描用（`\[` 不算类的开始）。 */
const ESCAPED_PAIR = /\\./g;

/**
 * POSIX 方括号类（**类中类**）：`[[:alpha:]]` / `[^[:digit:]]` / `[a[:word:]]`。
 *
 * rg 把它当 ASCII 类；JS 读成「字符集里再嵌一个 `[`」——`[[:alpha:]]` 实际是
 * 字符集合 `[:alph]`，于是 `:` 或 `[` 单独出现就命中，形状完全对不上。裸
 * `[:alpha:]`（方括号**外**）两边都是字面字符集，一致，**不拒**。
 *
 * 判据写成「一个未闭合的 `[` 后面出现 `[:name:]`」：先剥掉 `\x` 转义对，
 * 于是 `\[[:alpha:]]`（转义后的字面 `[`）不会被误判。
 */
const POSIX_CLASS = /\[[^\]]*\[:[A-Za-z]+\:\]/;

/**
 * 编译主 pattern；坏正则 → typed 拒绝（消息含 pattern 原文）。
 *
 * 本函数**不做**可行性校验（那是 `assertEngineAlignable` 的职责）——handler
 * 里两道依次走，坏正则的文案因此不会被新错误抢走。
 */
export function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    throw new ToolExecutionError(`grep: invalid pattern: ${pattern}`);
  }
}

/**
 * 已知会让 rg 与 JS `RegExp` 分叉、且**无法**用 `--no-unicode` 对齐的构造
 * → typed 拒绝。
 *
 * 在**共享入口**调用（handler 对两条引擎都会走），同一个 pattern 在两条引擎
 * 上的成败因此一致 —— 不是「rg 能搜、Node 静默回空」。
 */
export function assertEngineAlignable(pattern: string): void {
  if (PROPERTY_ESCAPE.test(pattern)) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: Unicode property escape (\\p{...} / \\P{...}) — ripgrep selects a Unicode property class while JavaScript RegExp reads \\p as a literal 'p', so the two engines would answer differently; spell the class out (e.g. [A-Za-z] for letters, [0-9] for digits)`
    );
  }
  if (CODE_POINT_ESCAPE.test(pattern)) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: code point escape (\\u{...} / \\x{...} / \\N{...}) — ripgrep accepts it while JavaScript RegExp reads it literally, so the two engines would answer differently; write the character itself, or the fixed-width \\u00e9 / \\xE9 form`
    );
  }
  if (POSIX_CLASS.test(pattern.replace(ESCAPED_PAIR, ""))) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: POSIX bracket class ([[:name:]]) — ripgrep reads it as an ASCII class while JavaScript RegExp reads it as a literal character set, so the two engines would answer differently; spell the class out (e.g. [A-Za-z] / [0-9])`
    );
  }
}

/**
 * `ignoreCase` + 有大小写的非 ASCII 字符 → typed 拒绝。
 *
 * 加 `--no-unicode` 后 rg 的 `-i` 只做 ASCII 折叠，JS 的 `i` 折 Unicode
 * （实测 `-i CAFÉ`：Node 命中 `café`，rg 不命中）；而 `--no-unicode` 又不能
 * 去（少了它 `\d` / `\w` / `\b` 又分叉）—— 两条路都走不通，只能拒绝。
 *
 * 判据只认**真的有大小写**的字符（`toLowerCase() !== toUpperCase()`）：CJK
 * 没有大小写，`-i 漢` 在两条引擎下都命中（实测），必须继续可用。
 */
export function assertIgnoreCaseAlignable(
  pattern: string,
  ignoreCase: boolean
): void {
  if (!ignoreCase) return;
  const cased = [...pattern].find(isCasedNonAscii);
  if (cased === undefined) return;
  throw new ToolExecutionError(
    `grep: unsupported combination in ${pattern}: ignoreCase with the non-ASCII cased character '${cased}' — ripgrep's case folding is ASCII-only while JavaScript RegExp folds Unicode, so the two engines would answer differently; drop ignoreCase and spell both cases out`
  );
}

/**
 * rg 侧要不要加 `--no-unicode`。
 *
 * `true` = pattern 只含「两边本来就同语义」的构造，`--no-unicode` 把
 * `\d` / `\w` / `\D` / `\W` / `\b` / `\B` 一并对齐且不伤任何东西；
 * `false` = 含多字节敏感构造（`.` / `\s` / `\S` / `\u` / `\x` / `\0` 以外的
 * 非 ASCII / 否定类），切字节语义会打坏它们，必须留在 Unicode 模式。
 *
 * 判定取保守方向：**宁可不切，也不切坏**（见文件头注释的实测分歧）。
 */
export function rgNeedsUnicodeDisabled(pattern: string): boolean {
  return !hasMultiByteSensitiveConstruct(pattern);
}

/**
 * 扫描 pattern 里的「匹配单位可能是多字节字符」的构造。
 *
 * 两条**互不相干**的判据，任一命中就得留在 Unicode 模式：
 *   - 转义类（`hasSensitiveEscape`）：`\s` / `\S` / `\u` / `\x` 在字节语义下
 *     含义会变；`\d` / `\w` / `\b` 一类**不算**（那正是要切过去的理由）。
 *     转义与方括号无关（`[\s]` 同样敏感），故单独一趟扫；
 *   - 字面类（`hasSensitiveLiteral`）：`.` 与非 ASCII 字面量（`.` 在字节语义
 *     下只吃一个字节）、`[^...]` / `[!...]`（否定类只匹配单个**字节**）、
 *     `[...]` 内的非 ASCII 成员。
 */
function hasMultiByteSensitiveConstruct(pattern: string): boolean {
  return hasSensitiveEscape(pattern) || hasSensitiveLiteral(pattern);
}

/** `\s` / `\S` / `\u` / `\x` 出现即敏感（含类内）。先剥掉成对反斜杠，`\\s` 不算。 */
function hasSensitiveEscape(pattern: string): boolean {
  return /\\[sSux]/.test(pattern.replace(/\\\\/g, ""));
}

/** 逐字符走 `.` / 非 ASCII / 否定类 / 类内非 ASCII；`[...]` 状态由本趟维护。 */
function hasSensitiveLiteral(pattern: string): boolean {
  const chars = [...pattern];
  let inClass = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === "\\") {
      i += 1; // 转义对整对跳过，`\.` 不算「点」
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      else if (isMultiByte(ch)) return true;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      const opened = openClass(chars, i);
      if (opened.sensitive) return true;
      i += opened.skip;
      continue;
    }
    if (isSensitiveLiteral(ch)) return true;
  }
  return false;
}

/**
 * `[...]` 起始处：否定类（`[^` / `[!`）在字节语义下只匹配一个字节 → 敏感；
 * `[]]` 的首个 `]` 是字面成员（rg 语法，见 glob-match 同源说明），要跳过。
 */
function openClass(
  chars: ReadonlyArray<string>,
  i: number
): { sensitive: boolean; skip: number } {
  if (chars[i + 1] === "^" || chars[i + 1] === "!") {
    return { sensitive: true, skip: 0 };
  }
  return { sensitive: false, skip: chars[i + 1] === "]" ? 1 : 0 };
}

function isSensitiveLiteral(ch: string): boolean {
  return ch === "." || isMultiByte(ch);
}

/**
 * 该字符是否有大小写概念（CJK / emoji / 标点都没有）。
 *
 * 只有非 ASCII 才算：ASCII 的大小写折叠在 rg 的 `-i` 与 JS 的 `i` 下完全
 * 一致（两边都折 `A`-`Z`），拒绝 `foo` 这类再普通不过的查询是误伤。
 */
function isCasedNonAscii(ch: string): boolean {
  if (ch.codePointAt(0)! <= 0x7f) return false;
  return ch.toLowerCase() !== ch.toUpperCase();
}

function isMultiByte(ch: string): boolean {
  return (ch.codePointAt(0) ?? 0) > 0x7f;
}
