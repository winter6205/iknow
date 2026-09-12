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
 *   - `rgNeedsUnicodeDisabled`：`\d` / `\w` / `\b` 一类切 `--no-unicode`，
 *     而 `.` / `\s` / `\S` / `\u` / 非 ASCII / 否定类留在 Unicode 模式。
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
  compilePattern,
  rgNeedsUnicodeDisabled,
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

describe("rgNeedsUnicodeDisabled — 模式选择", () => {
  it("`\\d` / `\\w` / `\\b` 一类（两边分歧源）→ 切 --no-unicode", () => {
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
      assert.equal(rgNeedsUnicodeDisabled(pattern), true, pattern);
    }
  });

  it("`.` / `\\s` / `\\S` → 不切（字节语义会打坏它们）", () => {
    // 实测：--no-unicode 下 `.` 只吃一个字节，`a.c` 反而不匹配 `aéc`；
    // `\s` 不再匹配 NBSP（JS 的 `\s` 是 Unicode 的）。
    for (const pattern of ["a.c", "caf.", "\\s", "\\s+", "\\S", "[^x]{2}"]) {
      assert.equal(rgNeedsUnicodeDisabled(pattern), false, pattern);
    }
  });

  it("非 ASCII 字面量 / 非 ASCII 类成员 → 不切", () => {
    assert.equal(rgNeedsUnicodeDisabled("café"), false);
    assert.equal(rgNeedsUnicodeDisabled("漢字"), false);
    assert.equal(rgNeedsUnicodeDisabled("é\\b"), false);
    assert.equal(rgNeedsUnicodeDisabled("[é]"), false);
    assert.equal(rgNeedsUnicodeDisabled("[a-é]"), false);
  });

  it("`\\uNNNN` / `\\xNN` 定长转义 → 不切（字符可能是多字节）", () => {
    assert.equal(rgNeedsUnicodeDisabled("\\u00e9"), false);
    assert.equal(rgNeedsUnicodeDisabled("\\xE9"), false);
    assert.equal(rgNeedsUnicodeDisabled("caf\\u00e9"), false);
  });

  it("纯 ASCII / 空 pattern → 切（零风险对齐各类）", () => {
    assert.equal(rgNeedsUnicodeDisabled("hit"), true);
    assert.equal(rgNeedsUnicodeDisabled("foo|bar"), true);
    assert.equal(rgNeedsUnicodeDisabled(""), true);
    assert.equal(rgNeedsUnicodeDisabled(".*"), false);
  });

  it("被转义的元字符不算多字节敏感（`\\.` / `\\\\d`）", () => {
    assert.equal(rgNeedsUnicodeDisabled("\\."), true);
    assert.equal(rgNeedsUnicodeDisabled("[.]"), true);
    assert.equal(rgNeedsUnicodeDisabled("[\\d]"), true);
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
