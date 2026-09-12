/**
 * 主 pattern 编译 / 语义可行性校验 / rg 模式选择单测（D6、SC9、SC10）。
 *
 * 锁的不变式：
 *   - 坏正则 → typed 拒绝且文案点名 `pattern`；
 *   - 无法让两引擎对齐的构造（`\p{...}` / `\P{...}` / `\u{...}` /
 *     `[[:name:]]`）在**共享入口**拒绝，文案点名构造与理由；
 *   - 字符类转义分叉（D5）：`\s` / `\S` 无条件拒绝（两条引擎的 Unicode 空白
 *     表不同），`\d` / `\D` / `\w` / `\W` / `\b` / `\B` 只在 Unicode 模式下
 *     拒绝（byte 模式下两边的类都按 ASCII 走、同判）；
 *   - 上述各文案与坏正则、未知 `type` 的文案互不混同（SC10）；
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
  assertClassEscapesAlignable,
  assertEngineAlignable,
  assertIgnoreCaseAlignable,
  assertLineContentOnly,
  assertStructuralAlignable,
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

  it("数字族 `\\N` / `\\NN` / `\\NNN`：三条子判据各自拒绝，且文案点名该形态", () => {
    // 生成式 fuzz 反推出的三条语义判据（见 pattern.ts 的
    // `assertDigitEscapeAlignable` 注释）。每条都先有 DIVERGE 实测、后才
    // 有这条 assert —— 不是照拼写补的。
    const cases: Array<readonly [string, RegExp]> = [
      // 1. > 3 位：PCRE2 rc=2 拒，JS 读前 3 位 octal + 余下字面
      ["\\0409", /more than 3 digits/],
      ["\\0007", /more than 3 digits/],
      // 2. 含 8/9：PCRE2 rc=2，JS 读字面数字
      ["\\8", /out of range for an octal escape/],
      ["\\9", /out of range for an octal escape/],
      ["\\88", /out of range for an octal escape/],
      // 3. 八进制值 ≥ 0x80：rg 按 UTF-8 码点解、JS 按单字节解
      ["\\200", /at or above 0x80/],
      ["\\277", /at or above 0x80/],
      ["\\377", /at or above 0x80/],
      // 4. 单数字反向引用越界：PCRE2 rc=2、JS 读字面数字
      ["\\1", /backreference to a group that does not exist/],
      ["(a)(b)\\3", /backreference to a group that does not exist/],
    ];
    for (const [pattern, expected] of cases) {
      rejects(() => assertEngineAlignable(pattern), expected);
    }
  });

  it("数字族的正向控制：这些形态实测两引擎对齐，必须继续放行", () => {
    // 高频用法全部落在低半区 / 合法反向引用 —— 这条是防止把本族简化成
    // 「数字转义一律拒」的护栏。
    for (const pattern of [
      "\\040", // 空格：低半区，两引擎同读 0x20
      "\\101", // 'A'
      "\\177", // DEL 边界（低半区上沿）
      "\\0", // NUL：前导 0 不是反向引用
      "\\01",
      "\\017",
      "(a)\\1", // 合法反向引用：N ≤ groupCount
      "(a)(b)\\2",
      "(?<n>a)\\1", // 具名捕获组同样计入 groupCount
    ]) {
      assert.doesNotThrow(() => assertEngineAlignable(pattern), pattern);
    }
  });

  it("非捕获构造不计入 groupCount：`(?:a)\\1` 仍按越界拒", () => {
    // `countCaptureGroups` 的负向控制 —— 若把 `(?:` 也数成组，这条会静默放行
    // 一个两引擎答案不同的 pattern（PCRE2 对 `\1` 无组时 rc=2）。
    rejects(
      () => assertEngineAlignable("(?:a)\\1"),
      /backreference to a group that does not exist/
    );
    rejects(
      () => assertEngineAlignable("(?=a)\\1"),
      /backreference to a group that does not exist/
    );
  });

  it("结构层残项：空下界量词与空字符类拒绝，字面形态放行", () => {
    // 同一份生成式 fuzz 的结构层残项（不带反斜杠的分歧），按「两条引擎能
    // 对这一段给出同一答案吗」判，不按「它是不是合法量词」判。
    for (const pattern of ["a{,2}", "a{,2,3}", "a{,}", "a{ ,2}"]) {
      rejects(() => assertStructuralAlignable(pattern), /empty lower bound/);
    }
    for (const pattern of ["[]", "[^]"]) {
      rejects(
        () => assertStructuralAlignable(pattern),
        /empty character class/
      );
    }
    // 正向控制：这些看着像、实测两引擎同判。
    for (const pattern of [
      "a{2}", // 正常量词
      "a{2,}", // 开上界
      "\\{,2}", // 转义 `{` = 字面，不是量词
      "[{,2}]", // 类内 `{` 是类成员
      "[!]", // POSIX 否定类的字面形态（非空类）
      "[\\]]", // 转义 `]` 开头的正常类
      "a{}", // 空体的字面 `{}`，两引擎同判
      "[a[", // `[` 作类成员的未闭类，两引擎同判
    ]) {
      assert.doesNotThrow(() => assertStructuralAlignable(pattern), pattern);
    }
  });
});

describe("assertClassEscapesAlignable — 字符类转义分叉（D5）", () => {
  it("`\\s` / `\\S` 无条件拒绝：两条引擎的 Unicode 空白表天生不同", () => {
    for (const pattern of ["\\s", "\\S"]) {
      rejects(() => assertClassEscapesAlignable(pattern), /whitespace class/);
      rejects(
        () => assertClassEscapesAlignable(pattern),
        /two engines would answer differently/
      );
    }
  });

  it("`\\s` 在字符类内（`[\\s]`）同样拒绝：不是位置例外", () => {
    rejects(() => assertClassEscapesAlignable("[\\s]"), /whitespace class/);
    rejects(() => assertClassEscapesAlignable("[^\\s]"), /whitespace class/);
  });

  it("`\\s` 在 ASCII pattern 下也拒绝：判据无条件，不看是否触发 Unicode", () => {
    // 防止有人误以为「`\\s` 在 byte 模式下两引擎同判」 —— 不是的，
    // 两边空白表是 Unicode 表，不是字节表。
    rejects(() => assertClassEscapesAlignable("a\\sb"), /whitespace class/);
  });

  it("`\\d` / `\\D` / `\\w` / `\\W` / `\\b` × Unicode 触发 → typed 拒绝", () => {
    const cases: Array<readonly [string, string]> = [
      ["\\d.漢", "\\d"],
      ["\\D.漢", "\\D"],
      ["\\w.漢", "\\w"],
      ["\\W.漢", "\\W"],
      ["\\b漢", "\\b"],
      // 否定类是 Unicode 触发构造（`hasSensitiveLiteral` 的判据），同样要把
      // `\d` 拽进 Unicode 模式。
      ["[^a]\\d", "\\d"],
    ];
    for (const [pattern, family] of cases) {
      const msg = messageOf(() => assertClassEscapesAlignable(pattern));
      assert.ok(
        msg.includes(family),
        `${pattern} → 文案含 \\${family}：${msg}`
      );
      assert.match(msg, /Unicode-mode trigger/);
      assert.match(msg, /two engines would answer differently/);
    }
  });

  it("`\\B` 无条件拒绝：byte 模式下也分叉，`\\B漢` 不再走 Unicode-trigger 文案", () => {
    // 本轮 D5-leak 的核心修正。原判据把 `\B` 与 `\b` 并列放进条件层，前提
    // 「byte 模式能对齐 `\B`」被实测推翻（/tmp/tool-bmode.mts）：rg 把多字节
    // 字符的内部字节边界也算非词边界，Node 逐 code unit 看结论相反。
    // 所以 `\B` 必须在**无条件**层被拒 —— 下面两条在 ASCII-only pattern 上
    // 也要拒（条件层放行的那种），文案走 non-word-boundary 一条。
    for (const pattern of ["\\B", "\\B漢", "a\\Bb", "漢\\B"]) {
      const msg = messageOf(() => assertClassEscapesAlignable(pattern));
      assert.match(msg, /non-word-boundary/, pattern);
      assert.match(msg, /two engines would answer differently/, pattern);
    }
    // 无条件层不看 `keepsUnicodeMode`：ASCII-only 也拒。
    assert.equal(keepsUnicodeMode("\\B"), false);
    rejects(() => assertClassEscapesAlignable("\\B"), /non-word-boundary/);
  });

  it("`[\\B]` 类内形态拒绝：rg 两种模式都 rc=2，JS 静默读字面 `B`", () => {
    // 实测（/tmp/d5-class-b.mts）：rg 对 `[\B]` 在 `--no-unicode` 与默认模式
    // 下**都** rc=2（Rust 引擎 invalid escape in character class，PCRE2 也
    // 拒），JS 把 `\B` 读成字面 `B` 并命中 —— 一个 rc=2 一个 rc=0，任何语料
    // 都救不回来。类内位置不豁免 `\B`（与 `\b` 的退格例外不同）。
    for (const pattern of ["[\\B]", "[a\\B]", "[\\B ]", "[\\b\\B]", "[^\\B]"]) {
      rejects(() => assertClassEscapesAlignable(pattern), /non-word-boundary/);
    }
  });

  it("`[\\b]`（类内退格）在 Unicode 触发下仍放行：位置例外只给 `\\b`", () => {
    // 实测（/tmp/d5-class-b.mts）：`[\b]` 是退格字节 0x08，rg 与 JS 都按字面
    // 字节读，含 Unicode 触发的 `[\b]漢` / `[\b.]` / `[\b£]` 也 SAME。原判据
    // 用 `/\\[dDwWbB]/` 盲扫，把这些**一致**的 pattern 误拒了 —— 本轮修掉。
    for (const pattern of [
      "[\\b]",
      "[\\b]漢",
      "[\\b.]",
      "[\\b\\d]",
      "[\\b.]漢",
      "[\\b£]",
    ]) {
      assert.doesNotThrow(
        () => assertClassEscapesAlignable(pattern),
        `应放行：${pattern}`
      );
    }
  });

  it("`\\b` 的类内豁免只给 `\\b`：`[\\d]漢` / `[\\w]漢` 照常拒", () => {
    // 反证：`\d` / `\w` 在类内仍是类成员（不是退格那种字面字节），随类的
    // Unicode 触发一起分叉（实测 `[\d]漢` / `[\w]漢` DIVERGE）。
    rejects(
      () => assertClassEscapesAlignable("[\\d]漢"),
      /Unicode-mode trigger/
    );
    rejects(
      () => assertClassEscapesAlignable("[\\w]漢"),
      /Unicode-mode trigger/
    );
  });

  it("`\\d` / `\\w` / `\\b` 在 ASCII-only pattern 下（byte 模式）继续放行", () => {
    // 反证：判据只在 Unicode 模式下砍类原子。ASCII-only pattern 不触发
    // Unicode mode —— 两边都按 ASCII 走，两引擎同判（D5 H1 系列）。
    for (const pattern of [
      "\\d",
      "\\d+",
      "\\d{3}",
      "\\w",
      "\\w+",
      "\\bfoo\\b",
      "[\\d]",
    ]) {
      assert.doesNotThrow(
        () => assertClassEscapesAlignable(pattern),
        `应放行：${pattern}`
      );
    }
  });

  it("`[^\\d]` 是**否定类**（Unicode 触发构造）→ 类原子同样进拒绝", () => {
    // 反证：否定类只匹配单个 code point，是 `hasSensitiveLiteral` 的触发
    // 判据之一；`[^\\d]` 因此进 Unicode 模式，`\\d` 在两侧归属相反 —— 实测
    // `[^\\d] Arabic`（语料 `٣٤`）rg 空 / Node 命中。不能因为「它是类」就
    // 放行。
    rejects(
      () => assertClassEscapesAlignable("[^\\d]"),
      /Unicode-mode trigger/
    );
  });

  it("`[\\b]`（类内退格字节）放行：退格是字面字节，两引擎一致", () => {
    // 防止把 `\\b` 误判为词边界 —— 类内的 `\\b` 是退格 0x08，与本函数无关。
    assert.doesNotThrow(() => assertClassEscapesAlignable("[\\b]"));
  });

  it("`\\\\s`（成对反斜杠 = 字面 `\\s`）放行：剥掉转义对后无敏感构造", () => {
    assert.doesNotThrow(() => assertClassEscapesAlignable("\\\\s"));
  });

  it("新文案与既有失败域互不混同（SC10）", () => {
    // `\s` / `\S` 文案点名构造名（whitespace class），不含 D1 的 line terminator。
    const wsMsg = messageOf(() => assertClassEscapesAlignable("\\s"));
    assert.ok(
      !/line terminator/.test(wsMsg),
      `\\s 文案不应混 line terminator：${wsMsg}`
    );
    assert.ok(
      !/property escape/.test(wsMsg),
      `\\s 文案不应混 property escape：${wsMsg}`
    );
    assert.ok(
      !/POSIX bracket class/.test(wsMsg),
      `\\s 文案不应混 POSIX：${wsMsg}`
    );
    assert.ok(
      !/code point escape/.test(wsMsg),
      `\\s 文案不应混 code point：${wsMsg}`
    );
    // 类原子 Unicode-mode 文案点名构造名 + Unicode-mode trigger。
    const classMsg = messageOf(() => assertClassEscapesAlignable("\\d.漢"));
    assert.ok(
      !/whitespace class/.test(classMsg),
      `类原子文案不应混 whitespace：${classMsg}`
    );
    assert.ok(
      !/property escape/.test(classMsg),
      `类原子文案不应混 property：${classMsg}`
    );
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

/**
 * D1-leak 回归：拼写矩阵（本轮的关键修正）。
 *
 * 原判据按**拼写枚举**（只列 `\n` / `\r` / `\xHH` / `\cJ` / `\NNN` / `\o{NNN}`），
 * 漏了 `\uHHHH` / `\UHHHHHHHH` / **裸 LF/CR 字符** —— 每条都实测 DIVERGE
 * （rg 报每个文件或 rc=2，Node 静默回空，`/tmp/tool-matrix.mts` 修前 17 条
 * DIVERGE）。修法是把判据换成**按值**（LF = 10 / CR = 13），本 describe 把
 * 「值的每一种拼写」逐条钉住：任一族再漏掉，这里必红。
 */
describe("assertLineContentOnly — LF/CR 值 → 拼写矩阵（D1-leak 回归）", () => {
  const LF = "\n";
  const CR = "\r";

  it("定长十六进制三兄弟：`\\xHH` / `\\uHHHH` / `\\UHHHHHHHH` 全按值拒", () => {
    for (const pattern of [
      "\\x0a",
      "\\x0d",
      "\\x0A",
      "\\x0D",
      "\\u000a",
      "\\u000A",
      "\\u000d",
      "\\u000D",
      "\\U0000000A",
      "\\U0000000a",
      "\\U0000000D",
      "\\U0000000d",
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("定长十六进制的**非**终止符值照常放行（`\\u0041` / `\\U00000041`）", () => {
    // 反证：判据按值，不是「见到 `\u` / `\U` 就拒」。
    for (const pattern of [
      "\\u0041",
      "\\U00000041",
      "\\U0001F600",
      "\\x41",
      "\\x0b", // VT，不是 LF/CR
      "\\u000b",
    ]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("八进制家族：`\\NNN` / `\\0NN` / `\\o{NNN}` 按数值判", () => {
    // `\012` = LF、`\015` = CR；`\o{12}` / `\o{015}` 同值。位数与 `\o{}` 的
    // 前导零都不改变值。
    for (const pattern of [
      "\\012",
      "\\15",
      "\\015",
      "\\o{12}",
      "\\o{15}",
      "\\o{015}",
      "\\o{0012}",
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
    // `\101` = 'A'、`\o{40}` = 空格、`\040` = 空格：值不是 10/13，放行。
    for (const pattern of ["\\101", "\\o{101}", "\\o{40}", "\\040", "\\0"]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("控制转义 `\\cJ` / `\\cM`（大小写不敏感）按值拒；`\\cA` 放行", () => {
    for (const pattern of ["\\cJ", "\\cj", "\\cM", "\\cm"]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
    assert.doesNotThrow(() => assertLineContentOnly("\\cA"));
    assert.doesNotThrow(() => assertLineContentOnly("\\cZ"));
  });

  it("**裸 LF / CR 字符**（pattern 里直接出现 U+000A / U+000D）按值拒", () => {
    // 这一族是「按拼写枚举」永远够不到的：没有反斜杠，只有 code point。
    // 实测修前 `\n`（裸）在 rg 侧命中每个文件、Node 侧回空。
    for (const pattern of [
      LF,
      CR,
      `${LF}+`,
      `a${LF}`,
      `${LF}a`,
      `a${LF}b`,
      `${LF}|a`,
      `${CR}a`,
      `a${CR}`,
      `(?:${LF})`,
      `(${LF})`,
      `(?:${LF})+`,
      `(( ${LF} ))`,
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("裸 LF/CR 在**类内**（`[<LF>]` / `[<LF><CR>]`）同样拒：类成员也按值判", () => {
    // 修前这一族被当成「类里有别的成员」直接跳过 —— 实测 `[<LF>]` rg 命中
    // 每个文件、Node 回空。
    for (const pattern of [
      `[${LF}]`,
      `[${CR}]`,
      `[${LF}${CR}]`,
      `[${CR}${LF}]`,
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("等价拼写在**类内 / 组内 / 量词下**一律按值拒（位置不改判据）", () => {
    for (const pattern of [
      "[\\u000a]",
      "[\\u000d]",
      "[\\U0000000A]",
      "[\\x0a]",
      "[\\cJ]",
      "[\\o{12}]",
      "(?:\\u000a)",
      "(\\u000a)",
      "(?:(?:\\u000a))",
      "(?:\\u000a)+",
      "\\u000a+",
      "\\u000a{1,}",
      "\\u000a+?",
      "a\\u000ab",
      "\\u000a|a",
      "(?=\\u000a)",
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("正向控制：类有非终止符成员（`[a<LF>b]` / `[^<LF>]`）必须放行", () => {
    // 协调者点名的正向控制（实测 SAME）：类里**还有别的可匹配成员**时普通
    // 内容就能命中（rg / PCRE2 / JS 同判 `[abc\n]` / `[^a\n]`）；判据不能
    // 因为「类里有 LF 值」就把整个类拒掉。`[^LF]` 是更严的边界 —— 否定类
    // 只匹配单个字符，rg / JS 一致判定为「不是 LF」。
    for (const pattern of [
      `[a${LF}b]`,
      `[${LF} a]`,
      `[${LF}a]`,
      `[a${CR}b]`,
      `[^${LF}]`,
      `[^${CR}]`,
      `[abc${LF}]`,
      `[abc${LF}${CR}]`,
    ]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("**非类内**裸 LF/CR 强制匹配：宁可 typed 拒绝也不静默给空", () => {
    // 顶层的「`a<LF>b` / `a<CR>b`」在两条引擎下**都**给空（按行不跨行，LF
    // 永远没机会匹配），表面看 SAME-empty，但用户大概率是误敲了换行。
    // 拒绝优于静默：让入口直接告诉用户「你的 pattern 里有个换行符」。
    // 这与原 D1（`\n` / `\r` 在两条引擎上必须同判）的判据一致 —— 既然无
    // 论 rg / Node 都永远没机会命中，typed 拒绝既不会缩小可工作的查询集，
    // 又能在第一时间抓出 pattern 拼写错误。
    for (const pattern of [
      `a${LF}b`,
      `a${CR}b`,
      `${LF}b`,
      `a${LF}`,
      `${CR}a`,
      `a${CR}`,
      `${LF}+`,
      `(${LF})`,
      `(?:${LF})`,
      `(?:${LF})+`,
    ]) {
      rejects(() => assertLineContentOnly(pattern), /line terminator/);
    }
  });

  it("裸 LF/CR 的「允许零次」与「否定断言」豁免同样成立", () => {
    for (const pattern of [
      `${LF}?`,
      `${LF}*`,
      `${LF}{0}`,
      `${LF}{0,2}`,
      `(?:${LF})?`,
      `(?!${LF})`,
      `(?<!${LF})`,
    ]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
  });

  it("矩阵完整性：LF/CR 值的拼写全表两两不同且都被这条文案拒", () => {
    // 把「全部拼写」显式列成一张表，防止将来某个拼写被新加的白名单绕过。
    const spellings = [
      "\\n",
      "\\r",
      "\\x0a",
      "\\x0d",
      "\\u000a",
      "\\u000d",
      "\\U0000000A",
      "\\U0000000D",
      "\\cJ",
      "\\cM",
      "\\012",
      "\\015",
      "\\o{12}",
      "\\o{15}",
      LF,
      CR,
    ];
    assert.equal(new Set(spellings).size, spellings.length);
    for (const spelling of spellings) {
      const message = messageOf(() => assertLineContentOnly(spelling));
      assert.match(message, /line terminator/, JSON.stringify(spelling));
    }
  });

  it("D1 文案不越界到 D5：`\\B` / `\\s` 不被行终止符判据拒", () => {
    // D1 判据只问「原子的值是不是 10 / 13」；`\B` / `\s` / `\S` 能匹配行内
    // 内容，归 D5（`assertClassEscapesAlignable`）管，两条文案不能互相抢。
    for (const pattern of ["\\B", "\\s", "\\S", "\\b", "\\d", "\\w"]) {
      assert.doesNotThrow(() => assertLineContentOnly(pattern), pattern);
    }
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
  it("构造文案与坏正则、未知 type 的文案两两不同", () => {
    const badRegex = messageOf(() => compilePattern("(unclosed", false));
    const unknownType = messageOf(() => resolveTypeName("nosuchtype"));
    const property = messageOf(() => assertEngineAlignable("\\p{L}"));
    const codePoint = messageOf(() => assertEngineAlignable("\\u{6f22}"));
    const posix = messageOf(() => assertEngineAlignable("[[:alpha:]]"));
    const caseFolding = messageOf(() =>
      assertIgnoreCaseAlignable("CAFÉ", true)
    );
    const lineTerminator = messageOf(() => assertLineContentOnly("\\n"));
    const whitespaceClass = messageOf(() => assertClassEscapesAlignable("\\s"));
    const unicodeModeClass = messageOf(() =>
      assertClassEscapesAlignable("\\d.漢")
    );

    const all = [
      badRegex,
      unknownType,
      property,
      codePoint,
      posix,
      caseFolding,
      lineTerminator,
      whitespaceClass,
      unicodeModeClass,
    ];
    for (const message of all) assert.notEqual(message, "");
    assert.equal(new Set(all).size, all.length, all.join("\n---\n"));

    // 未知 type 仍不得泄漏 `pattern` 关键词（既有 SC10 纪律不变）。
    assert.equal(/pattern/.test(unknownType), false, unknownType);
    // 新文案不得被读成「未知 type」。
    for (const message of [
      property,
      codePoint,
      posix,
      caseFolding,
      lineTerminator,
      whitespaceClass,
      unicodeModeClass,
    ]) {
      assert.equal(/unknown type/.test(message), false, message);
      assert.equal(/\btype\b/.test(message), false, message);
    }
  });
});
