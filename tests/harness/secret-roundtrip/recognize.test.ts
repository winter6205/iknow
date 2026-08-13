/**
 * recognize.test.ts — T1 secret-roundtrip SSOT — recognize.ts 验收。
 *
 * 覆盖 plan #406 §3 T1:
 *   A1: recognize("sk-...") 无 registry → matched 1 + <<<SECRET_1>>> 替换
 *   A2: 同 registry 二次 recognize 同值 → matched 0 + 同一占位符（去重验证）
 *   A3: restore 跨模块还原（echo <<<SECRET_1>>> → echo sk-...）
 *   A4/A5: patterns.test.ts / 全量 suite 覆盖（本文件不重复）
 *
 * 边界（per test.md + defensive-contract 5 类输入）:
 *   - empty：空文本 → matched [] + replaced ""
 *   - negative：无密钥文本 → matched [] + replaced 原样 verbatim
 *   - overflow：25_000 字符文本含密钥 → 不抛且正确替换（recognize 不截断，
 *     与 secrets-guard 的 20_000 截断是不同契约——此处扫全量用户文本）
 *   - concurrent：同文本两个不同 secret → 各占唯一 ID + matched 2
 *   - exception：非法自定义 pattern 静默剔除（构造不抛），默认模式仍生效
 *   - dedup：同值出现 3 次 → matched 1（注册一次），三处全替换同一占位符
 *   - 占位符前缀安全（restore 交叉验证）：SECRET_1 不部分命中 SECRET_10
 *   - re-entrancy：g-flag 有状态 lastIndex 复位，registry 跨多轮复用不漏匹配
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { recognize } from "../../../src/harness/secret-roundtrip/recognize.js";
import {
  createSecretRegistry,
  restore,
} from "../../../src/harness/secret-roundtrip/registry.js";

describe("recognize — A1：无 registry 一次性扫描", () => {
  it('recognize("sk-aaaaaaaaaaaaaaaaaaaa") → matched 1 + <<<SECRET_1>>>，无明文', () => {
    const r = recognize("sk-aaaaaaaaaaaaaaaaaaaa");
    assert.equal(r.matched.length, 1);
    assert.equal(r.matched[0], "sk-aaaaaaaaaaaaaaaaaaaa");
    assert.ok(r.replaced.includes("<<<SECRET_1>>>"));
    assert.ok(!r.replaced.includes("sk-aaaaaaaaaaaaaaaaaaaa"));
  });
});

describe("recognize — A2 + A3：共享 registry 去重 + restore 跨模块还原", () => {
  const SECRET = "sk-aaaaaaaaaaaaaaaaaaaa";

  it("第二次 recognize 同值 → matched 0 + 同一占位符（A2）", () => {
    const reg = createSecretRegistry();
    const first = recognize(SECRET, reg);
    assert.equal(first.matched.length, 1);
    assert.equal(first.replaced, "<<<SECRET_1>>>");

    const second = recognize(SECRET, reg);
    assert.equal(second.matched.length, 0); // 已在 registry → 不重复计数
    assert.equal(second.replaced, "<<<SECRET_1>>>"); // 占位符去重复用
    assert.equal(reg.size, 1); // 只注册 1 条
  });

  it('A3：restore("echo <<<SECRET_1>>>", registry) === "echo sk-..."', () => {
    const reg = createSecretRegistry();
    recognize(SECRET, reg); // 走识别层注册，跨模块集成验证
    assert.equal(restore("echo <<<SECRET_1>>>", reg), `echo ${SECRET}`);
  });
});

describe("recognize — 边界：empty / negative", () => {
  it("empty：空文本 → matched [] + replaced 空串", () => {
    const r = recognize("");
    assert.deepEqual(r.matched, []);
    assert.equal(r.replaced, "");
  });

  it("negative：无密钥文本 → matched [] + replaced 原样 verbatim", () => {
    const input = "hello world, just some prose without secrets";
    const r = recognize(input);
    assert.deepEqual(r.matched, []);
    assert.equal(r.replaced, input);
  });
});

describe("recognize — 边界：overflow（recognize 扫全量，不截断）", () => {
  it("25_000 字符文本含密钥：不抛 + matched 1 + 正确替换", () => {
    const secret = "sk-aaaaaaaaaaaaaaaaaaaa";
    const text = "a".repeat(25_000) + " " + secret;
    const r = recognize(text);
    assert.equal(r.matched.length, 1);
    assert.ok(r.replaced.includes("<<<SECRET_1>>>"));
    assert.ok(!r.replaced.includes(secret));
    assert.ok(r.replaced.startsWith("a".repeat(25_000) + " "));
  });
});

describe("recognize — 边界：concurrent（同文本多个不同 secret）", () => {
  it("两个不同 secret → matched 2，各得唯一占位符", () => {
    const reg = createSecretRegistry();
    const r = recognize(
      "key sk-aaaaaaaaaaaaaaaaaaaa and AKIA1234567890ABCDEF here",
      reg
    );
    assert.equal(r.matched.length, 2);
    assert.ok(r.replaced.includes("<<<SECRET_1>>>"));
    assert.ok(r.replaced.includes("<<<SECRET_2>>>"));
    assert.ok(!r.replaced.includes("sk-aaaaaaaaaaaaaaaaaaaa"));
    assert.ok(!r.replaced.includes("AKIA1234567890ABCDEF"));
    assert.equal(reg.size, 2);
  });
});

describe("recognize — 边界：exception（非法自定义 pattern 静默剔除）", () => {
  it('createSecretRegistry({ patterns: ["("] }) 构造不抛，默认模式仍生效', () => {
    const reg = createSecretRegistry({ patterns: ["("] });
    assert.equal(reg.patterns.length, 7); // 仅 DEFAULT，非法 extras 未入列
    const r = recognize("sk-aaaaaaaaaaaaaaaaaaaa", reg);
    assert.equal(r.matched.length, 1);
    assert.equal(r.replaced, "<<<SECRET_1>>>");
  });
});

describe("recognize — 边界：dedup（同值多次出现）", () => {
  it("同值出现 3 次 → matched 1，三处全替换为同一占位符", () => {
    const reg = createSecretRegistry();
    const text =
      "sk-aaaaaaaaaaaaaaaaaaaa sk-aaaaaaaaaaaaaaaaaaaa sk-aaaaaaaaaaaaaaaaaaaa";
    const r = recognize(text, reg);
    assert.equal(r.matched.length, 1); // 只注册一次
    assert.equal(r.replaced, "<<<SECRET_1>>> <<<SECRET_1>>> <<<SECRET_1>>>");
    assert.equal(reg.size, 1);
  });
});

describe("recognize — 边界：占位符前缀安全 + re-entrancy", () => {
  it("占位符前缀安全：SECRET_1 不部分命中 SECRET_10（restore 交叉验证）", () => {
    const reg = createSecretRegistry();
    for (let i = 0; i < 10; i++) reg.register(`v${i + 1}`);
    // recognize-level smoke：<<<SECRET_N>>> 不是密钥形态 → 原样保留、不误识别
    const r = recognize("<<<SECRET_1>>> and <<<SECRET_10>>>", reg);
    assert.deepEqual(r.matched, []);
    assert.equal(r.replaced, "<<<SECRET_1>>> and <<<SECRET_10>>>");
    // restore 边界：split/join 全字面匹配，SECRET_1 不误伤 SECRET_10
    assert.equal(restore("<<<SECRET_1>>> + <<<SECRET_10>>>", reg), "v1 + v10");
  });

  it("re-entrancy：g-flag 有状态 lastIndex 复位，registry 跨轮复用不漏匹配", () => {
    const reg = createSecretRegistry();
    const r1 = recognize("sk-aaaaaaaaaaaaaaaaaaaa", reg);
    assert.equal(r1.matched.length, 1);
    assert.equal(r1.replaced, "<<<SECRET_1>>>");

    // 若 lastIndex 未复位，第二次 exec 会从错误位置开始而漏匹配
    const r2 = recognize("sk-bbbbbbbbbbbbbbbbbbbb", reg);
    assert.equal(r2.matched.length, 1);
    assert.equal(r2.replaced, "<<<SECRET_2>>>");
  });
});
