/**
 * 主 pattern 编译 / 语义可行性校验 / rg 模式选择单测（D6、SC9、SC10）。
 *
 * 锁的不变式：
 *   - 坏正则 → typed 拒绝且文案点名 `pattern`；
 *   - 无法让两引擎对齐的构造（`\p{...}` / `\P{...}` / `\u{...}` /
 *     `[[:name:]]`）在**共享入口**拒绝，文案点名构造与理由；
 *   - 三类新文案与坏正则、未知 `type` 的文案互不混同（SC10）；
 *   - `ignoreCase` + 有大小写的非 ASCII → 拒绝；CJK（无大小写）+ `ignoreCase`
 *     必须继续放行；
 *   - `keepsUnicodeMode`：`.` / `\s` / `\S` / `\u` / 非 ASCII / 否定类必须留在
 *     Unicode 模式（rg 不加 `--no-unicode`、Node 加 `u`），`\d` / `\w` / `\b`
 *     一类切走（rg 加 `--no-unicode`、Node 不加 `u`）；
 *   - `compilePattern` 按同一判据加 `u`，且**加不上必须退回无 `u`**（接受集
 *     只增不减）。
 *
 * 规则来源是真实二进制与 `node -e` 的逐条实测（见 `pattern.ts` 文件头），
 * 这里只钉住判定结果，不再重复跑进程。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  assertEngineAlignable,
  assertIgnoreCaseAlignable,
  assertLineContentOnly,
  compilePattern,
  keepsUnicodeMode,
} from "../../../../src/harness/aci/search/pattern.ts";
import { resolveTypeName } from "../../../../src/harness/aci/search/type-table.ts";

function messageOf(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

function rejects(fn: () => unknown, expected: RegExp): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof ToolExecutionError && expected.test(error.message)
  );
}

describe("compilePattern — 坏正则（SC10）", () => {
  it("未闭合括号 → typed 拒绝，文案含 pattern 原文", () => {
    rejects(() => compilePattern("(unclosed", false), /pattern/);
    rejects(() => compilePattern("(unclosed", false), /\(unclosed/);
  });

  it("合法正则原样编译（ignoreCase 走 i flag）", () => {
    assert.equal(compilePattern("a+", false).test("aaa"), true);
    assert.equal(compilePattern("a", false).test("A"), false);
    assert.equal(compilePattern("a", true).test("A"), true);
  });
});

describe("assertEngineAlignable — 无法对齐的构造", () => {
  it("Unicode property escape `\\p{L}` → typed 拒绝且点名构造", () => {
    rejects(() => assertEngineAlignable("\\p{L}+"), /property escape/);
    rejects(() => assertEngineAlignable("\\p{L}+"), /\\p\b|p\{/);
  });

  it("`\\P{...}` / `\\pL` 两种形态同样拒绝", () => {
    rejects(() => assertEngineAlignable("\\P{L}"), /property escape/);
    rejects(() => assertEngineAlignable("\\pL"), /property escape/);
  });

  it("码点转义 `\\u{...}` / `\\x{...}` / `\\N{...}` → typed 拒绝", () => {
    rejects(() => assertEngineAlignable("\\u{6f22}"), /code point escape/);
    rejects(() => assertEngineAlignable("\\x{6f22}"), /code point escape/);
    rejects(
      () => assertEngineAlignable("\\N{LATIN SMALL LETTER E}"),
      /code point escape/
    );
  });

  it("POSIX 类中类 `[[:alpha:]]` → typed 拒绝且点名构造", () => {
    rejects(() => assertEngineAlignable("[[:alpha:]]+"), /POSIX bracket class/);
    rejects(() => assertEngineAlignable("[^[:digit:]]"), /POSIX bracket class/);
    rejects(() => assertEngineAlignable("[a[:word:]]"), /POSIX bracket class/);
  });

  it("裸 `[:alpha:]`（方括号外的字面字符集）不拒绝：两引擎一致", () => {
    assert.doesNotThrow(() => assertEngineAlignable("[:alpha:]"));
  });

  it("转义后的字面 `\\[` 不触发类中类误判", () => {
    assert.doesNotThrow(() => assertEngineAlignable("\\[[:alpha:]]"));
  });

  it("两条引擎共用的对齐类放行（`\\d` / `\\b` / look-around / 反向引用）", () => {
    for (const pattern of [
      "\\d+",
      "\\bfoo\\b",
      "(?=foo)foo",
      "(foo)\\1",
      "a.c",
    ]) {
      assert.doesNotThrow(() => assertEngineAlignable(pattern), pattern);
    }
  });
});

describe("assertLineContentOnly — 行终止符原子必须同判（D1）", () => {
  it("裸 `\\n` / `\\r` → typed 拒绝且点名构造", () => {
    rejects(() => assertLineContentOnly("\\n"), /line terminator/);
    rejects(() => assertLineContentOnly("\\r"), /line terminator/);
    rejects(() => assertLineContentOnly("\\n"), /\\n/);
  });

  it("带量词的终止符原子（`+` / `{1,}` / `{2}` / lazy `+?`）同样拒绝", () => {
    // 实测：`\n+?` 是 lazy 但仍要求至少一次 → rg 报每个文件、Node 报空。
    for (const pattern of [
      "\\n+",
      "\\r+",
      "\\n+?",
      "\\n{1}",
      "\\n{1,}",
      "\\n{2}",
      "\\n{2,3}",
      "a\\n",
      "a\\nb",
      "^\\n",
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("只含终止符的类（`[\\n]` / `[\\r]` / `[\\n\\r]` / `[\\x0a]`）拒绝", () => {
    for (const pattern of [
      "[\\n]",
      "[\\r]",
      "[\\n\\r]",
      "[\\r\\n]",
      "[\\x0a]",
      "[\\x0d]",
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("等价拼写（`\\x0a` / `\\cJ` / `\\012` / `\\o{12}`）按数值判，不看拼法", () => {
    for (const pattern of [
      "\\x0a",
      "\\x0d",
      "\\cJ",
      "\\cM",
      "\\012",
      "\\015",
      "\\o{12}",
      "\\o{015}",
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
    // `\x41` = 'A'、`\o{40}` = 空格、`\101` = 'A'：不是终止符，必须放行。
    for (const pattern of ["\\x41", "\\o{40}", "\\101", "\\040"]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("允许零次的量词豁免：`\\n?` / `\\n*` / `\\n{0,2}` / `[\\n]?` / `(?:\\n)?`", () => {
    // 实测 SAME：空匹配到处成立，两条引擎都不必碰行边界。
    for (const pattern of [
      "\\n?",
      "\\n??",
      "\\n*",
      "\\n*?",
      "\\n{0}",
      "\\n{0,2}",
      "\\n{0,1}?",
      "[\\n]?",
      "[\\n]*",
      "[\\n]{0,1}",
      "(?:\\n)?",
      "(\\n)?",
      "(?:\\n){0}",
      "\\r?",
    ]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("否定断言内的终止符原子豁免（`(?!\\n)` / `(?<!\\n)`）", () => {
    // 实测 SAME：断言在「不是行终止符」时成立，行内到处成立。
    for (const pattern of ["(?!\\n)", "(?<!\\n)", "a(?!\\n)", "(?!\\r)"]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("正向断言**不**豁免：`(?=\\n)` / `(?<=\\n)` 实测 DIFF", () => {
    for (const pattern of ["(?=\\n)", "(?<=\\n)", "a(?=\\n)"]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("交替**不**豁免：`\\n|a` 的一致是语料巧合", () => {
    // `\n|a` 在含 a 的语料上两侧都靠 `a` 命中（巧合）；语料换成不含 a 时
    // rg 立刻报全部文件、Node 报空（实测 `\n|zz`）。故不做分支推断。
    rejects(() => assertLineContentOnly("\\n|a"), /line terminator/);
    rejects(() => assertLineContentOnly("\\n|zz"), /line terminator/);
    rejects(() => assertLineContentOnly("(?:\\n|a)"), /line terminator/);
    rejects(() => assertLineContentOnly("(a|\\n)"), /line terminator/);
  });

  it("可匹配行内内容的构造放行（`[^\\n]` / `[abc\\n]` / `\\d` / `\\s` / `.`）", () => {
    for (const pattern of [
      "[^\\n]",
      "[^\\r]",
      "[^\\n\\r]",
      "[abc\\n]",
      "[a\\nb]",
      "[\\nabc]",
      "[abc\\n]+",
      "\\d",
      "\\s",
      "\\S",
      "\\W",
      "\\D",
      ".",
      "a.c",
      "foo",
      "",
    ]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("文案与既有三类构造互不混同（SC10）", () => {
    const message = messageOf(() => assertLineContentOnly("\\n"));
    assert.match(message, /line terminator/);
    assert.doesNotMatch(
      message,
      /property escape|code point escape|POSIX bracket/
    );
    assert.match(message, /\\n/);
  });
});

describe("assertIgnoreCaseAlignable — ignoreCase × 非 ASCII（SC9）", () => {
  it("非 ASCII 且有大小写 + ignoreCase → typed 拒绝且点名 ignoreCase 与字符", () => {
    rejects(() => assertIgnoreCaseAlignable("CAFÉ", true), /ignoreCase/);
    rejects(() => assertIgnoreCaseAlignable("café", true), /ignoreCase/);
    rejects(() => assertIgnoreCaseAlignable("café", true), /é/);
  });

  it("CJK（无大小写）+ ignoreCase 放行：两条引擎答案相同", () => {
    // 实测：`-i 漢` 在 rg（含 --no-unicode）与 Node 都命中 —— 汉字没有大小写
    // 概念，折叠与否不影响结果，拒绝它会砍掉一条本来一致的查询。
    assert.doesNotThrow(() => assertIgnoreCaseAlignable("漢字", true));
    assert.doesNotThrow(() => assertIgnoreCaseAlignable("漢", true));
  });

  it("ignoreCase 关闭时非 ASCII 放行（大小写敏感下两边同义）", () => {
    assert.doesNotThrow(() => assertIgnoreCaseAlignable("CAFÉ", false));
    assert.doesNotThrow(() => assertIgnoreCaseAlignable("café", false));
  });

  it("纯 ASCII + ignoreCase 放行", () => {
    assert.doesNotThrow(() => assertIgnoreCaseAlignable("foo", true));
  });
});

describe("keepsUnicodeMode — 模式选择（rg 不加 --no-unicode / Node 加 u）", () => {
  it("`\\d` / `\\w` / `\\b` 一类（两边分歧源）→ 不留 Unicode（rg 切字节）", () => {
    for (const pattern of [
      "\\d",
      "\\d+",
      "^\\d{2,4}$",
      "\\w",
      "\\bfoo\\b",
      "\\D",
      "\\W",
      "\\Bfoo",
      "[\\d]",
      "[a-z]+",
    ]) {
      assert.equal(keepsUnicodeMode(pattern), false, pattern);
    }
  });

  it("`.` / `\\s` / `\\S` → 留 Unicode（字节语义会打坏它们）", () => {
    // 实测：--no-unicode 下 `.` 只吃一个字节，`a.c` 反而不匹配 `aéc`；
    // `\s` 不再匹配 NBSP（JS 的 `\s` 是 Unicode 的）。
    for (const pattern of ["a.c", "caf.", "\\s", "\\s+", "\\S", "[^x]{2}"]) {
      assert.equal(keepsUnicodeMode(pattern), true, pattern);
    }
  });

  it("非 ASCII 字面量 / 非 ASCII 类成员 → 留 Unicode", () => {
    assert.equal(keepsUnicodeMode("café"), true);
    assert.equal(keepsUnicodeMode("漢字"), true);
    assert.equal(keepsUnicodeMode("é\\b"), true);
    assert.equal(keepsUnicodeMode("[é]"), true);
    assert.equal(keepsUnicodeMode("[a-é]"), true);
  });

  it("`\\uNNNN` / `\\xNN` 定长转义 → 留 Unicode（字符可能是多字节）", () => {
    assert.equal(keepsUnicodeMode("\\u00e9"), true);
    assert.equal(keepsUnicodeMode("\\xE9"), true);
    assert.equal(keepsUnicodeMode("caf\\u00e9"), true);
  });

  it("纯 ASCII / 空 pattern → 不留 Unicode（零风险对齐各类）", () => {
    assert.equal(keepsUnicodeMode("hit"), false);
    assert.equal(keepsUnicodeMode("foo|bar"), false);
    assert.equal(keepsUnicodeMode(""), false);
    assert.equal(keepsUnicodeMode(".*"), true);
  });

  it("被转义的元字符不算多字节敏感（`\\.` / `\\\\d`）", () => {
    assert.equal(keepsUnicodeMode("\\."), false);
    assert.equal(keepsUnicodeMode("[.]"), false);
    assert.equal(keepsUnicodeMode("[\\d]"), false);
  });
});

describe("compilePattern — `u` 规则与退回（code point 对齐）", () => {
  it("留 Unicode 的 pattern 按 code point 匹配（`.`` 与计数 quantifier）", () => {
    // 实测两条引擎的原始分歧：`a.c` 不命中 `a😀c`、`^.{3}$` 不命中 `e+combining+x`。
    // rg 默认是 code point 语义，Node 侧必须靠 `u` 才对齐。
    const emoji = "a\u{1F600}c";
    assert.equal(compilePattern("a.c", false).test(emoji), true);
    assert.equal(compilePattern("^.{3}$", false).test(emoji), true);
    assert.equal(compilePattern("^.$", false).test("\u{1F600}"), true);
    // 非 BMP 字面量按**整个字符**量化（无 `u` 时量化的是 surrogate）。
    assert.equal(
      compilePattern("\u{1F600}{2}", false).test("\u{1F600}\u{1F600}"),
      true
    );
  });

  it("不留 Unicode 的 pattern 保持 ASCII 类口径（`\\d` / `\\w` 不吃非 ASCII）", () => {
    assert.equal(compilePattern("\\d", false).test("٣٤"), false);
    assert.equal(compilePattern("\\w", false).test("漢"), false);
    assert.equal(compilePattern("\\bfoo\\b", false).test("éfoo"), true);
  });

  it("不受 `.` 影响的 ASCII 类在 ignoreCase 下也不折 KELVIN / LONG S", () => {
    // 判据为 false ⇒ Node 不加 `u`。实测 rg 加了 `--no-unicode` 后 `-i k`
    // 不命中 `K`；Node 若加 `u` 会命中（`iu` 的 simple case folding）。
    assert.equal(compilePattern("k", true).test("\u{212A}"), false);
    assert.equal(compilePattern("s", true).test("\u{017F}"), false);
  });

  it("留 Unicode 的 pattern 在 ignoreCase 下与 rg 同向折 KELVIN / LONG S", () => {
    // 实测 rg 留在 Unicode 模式时 `-i k.` 命中 `Kx`；`iu` 同结果（判据为 true）。
    assert.equal(compilePattern("k.", true).test("\u{212A}x"), true);
    assert.equal(compilePattern("s.", true).test("\u{017F}x"), true);
  });

  it("`u` 编不过时退回无 `u`：只在无 `u` 下合法的 pattern 照常编译", () => {
    // 这些在 pattern.ts 的判据下**留 Unicode**（`\u` / `\x` 敏感、`é` 非
    // ASCII），却编不过带 `u` 的形态 —— 退回是「接受集只增不减」的保证。
    for (const pattern of ["\\u", "\\x", "é{", "é{,2}", "A\\u", "\\s{"]) {
      // 每个都**确实**留 Unicode（否则这条测试没走到退回分支）。
      assert.equal(keepsUnicodeMode(pattern), true, pattern);
      assert.doesNotThrow(() => compilePattern(pattern, false), pattern);
    }
    // 退回后仍是**可用**的 RegExp（不是哑对象），且 `unicode` 为 false ——
    // 这正是「走了退回分支」的可观测证据（`u` 编译成功时该属性为 true）。
    const fallback = compilePattern("\\u", false);
    assert.equal(fallback.unicode, false);
    assert.equal(fallback.test("u"), true);
    // 对照：同一判据为 true 的 pattern，能加 `u` 的必须真加上。
    assert.equal(compilePattern("a.c", false).unicode, true);
    assert.equal(compilePattern("é{", false).unicode, false);
  });

  it("判据为 false 且只在不带 `u` 下合法的 pattern 照常编译（`{` / `]` 一类）", () => {
    for (const pattern of ["{", "}", "]", "a{", "{,}", "\\-"]) {
      assert.equal(keepsUnicodeMode(pattern), false, pattern);
      assert.doesNotThrow(() => compilePattern(pattern, false), pattern);
    }
    assert.equal(compilePattern("{", false).test("{"), true);
    assert.equal(compilePattern("]", false).test("]"), true);
  });

  it("两边都编不过的 pattern 仍是同一条 typed 拒绝", () => {
    rejects(() => compilePattern("(unclosed", false), /pattern/);
    rejects(() => compilePattern("[", false), /pattern/);
    rejects(() => compilePattern("a**", false), /pattern/);
  });

  it("已知残留：单反斜杠转义在 JS 侧读字面量（文件头清单的钉子）", () => {
    // 这些 pattern 在 rg 侧被接受（`\A` / `\z` 走 Rust 默认引擎，`\Z` / `\e`
    // 一类靠 `--engine=auto` 退 PCRE2），JS 却读成字面量 —— 两侧都「接受」
    // 但命中不同，属 pattern.ts 文件头列明的残留 2-A。这里只钉住 JS 侧的
    // 实际读法，不声称对齐（对齐要靠 typed 拒绝，属另一刀）。
    for (const [pattern, literal] of [
      ["\\A", "A"],
      ["\\z", "z"],
      ["\\Z", "Z"],
      ["\\N", "N"],
      ["\\e", "e"],
      ["\\G", "G"],
      ["\\K", "K"],
      ["\\X", "X"],
      ["\\C", "C"],
      ["\\h", "h"],
      ["\\H", "H"],
      ["\\R", "R"],
    ] as const) {
      const compiled = compilePattern(pattern, false);
      assert.equal(compiled.unicode, false, pattern); // 两侧都编不过带 `u` 的形态
      assert.equal(compiled.test(literal), true, pattern);
    }
  });

  it("已知残留：Rust 与 PCRE2 都拒的转义在 JS 侧静默命中（清单的钉子）", () => {
    // 残留 2-C：rg rc=2 typed 失败，JS 读字面量并命中。`\c` 单独列 —— JS 把
    // 它读成两字符序列 `\c`，命中对象不是单个 `c`（实测）。
    for (const [pattern, literal] of [
      ["\\q", "q"],
      ["\\g", "g"],
      ["\\k", "k"],
      ["\\o", "o"],
      ["\\y", "y"],
      ["\\T", "T"],
    ] as const) {
      const compiled = compilePattern(pattern, false);
      assert.equal(compiled.unicode, false, pattern);
      assert.equal(compiled.test(literal), true, pattern);
    }
    const c = compilePattern("\\c", false);
    assert.equal(c.unicode, false);
    assert.equal(c.test("c"), false);
    assert.equal(c.test("\\c"), true);
  });

  it("残留清单里点名的「不是残留」：`a{2,1}` 两边同为 typed 拒绝", () => {
    // argv.ts 的 auto 注释专门排除这条：JS 也拒（numbers out of order），
    // 不是「rg 拒而 Node 静默命中」那一类。
    rejects(() => compilePattern("a{2,1}", false), /pattern/);
    rejects(() => compilePattern("a{2,1}", false), /a\{2,1\}/);
  });
});

describe("新文案与既有失败域互不混同（SC10）", () => {
  it("三类构造文案与坏正则、未知 type 的文案两两不同", () => {
    const badRegex = messageOf(() => compilePattern("(unclosed", false));
    const unknownType = messageOf(() => resolveTypeName("nosuchtype"));
    const property = messageOf(() => assertEngineAlignable("\\p{L}"));
    const codePoint = messageOf(() => assertEngineAlignable("\\u{6f22}"));
    const posix = messageOf(() => assertEngineAlignable("[[:alpha:]]"));
    const caseFolding = messageOf(() =>
      assertIgnoreCaseAlignable("CAFÉ", true)
    );

    const all = [
      badRegex,
      unknownType,
      property,
      codePoint,
      posix,
      caseFolding,
    ];
    for (const message of all) assert.notEqual(message, "");
    assert.equal(new Set(all).size, all.length, all.join("\n---\n"));

    // 未知 type 仍不得泄漏 `pattern` 关键词（既有 SC10 纪律不变）。
    assert.equal(/pattern/.test(unknownType), false, unknownType);
    // 新文案不得被读成「未知 type」。
    for (const message of [property, codePoint, posix, caseFolding]) {
      assert.equal(/unknown type/.test(message), false, message);
      assert.equal(/\btype\b/.test(message), false, message);
    }
  });
});
