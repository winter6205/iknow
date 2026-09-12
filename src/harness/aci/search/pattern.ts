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
 * 行终止符字面（D1，实测）：`\n` 在两条引擎上**必须同判**，否则一条 `\n`
 * 就是「rg 报每个文件、Node 报空」。机制是 `--crlf` 与 `--engine=auto`
 * **叠加**的结果，单看任一个都不是原因（逐条实测）：
 *   - 只有 `--crlf`：rg 默认引擎的守卫照常命中 → rc=2，两条引擎都不给结果；
 *   - 只有 `--engine=auto`：PCRE2 收下 `\n`，但没有 `--crlf` 时行边界不在
 *     可匹配面上 → rc=1，与 Node 的空结果一致；
 *   - 两者都在：`--crlf` 触发守卫 rc=2 → auto 换 PCRE2 → PCRE2 在 `--crlf`
 *     下把行边界放进可匹配面 → rc=0 且**命中每一个文件**，Node 侧仍回空。
 *
 * 本工具是**按行**搜索：`file-lines.splitLines` 按 `\n` 切行、行内容里不含
 * LF，所以「只能匹配行终止符」的原子是死查询 —— Node 侧永远匹配不到，rg
 * 侧却可能把它当行边界。两条引擎给不出同一答案，因此这类原子在共享入口
 * typed 拒绝（`assertLineContentOnly`）：**只要 pattern 里出现一个只匹配
 * LF / CR 的原子就拒**，不看它是否被问号/星号包着（rg 的字面量预筛会让
 * `\n|zz` 这类交替也命中全部行，实测），也不看它落在哪种出法下。宁可入口
 * 报错，也不要同一个查询的答案取决于哪条引擎在跑。
 *
 * `\o{...}`（PCRE2 的字节转义，`\o{12}` = LF）走同一刀：rg 由 auto 退到
 * PCRE2 才收，JS 读成字面 `o` + 量词 —— 见 `assertEngineAlignable`。
 *
 * 单反斜杠转义的接受集差异（逐条实测过，不在本模块的处理面上；要收只能改成
 * typed 拒绝，属另一刀）。两侧都「收」，但 `\` + 字母在 rg / PCRE2 与 JS 里
 * 含义不同，且分两种来源：
 *   - Rust **默认引擎**就收的：`\A` / `\z`（rg 命中全部行，JS 读成字面量
 *     `A` / `z`，命中含该字母的行）；
 *   - Rust 不收、argv 的 `--engine=auto` 退到 PCRE2 才收的：`\Z` / `\N` /
 *     `\h` / `\H` / `\R` / `\e` / `\G` / `\K` / `\X` / `\C`（实测；PCRE2 的
 *     `\Z` 是文末锚，rg 命中全部行，JS 读字面量 `Z`）。
 * `\q` / `\g` / `\k` / `\o` / `\y` / `\T`（以及读成两字符序列 `\c` 的
 * `\c`）是**两个引擎都拒**：rg rc=2 typed 失败，JS（不带 `u`）读字面量
 * `q` / `g` / `k`… 静默命中 —— 同向「都算错」，但形状不同。
 * 注意 `a{2,1}` **不是**这类残留：JS 也拒（`numbers out of order`），两边
 * 同为 typed 拒绝。
 *
 * 字符类转义（`\s` / `\S` / `\d` / `\D` / `\w` / `\W` / `\b` / `\B`）**不再
 * 是残留**：五族曾列在这里，D5 逐族实测后由 `assertClassEscapesAlignable`
 * 在共享入口 typed 拒绝（理由与判据见该函数）。
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
 * 只匹配行终止符的原子（D1）：`\n` / `\r` 及其等价拼写。
 *
 * 命中即说明这个原子在**按行**搜索里没有可匹配的内容 —— `file-lines.splitLines`
 * 按 LF 切行、行内容不含 LF，CRLF 行尾的 CR 也被剥掉。Node 侧因此永远匹配
 * 不到，rg 侧却可能（`--crlf` + `--engine=auto`，见文件头）把它当行边界，
 * 于是每个文件都「命中」。两条引擎给不出同一答案 → 入口 typed 拒绝。
 *
 * 判据是**行为式**的、不看拼法：rg 的守卫按字面量长度决定是否放行
 * （实测 `\n|a` rc=0 而 `\n|zz` rc=2），同一条交替在语料变化时还会从「巧合
 * 一致」翻成「全命中」。所以这里只问「有没有一个原子只可能匹配 LF/CR」，
 * 不问它周围长什么样。
 */
export function assertLineContentOnly(pattern: string): void {
  const atom = findMandatoryTerminatorAtom(pattern);
  if (atom === null) return;
  throw new ToolExecutionError(
    `grep: unsupported pattern construct in ${pattern}: the atom ${atom} can only match a line terminator (LF / CR) — this tool searches line by line, so JavaScript RegExp can never match it while ripgrep may treat it as a line boundary and report every file, so the two engines would answer differently; search for something that can appear inside a line, or drop the terminator`
  );
}

/**
 * 找 pattern 里第一个「**必须**匹配行终止符」的原子；没有则返回 null。
 *
 * 三条例外（都逐条实测过是两条引擎一致的，不是推断）：
 *   - **允许零次**的量词跟在原子或它所在的组之后（`?` / `??` / `*` / `*?` /
 *     `{0}` / `{0,N}` / `{0,N}?`）→ 空匹配到处成立，两条引擎都不必碰行边界。
 *     `+?` **不**豁免：lazy 只改匹配顺序，仍要求至少一次（实测 DIFF）；
 *   - **否定** look-around 内（`(?!` / `(?<!`）→ 断言在「后面/前面不是行终止符」
 *     时成立，行内到处都成立，两条引擎同判；
 *   - 类里**还有别的可匹配成员**（`[abc\n]` / `[a\nb]`）→ 普通内容就能命中，
 *     实测 SAME。只有「整个类的成员都只能是 LF/CR」（`[\n]` / `[\r]` /
 *     `[\n\r]` / `[\x0a]`）才拒。
 *
 * **交替不豁免**：`\n|a` 看起来一致只是因为语料里恰好有 `a`（两条引擎各自靠
 * `a` 命中，是巧合）；换 `\n|zz` 立刻变成 rg 报全部、Node 只报 `zz`（实测）。
 * 所以不做「有非终止符分支就放行」的推断。
 *
 * 量词要**隔着组的右括号**看：`(?:\n)?` 与 `(\n)?` 都被实测为一致，而
 * `(?:\n)` 与 `(\n)` 不一致 —— 判据因此把「组」当成一个可被子孙污染的单位，
 * 在 `)` 处结算：组自己允许零次 → 里面的原子不带出来；否则带出来给外层。
 * 正向 look-around（`(?=` / `(?<=`）不带 `?` 时**照样带出**：`(?=\n)` 实测
 * DIFF，断言要求真的有一个行终止符，行内容里没有。
 */
function findMandatoryTerminatorAtom(pattern: string): string | null {
  const chars = [...pattern];
  /** 顶层用一个哨兵根帧；`pop` 永不丢顶层。 */
  const stack: GroupFrame[] = [{ negative: false, atom: null }];
  let inClass = false;
  let classHasNonTerminator = false;
  let classNegated = false;
  let classTerminator: TerminatorAtom | null = null;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;

    if (ch === "\\") {
      const atom = readTerminatorEscape(chars, i);
      const nextOpt = quantifyAfter(chars, i + (atom?.length ?? 2)).optional;
      if (atom !== null) {
        if (inClass) {
          /** 类内成员的 quantifier 没意义（类只描述「匹配哪些字符」），只看下一个类外量词。 */
          if (classTerminator === null)
            classTerminator = { text: atom.text, optional: nextOpt };
          else classTerminator.optional &&= nextOpt;
        } else {
          recordAtom(stack, { text: atom.text, optional: nextOpt });
        }
      } else if (inClass) {
        /** 非终止符转义（如 `\d` / `\w`）也算类里有「别的成员」。 */
        classHasNonTerminator = true;
      }
      i += (atom?.length ?? 2) - 1;
      continue;
    }

    if (inClass) {
      if (ch === "]") {
        inClass = false;
        if (
          !classHasNonTerminator &&
          classTerminator !== null &&
          !classNegated
        ) {
          /** 类自己的量词（`?` / `*` / `{0,N}`）跟在 `]` 之后，要看。 */
          classTerminator.optional ||= quantifyAfter(chars, i + 1).optional;
          recordAtom(stack, classTerminator);
        }
        classTerminator = null;
        classHasNonTerminator = false;
        classNegated = false;
      } else if (ch !== "-" && ch !== "[") {
        /** 普通字面量是「类里有别的成员」；`-` / `[` 是 rg 的 range / 类中类前缀，不算成员。 */
        classHasNonTerminator = true;
      }
      continue;
    }

    if (ch === "[") {
      inClass = true;
      classHasNonTerminator = false;
      classTerminator = null;
      /** `^` / `!` 是否定前缀；`[]]` 的首个 `]` 是字面成员（rg / PCRE2）。 */
      const next = chars[i + 1];
      if (next === "^" || next === "!") {
        classNegated = true;
        i += 1;
      } else {
        classNegated = false;
        if (next === "]") i += 1;
      }
      continue;
    }

    if (ch === "(") {
      stack.push({ negative: isNegativeAssertion(chars, i), atom: null });
      continue;
    }

    if (ch === ")") {
      /** `)` 自己的量词在这里结算：组允许零次 → 里面的原子不带出来。 */
      if (quantifyAfter(chars, i + 1).optional) stack.pop();
      else {
        const closed = stack.pop();
        if (closed !== undefined && !closed.negative && closed.atom !== null) {
          recordAtom(stack, closed.atom);
        }
      }
      continue;
    }
  }

  return (
    stack.find((frame) => frame.atom !== null && !frame.negative)?.atom?.text ??
    null
  );
}

/**
 * 记录一个「必须匹配」的原子。允许零次的不记；否定断言内的一律不记。
 *
 * 只在**最内层**记 —— 外层组结算时会把内层带出来的原子再带一层，所以同一
 * 个原子不会被重复记，也不会因为内层组允许零次而在外层复活。
 */
function recordAtom(
  stack: Array<{ negative: boolean; atom: TerminatorAtom | null }>,
  atom: TerminatorAtom
): void {
  if (atom.optional) return;
  const current = stack[stack.length - 1];
  if (current === undefined || current.negative) return;
  if (current.atom === null) current.atom = atom;
}

/** 组帧：`negative` 是否定断言；`atom` 是组内**必须匹配**的终止符原子。 */
interface GroupFrame {
  negative: boolean;
  atom: TerminatorAtom | null;
}

interface TerminatorAtom {
  text: string;
  optional: boolean;
}

/** `(?<!` / `(?!` 起始（不含 `(?<=` / `(?=`）。 */
function isNegativeAssertion(chars: ReadonlyArray<string>, i: number): boolean {
  if (chars[i + 1] !== "?") return false;
  if (chars[i + 2] === "!") return true;
  if (chars[i + 2] !== "<") return false;
  return chars[i + 3] === "!";
}

/**
 * `i` 处的转义是否只匹配 LF/CR（`\n` / `\r` / `\x0a` / `\cJ` / `\012` /
 * `\o{12}` 及其 CR 等价拼写）。返回原子原文与长度；不是则 null。
 *
 * 只认「**只**可能匹配终止符」的：`\s` / `\S` / `\W` / `\D` / `.` 都能匹配
 * 行内内容，不在此列（它们的 BOM/NEL 分歧属 D5，另一刀）。
 */
function readTerminatorEscape(
  chars: ReadonlyArray<string>,
  i: number
): { text: string; length: number } | null {
  const kind = chars[i + 1];
  if (kind === undefined) return null;

  if (kind === "n" || kind === "r") return { text: `\\${kind}`, length: 2 };

  const twoHex = readFixedHex(chars, i, 2);
  if (twoHex !== null && isTerminatorCode(twoHex.value)) {
    return { text: twoHex.text, length: twoHex.length };
  }

  const control = readControlEscape(chars, i);
  if (control !== null && isTerminatorCode(control.value)) {
    return { text: control.text, length: control.length };
  }

  const octal = readOctalEscape(chars, i);
  if (octal !== null && isTerminatorCode(octal.value)) {
    return { text: octal.text, length: octal.length };
  }
  return null;
}

/** `\xHH`（定长两位）。`\x{...}`（码点转义）另有判据，不在此处理。 */
function readFixedHex(
  chars: ReadonlyArray<string>,
  i: number,
  digits: number
): { value: number; text: string; length: number } | null {
  if (chars[i + 1] !== "x") return null;
  const slice = chars.slice(i + 2, i + 2 + digits).join("");
  if (slice.length !== digits || !/^[0-9a-fA-F]+$/.test(slice)) return null;
  return {
    value: parseInt(slice, 16),
    text: `\\x${slice}`,
    length: 2 + digits,
  };
}

/** `\cJ` / `\cM`（control escape，大小写不敏感）。 */
function readControlEscape(
  chars: ReadonlyArray<string>,
  i: number
): { value: number; text: string; length: number } | null {
  if (chars[i + 1] !== "c") return null;
  const letter = chars[i + 2];
  if (letter === undefined) return null;
  const upper = letter.toUpperCase();
  if (upper === "J") return { value: 10, text: `\\c${letter}`, length: 3 };
  if (upper === "M") return { value: 13, text: `\\c${letter}`, length: 3 };
  return null;
}

/**
 * 八进制转义：`\0NN` / `\NNN` / `\o{NN}`。值是字节，只认 10（LF）/ 13（CR）。
 *
 * `\40`（空格）这类**不是**终止符，必须放行 —— 判据按数值而不是按拼法。
 */
function readOctalEscape(
  chars: ReadonlyArray<string>,
  i: number
): { value: number; text: string; length: number } | null {
  if (chars[i + 1] === "o" && chars[i + 2] === "{") {
    const close = chars.indexOf("}", i + 3);
    if (close === -1) return null;
    const digits = chars.slice(i + 3, close).join("");
    if (!/^[0-7]+$/.test(digits)) return null;
    return {
      value: parseInt(digits, 8),
      text: `\\o{${digits}}`,
      length: close - i + 1,
    };
  }
  const digits = readOctalDigits(chars, i + 1);
  if (digits === "") return null;
  return {
    value: parseInt(digits, 8),
    text: `\\${digits}`,
    length: 1 + digits.length,
  };
}

/** 取 `\` 之后连续的八进制数字（最多 3 位）。 */
function readOctalDigits(chars: ReadonlyArray<string>, from: number): string {
  let digits = "";
  for (let i = from; i < chars.length && digits.length < 3; i += 1) {
    const ch = chars[i]!;
    if (ch < "0" || ch > "7") break;
    digits += ch;
  }
  return digits;
}

function isTerminatorCode(value: number): boolean {
  return value === 10 || value === 13;
}

/** 紧随位置 `from` 的量词是否允许零次重复（`?` / `*` / `{0,...}`，含 lazy）。 */
function quantifyAfter(
  chars: ReadonlyArray<string>,
  from: number
): { optional: boolean } {
  const ch = chars[from];
  if (ch === "?") return { optional: chars[from + 1] !== "+" };
  if (ch === "*") return { optional: true };
  if (ch !== "{") return { optional: false };
  const close = chars.indexOf("}", from);
  if (close === -1) return { optional: false };
  const body = chars.slice(from + 1, close).join("");
  const match = /^(\d+)(?:,(\d*))?$/.exec(body);
  if (match === null) return { optional: false };
  return { optional: match[1] === "0" };
}

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
 * 字符类转义 × Unicode 口径分叉（D5，逐条实测）：
 *
 * 五族都无法让两条引擎在「同一个 pattern、同一个语料」下给出同一答案 —
 * - 不是「这条慢那条快」也不是「这条少一条」那种可静默修的对齐缺口，而是
 *   「同一个输入，两条引擎给的命中集真的不同」。选择标准：宁可 typed 拒绝，
 *   也不要同一个查询的答案取决于哪条引擎在跑（SC9 / SC10）。
 *
 * 拆成两层（与 `hasSensitiveEscape` / `keepsUnicodeMode` 的判据对齐）：
 *
 * - `\s` / `\S` —— **永远**拒绝。两条引擎的 Unicode 空白表天生不同：
 *   rg 收 NEL（U+0085）不收 BOM（U+FEFF），JS 收 BOM 不收 NEL（实测，
 *   `nel-bom-detail.mts`）。任意语料都可能踩到其中一边，让两条引擎落到
 *   同一答案的可能性是 0。ASCII 空白（SP / TAB）两边一致 —— 但这是
 *   「恰好这条语料里没 BOM/NEL」的巧合，不是契约能保的事。
 *
 * - `\d` / `\D` / `\w` / `\W` / `\b` / `\B` —— **只在 Unicode 模式**拒绝。
 *   字节模式（rg `--no-unicode` + Node 不加 `u`，由 `keepsUnicodeMode=false`
 *   触发）下两边的类都按 ASCII 走，`\d` 不吃 `٣`、`\w` 不吃 `漢`、`\b` 把
 *   `é` 当非词字符 —— 完全 SAME（实测 `H1` 系列）。但 `漢` / `.` / 否定类
 *   一旦逼出 Unicode 模式，类原子就分叉（实测 `H2` 系列）：rg 收 `٣`
 *   而 JS 不收（`\d.` on `٣٤`）、rg 收 `漢` 而 JS 不收（`\w.` on `漢x`）、
 *   `é` 两侧词字归属相反（`\bé` 在 `café` 上一致但 `\b漢` 在 `a漢b` 上
 *   rg 空 / JS 命中）。
 *
 * 替代方案被实测否定（不必再考虑）：
 * - 「`(?-u)` 局部关 Unicode」会让 `.` 退字节（`(?-u)a.c` 不匹配 `aéc`），
 *   不能在保留 `.` 的同时让 `\d` 走 ASCII。
 * - 「rg 的 `(*UCP)` / `(*NO_UCP)`」由 `--engine=auto` 拒收（实测 rc=2）。
 * - 「`--no-unicode` 常开」打坏 `.` / `\s` / NBSP（实测）。
 *
 * 因此收口只有 typed 拒绝一处。判据只问构造名（不含类内位置 —— 见 `B` 例
 * 外）：`[\\b]` 是退格字节（0x08），两边都吃，不会被本判据误伤；
 * `[^\\w]` 是字符类，`\\w` 是它**唯一**的成员，按家族语义拒绝即可。
 *
 * 字面量先剥掉成对反斜杠：`\\\\s` 在两条引擎上都读成字面 `\\s`，是用户
 * 在搜字面反斜杠 + s，不算敏感构造。
 */
export function assertClassEscapesAlignable(pattern: string): void {
  /** `\s` / `\S` —— 必拒（无条件）。 */
  const WHITESPACE_FAMILY = /\\[sS]/;
  /** `\d` / `\D` / `\w` / `\W` / `\b` / `\B` —— Unicode 模式下必拒。 */
  const CLASS_FAMILY = /\\[dDwWbB]/;
  const escaped = pattern.replace(/\\\\/g, "");

  if (WHITESPACE_FAMILY.test(escaped)) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: \\s / \\S whitespace class — ripgrep and JavaScript RegExp use different Unicode whitespace tables (ripgrep accepts NEL but not BOM; JavaScript accepts BOM but not NEL), so the two engines would answer differently on the same query; spell out the whitespace characters you need (e.g. [ \\t] for ASCII, [ \\t\\u00a0] to also include NBSP)`
    );
  }

  if (keepsUnicodeMode(pattern) && CLASS_FAMILY.test(escaped)) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: \\d / \\D / \\w / \\W / \\b / \\B class escape combined with a Unicode-mode trigger (non-ASCII literal, '.', or negated class) — ripgrep uses Unicode classes (\\d eats ٣, \\w eats 漢, \\b treats é as a word char) while JavaScript RegExp keeps these classes ASCII-only, so the two engines would answer differently; remove the Unicode trigger to stay in byte mode (where both engines agree on ASCII classes) or spell the class out (e.g. [0-9] for digits, [A-Za-z] for words)`
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
