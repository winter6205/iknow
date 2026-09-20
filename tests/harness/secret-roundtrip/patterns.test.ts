/**
 * patterns.test.ts — SSOT acceptance tests for secret-roundtrip patterns.ts.
 *
 * Coverage:
 *   - all 7 builtin pattern classes hit individually (equivalent to the original
 *     secrets-guard — single-source SSOT);
 *   - compilePatterns("([", "sk-[A-Z]+") -> 1 compiled + 1 dropped (invalid
 *     regex dropped, the rest stay effective);
 *   - counter-example: compilePatterns([]) -> empty compiled set (dropped empty too);
 *   - createCompiledPatterns factory = DEFAULT + extras merged in one compile;
 *   - default patterns contain no real secret (grep assertion — placeholder regex shapes only).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  compilePatterns,
  createCompiledPatterns,
  DEFAULT_SECRET_PATTERNS,
} from "../../../src/harness/secret-roundtrip/patterns.js";

describe("DEFAULT_SECRET_PATTERNS — 正例（7 类内置模式）", () => {
  // compilePatterns() hits without the g flag too (.test() works either way).
  // Compile once without g for uniform assertions (patterns.ts uses g; here we
  // only care about .test hits — g does not change whether a match position exists).
  const { compiled } = compilePatterns(DEFAULT_SECRET_PATTERNS);
  // Force-strip the g suffix for single-point .test assertions (compilePatterns
  // uses g for recognize's iterative scanning; .test still advances lastIndex under g).
  const cases: Array<{ label: string; re: RegExp; sample: string }> = [
    {
      label: "私钥块 -----BEGIN RSA PRIVATE KEY-----",
      re: new RegExp(DEFAULT_SECRET_PATTERNS[0]!),
      sample: "-----BEGIN RSA PRIVATE KEY-----\nMIIEvgIB",
    },
    {
      label: "sk- 前缀通用 API key",
      re: new RegExp(DEFAULT_SECRET_PATTERNS[1]!),
      sample: "sk-abcdefghijklmnopqrstuvwxyz123",
    },
    {
      label: "AWS access key AKIA",
      re: new RegExp(DEFAULT_SECRET_PATTERNS[2]!),
      sample: "AKIA1234567890ABCDEF",
    },
    {
      label: "GitHub ghp_ token",
      re: new RegExp(DEFAULT_SECRET_PATTERNS[3]!),
      sample: "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
    },
    {
      label: "GitHub github_pat_ token",
      re: new RegExp(DEFAULT_SECRET_PATTERNS[4]!),
      sample: "github_pat_" + "a".repeat(50),
    },
    {
      label: "Slack xoxb token",
      re: new RegExp(DEFAULT_SECRET_PATTERNS[5]!),
      sample: "xoxb-1234567890-abcdef",
    },
    {
      label: "私钥文件外传 cat id_rsa",
      re: new RegExp(DEFAULT_SECRET_PATTERNS[6]!),
      sample: "cat ~/.ssh/id_rsa",
    },
  ];
  for (const c of cases) {
    it(`命中：${c.label}`, () => {
      assert.equal(c.re.test(c.sample), true);
    });
  }

  it("compilePatterns(DEFAULT_SECRET_PATTERNS) 长度 = 7（SSOT 一一对应）", () => {
    assert.equal(compiled.length, DEFAULT_SECRET_PATTERNS.length);
    assert.equal(compiled.length, 7);
  });
});

describe("DEFAULT_SECRET_PATTERNS — 反例（无害文本不命中）", () => {
  const { compiled } = compilePatterns(DEFAULT_SECRET_PATTERNS);
  it("普通 bash 命令不命中任何模式", () => {
    const sample = "ls -la /tmp && echo hello world";
    for (const { re } of compiled) {
      // Reset lastIndex so every .test() starts from 0
      re.lastIndex = 0;
      assert.equal(re.test(sample), false, `${re.source} 不应命中`);
    }
  });
  it("含 'key' / 'token' 字样的英文文本不命中", () => {
    const sample = "Please add an API key for testing the new token format";
    for (const { re } of compiled) {
      re.lastIndex = 0;
      assert.equal(re.test(sample), false);
    }
  });
});

describe("compilePatterns — 边界（异常类边界 / 非法正则剔除）", () => {
  it("非法正则 + 合法正则混合：1 编入 + 1 剔除（A4）", () => {
    const { compiled, dropped } = compilePatterns(["([", "sk-[A-Z]+"]);
    assert.equal(compiled.length, 1);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0], "([");
    // The surviving regex still works normally
    assert.equal(compiled[0]!.re.test("sk-ABCDE"), true);
  });

  it("全部非法正则：compiled=[], dropped 含全部", () => {
    const { compiled, dropped } = compilePatterns(["(", "[", "sk-(unbalanced"]);
    assert.equal(compiled.length, 0);
    assert.equal(dropped.length, 3);
  });

  it("空数组：compiled=[], dropped=[]", () => {
    const { compiled, dropped } = compilePatterns([]);
    assert.equal(compiled.length, 0);
    assert.equal(dropped.length, 0);
  });

  it("返回值不可变（Object.freeze 守门）", () => {
    const r = compilePatterns(["x"]);
    assert.throws(() => {
      (r.compiled as unknown as { length: number }).length = 99;
    });
    assert.throws(() => {
      (r.dropped as unknown as { length: number }).length = 99;
    });
  });

  it("overflow：超长输入字符串在 patterns.ts 阶段不抛（stress no-throw）", () => {
    // compilePatterns never touches text, it only compiles regexes; the stress test verifies no-throw.
    // The old fixture "sk-AAAAAAAAAAAAAA" had only 14 A's, failing sk-[...]{20,} (needs ≥20);
    // no non-sk- pattern matches a pure sk- string either, so for a no-match input every
    // pattern returns false and a `=== true` assertion could never hold. Use an oversized
    // string containing all 7 shapes so each pattern truly matches (fixture fix, assertion
    // strength unchanged).
    const chunk = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "sk-" + "A".repeat(40),
      "AKIA1234567890ABCDEF",
      "ghp_" + "a".repeat(36),
      "github_pat_" + "a".repeat(50),
      "xoxb-1234567890-abcdef",
      "cat ~/.ssh/id_rsa",
    ].join(" ");
    const huge = chunk.repeat(1_000);
    const { compiled } = compilePatterns(DEFAULT_SECRET_PATTERNS);
    for (const { re } of compiled) {
      re.lastIndex = 0;
      assert.equal(re.test(huge), true);
    }
  });
});

describe("createCompiledPatterns — 工厂", () => {
  it("无 extras：仅 DEFAULT_SECRET_PATTERNS（7 条）", () => {
    const compiled = createCompiledPatterns();
    assert.equal(compiled.length, 7);
  });
  it("有 extras：DEFAULT + extras 拼接（追加在 default 之后）", () => {
    const compiled = createCompiledPatterns(["MY_[0-9]{6}"]);
    assert.equal(compiled.length, 8);
    assert.equal(compiled[7]!.source, "MY_[0-9]{6}");
    // The head is still the first default pattern
    assert.equal(compiled[0]!.source, DEFAULT_SECRET_PATTERNS[0]);
  });
  it("返回的是冻结的 ReadonlyArray", () => {
    const compiled = createCompiledPatterns();
    assert.equal(Object.isFrozen(compiled), true);
  });
});

describe("DEFAULT_SECRET_PATTERNS — 占位形态 only（无真实密钥）", () => {
  // Safety constraint: the default set must contain placeholder regex source strings only, never a real sk-/AKIA key.
  // Enforcement grep: every source string matches itself under some placeholder shape (priv-key-block / sk- / AKIA / ghp_ /
  // github_pat_ / xox / id_ forms), with no real-key traits such as 24+ consecutive base64 characters.
  it("无默认源串含 24+ 连续 base64 字符（真实 key 形态）", () => {
    const realKey = /[A-Za-z0-9+\/]{24,}/;
    for (const src of DEFAULT_SECRET_PATTERNS) {
      assert.equal(realKey.test(src), false, `${src} 不应含真实密钥形态`);
    }
  });
});
