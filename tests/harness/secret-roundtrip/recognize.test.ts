/**
 * recognize.test.ts — SSOT acceptance tests for secret-roundtrip recognize.ts.
 *
 * Coverage:
 *   recognize("sk-...") without registry → matched 1 + <<<SECRET_1>>> replacement
 *   second recognize of the same value on one registry → matched 0 + same placeholder (dedup check)
 *   restore cross-module round-trip (echo <<<SECRET_1>>> → echo sk-...)
 *   pattern-compilation and full-suite aspects are covered by patterns.test.ts / the whole suite, not repeated here
 *
 * Boundaries (defensive contract, five input classes):
 *   - empty: empty text → matched [] + replaced ""
 *   - negative: text without secrets → matched [] + replaced verbatim
 *   - overflow: 25_000-char text containing a secret → no throw, correct replacement
 *     (recognize never truncates — a different contract from secrets-guard's
 *     20_000 truncation, since this scans full user text)
 *   - concurrent: two different secrets in one text → each gets a unique ID + matched 2
 *   - exception: invalid custom patterns silently dropped (construction never throws), defaults still effective
 *   - dedup: same value appearing 3 times → matched 1 (registered once), all three replaced with the same placeholder
 *   - placeholder prefix safety (cross-checked via restore): SECRET_1 never partially matches SECRET_10
 *   - re-entrancy: stateful g-flag lastIndex is reset, a registry reused across rounds misses no match
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
    assert.equal(second.matched.length, 0); // already in the registry → not double-counted
    assert.equal(second.replaced, "<<<SECRET_1>>>"); // dedup reuses the placeholder
    assert.equal(reg.size, 1); // only 1 entry registered
  });

  it('A3：restore("echo <<<SECRET_1>>>", registry) === "echo sk-..."', () => {
    const reg = createSecretRegistry();
    recognize(SECRET, reg); // registers through the recognize layer; cross-module integration check
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
    assert.equal(reg.patterns.length, 7); // DEFAULT only, invalid extras not admitted
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
    assert.equal(r.matched.length, 1); // registered once
    assert.equal(r.replaced, "<<<SECRET_1>>> <<<SECRET_1>>> <<<SECRET_1>>>");
    assert.equal(reg.size, 1);
  });
});

describe("recognize — 边界：占位符前缀安全 + re-entrancy", () => {
  it("占位符前缀安全：SECRET_1 不部分命中 SECRET_10（restore 交叉验证）", () => {
    const reg = createSecretRegistry();
    for (let i = 0; i < 10; i++) reg.register(`v${i + 1}`);
    // recognize-level smoke: <<<SECRET_N>>> is not secret-shaped → kept verbatim, never misrecognized
    const r = recognize("<<<SECRET_1>>> and <<<SECRET_10>>>", reg);
    assert.deepEqual(r.matched, []);
    assert.equal(r.replaced, "<<<SECRET_1>>> and <<<SECRET_10>>>");
    // restore boundary: split/join matches full literals, SECRET_1 never harms SECRET_10
    assert.equal(restore("<<<SECRET_1>>> + <<<SECRET_10>>>", reg), "v1 + v10");
  });

  it("re-entrancy：g-flag 有状态 lastIndex 复位，registry 跨轮复用不漏匹配", () => {
    const reg = createSecretRegistry();
    const r1 = recognize("sk-aaaaaaaaaaaaaaaaaaaa", reg);
    assert.equal(r1.matched.length, 1);
    assert.equal(r1.replaced, "<<<SECRET_1>>>");

    // If lastIndex were not reset, the second exec would start at the wrong offset and miss the match
    const r2 = recognize("sk-bbbbbbbbbbbbbbbbbbbb", reg);
    assert.equal(r2.matched.length, 1);
    assert.equal(r2.replaced, "<<<SECRET_2>>>");
  });
});
