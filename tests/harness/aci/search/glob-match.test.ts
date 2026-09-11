/**
 * `--glob` 的 Node 引擎实现（D4 / SC9「Node 全语义」）。
 *
 * 为什么要单独测：`glob` 是 `type` 之外的第二个收窄维度，rg 引擎交给 rg 自
 * 己判，Node 引擎走这里 —— 两边不等价就是 SC9 失败。而这条路径在工具级测试
 * 里只被 `*.ts` / `sub/*.ts` 两个模式覆盖，`?` / `[...]` / `!` 否定 / 未闭合
 * `[` 这些分支没有别的地方钉住。
 *
 * 语义以 ripgrep 实测为准（不是自创规则）：
 *   - 不含 `/` → 按**基名**匹配任意深度；
 *   - 含 `/` → 锚定搜索根；
 *   - `*` / `?` 段内通配，`**` 跨段；
 *   - `[...]` 字符类区分大小写；
 *   - `!` 前缀是否定，与正模式并列时先收后剔。
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
    // 目录本身不是候选（walk 只产出文件），但带尾斜杠的路径也可判。
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
    // 在 pattern 中间同样拒。
    assert.throws(() => assertValidGlob("a[b"), /unclosed/);
    assert.throws(() => assertValidGlob("x[!]y"), /unclosed/);
  });

  it("`[]]` 合法：紧跟 `[` 的 `]` 是字面成员而非终止符", () => {
    assert.doesNotThrow(() => assertValidGlob("[]]"));
    assert.equal(matchOne("].ts", "[]].ts"), true);
    assert.equal(matchOne("a.ts", "[]].ts"), false);
  });

  it("`[1]` 是字符类、不是字面 `[1]`（rg 实测口径）", () => {
    // 直觉会以为 `x[1].ts` 匹配字面文件名 `x[1].ts`；rg 实际按字符类解，
    // 匹配的是 `x1.ts`。这条钉住「按 rg 而非按直觉」。
    assert.equal(matchOne("x1.ts", "x[1].ts"), true);
    assert.equal(matchOne("x[1].ts", "x[1].ts"), false);
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
});
