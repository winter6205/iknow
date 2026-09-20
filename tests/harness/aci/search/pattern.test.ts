/**
 * Main-pattern compilation unit tests (ADR-0089).
 *
 * Invariants locked:
 *   - `compilePattern` compiles `pattern` + `ignoreCase` into a JS `RegExp`;
 *     a bad regex is a typed reject naming `pattern` in its message (kept
 *     disjoint from the unknown-`type` failure domain);
 *   - when the Unicode-preservation predicate is true, add the `u` flag
 *     (`a.c` matches emoji and other multi-byte characters); if it fails to
 *     compile, fall back to no `u` (the accept set may grow, never shrink);
 *   - when the predicate is false, no `u` (`\d` / `\w` / `\b` stay ASCII;
 *     `iu` must not fold KELVIN / LONG S);
 *   - `keepsUnicodeMode`: `.` / `\s` / `\S` / `\u` / non-ASCII / negated
 *     classes must keep Unicode; `\d` / `\w` / `\b`-style patterns get **no**
 *     `u` (JS without `u` is already ASCII, and adding `u` would fold
 *     KELVIN / LONG S instead). This predicate governs **only the Node-side
 *     `u` flag**; rg argv no longer reads it (ADR-0089 removed the
 *     `--no-unicode` projection).
 *
 * This file used to also pin semantic alignment between rg and JS `RegExp`
 * (any construct where the two engines could not agree was a typed reject at
 * the shared entry). Since ADR-0089 the rg path trusts only the rg subprocess
 * (rc=2 = rg's own rejection) and the Node path only runs patterns
 * `compilePattern` can compile — the two engines are no longer forced to the
 * same verdict; differing hit sets are allowed. Matching unit tests were
 * removed; accept-set divergence is pinned at handler level in
 * `tests/harness/aci/tools/grep.test.ts`.
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
    // Adding `u` to these patterns makes them **wider** (KELVIN / LONG S
    // folding), not sharper, so they stay at the no-`u` tier. rg has no
    // corresponding switch anymore — it runs its own Unicode classes.
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
    // Measured: in JS without `u`, `.` consumes one code unit, so `a.c`
    // misses `aéc`; `\s` stops matching NBSP (JS `\s` is Unicode-ish but only
    // matches non-BMP whitespace under `u`). rg keeps its own default Unicode
    // semantics (ADR-0089); this predicate only decides the Node-side `u` flag.
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
    // Measured raw divergence of the two engines: `a.c` misses `a😀c`,
    // `^.{3}$` misses `e+combining+x`. rg defaults to code-point semantics;
    // the Node side must go through `u` to align.
    const emoji = "a\u{1F600}c";
    assert.equal(compilePattern("a.c", false).test(emoji), true);
    assert.equal(compilePattern("^.{3}$", false).test(emoji), true);
    assert.equal(compilePattern("^.$", false).test("\u{1F600}"), true);
    // Non-BMP literals are quantified per **whole character** (without `u`
    // the quantifier would target surrogates).
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
    // Predicate false ⇒ Node adds no `u`. `iu`'s simple case folding maps
    // U+212A KELVIN / U+017F LONG S, so these patterns must stay at the no-`u` tier.
    assert.equal(compilePattern("k", true).test("\u{212A}"), false);
    assert.equal(compilePattern("s", true).test("\u{017F}"), false);
  });

  it("留 Unicode 的 pattern 在 ignoreCase 下与 rg 同向折 KELVIN / LONG S", () => {
    // Measured: with rg kept in Unicode mode, `-i k.` hits `Kx`; `iu` gives
    // the same result (predicate true).
    assert.equal(compilePattern("k.", true).test("\u{212A}x"), true);
    assert.equal(compilePattern("s.", true).test("\u{017F}x"), true);
  });

  it("`u` 编不过时退回无 `u`：只在无 `u` 下合法的 pattern 照常编译", () => {
    // Under pattern.ts's predicate these **do get `u`** (`\u` / `\x`
    // sensitivity, `é` non-ASCII), yet fail to compile with `u` — the
    // fallback is what guarantees "accept set may grow, never shrink".
    for (const pattern of ["\\u", "\\x", "é{", "é{,2}", "A\\u", "\\s{"]) {
      // each one **does** trip the predicate (otherwise this test never
      // reaches the fallback branch).
      assert.equal(keepsUnicodeMode(pattern), true, pattern);
      assert.doesNotThrow(() => compilePattern(pattern, false), pattern);
    }
    // After fallback it is still a **usable** RegExp (not a dud), with
    // `unicode` false — the observable proof that the fallback branch ran
    // (`unicode` is true when `u` compiles).
    const fallback = compilePattern("\\u", false);
    assert.equal(fallback.unicode, false);
    assert.equal(fallback.test("u"), true);
    // Control: same predicate true, and a pattern that can take `u` must really get it.
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
    // JS does not treat these escapes as metacharacters (only rg's default
    // engine or PCRE2 would); JS `RegExp` reads them as two literal
    // characters — so the Node path "accepts" them but matches the
    // backslash-stripped text. The rg path accepts the same patterns and
    // matches per rg's own semantics; the two engines' hit sets may differ —
    // an accepted contract of ADR-0089. This test pins only the Node path's
    // **own** compile/read behavior: it compiles, and matches the
    // backslash-stripped literal.
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
      assert.equal(compiled.unicode, false, pattern); // the `u` form fails to compile
      assert.equal(compiled.test(literal), true, pattern);
    }
  });

  it("rg 拒的转义在 JS 侧静默命中（Node 路径的编读钉子）", () => {
    // rg's default engine rejects these escapes with rc=2 (typed failure
    // domain: rg reports it itself); JS `RegExp` reads them as literals and
    // matches — so the Node path is **wider than** the rg path, which
    // ADR-0089 treats as a feature (not a test gap). `\c` is listed
    // separately — JS reads it as the two-character sequence `\c`, matching
    // not a lone `c` (measured). This test pins the Node path's **own**
    // compile/read behavior, without assuming rg matches too.
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
    // argv.ts's auto note excludes this one explicitly: JS rejects it too
    // (numbers out of order), so it is not the "rg rejects while Node
    // silently matches" class.
    rejects(() => compilePattern("a{2,1}", false), /pattern/);
    rejects(() => compilePattern("a{2,1}", false), /a\{2,1\}/);
  });
});

describe("SC10 失败域互不混同（仅与仍存活的失败域）", () => {
  // Before ADR-0089 this compared cross-contamination of 9 message domains.
  // After retiring 5 aligners only two typed failure domains remain:
  // `compilePattern`'s bad regex and `resolveTypeName`'s unknown type. Other
  // failure domains (rg subprocess's own rc=2 errors, Node path no-hit,
  // long-line truncation / newline-containing path skips, etc.) are pinned
  // at handler level in `tests/harness/aci/tools/grep.test.ts`.
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
