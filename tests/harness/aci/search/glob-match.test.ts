/**
 * Node-engine implementation of `--glob` ("Node full semantics" parity).
 *
 * Why test it separately: `glob` is the second narrowing dimension besides
 * `type`; the rg engine delegates to rg itself while the Node engine goes
 * through this module — any divergence fails parity. Tool-level tests only
 * cover `*.ts` / `sub/*.ts`, leaving `?` / `[...]` / `!` negation / unclosed
 * `[` untested elsewhere.
 *
 * Semantics follow ripgrep as measured (not invented rules):
 *   - no `/` in pattern → match by **basename** at any depth;
 *   - contains `/` → anchored to the search root;
 *   - `*` / ``? wildcard within a segment, `**` crosses segments;
 *   - `[...]` character classes are case-sensitive;
 *   - `!` prefix negates; with positive patterns, collect first then remove.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assertValidGlob,
  matchOne,
  matchesGlobSet,
} from "../../../../src/harness/aci/search/glob-match.ts";
import { ToolExecutionError } from "../../../../src/harness/errors.ts";

describe("matchOne — 锚定与基名", () => {
  it("不含 `/` 的模式按基名匹配任意深度", () => {
    assert.equal(matchOne("a.ts", "*.ts"), true);
    assert.equal(matchOne("x/y/a.ts", "*.ts"), true);
    assert.equal(matchOne("x/y/a.md", "*.ts"), false);
  });

  it("含 `/` 的模式锚定：`sub/*.ts` 只吃一层、且不吃根下同名文件", () => {
    assert.equal(matchOne("sub/c.ts", "sub/*.ts"), true);
    assert.equal(matchOne("a.ts", "sub/*.ts"), false);
    assert.equal(matchOne("sub/deep/c.ts", "sub/*.ts"), false);
  });

  it("`**` 跨段", () => {
    assert.equal(matchOne("sub/deep/c.ts", "sub/**/*.ts"), true);
    assert.equal(matchOne("sub/c.ts", "sub/**/*.ts"), true);
    assert.equal(matchOne("other/c.ts", "sub/**/*.ts"), false);
    assert.equal(matchOne("a/b/c/d.ts", "**/*.ts"), true);
  });

  it("`*` 收下任意真实基名（空 pattern 在解析层已被拒，不流到这里）", () => {
    assert.equal(matchOne("a.ts", "*"), true);
    assert.equal(matchOne("x/y/a.ts", "*"), true);
    // Directories are never candidates (walk yields files only), but a
    // trailing-slash path is still evaluable.
    assert.equal(matchOne("x/y/", "*"), true);
  });
});

describe("matchOne — 段内元字符", () => {
  it("`?` 恰好一个字符", () => {
    assert.equal(matchOne("a.ts", "?.ts"), true);
    assert.equal(matchOne("ab.ts", "?.ts"), false);
    assert.equal(matchOne(".ts", "?.ts"), false);
  });

  it("`*` 段内折叠：`a*b` 跨多字符，`**` 在同一段内不越段", () => {
    assert.equal(matchOne("aXXXb.ts", "a*b.ts"), true);
    assert.equal(matchOne("ab.ts", "a*b.ts"), true);
    assert.equal(matchOne("a/b.ts", "a*b.ts"), false);
  });

  it("`[...]` 字符类与会话大小写敏感", () => {
    assert.equal(matchOne("a.ts", "[abc].ts"), true);
    assert.equal(matchOne("d.ts", "[abc].ts"), false);
    assert.equal(matchOne("A.ts", "[abc].ts"), false, "字符类不得忽略大小写");
  });

  it("`[a-z]` 区间", () => {
    assert.equal(matchOne("m.ts", "[a-z].ts"), true);
    assert.equal(matchOne("0.ts", "[a-z].ts"), false);
  });

  it("`[!a-z]` / `[^a-z]` 否定类", () => {
    assert.equal(matchOne("0.ts", "[!a-z].ts"), true);
    assert.equal(matchOne("m.ts", "[!a-z].ts"), false);
    assert.equal(matchOne("0.ts", "[^a-z].ts"), true);
    assert.equal(matchOne("m.ts", "[^a-z].ts"), false);
  });

  it("未闭合的 `[` → typed 拒绝（rg 对它 rc=2，不是「无匹配」）", () => {
    assert.throws(
      () => assertValidGlob("[.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /glob/.test(error.message) &&
        /unclosed/.test(error.message)
    );
    // Rejected mid-pattern too.
    assert.throws(() => assertValidGlob("a[b"), /unclosed/);
    assert.throws(() => assertValidGlob("x[!]y"), /unclosed/);
  });

  it("`[]]` 合法：紧跟 `[` 的 `]` 是字面成员而非终止符", () => {
    assert.doesNotThrow(() => assertValidGlob("[]]"));
    assert.equal(matchOne("].ts", "[]].ts"), true);
    assert.equal(matchOne("a.ts", "[]].ts"), false);
  });

  it("`[1]` 是字符类、不是字面 `[1]`（rg 实测口径）", () => {
    // Intuition says `x[1].ts` matches the literal file `x[1].ts`; rg parses
    // it as a character class, matching `x1.ts`. This pins "follow rg, not intuition".
    assert.equal(matchOne("x1.ts", "x[1].ts"), true);
    assert.equal(matchOne("x[1].ts", "x[1].ts"), false);
  });
});

describe("matchOne — brace 交替（rg 实测口径）", () => {
  it("`{a,b}` 交替展开", () => {
    assert.equal(matchOne("a.ts", "{a,b}.ts"), true);
    assert.equal(matchOne("b.ts", "{a,b}.ts"), true);
    assert.equal(matchOne("c.ts", "{a,b}.ts"), false);
  });

  it("单元素 `{ts}` 等价于 `ts`；`{}` 匹配空模式（不命中真实文件）", () => {
    assert.equal(matchOne("a.ts", "*.{ts}"), true);
    assert.equal(matchOne("ab", "a{}b"), true);
    assert.equal(matchOne("a", "a{}"), true);
    assert.equal(matchOne("a.ts", "{}"), false);
  });

  it("空备选 = 空串（`{a,}` ≡ a 或空，`{,}` ≡ 空模式）", () => {
    assert.equal(matchOne("a.ts", "{a,}.ts"), true);
    assert.equal(matchOne("b.ts", "{a,}.ts"), false);
    assert.equal(matchOne(".ts", "{a,}.ts"), true);
    // `{,}` expands to an empty pattern: only an empty path could hit, real
    // file names never do.
    assert.equal(matchOne("a.ts", "{,}.ts"), false);
    assert.equal(matchOne(".ts", "{,}.ts"), true);
    // A `/` inside an alternate anchors the whole pattern (see below); the
    // empty alternate still yields no hittable candidate.
    assert.equal(matchOne("z.ts", "{sub,/}z.ts"), false);
  });

  it("嵌套与多组笛卡尔积", () => {
    assert.equal(matchOne("b", "{a,{b,c}}"), true);
    assert.equal(matchOne("c", "{a,{b,c}}"), true);
    assert.equal(matchOne("d", "{a,{b,c}}"), false);
    assert.equal(matchOne("a1", "{a,b}{1,2}"), true);
    assert.equal(matchOne("b2", "{a,b}{1,2}"), true);
    assert.equal(matchOne("c1", "{a,b}{1,2}"), false);
  });

  it("不做 shell 区间展开：`{1..3}` 是**字面 `1..3`**（花括号只被剥掉）", () => {
    // Measured with rg: `{1..3}` does not expand to 1/2/3 but equals `1..3` —
    // matches a file named `1..3`, not `1` / `2` / `3`, nor the literal `{1..3}`.
    assert.equal(matchOne("1", "{1..3}"), false);
    assert.equal(matchOne("2", "{1..3}"), false);
    assert.equal(matchOne("1..3", "{1..3}"), true);
    assert.equal(matchOne("{1..3}", "{1..3}"), false);
    assert.equal(matchOne("a..c", "{a..c}"), true);
    assert.equal(matchOne("b", "{a..c}"), false);
  });

  it("`\\{` / `\\}` / `\\*` 转义为字面字符", () => {
    assert.equal(matchOne("a{b", "a\\{b"), true);
    assert.equal(matchOne("a}b", "a\\}b"), true);
    assert.equal(matchOne("star*", "star\\*"), true);
    assert.equal(matchOne("starX", "star\\*"), false);
  });

  it("字符类里的花括号是字面成员，不参与分组", () => {
    assert.equal(matchOne("{.ts", "[{].ts"), true);
    assert.equal(matchOne("}.ts", "[{}].ts"), true);
    assert.equal(matchOne("a.ts", "[{].ts"), false);
    assert.doesNotThrow(() => assertValidGlob("[{}].ts"));
  });
});

describe("matchOne — 锚定是整条模式的性质（brace 不改判）", () => {
  it("只要原文含 `/` 就锚定，哪怕它在 brace 备选里", () => {
    // Measured with rg: `{a,sub/only}.ts` hits both root a.ts and sub/only.ts;
    // `{sub/nope,zz}.ts` does not hit sub/zz.ts (whole pattern anchors, basename
    // fallback disabled).
    assert.equal(matchOne("a.ts", "{a,sub/only}.ts"), true);
    assert.equal(matchOne("sub/only.ts", "{a,sub/only}.ts"), true);
    assert.equal(matchOne("sub/zz.ts", "{sub/nope,zz}.ts"), false);
    assert.equal(matchOne("zz.ts", "zz.ts"), true);
    assert.equal(matchOne("sub/zz.ts", "zz.ts"), true);
  });

  it("单个前导 `/` 是「从搜索根起」，不是空段", () => {
    assert.equal(matchOne("a.ts", "/a.ts"), true);
    assert.equal(matchOne("sub/a.ts", "/a.ts"), false);
    assert.equal(matchOne("a.ts", "/*.ts"), true);
    assert.equal(matchOne("a.ts", "//a.ts"), false);
  });
});

describe("assertValidGlob — brace 语法错误（rg rc=2 口径）", () => {
  it("`{` 缺 `}` → unclosed alternate group", () => {
    assert.throws(
      () => assertValidGlob("{a,b"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /glob/.test(error.message) &&
        /unclosed/.test(error.message)
    );
    assert.throws(() => assertValidGlob("x{y"), /unclosed/);
  });

  it("`}` 无 `{` → unopened alternate group", () => {
    assert.throws(
      () => assertValidGlob("a,b}"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /glob/.test(error.message) &&
        /unopened/.test(error.message)
    );
    assert.throws(() => assertValidGlob("{a,b}}"), /unopened/);
  });

  it("合法形态不抛（含转义与字符类里的花括号）", () => {
    for (const glob of ["{a,b}", "{a,{b,c}}", "a\\{b", "[{]x", "{a,}b"]) {
      assert.doesNotThrow(() => assertValidGlob(glob), glob);
    }
  });
});

describe("matchesGlobSet — `!` 否定", () => {
  it("只有正模式时按正模式收", () => {
    assert.equal(matchesGlobSet("a.ts", ["*.ts"]), true);
    assert.equal(matchesGlobSet("a.md", ["*.ts"]), false);
  });

  it("只有负模式时默认全收、命中否定才剔", () => {
    assert.equal(matchesGlobSet("a.md", ["!*.ts"]), true);
    assert.equal(matchesGlobSet("a.ts", ["!*.ts"]), false);
  });

  it("正负并列 → 先收后剔", () => {
    assert.equal(matchesGlobSet("a.ts", ["*.ts", "!skip.ts"]), true);
    assert.equal(matchesGlobSet("skip.ts", ["*.ts", "!skip.ts"]), false);
    assert.equal(matchesGlobSet("a.md", ["*.ts", "!skip.ts"]), false);
  });

  it("空集合 → 全收（无 glob 即无收窄）", () => {
    assert.equal(matchesGlobSet("anything.txt", []), true);
  });

  it("裸 `!` → 一条都不收（不是「无正模式→全收」）", () => {
    // Measured with rg 15.0.0: a lone `--glob '!'` is rc=1 (empty pattern
    // matches no real path); `--glob '!*'` on the same tree is also rc=1. If
    // set semantics treated it as "no positive pattern", it would invert into
    // listing the whole repo — exactly the direction Node and rg diverge.
    for (const path of ["a.ts", "sub/c.ts", "anything.txt", "!"]) {
      assert.equal(matchesGlobSet(path, ["!"]), false, path);
    }
  });

  it("`\\!x` 是转义后的字面 `!`，仍是正模式（不是否定）", () => {
    // Measured with rg 15.0.0: `--glob '!bang.ts'` does not remove `!bang.ts`
    // (returns the whole repo); `--glob '\!bang.ts'` returns only `!bang.ts`.
    assert.equal(matchesGlobSet("!bang.ts", ["\\!bang.ts"]), true);
    assert.equal(matchesGlobSet("a.ts", ["\\!bang.ts"]), false);
    assert.equal(matchesGlobSet("!bang.ts", ["!bang.ts"]), true);
  });
});

/**
 * Trailing-`/` patterns.
 *
 * Measured with rg (15.0.0): `sub/`, `a.ts/`, double-star trailing slash,
 * `//`, and `sub//c.ts` all select zero files — an empty segment can only
 * match an empty name, and directories themselves are not candidate files.
 * The old implementation popped the trailing empty segment, so `sub/`
 * degraded to `sub` and wildcard-with-slash degraded to wildcard, letting
 * the Node path collect the whole repo where the rg path returned empty.
 */
describe("matchOne — 尾随空段不剔除", () => {
  it("尾随 `/` 的正模式不匹配任何文件", () => {
    for (const glob of ["sub/", "*/", "**/", "a.ts/", "/", "//", "sub//c.ts"]) {
      for (const path of ["a.ts", "sub/c.ts", "sub"]) {
        assert.equal(matchOne(path, glob), false, `${glob} vs ${path}`);
      }
    }
  });

  it("否定形态的尾随 `/` 同样按子目录剔除（`!sub/` 剔掉 sub 全子树）", () => {
    // Measured with rg: `--glob '!sub/'` removes everything under sub/ (deep
    // included); same for `!deep/`.
    assert.equal(matchesGlobSet("a.ts", ["!sub/"]), true);
    assert.equal(matchesGlobSet("sub/c.ts", ["!sub/"]), false);
    assert.equal(matchesGlobSet("sub/deep/d.ts", ["!sub/"]), false);
  });

  it("`!*/` / `!**/` 剔掉有一层以上目录的路径（rg 实测只留根级文件）", () => {
    assert.equal(matchesGlobSet("a.ts", ["!*/"]), true);
    assert.equal(matchesGlobSet("sub/c.ts", ["!*/"]), false);
    assert.equal(matchesGlobSet("a.ts", ["!**/"]), true);
    assert.equal(matchesGlobSet("sub/c.ts", ["!**/"]), false);
  });

  it("完整文件名 + 尾随 `/` 不是「匹配该名字」（`!a.ts/` 不剔 a.ts）", () => {
    // Measured with rg: `--glob '!a.ts/'` returns the whole repo (a.ts
    // included) — it matches no path at all.
    assert.equal(matchesGlobSet("a.ts", ["!a.ts/"]), true);
    assert.equal(matchesGlobSet("sub/c.ts", ["!a.ts/"]), true);
  });
});
