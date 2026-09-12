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
 * 在共享入口 typed 拒绝（理由与判据见该函数）——其中 `\s` / `\S` / `\B`
 * 无条件拒，`\d` / `\D` / `\w` / `\W` / `\b` 仅在 Unicode 模式拒
 * （`[\b]` 类内退格豁免）。
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
 * 只匹配行终止符的原子（D1）：任何**值是 LF (0x0A) 或 CR (0x0D)** 的原子。
 *
 * 命中即说明这个原子在**按行**搜索里没有可匹配的内容 —— `file-lines.splitLines`
 * 按 LF 切行、行内容不含 LF，CRLF 行尾的 CR 也被剥掉。Node 侧因此永远匹配
 * 不到，rg 侧却可能（`--crlf` + `--engine=auto`，见文件头）把它当行边界，
 * 于是每个文件都「命中」。两条引擎给不出同一答案 → 入口 typed 拒绝。
 *
 * 判据是**按数值**（LF = 10，CR = 13），不看拼法 —— 这是本轮的关键修正
 * （之前用「按拼写枚举」漏了 `\u000a` / `\U0000000A` / 裸 LF / 裸 CR）。拼写
 * 枚举永远会漏下一族：实测表覆盖以下**全部**拼写（任一族被忽略就会漏一族）：
 *
 *   - 字面转义：`\n` / `\r`
 *   - 定长十六进制：`\xHH`（2 位）、`\uHHHH`（4 位）、`\UHHHHHHHH`（8 位）
 *   - 控制转义：`\cJ` / `\cM`（不分大小写）
 *   - 八进制：`\NNN` / `\0NN` / `\o{NNN}`（任意位数的合法八进制数）
 *   - **裸字节**：pattern 字符串里**直接**出现 LF (U+000A) / CR (U+000D)
 *     字符 —— 这是与「拼写枚举」对立的语义：不是看 `\`，是看 code point。
 *
 * 上下文同样按数值判：
 *   - 类（`[...]`）：成员里**全部**只能匹配 LF/CR（`[\n]` / `[\r]` /
 *     `[\u000a]`）→ 拒。**有别的可匹配成员**（`[a\nb]` / `[\n a]`）→ 放
 *     行：普通内容就能命中（实测 SAME）。
 *   - 组（`(...)` / `(?...)`）：外层**允许零次**（`?` / `??` / `*` / `*?` /
 *     `{0}` / `{0,N}`）→ 里面的 LF 原子不带出来（实测 SAME）；否则带出。
 *   - 否定 look-around（`(?!...)` / `(?<!...)`）→ LF 原子不带出（实测
 *     SAME：行内到处不是 LF，断言总成立）。
 *   - **交替不豁免**：`\n|a` 看起来一致只是因为语料里恰好有 `a`；换 `\n|zz`
 *     立刻 rg 报全部、Node 只报 `zz`（实测）。所以不靠「有非终止符分支」。
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
 * 判据是**值**（LF = 10 / CR = 13），不是拼写 —— 见 `assertLineContentOnly`
 * 的实测表。裸 LF/CR 字符与 `\n` / `\u000a` / `\U0000000A` 走同一条路。
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
        /**
         * 类内成员的 quantifier 没意义（类只描述「匹配哪些字符」），只看下
         * 一个类外量词；类外原子照常按「允许零次」结算。
         */
        if (inClass) {
          if (classTerminator === null) {
            classTerminator = { text: atom.text, optional: nextOpt };
          } else {
            classTerminator.optional &&= nextOpt;
          }
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
      } else if (ch === "\n" || ch === "\r") {
        /**
         * **裸 LF / CR 字节**（本轮新增的一族）：不是 `\` 转义，而是 pattern
         * 字符串里直接出现 U+000A / U+000D。语义判据（值 = 10 / 13）在这里
         * 生效 —— 与 `\n` / `\x0a` 及「类内裸 LF」走同一条记录路径，而不是
         * 再枚举一族拼写。实测（`/tmp/tool-matrix.mts`，真实二进制 + 真实
         * argv）：类内裸 LF 在 rg 侧命中每个文件、Node 侧回空。
         */
        if (classTerminator === null) {
          classTerminator = {
            text: ch === "\n" ? "\\n" : "\\r",
            optional: false,
          };
        }
      } else if (ch !== "-" && ch !== "[") {
        /** 普通字面量是「类里有别的成员」；`-` / `[` 是 rg 的 range / 类中类前缀，不算成员。 */
        classHasNonTerminator = true;
      }
      continue;
    }

    if (ch === "\n" || ch === "\r") {
      /**
       * 裸 LF / CR 在**类外**：与 `\n` / `\r` 同为终止符原子（同一个值），
       * 走同一条记录路径。实测（`/tmp/tool-matrix.mts`）：`a<LF>` 在 rg 侧
       * 命中 `a` 结尾的行、Node 侧回空 —— 不是「两条引擎都没得匹配」的巧合。
       */
      recordAtom(stack, {
        text: ch === "\n" ? "\\n" : "\\r",
        optional: quantifyAfter(chars, i + 1).optional,
      });
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
 * `i` 处的转义是否只匹配 LF/CR。返回原子原文与长度；不是则 null。
 *
 * 判据是**值 = 10 或 13**，覆盖全部会取到该值的拼写（实测表见
 * `assertLineContentOnly` 的 doc）：
 *   - `\n` / `\r`（字面转义）
 *   - `\xHH`（2 位定长十六进制）
 *   - `\uHHHH`（4 位定长十六进制）—— 本轮新增；实测 `\u000a` rg rc=2
 *     （`rg: the literal "\n" is not allowed in a regex`）、Node 静默
 *     回空（JS 无 `u` 时 `\u000a` 是**既存**转义，值就是 LF）
 *   - `\UHHHHHHHH`（8 位定长十六进制）—— 本轮新增；`\U0000000A` 实测
 *     rg rc=2、Node 静默回空（**裸** JS 无 `u` 时它读成字面 `U` + 数字，
 *     值不是 10，但 rg 读成码点 10 → 分叉）
 *   - `\cJ` / `\cM`（control escape，大小写不敏感）
 *   - `\NNN` / `\0NN` / `\o{NNN}`（八进制，值按数值判）
 *
 * 只认「**只**可能匹配终止符」的：`\s` / `\S` / `\W` / `\D` / `.` 都能匹配
 * 行内内容，不在此列（它们的空白表 / 类口径分歧属 D5，另一刀）。
 */
function readTerminatorEscape(
  chars: ReadonlyArray<string>,
  i: number
): { text: string; length: number } | null {
  const kind = chars[i + 1];
  if (kind === undefined) return null;

  if (kind === "n" || kind === "r") return { text: `\\${kind}`, length: 2 };

  /**
   * 定长十六进制三兄弟共用 `readFixedHex`：只有**宽度**不同，判据（值是否
   * 10 / 13）同一份。`\u{...}` / `\x{...}`（变宽码点转义）不走这里 —— 它们
   * 由 `assertEngineAlignable` 的 `CODE_POINT_ESCAPE` 收口。
   */
  for (const [marker, digits] of [
    ["x", 2],
    ["u", 4],
    ["U", 8],
  ] as const) {
    if (kind !== marker) continue;
    const fixed = readFixedHex(chars, i, digits, marker);
    if (fixed !== null && isTerminatorCode(fixed.value)) {
      return { text: fixed.text, length: fixed.length };
    }
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

/**
 * `\<marker>` + 定长 `digits` 位十六进制（`\xHH` / `\uHHHH` / `\UHHHHHHHH`）。
 * `\x{...}` / `\u{...}`（变宽码点转义）另有判据，不在此处理。
 */
function readFixedHex(
  chars: ReadonlyArray<string>,
  i: number,
  digits: number,
  marker: string
): { value: number; text: string; length: number } | null {
  if (chars[i + 1] !== marker) return null;
  const slice = chars.slice(i + 2, i + 2 + digits).join("");
  if (slice.length !== digits || !/^[0-9a-fA-F]+$/.test(slice)) return null;
  return {
    value: parseInt(slice, 16),
    text: `\\${marker}${slice}`,
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
 * 白名单：两条引擎解析成**同一个原子**的反斜杠转义字母。
 *
 * 来源不是文档、是 fuzz：整字母表 × 4 种后缀形态（裸 / `{...}` / `HH` /
 * `HHHH` / `HHHHHHHH`）× 类内类外，用真实 rg + 真实 argv 与 Node 回退各跑
 * 一遍（`/tmp/fuzz-escapes.mts`，824 行）。**只列两边同判的**；表外一律拒。
 *
 * 为什么是「白名单反转」而不是「再枚举一列坏拼写」：这是同一个坑的第三次
 * （按拼写枚举 → 漏下一族）。fuzz 的结论是发散**不是有限的拼写表** ——
 * 24 个字母 × 4 种后缀 × 两种位置，靠枚举永远补不完。反过来只放行已实测
 * 对齐的集合，rg 将来新增转义也只会落进拒绝面，不会静默分叉。
 *
 * 各字母的实测归类（`/tmp/escape-semantics.mts` 97 行）：
 *   - **对齐（进白名单）**：`\. \* \+ \? \( \) \[ \] \{ \} \| \^ \$ \\ \/
 *     \- \# \& \~ \_ \! \@ \% \ ` 等**标点类**（两引擎都读字面）、
 *     `\t \f \v \n \r`（控制字符）、`\0`+八进制、`\cX`（control）、
 *     `\xHH` / `\uHHHH` / `\UHHHHHHHH`（定长十六进制，**仅当解析成功**）、
 *     `\d \D \w \W \s \S \b \B`（D5 层按 Unicode 口径管）、
 *     `\p{...}` / `\P{...}` / `\u{...}` / `\x{...}` / `\N{...}`（上文已拒）。
 *   - **不对齐（出白名单 → 拒）**：`\a`（JS 读字面 `a`、rg 读 BEL）、
 *     `\e`（JS 字面 `e`、PCRE2 读 ESC）、`\A \z \Z \G \K`（锚，rg 命中
 *     全部行、JS 读字面字母）、`\h \H \R \V \X \C \N`（PCRE2 专有类，
 *     JS 读字面）、`\g \i \j \k \l \m \o \q \y`（两引擎都拒、JS 读字面）、
 *     `\E \Q`（PCRE2 引号对，JS 读字面）、`\F \I \J \L \M \O \T \Y`
 *     （PCRE2 拒、Rust 拒、JS 读字面）。
 *   - **后缀敏感**：`\x` / `\u` / `\U` / `\c` **光杆**时 JS 读字面、不被
 *     当作转义；`\uHHHH` / `\UHHHHHHHH` 解析成功但 rg（Rust）拒收 —— 这两
 *     条的歧义靠 D1 层按**值**收口（值是 LF/CR 就 D1 拒），非 LF/CR 值时
 *     `A` / `\U00000041` 实测**不**进分叉表（见 fuzz 基线）。`\o{...}`
 *     走 D1 的值判据（`\o{12}` = LF 已拒）；非终止符值（`\o{40}` / `\o{101}`）
 *     实测 DIVERGE，**不在白名单**。
 *
 * 单字母索引（`ALIGNED_ESCAPE_LETTERS`）；结构性转义（十六进制 / 八进制 /
 * control / `{...}` 形态）另有判据。**不在白名单的字母直接拒**，不看后缀。
 */
const ALIGNED_ESCAPE_LETTERS = new Set([
  // 控制字符转义：两引擎同值
  "t",
  "n",
  "r",
  "f",
  "v",
  // 定长十六进制 / 八进制 / control：由 `readFixedHex` / `readOctalDigits` /
  // `readControlEscape` 按值解析；解析成功即两引擎同值
  "x",
  "u",
  "U",
  "c",
  // 字符类（D5 层管口径）
  "d",
  "D",
  "w",
  "W",
  "s",
  "S",
  "b",
  "B",
  // property escape / 码点转义：上文 PROPERTY_ESCAPE / CODE_POINT_ESCAPE 已拒
  "p",
  "P",
  "N",
  // 八进制字面（`\0` / `\12` / `\101`）：`\0` 后跟数字才成八进制，
  // 由数值判据（D1）收口；光杆 `\0` 两引擎都读 NUL，SAME
  "0",
]);

/**
 * 标点类转义：`\.` / `\*` / `\\` 等。两引擎都读字面，永远对齐。
 *
 * 判据是「非字母数字」而不是枚举标点 —— JS 对非字母数字的转义一律读字面，
 * rg 同样（`. * + ? ( ) [ ] { } | ^ $ \ / - # & ~ _ ! @ %` 实测 SAME）。
 * 非 ASCII 字面（`\漢` / `\é`）也走这条（实测 SAME；`\é` rg 默认 rc=2、
 * auto 退 PCRE2 rc=1，两边都回空，仍 SAME）。
 */
function isLiteralEscapeLetter(ch: string): boolean {
  return !/[A-Za-z0-9]/.test(ch);
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
  /**
   * 结构层（与反斜杠转义并列）的两条 fuzz 残项 —— 不带 `\letter`，所以
   * 转义字母扫描挡不住；按生成式探针实测两边仍分叉：
   *
   * - `{,N}` / `{,N,M}` / `{,}` **从**空下界的量词：rg（Rust 与 PCRE2）把它
   *   解析成量词（"0 to N"），JS RegExp 把 `{` 当字面，整段不命中（实测
   *   `a{,2}` rg 命中全部文件、JS 命中 `a{,2}b` 那一行）。带非空下界
   *   `a{2,}` / `a{2,5}` 两条引擎同判（都是量词），不放进这里。
   *
   * - 空字符类 `[]` / `[^]`：rg-default 与 rg-pcre2 **都** rc=2 拒收，
   *   JS RegExp 编过、`test()` 永远 false —— 一个 typed-reject、一个静默空答，
   *   是用户看见的"工具答不出来"和"工具说没结果"的差别。这种 case 用
   *   typed 拒绝把两条路径对齐成同一个错误。`[!]` 是 POSIX 否定类，rg 与
   *   JS 都按 POSIX 处理，**不**算分叉 —— 不要误拒。
   */
  assertStructuralAlignable(pattern);
  /**
   * 反斜杠转义字母接受集差异（fuzz 结果收口）：不在 `ALIGNED_ESCAPE_LETTERS`
   * 且不是标点类的字母 → typed 拒绝。
   *
   * 不看后缀形态（`{...}` / `HH` / `HHHH` / `HHHHHHHH`），只看**字母本身**
   * —— `\o` 裸在 rg 侧 rc=2、JS 侧读字面 `o`，与 `\o{101}` 是同一个字
   * 母的问题；`\A{2}` / `\A41` 是同一个字母的不同后缀，由同一条 gate 拒。
   * D1 / D5 的按值判据会先在这里跑，LF/CR 值转义与 Unicode 模式下的类转
   * 义已在前面拒掉；这里只负责把"两引擎解析不同"的那族字母统统一刀。
   */
  assertAlignedEscapeLetter(pattern);
}

/**
 * fuzz 出的非对齐字母扫描（见 `assertEngineAlignable` 上面的注释）。`\o`
 * 的解析要求形态是 `\o{NNN}`；不在白名单的光杆一律拒，光杆 `\o` 由它本身
 * 出白名单触发。`\\` 是合法的转义对（`\\s` = 字面 `\s`，两引擎 SAME），
 * 跳过整对。
 *
 * 结构敏感族（`\x` / `\u` / `\U` / `\c` / `\N` / `\p` / `\P` / `\o` / `\0` /
 * `\n` 等控制字符）需要**同时**校验后缀形态：
 *   - `\x` 必须跟 **2** 个十六进制位；`\xZ` / `\x` rg rc=2、JS 读字面 `x`。
 *   - `\u` 必须跟 **4** 位十六进制（**不**带大括号 —— 带大括号走
 *     CODE_POINT_ESCAPE 上游 gate）。`\u` 光杆、`\uZZZZ` 都是分歧。
 *   - `\U` 必须跟 **8** 位十六进制。
 *   - `\c` 必须跟 **一个字母**（`\cJ` = LF、`\cA` = SOH）。`\c{...}` / `\cHH`
 *     在 rg 侧被解析成数字（在 PCRE2 里 `\c{...}` 是字符类 / 量化），JS 读
 *     字面 `\c{...}` —— 与 `\cX` 不同形，要拒。
 *   - `\N` 必须跟 `{...}`（走 CODE_POINT_ESCAPE 上游 gate），光杆 JS 读字面 N。
 *   - `\p` / `\P` 必须跟 `{...}` 或单字母（走 PROPERTY_ESCAPE 上游 gate），
 *     光杆 rg rc=2、JS 读字面。
 *   - `\o` 必须跟 `{octal}` 且值为 LF/CR（前者交给下游 D1 按值判据）；裸
 *     `\o` / `\o40` / `\o{101}` JS 读字面。
 *   - `\NNN`（数字起头）走八进制数字解析；光杆 `\1` / `\8`（数字 8 在八进制
 *     范围外）在两条引擎上一致拒（rg rc=2、JS 也编不过）—— 不需要在这里
 *     单独拒，但需要把 `\d` 这类已知的 D5 / D1 路径让位给它们。
 *
 * `\d` / `\D` / `\w` / `\W` / `\s` / `\S` / `\b` / `\B` 后**不能再接量化**
 * 在两条引擎上分歧（`\D{...}` / `\W{...}` 实测 rg 命中非数字行、JS 编不过）
 * —— 这条只对 `{}` 形态的量化生效（`*` / `+` / `?` 是合法量化），由
 * `assertAlignedEscapeSuffix` 的量化收尾段挡。
 */
function assertAlignedEscapeLetter(pattern: string): void {
  const escaped = pattern.replace(/\\\\/g, "");
  const chars = [...escaped];
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (chars[i] !== "\\") continue;
    const letter = chars[i + 1]!;
    if (isLiteralEscapeLetter(letter)) {
      i += 1; // 整对跳过：`\\.` / `\\*` 一类的标点 / 非 ASCII 两引擎读字面
      continue;
    }
    if (letter >= "0" && letter <= "9") {
      /** `\N` / `\NN` / `\NNN` —— 反向引用 / 八进制 / 字面三岔口，判据见
       * `assertDigitEscapeAlignable`。 */
      i = assertDigitEscapeAlignable(escaped, chars, i) - 1;
      continue;
    }
    if (ALIGNED_ESCAPE_LETTERS.has(letter)) {
      /** 结构族（hex / 控制字符 / property / code point / octal）走
       * `assertAlignedEscapeSuffix` 验后缀形态。 */
      i = assertAlignedEscapeSuffix(chars, i, letter) - 1;
      continue;
    }
    // `\letter`（letter ∉ 白名单 ∉ 标点）→ 出 fuzz 的 288 行 DIVERGE
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: \\${letter} — ripgrep and JavaScript RegExp parse this escape differently (one engine rejects with rc=2, the other reads it as the literal character \\${letter}, or only one engine accepts a feature escape while the other does not); pick a different escape — see \\p / \\P / \\d / \\D / \\w / \\W / \\b / \\B / \\s / \\S / \\n / \\r / \\t / \\f / \\v / \\xHH / \\uHHHH / \\UHHHHHHHH / \\cX / \\NNN / \\p{...} / \\u{...} / \\x{...} / \\N{...} / \\o{NNN} (LF/CR only) / \\. \\* \\+ \\? \\( \\) \\[ \\] \\{ \\} \\| \\^ \\$ \\\\`
    );
  }
}

/**
 * 数字族（`\N` / `\NN` / `\NNN`）：两引擎的"反向引用 vs 八进制 vs 字面"
 * 三岔口收口。判据按**语义**（这一段在两引擎上解析成同一个原子吗），不按
 * 拼写枚举 —— 本族到此为止按拼写补过多次，每次都有漏网的成员。
 *
 * 三条子判据，每条都由生成式 fuzz 的 DIVERGE 表反推、并被同一 fuzz 复跑
 * 验证归零（`/home/winner/.claude/jobs/0df87588/tmp/fuzz-escapes.mts`）：
 *
 * 1. **> 3 位数字整族拒。** 两引擎都只把前 3 位当八进制，但第 4 位起
 *    PCRE2 直接 rc=2 拒、JS 读字面数字 → 给不出同一答案。
 *
 * 2. **含 8/9 整族拒。** `\8` / `\9` 在八进制范围外：PCRE2 rc=2 拒，JS 读
 *    字面 `8` / `9`。
 *
 * 3. **八进制值 ≥ 0x80 整族拒。** 这是本族最容易按拼写漏掉的一条：值在
 *    低半区（`\0`..`\177`）时两引擎都当 ASCII 字节，一致；到 `\200` 以上，
 *    rg 按 **UTF-8 码点**解、JS 按**单字节**解 —— 同一段文本一个命中
 *    `b80`（字节 0x80）另一个不命中。实测 `\200` / `\277` / `\300` 在
 *    `0groups` / `1group` / `2groups` 三档下 rg=rc1-无命中、JS=命中 `b80`。
 *
 *    **高频用法 `\040`（空格）落在低半区，仍然放行** —— 这是本条不能简化成
 *    "数字转义一律拒"的原因。
 *
 * 4. **单数字 `\1`..`\9` 越界拒。** PCRE2 只把 1-9 当反向引用，目标组不
 *    存在时 rc=2 拒整条 pattern；JS 在 `N > groupCount` 时读**字面数字**。
 *    判据要看**前缀**的捕获组数（`countCaptureGroups`）。多数字（`\12` /
 *    `\040`）不走这条：两引擎都按八进制读，无此歧义，前导 `0` 更不是
 *    反向引用。
 *
 * 值的 **LF/CR**（`\12` / `\15`）由上游 `assertLineContentOnly` 按值拒，
 * 这里不重复 —— 两处都判会让错误文案二义。
 */
function assertDigitEscapeAlignable(
  pattern: string,
  chars: ReadonlyArray<string>,
  i: number
): number {
  /** `\N` 的 N 起点 = 转义字母本身（letter 已在 `[0-9]` 命中），取其后的
   * 连续数字 —— octal 路径两引擎都只吃**前 3 位**。 */
  let j = i + 1;
  while (j < chars.length && chars[j]! >= "0" && chars[j]! <= "9") j += 1;
  const run = chars.slice(i + 1, j).join("");
  const head = run.slice(0, 3);
  const digitError = (detail: string): never => {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: \\${run} ${detail} — ripgrep and JavaScript RegExp would answer differently; write the character itself, or an octal escape of at most 3 digits in the range \\0..\\177`
    );
  };
  if (run.length > 3) {
    digitError(
      "has more than 3 digits (ripgrep rejects it while JavaScript RegExp reads the first 3 as an octal escape and the rest as literal digits)"
    );
  }
  if (/[89]/.test(run)) {
    digitError(
      "contains 8 or 9, which is out of range for an octal escape (ripgrep rejects it while JavaScript RegExp reads the digit literally)"
    );
  }
  /** 八进制值 ≥ 0x80 时 rg 按 UTF-8 码点解、JS 按单字节解（实测
   * `probe-numeric.mts`：`\200` 在 0/1 组时 rg rc=1 而 JS rc=0 命中
   * `b80`）。低半区（`\0`..`\177`）两边同为 ASCII 字节，才对齐 —— 正向
   * 对照 `\040`（空格）/ `\177`（DEL）在 `probe-positive-controls.mts` 里
   * 两边同为 rc=0。 */
  const value = parseInt(head, 8);
  if (value >= 0x80) {
    digitError(
      `is the octal value ${value} (0x${value.toString(16)}), at or above 0x80 — ripgrep decodes it as a UTF-8 code point while JavaScript RegExp matches the single byte, so the two engines would answer differently`
    );
  }
  /** 单数字反向引用 `\1`..`\9`：PCRE2 只接受指向真实存在的组，组号越界时
   * rc=2 拒；JS 在 `N > groupCount` 时读**字面数字** —— 分叉。实测
   * `fuzz-escapes` Dimension 7 的 `0groups\1`..`2groups\7` 共 19 行在修复前
   * 是 DIVERGE（rg ERR:engine-rc2 / node RESULT），加这条后归零。
   *
   * 多数字（`\12` / `\040`）没有这层歧义：两引擎都按八进制读，所以不查
   * groupCount（实测同一 fuzz 的多数字行修复前后都是 SAME）。前导 `0`
   * （`\0` / `\040`）同样不是反向引用。 */
  const groupCount = countCaptureGroups(chars, i);
  if (run.length === 1 && run !== "0" && parseInt(run, 10) > groupCount) {
    digitError(
      `is a backreference to a group that does not exist (only ${groupCount} capturing group(s) precede it) — ripgrep rejects the pattern with rc=2 while JavaScript RegExp reads the digit literally, so the two engines would answer differently`
    );
  }
  return j;
}

/**
 * `\` 之前出现的**捕获组**个数（`(` 不计 `(?` 开头的非捕获构造）。
 *
 * 只服务于 `assertDigitEscapeAlignable` 的反向引用判据：`\N` 是否指向一个
 * 真实存在的组。`(?<name>...)` 是**具名捕获组**，`(?P<name>...)` 同理；
 * `(?:` / `(?=` / `(?!` / `(?<=` / `(?<!` / `(?#` / `(?i` 一类不是捕获组。
 */
function countCaptureGroups(
  chars: ReadonlyArray<string>,
  until: number
): number {
  let count = 0;
  for (let k = 0; k < until; k += 1) {
    if (chars[k] !== "(") continue;
    const next = chars[k + 1];
    if (next !== "?") {
      count += 1; // 普通捕获组
      continue;
    }
    const third = chars[k + 2];
    /** `(?<name>` 与 `(?P<name>` 是具名捕获组；`(?<=` / `(?<!` 是断言。 */
    if (third === "<" && chars[k + 3] !== "=" && chars[k + 3] !== "!")
      count += 1;
    if (third === "P" && chars[k + 3] === "<") count += 1;
  }
  return count;
}

/**
 * 结构层 fuzz 残项（与反斜杠转义并列）：`{,N}` 量词 + 空字符类。
 *
 * `assertAlignedEscapeLetter` 处理 `\letter` 一族，不带反斜杠的结构分歧走
 * 这里。判据只盯"被两条引擎解析成不同东西"的最窄集合 —— 探针实测过、不靠
 * 拼写枚举（**这个坑的第四次按拼写补**）。两条路径都从同一份 fuzz 同源
 * 收口（`fuzz-escapes.mts` Dimension 6 + 本 pass），判据是
 * "两条引擎对这一段能给出同一个答案吗"，不是"它是不是合法量词"。
 *
 * - **空下界量词** `{,N}` / `{,N,M}` / `{,}` —— 必须从 `{` 后**没有数字**
 *   就接 `,` 才算。`\{,N\}` 是字面序列，两条引擎都读字面，**不**算分叉。
 *   类内（`[{,2}]`）两引擎都把它当类成员，**不**算分叉（实测 SAME）。
 *
 * - **空字符类** `[]` / `[^]` —— 必须在 `[` 后**第一个**字符就是 `]`（或
 *   `^` 加 `]`）。`[!]` 是 POSIX 否定类，两引擎都按 POSIX 处理，**不**算
 *   分叉（实测 SAME）。`\[` 是字面 `[`，两引擎都读字面，**不**算分叉。
 *   `[\]]` 类的闭合在转义 `\]` 之后，正常类，**不**算分叉（实测 SAME）。
 *
 * 检测时跳过 `\\` （剥成对反斜杠：字面 `\\` 在两条引擎上读字面 `\\`，不是
 * 转义起点）；并跟踪 `[]` 类内 / 类外位置（量词只在类外歧义）。
 */
export function assertStructuralAlignable(pattern: string): void {
  const stripped = pattern.replace(/\\\\/g, "");
  const chars = [...stripped];
  let inClass = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === "\\") {
      i += 1; // 跳过整对转义：\`letter` 不参与结构层判断
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      const next = chars[i + 1];
      const after = chars[i + 2];
      /** 空字符类 `[]` / `[^]`：rg 拒、JS 读字面。`[!]` 是 POSIX，两边同判。 */
      if (next === "]" || (next === "^" && after === "]")) {
        throw new ToolExecutionError(
          `grep: unsupported pattern construct in ${pattern}: empty character class (${ch}${next ?? ""}${after ?? ""}) — ripgrep rejects an empty class with rc=2 while JavaScript RegExp accepts it (matches nothing), so the two engines would answer differently; write the class you actually want, e.g. [a-z] or [^\\n]`
        );
      }
      inClass = true;
      continue;
    }
    if (ch === "{") {
      /** 空下界量词 `{,N}` / `{,N,M}` / `{,}` —— rg 解析成量词、JS 读字面
       * `{`。判断：跳过空白后**第一个非空字符**是 `,`。类内（已在上面
       * `continue`）和 `\{...\}`（`\\` 整对跳过）都不算。 */
      let j = i + 1;
      while (j < chars.length && chars[j] === " ") j += 1;
      if (j < chars.length && chars[j] === ",") {
        throw new ToolExecutionError(
          `grep: unsupported pattern construct in ${pattern}: brace quantifier with an empty lower bound ({,N} or {,}) — ripgrep parses it as a quantifier (0 to N matches) while JavaScript RegExp reads the { as a literal character, so the two engines would answer differently; write the lower bound explicitly (e.g. {0,2} instead of {,2})`
        );
      }
    }
  }
}

/**
 * 验转义对 `\letter`（letter ∈ `ALIGNED_ESCAPE_LETTERS`）的**后缀形态**
 * 是不是被两条引擎都接受。返回**新下标**（跳过整对与后缀），不合规则
 * typed 拒绝。
 */
function assertAlignedEscapeSuffix(
  chars: ReadonlyArray<string>,
  i: number,
  letter: string
): number {
  /** 控制字符 `\t` / `\n` / `\r` / `\f` / `\v` —— 整对 2 字符。 */
  if (
    letter === "t" ||
    letter === "n" ||
    letter === "r" ||
    letter === "f" ||
    letter === "v"
  ) {
    return i + 2;
  }
  /** `\x` 必须跟 **2** 个十六进制位。 */
  if (letter === "x") {
    const slice = chars.slice(i + 2, i + 4).join("");
    if (slice.length !== 2 || !/^[0-9a-fA-F]+$/.test(slice)) {
      throw escapeSuffixError(chars, i, "\\x requires exactly 2 hex digits");
    }
    return i + 4;
  }
  /** `\u` 必须跟 **4** 个十六进制位（**不带**大括号 —— 带大括号走
   * 上游 CODE_POINT_ESCAPE gate）。值落在 UTF-16 代理对范围（U+D800..
   * U+DFFF）时两条引擎**仍**分叉：rg（Rust 引擎）按码点拒收，JS 按
   * code unit 读 —— 实测 `probe-comment-claims.mts`：`\uD83D` rg rc=2、
   * JS rc=0 命中 `emoji.txt,surr.txt`；`A` 两边同为 rc=0 `A.txt`
   * （对照组）。所以这条不只是"格式校验"，还要按**值**再卡一次。之后**也**
   * 不能跟更多十六进制位（`\uHHHHHH` rg rc=2、JS 读 `\uHHHH` + 字面）。 */
  if (letter === "u") {
    const slice = chars.slice(i + 2, i + 6).join("");
    if (slice.length !== 4 || !/^[0-9a-fA-F]+$/.test(slice)) {
      throw escapeSuffixError(
        chars,
        i,
        "\\u requires exactly 4 hex digits (without braces; \\u{...} is a different gate)"
      );
    }
    const cp = parseInt(slice, 16);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new ToolExecutionError(
        `grep: unsupported pattern construct in ${chars.join("")}: \\u${slice} is in the UTF-16 surrogate range (U+D800..U+DFFF) — ripgrep rejects it as an invalid code point while JavaScript RegExp reads it as a lone surrogate code unit, so the two engines would answer differently; use the surrogate pair \\uD83D\\uDE00 for 😀, or write the supplementary character itself`
      );
    }
    const tail = chars[i + 6];
    if (tail !== undefined && /[0-9a-fA-F]/.test(tail)) {
      throw new ToolExecutionError(
        `grep: unsupported pattern construct in ${chars.join("")}: \\u${slice} followed by another hex digit — the two engines disagree on the suffix boundary`
      );
    }
    return i + 6;
  }
  /** `\U` 不是 JS 转义 —— JS 把 `\U00000041` 读成字面 `U00000041`
   *（反斜杠 + U 字母 + 8 位十六进制字面），rg 解析为码点 U+41 = `A`。
   * 任何 8-hex 值都会分叉（实测 `probe-comment-claims.mts`：`\U00000041`
   * rg rc=0 `A.txt` / JS rc=1；`\U0001F600` rg rc=0 `emoji.txt` / JS rc=1）。
   * **整族拒**，不只拒 LF/CR —— 没有一个值能让两条引擎给出同一答案。 */
  if (letter === "U") {
    const slice = chars.slice(i + 2, i + 10).join("");
    if (slice.length !== 8 || !/^[0-9a-fA-F]+$/.test(slice)) {
      throw escapeSuffixError(chars, i, "\\U requires exactly 8 hex digits");
    }
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${chars.join("")}: \\U${slice} — JavaScript RegExp has no \\UHHHHHHHH escape (it reads \\U + 8 hex digits literally as the text "U${slice}"), while ripgrep parses \\U${slice} as the Unicode code point U+${slice}, so the two engines would answer differently; for code points above U+FFFF use the surrogate pair (\\uD83D\\uDE00) or write the character itself`
    );
  }
  /** `\c` 必须跟**一个字母**（控制转义）。`\c{...}` / `\cHH` 不在此形。 */
  if (letter === "c") {
    const next = chars[i + 2];
    if (next === undefined || !/[A-Za-z]/.test(next)) {
      throw escapeSuffixError(chars, i, "\\c requires exactly one letter");
    }
    return i + 3;
  }
  /** `\p` / `\P` / `\N` —— 已由上游 PROPERTY_ESCAPE / CODE_POINT_ESCAPE 拒，
   * 这里只校验"光杆也要拒"。 */
  if (letter === "p" || letter === "P" || letter === "N") {
    throw escapeSuffixError(
      chars,
      i,
      `\\${letter} requires a {name} or single-letter form (handled by an upstream gate) — the bare \\${letter} diverges between ripgrep and JavaScript RegExp`
    );
  }
  /** 类原子 `\d` / `\D` / `\w` / `\W` / `\s` / `\S` / `\b` / `\B` —— 后
   * 不能接 `{...}` 量化。`*` / `+` / `?` / `{,N}` / `{N,}` 量化在两条
   * 引擎上一致；但 `{...}` 实测 DIVERGE（rg 命中、JS 编不过）。 */
  if ("dDwWbBsS".includes(letter)) {
    const next = chars[i + 2];
    if (next === "{") {
      throw escapeSuffixError(
        chars,
        i,
        `\\${letter} cannot be followed by a brace — the two engines diverge on \\${letter}{...} (ripgrep accepts it, JavaScript RegExp rejects the syntax)`
      );
    }
    return i + 2;
  }
  return i + 2;
}

function escapeSuffixError(
  chars: ReadonlyArray<string>,
  i: number,
  detail: string
): never {
  // Aborts the loop early by throwing — handler catches the ToolExecutionError.
  void chars;
  void i;
  throw new ToolExecutionError(
    `grep: unsupported pattern construct: ${detail}`
  );
}

/**
 * 字符类转义 × Unicode 口径分叉（D5，逐条实测）：
 *
 * 各家族都无法让两条引擎在「同一个 pattern、同一个语料」下给出同一答案 —
 * 不是「这条慢那条快」也不是「这条少一条」那种可静默修的对齐缺口，而是
 * 「同一个输入，两条引擎给的命中集真的不同」。选择标准：宁可 typed 拒绝，
 * 也不要同一个查询的答案取决于哪条引擎在跑（SC9 / SC10）。
 *
 * 拆成三层（层与层的差别是**拒绝条件**，不是构造名）：
 *
 * - `\s` / `\S` —— **无条件**拒绝。两条引擎的 Unicode 空白表天生不同：
 *   rg 收 NEL（U+0085）不收 BOM（U+FEFF），JS 收 BOM 不收 NEL（实测
 *   `/tmp/s-uncond.mts`）。且不止于 Unicode：`--crlf` 让 rg 在匹配前剥掉
 *   行尾 CR，JS 的 `\s` 却把 CR 当空白 —— 纯 ASCII 语料里一个**行中**裸 CR
 *   就够分叉（实测 `a\rb`：rg 不命中、Node 命中），所以「限 ASCII 就安全」
 *   不成立。两条路都堵死，只能无条件拒。
 *
 * - `\B` —— **无条件**拒绝（本轮从条件层挪上来）。原以为「byte 模式能对齐
 *   `\B`」的前提**不成立**，实测（`/tmp/d5-class-b.mts`，真实 argv）：
 *   rg 在 byte 模式下把多字节字符的**内部**字节边界也算「非词边界」，
 *   `a漢b` / `a€b` / `a£b` 都命中；JS 无 `u` 时逐 code unit 看，`漢` / `€` /
 *   `£` 前后的 code unit 全是非词字符，`\B` 不成立 → 同一行 rg 命中、Node
 *   不命中。类内形态更硬：rg 对 `[\B]` **两种模式都 rc=2**（Rust 引擎
 *   `invalid escape sequence found in character class`，PCRE2 也拒），JS 却
 *   把 `\B` 读成字面 `B` 静默命中 —— 一个 rc=2 一个 rc=0，没有任何语料
 *   能让二者同判。
 *
 * - `\d` / `\D` / `\w` / `\W` / `\b` —— **只在 Unicode 模式**拒绝。字节模式
 *   （rg `--no-unicode` + Node 不加 `u`，由 `keepsUnicodeMode=false` 触发）
 *   下两边的类都按 ASCII 走，`\d` 不吃 `٣`、`\w` 不吃 `漢`、`\b` 把 `é`
 *   当非词字符 —— 完全 SAME（实测 `/tmp/tool-bmode.mts` 的 byte 段）。
 *   但 `漢` / `.` / 否定类一旦逼出 Unicode 模式，类原子就分叉（同文件
 *   unicode 段）：rg 收 `٣` 而 JS 不收（`\d.` on `٣٤`）、rg 收 `漢` 而 JS
 *   不收（`\w.` on `漢x`）、`é` 两侧词字归属相反（`\b漢` 在 `a漢b` 上
 *   rg 命中 `a漢b` / Node 命中 `漢` 那一行之外的文件）。
 *
 * **类内 `\b` 是唯一的位置例外**：`[\b]` 是退格字节 0x08，rg 与 JS 都按
 * 字面字节读（实测 `[\b]` 在两模式下都 SAME，含 `[\b]漢` / `[\b.]` /
 * `[\b£]` 这类 Unicode 触发组合）。所以 `\b` 的扫描必须**区分类内类外** ——
 * 类外 `\b` 是词边界（Unicode 模式下分叉），类内 `\b` 是退格（永远一致）。
 * 只对 `\b` 开这个口子：`\d` / `\w` 在类内仍是类成员，照常按家族拒
 * （`[\d]漢` 实测 DIVERGE）。
 *
 * 替代方案被实测否定（不必再考虑）：
 * - 「`(?-u)` 局部关 Unicode」会让 `.` 退字节（`(?-u)a.c` 不匹配 `aéc`），
 *   不能在保留 `.` 的同时让 `\d` 走 ASCII。
 * - 「rg 的 `(*UCP)` / `(*NO_UCP)`」由 `--engine=auto` 拒收（实测 rc=2）。
 * - 「`--no-unicode` 常开」打坏 `.` / `\s` / NBSP（实测）。
 *
 * 因此收口只有 typed 拒绝一处。字面量先剥掉成对反斜杠：`\\\\s` 在两条
 * 引擎上都读成字面 `\\s`，是用户在搜字面反斜杠 + s，不算敏感构造。
 */
export function assertClassEscapesAlignable(pattern: string): void {
  const escaped = pattern.replace(/\\\\/g, "");

  /** `\s` / `\S` —— 必拒（无条件，含类内）。 */
  if (hasEscape(escaped, (kind) => kind === "s" || kind === "S")) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: \\s / \\S whitespace class — ripgrep and JavaScript RegExp use different Unicode whitespace tables (ripgrep accepts NEL but not BOM; JavaScript accepts BOM but not NEL) and ripgrep's --crlf strips a trailing CR before matching while JavaScript's \\s matches it, so the two engines would answer differently on the same query; spell out the whitespace characters you need (e.g. [ \\t] for ASCII, [ \\t\\u00a0] to also include NBSP)`
    );
  }

  /**
   * `\B` —— 必拒（无条件，含类内）：byte 模式下 rg 把多字节字符的内部字节
   * 边界也算非词边界，JS 逐 code unit 看结论相反；类内 `[\B]` 更是 rg
   * rc=2 而 JS 静默读字面 `B`。
   */
  if (hasEscape(escaped, (kind) => kind === "B")) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: \\B non-word-boundary — ripgrep counts a byte position inside a multi-byte character as a non-word boundary while JavaScript RegExp (without the u flag) does not, and inside a character class ripgrep rejects \\B outright while JavaScript reads it as a literal 'B', so the two engines would answer differently; there is no way to spell a non-word-boundary that both engines compute the same way`
    );
  }

  if (
    keepsUnicodeMode(pattern) &&
    hasClassAwareEscape(
      escaped,
      (kind) => "dDwWb".includes(kind),
      (kind) => kind === "b"
    )
  ) {
    throw new ToolExecutionError(
      `grep: unsupported pattern construct in ${pattern}: \\d / \\D / \\w / \\W / \\b class escape combined with a Unicode-mode trigger (non-ASCII literal, '.', or negated class) — ripgrep uses Unicode classes (\\d eats ٣, \\w eats 漢, \\b treats é as a word char) while JavaScript RegExp keeps these classes ASCII-only, so the two engines would answer differently; remove the Unicode trigger to stay in byte mode (where both engines agree on ASCII classes) or spell the class out (e.g. [0-9] for digits, [A-Za-z] for words)`
    );
  }
}

/**
 * 剥过成对反斜杠的 pattern 里，是否有**任意位置**（含类内）的家族转义。
 *
 * 用于无条件家族（`\s` / `\S` / `\B`）：这三族在类内类外都分叉，位置无关。
 */
function hasEscape(
  escaped: string,
  inFamily: (kind: string) => boolean
): boolean {
  const chars = [...escaped];
  for (let i = 0; i < chars.length - 1; i += 1) {
    if (chars[i] !== "\\") continue;
    const kind = chars[i + 1]!;
    if (inFamily(kind)) return true;
    i += 1; // 整对跳过：`\\d` 的 `d` 不是转义起始
  }
  return false;
}

/**
 * 剥过成对反斜杠的 pattern 里，是否有**家族内**的转义，且与 `classExempt`
 * 集合里的转义在类内不算。
 *
 * 用于条件家族（`\d` / `\D` / `\w` / `\W` / `\b`）：类内 `\b` 是退格字节
 * 0x08（两条引擎一致），但 `\d` / `\w` 在类内仍是类成员，会随类的
 * Unicode 模式触发一起分叉（实测 `[\d]漢` / `[\w]漢` 都是 DIVERGE）。
 * `classExempt` 只豁免 `\b`，其余成员照常计入。
 */
function hasClassAwareEscape(
  escaped: string,
  inFamily: (kind: string) => boolean,
  classExempt: (kind: string) => boolean
): boolean {
  const chars = [...escaped];
  let inClass = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === "\\") {
      const kind = chars[i + 1];
      if (kind !== undefined && inFamily(kind)) {
        if (!inClass || !classExempt(kind)) return true;
      }
      i += 1; // 整对跳过
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      /** `[^` / `[!` 是否定前缀；`[]]` 的首个 `]` 是字面成员（rg 语法）。 */
      const next = chars[i + 1];
      if (next === "^" || next === "!") i += 1;
      else if (next === "]") i += 1;
      continue;
    }
  }
  return false;
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
 * `false` → rg 加 `--no-unicode`，把 `\d` / `\w` / `\D` / `\W` / `\b` 对齐到
 * JS 的 ASCII 口径；Node 不加 `u`（加了反而把 KELVIN / LONG S 折进来，见下）。
 * `\B` 曾按此对齐，实测推翻了前提（byte 模式下 rg 仍把多字节字符的内部字节
 * 边界算非词边界）——现在它由 `assertClassEscapesAlignable` 无条件拒绝，不在
 * 本判据的覆盖面上。
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
