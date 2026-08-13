/**
 * patterns.test.ts — T1 secret-roundtrip SSOT — patterns.ts 验收。
 *
 * 覆盖 plan #406 §3 T1:
 *   A1: 7 类内置模式各自命中（与原 secrets-guard 等价 — 单源 SSOT）
 *   A4: compilePatterns("([", "sk-[A-Z]+") → 1 编入 + 1 剔除（非法正则剔除，
 *        其余正常生效 — Constraints (a) flatMap 错误剔除语义）
 *   反例：compilePatterns([]) → 空编译集（dropped 也是空）
 *   createCompiledPatterns 工厂 = DEFAULT + extras 合并编译
 *   默认模式无真实密钥（grep 断言 — 占位正则形态 only）
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  compilePatterns,
  createCompiledPatterns,
  DEFAULT_SECRET_PATTERNS,
} from "../../../src/harness/secret-roundtrip/patterns.js";

describe("DEFAULT_SECRET_PATTERNS — 正例（7 类内置模式）", () => {
  // compilePatterns() 不带 g 也会命中（不带 g 也能用 .test() 检测 — 见 test）。
  // 为统一断言，使用 compilePatterns 做一次非 g 编译（patterns.ts 用 g，
  // 这里只关心 .test 命中 — g 不影响是否存在匹配点）。
  const { compiled } = compilePatterns(DEFAULT_SECRET_PATTERNS);
  // 强制去掉 g 后缀以跑 .test 单点断言（compilePatterns 用 g 是为 recognize
  // 迭代扫描设计的；.test 在带 g 标志下仍会推进 lastIndex）。
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
      // lastIndex 重置保证每次 .test() 都从 0 开始
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
    // 存活正则仍能正常工作
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
    // compilePatterns 不接触 text，只编译正则。stress test 验证 no-throw。
    // 原 fixture "sk-AAAAAAAAAAAAAA" 仅 14 个 A，不满足 sk-[...]{20,}（需要 ≥20）→
    // 非 sk- 模式在纯 sk- 串里也没有匹配，任何模式对无匹配输入都返回 false，
    // `=== true` 断言不可能成立。改为含全部 7 类形态的超长串，使每条模式都真命中
    // （fixture 修错，断言强度不变）。
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
    // 头部仍是默认集第一条
    assert.equal(compiled[0]!.source, DEFAULT_SECRET_PATTERNS[0]);
  });
  it("返回的是冻结的 ReadonlyArray", () => {
    const compiled = createCompiledPatterns();
    assert.equal(Object.isFrozen(compiled), true);
  });
});

describe("DEFAULT_SECRET_PATTERNS — 占位形态 only（无真实密钥）", () => {
  // 安全约束：默认集只能是占位正则源串，绝不含真实 sk-/AKIA 密钥。
  // 实施性 grep：每个源串都应以某种占位形态匹配自身（priv-key-block / sk- / AKIA / ghp_ /
  // github_pat_ / xox / id_ 形态），但不出现 base64 高熵 24+ 连续串等真实密钥特征。
  it("无默认源串含 24+ 连续 base64 字符（真实 key 形态）", () => {
    const realKey = /[A-Za-z0-9+\/]{24,}/;
    for (const src of DEFAULT_SECRET_PATTERNS) {
      assert.equal(realKey.test(src), false, `${src} 不应含真实密钥形态`);
    }
  });
});
