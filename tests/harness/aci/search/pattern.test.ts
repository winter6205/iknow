/**
 * 主 pattern 编译单测（ADR-0089）。
 *
 * 锁的不变式：
 *   - `compilePattern` 把 `pattern` + `ignoreCase` 编译成 JS `RegExp`，坏正则
 *     → typed 拒绝且文案点名 `pattern`（与未知 `type` 的失败域互不混同，
 *     SC10）；
 *   - 判据为 true 时加 `u` flag（`a.c` 匹配 emoji 等多字节字符），加不上
 *     必须退回无 `u`（接受集只增不减）；
 *   - 判据为 false 时不加 `u`（`\d` / `\w` / `\b` 停在 ASCII 口径，`iu`
 *     不折 KELVIN / LONG S）；
 *   - `keepsUnicodeMode`：`.` / `\s` / `\S` / `\u` / 非 ASCII / 否定类必须
 *     留 Unicode；`\d` / `\w` / `\b` 一类**不加** `u`（JS 无 `u` 已按 ASCII
 *     走，加了反而折 KELVIN / LONG S）。这是**仅作用于 Node 侧 `u` flag**
 *     的判据，rg argv 已不读它（ADR-0089 把 `--no-unicode` 那条投影拆掉了）。
 *
 * 之前这里还钉着 rg 与 JS `RegExp` 之间的语义对齐（哪条构造在两条引擎上
 * 给不出同一答案就在共享入口 typed 拒绝）。ADR-0089 之后 rg 路径只信 rg
 * 子进程本身（rc=2 = rg 自己拒），Node 路径只跑 `compilePattern` 编得过的
 * pattern，两条引擎不再被强制同判 —— 命中集允许不同。对应单测一并删除，
 * 接受集差异由 `tests/harness/aci/tools/grep.test.ts` 在 handler 级钉住。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
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

describe("keepsUnicodeMode — Node 侧 u flag 判据（rg 不再读本判据）", () => {
  it("`\\d` / `\\w` / `\\b` 一类 → 不加 `u`（JS 无 `u` 已按 ASCII 走）", () => {
    // 这些 pattern 加 `u` 会**变宽**（折 KELVIN / LONG S）而不是变准，所以要
    // 停在无 `u` 一档。rg 侧不再有对应开关 —— 它按自己的 Unicode 类跑。
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

  it("`.` / `\\s` / `\\S` → 留 Unicode（无 u 时 code unit 语义会打坏）", () => {
    // 实测：JS 无 `u` 时 `.` 只吃一个 code unit，`a.c` 不匹配 `aéc`；
    // `\s` 不再匹配 NBSP（JS 的 `\s` 是 Unicode 的，但要走 `u` 才匹配 BMP
    // 之外的空白）。rg 侧走自己的默认 Unicode 语义（ADR-0089），本判据只
    // 决定 Node 侧要不要加 `u`。
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

  it("纯 ASCII / 空 pattern → 不加 `u`（无多字节构造）", () => {
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
    // 判据为 false ⇒ Node 不加 `u`。`iu` 的 simple case folding 会折
    // U+212A KELVIN / U+017F LONG S，所以这种 pattern 必须留在无 `u` 一档。
    assert.equal(compilePattern("k", true).test("\u{212A}"), false);
    assert.equal(compilePattern("s", true).test("\u{017F}"), false);
  });

  it("留 Unicode 的 pattern 在 ignoreCase 下与 rg 同向折 KELVIN / LONG S", () => {
    // 实测 rg 留在 Unicode 模式时 `-i k.` 命中 `Kx`；`iu` 同结果（判据为 true）。
    assert.equal(compilePattern("k.", true).test("\u{212A}x"), true);
    assert.equal(compilePattern("s.", true).test("\u{017F}x"), true);
  });

  it("`u` 编不过时退回无 `u`：只在无 `u` 下合法的 pattern 照常编译", () => {
    // 这些在 pattern.ts 的判据下**会加 `u`**（`\u` / `\x` 敏感、`é` 非
    // ASCII），却编不过带 `u` 的形态 —— 退回是「接受集只增不减」的保证。
    for (const pattern of ["\\u", "\\x", "é{", "é{,2}", "A\\u", "\\s{"]) {
      // 每个都**确实**命中判据（否则这条测试没走到退回分支）。
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

  it("单反斜杠转义在 JS 侧读字面量（Node 路径的编读钉子）", () => {
    // 这些转义 JS 不认作元字符（rg 默认引擎或 PCRE2 才认作），JS `RegExp`
    // 把它当两字面字符序列 —— Node 路径因此「接受」但命中的是去反斜杠的
    // 文本。rg 路径同样接受这些 pattern（按 rg 自己的语义命中），两条引擎
    // 的命中集可能不同，是 ADR-0089 已接受的合同。本测试只钉 Node 路径**自
    // 己**的实际编读：编得过、且命中的是去掉反斜杠后的字面字符。
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
      assert.equal(compiled.unicode, false, pattern); // 带 `u` 的形态编不过
      assert.equal(compiled.test(literal), true, pattern);
    }
  });

  it("rg 拒的转义在 JS 侧静默命中（Node 路径的编读钉子）", () => {
    // 这些转义 rg 默认引擎会 rc=2 拒（typed 失败域：rg 自己报），JS `RegExp`
    // 读字面量并命中 —— Node 路径因此**比 rg 路径更宽**，ADR-0089 视为特性
    // （不是漏测）。`\c` 单独列 —— JS 把它读成两字符序列 `\c`，命中对象
    // 不是单个 `c`（实测）。本测试钉 Node 路径**自己**的编读，不假设 rg
    // 也命中。
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

describe("SC10 失败域互不混同（仅与仍存活的失败域）", () => {
  // ADR-0089 之前这里比对 9 条构造文案的互不混同。退役 5 个对齐器之后只剩
  // 两条 typed 失败域：`compilePattern` 的坏正则，与 `resolveTypeName` 的
  // 未知 type。其它失败域（rg 子进程自己的 rc=2 报错、Node 路径无命中、
  // 长行截断 / 含换行路径跳过等）由 `tests/harness/aci/tools/grep.test.ts`
  // 在 handler 级钉住。
  it("坏正则与未知 type 文案互不包含对方关键词", () => {
    const badRegex = messageOf(() => compilePattern("(unclosed", false));
    const unknownType = messageOf(() => resolveTypeName("nosuchtype"));

    assert.notEqual(badRegex, "");
    assert.notEqual(unknownType, "");
    assert.equal(
      /pattern/.test(unknownType),
      false,
      `type error leaked pattern: ${unknownType}`
    );
    assert.equal(
      /type/.test(badRegex),
      false,
      `regex error leaked type: ${badRegex}`
    );
    assert.ok(/pattern/.test(badRegex));
    assert.ok(/type/.test(unknownType));
  });
});
