/**
 * 主 pattern 编译、可行性校验与 rg 正则模式选择（两引擎共用；D6 / SC9 / SC10）。
 *
 * 单点职责：
 *   - 把 `pattern` + `ignoreCase` 编译成 RegExp，坏正则 → typed 拒绝；
 *   - 把**无法让两条引擎给出同一答案**的构造 typed 拒绝（宁可入口报错，
 *     也不要同一个查询的答案取决于哪条引擎在跑）；
 *   - 给出「这个 pattern 是否必须留在 Unicode 口径」的唯一判据
 *     （`keepsUnicodeMode`），rg 与 Node 两条引擎各按它收口。
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
 * 两条引擎的默认「匹配单位」口径不同：
 *   - JS `RegExp` **不带 `u`** 是 UTF-16 code unit 语义：`.` 与计数 quantifier
 *     一次只吃一个 code unit（实测 `a.c` 不匹配 `a😀c`、`^.{3}$` 不匹配
 *     `a😀c`），`\d` / `\w` / `\b` 只认 ASCII，但 `\s` 是 **Unicode 的**
 *     （NBSP / U+3000 都算）；
 *   - Rust regex 默认是 **code point + Unicode 类**：`.` 一次吃一个 code
 *     point，`\d` 吃 ٣٤、`\w` 吃 CJK、`\b` 把 `é` 当词字符，`\s` 与 JS 同为
 *     Unicode 口径。
 *
 * 唯一判据是 `keepsUnicodeMode(pattern)`（本模块是它的唯一实现处），两条引擎
 * 各按它收口、共用同一次扫描结果：
 *   - rg 侧：**不含**敏感构造 → 加 `--no-unicode`（切字节语义），把 `\d` /
 *     `\w` / `\b` 一类对齐到 JS 的 ASCII 口径。常开不行 —— 实测 `--no-unicode`
 *     下 `.` 退化成「一个字节」，`a.c` 反而不匹配 `aéc`，`\s` 也不再匹配
 *     NBSP；
 *   - Node 侧：**含**敏感构造 → 编译加 `u` flag（切 code point 语义），把 `.` /
 *     计数 quantifier / 字符类对齐到 rg 的 code point 口径。加 `u` 只在 rg
 *     同样留在 Unicode 模式时有意义，两边的开关因此是同一个判据的两面。
 *
 * 各写一遍判据就有漂移出「rg 切了字节、Node 没切」的余地，所以只留一个名字。
 * `u` 编译失败时退回无 `u`（见 `compilePattern`），接受集只增不减。
 *
 * 已知残留（逐条实测过，两类都不在本模块的处理面上；要收只能改成 typed
 * 拒绝，属另一刀）：
 *
 * 1) 敏感构造 × rg 的 Unicode 类混排。判据为真时 rg 留在 Unicode 模式，它的
 *    `\d` / `\w` / `\b` 是 Unicode 类；JS 即使加了 `u` 这些类仍是 ASCII 的
 *    —— `\d.` 于是 rg 多收「٣٤ alpha」（`\d` 吃阿拉伯-印度数字、`.` 吃一个
 *    code point）、JS 只收 ASCII 数字；`\w.c` 同理（rg 多收 `漢xc`）。既不能
 *    加 `--no-unicode`（会打坏 `.`），`u` 也补不上这些类。
 *
 * 2) 单反斜杠转义的接受集差异。两侧都「收」，但 `\` + 字母在 rg / PCRE2 与
 *    JS 里含义不同，且分两种来源：
 *      - Rust **默认引擎**就收的：`\A` / `\z`（rg 命中全部行，JS 读成字面量
 *        `A` / `z`，命中含该字母的行）；
 *      - Rust 不收、argv 的 `--engine=auto` 退到 PCRE2 才收的：`\Z` / `\N` /
 *        `\h` / `\H` / `\R` / `\e` / `\G` / `\K` / `\X` / `\C`（实测；PCRE2 的
 *        `\Z` 是文末锚，rg 命中全部行，JS 读字面量 `Z`）。
 *    `\q` / `\g` / `\k` / `\o` / `\y` / `\T`（以及读成两字符序列 `\c` 的
 *    `\c`）是**两个引擎都拒**：rg rc=2 typed 失败，JS（不带 `u`）读字面量
 *    `q` / `g` / `k`… 静默命中 —— 同向「都算错」，但形状不同。
 *    注意 `a{2,1}` **不是**这类残留：JS 也拒（`numbers out of order`），两边
 *    同为 typed 拒绝。
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
 *
 * `u` flag 只在 pattern 必须留在 Unicode 口径时加（`keepsUnicodeMode`，与
 * rg 侧「不加 `--no-unicode`」是同一个判据）——此时 JS 的 `.` / 计数
 * quantifier / 字符类才与 rg 的 code point 语义逐字对齐。
 *
 * 加得上才加：`u` 会收紧语法，`{` / `]` / `\A` / `\q` / `\u` 一类在它下面
 * 编不过，而它们今天在两条引擎上要么一致、要么是既有的别的分歧类。所以
 * **先试带 `u`，编不过退回不带 `u`**（今天的行为）——接受集只增不减，
 * 不存在「今天能编、改完被拒」的 pattern。
 *
 * 顺序还有一层：不带 `u` 的接受集更宽，若先编无 `u` 再按需试 `u`，就必须
 * 把「u 编不过」也实现成退回，两条分支的文案还要各写一遍。先试 `u` 只有
 * 一个出口。
 */
export function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  const base = ignoreCase ? "i" : "";
  if (keepsUnicodeMode(pattern)) {
    const unicode = tryCompile(pattern, `${base}u`);
    if (unicode !== null) return unicode;
  }
  const plain = tryCompile(pattern, base);
  if (plain !== null) return plain;
  throw new ToolExecutionError(`grep: invalid pattern: ${pattern}`);
}

/** 编得过就返回；编不过返回 null（由调用方决定退到哪一档）。 */
function tryCompile(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
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
 * 这个 pattern 是否必须留在 Unicode 口径 —— 两条引擎的**唯一**模式判据。
 *
 * `true`（含多字节敏感构造：`.` / `\s` / `\S` / `\u` / `\x` / 非 ASCII /
 * 否定类）→ rg **不加** `--no-unicode`（切字节语义会打坏它们），Node 编译
 * **加** `u`（否则 `.` / 计数 quantifier 停在 code unit 上）。
 * `false` → rg 加 `--no-unicode`，把 `\d` / `\w` / `\D` / `\W` / `\b` / `\B`
 * 对齐到 JS 的 ASCII 口径；Node 不加 `u`（加了反而把 KELVIN / LONG S 折进来，
 * 见下）。
 *
 * 取保守方向：**宁可不切，也不切坏**（见文件头注释的实测分歧）。
 *
 * ignoreCase 的两点边界（实测）：
 *   - 非 ASCII pattern + `ignoreCase` 已在入口 typed 拒绝
 *     （`assertIgnoreCaseAlignable`），所以这里只需考虑 ASCII pattern；
 *   - `i` × `u` 会把 U+212A KELVIN / U+017F LONG S 折进 `k` / `s`（实测
 *     `new RegExp("k","iu").test("\\u212A")` 为 true）—— 与 rg 留在 Unicode
 *     模式时的 simple case folding **同向**（实测 `rg -i k` 命中 `Kx`），所以
 *     判据为 true 时加 `u` 在 ignoreCase 下是**改善**而不是新分歧。
 *     反面：判据为 false 时 rg 切了 `--no-unicode`，`-i k` 不再命中 `Kx`
 *     （实测），而 Node 若加 `u` 会命中 —— 所以那侧 **不能**加 `u`，两条
 *     引擎的开关必须同源。
 */
export function keepsUnicodeMode(pattern: string): boolean {
  return hasMultiByteSensitiveConstruct(pattern);
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
