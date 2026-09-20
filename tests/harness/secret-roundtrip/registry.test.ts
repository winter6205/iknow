/**
 * registry.test.ts — SSOT acceptance tests for secret-roundtrip registry.ts.
 *
 * Coverage:
 *   restore("echo <<<SECRET_1>>>", registry) → "echo sk-..."
 *   boundary: empty registry restore → returns input verbatim
 *   boundary: unknown placeholder passes through without throwing (cross-session restart scenario)
 *   boundary: repeated register of the same value → same placeholder (IDs never reused)
 *   boundary: concurrent register (each of several simultaneous values gets a unique ID)
 *   boundary: register call order → placeholder IDs increase monotonically and are never reused
 *   immutability: registry functions frozen (top-level Object.freeze)
 *   immutability: the entries array returned by entries() is frozen
 *   patterns field is a frozen compiled set
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createSecretRegistry,
  restore,
} from "../../../src/harness/secret-roundtrip/registry.js";

describe("createSecretRegistry — 基本 API", () => {
  it("register(value) 首次返回 <<<SECRET_1>>>", () => {
    const reg = createSecretRegistry();
    assert.equal(reg.register("sk-aaaaaaaaaaaaaaaaaaaa"), "<<<SECRET_1>>>");
    assert.equal(reg.size, 1);
  });

  it("register 第二次同值 → 同 placeholder（不重用 ID）", () => {
    const reg = createSecretRegistry();
    const first = reg.register("sk-aaaaaaaaaaaaaaaaaaaa");
    const second = reg.register("sk-aaaaaaaaaaaaaaaaaaaa");
    assert.equal(first, second);
    assert.equal(first, "<<<SECRET_1>>>");
    assert.equal(reg.size, 1);
  });

  it("register 不同值 → 不同 placeholder（ID 单调递增）", () => {
    const reg = createSecretRegistry();
    assert.equal(reg.register("sk-aaaa"), "<<<SECRET_1>>>");
    assert.equal(reg.register("AKIA1234567890ABCDEF"), "<<<SECRET_2>>>");
    assert.equal(reg.register("xoxb-1234567890-abcdef"), "<<<SECRET_3>>>");
    assert.equal(reg.size, 3);
  });

  it("resolve(placeholder) → 原 value；未知 placeholder → undefined", () => {
    const reg = createSecretRegistry();
    reg.register("sk-aaaaaaaaaaaaaaaaaaaa");
    assert.equal(reg.resolve("<<<SECRET_1>>>"), "sk-aaaaaaaaaaaaaaaaaaaa");
    assert.equal(reg.resolve("<<<SECRET_999>>>"), undefined);
  });

  it("has(value) 在 register 前 false / 后 true", () => {
    const reg = createSecretRegistry();
    assert.equal(reg.has("sk-aaaa"), false);
    reg.register("sk-aaaa");
    assert.equal(reg.has("sk-aaaa"), true);
  });

  it("entries() 返回 (placeholder, value) 对，冻结", () => {
    const reg = createSecretRegistry();
    reg.register("sk-aaaa");
    reg.register("sk-bbbb");
    const entries = reg.entries();
    assert.equal(entries.length, 2);
    assert.equal(Object.isFrozen(entries), true);
    for (const e of entries) {
      assert.equal(Object.isFrozen(e), true);
    }
    const set1 = new Set(entries.map((e) => e.placeholder));
    assert.ok(set1.has("<<<SECRET_1>>>"));
    assert.ok(set1.has("<<<SECRET_2>>>"));
  });

  it("values() 返回所有注册 value（去重保序）", () => {
    const reg = createSecretRegistry();
    reg.register("sk-aaaa");
    reg.register("sk-bbbb");
    reg.register("sk-aaaa"); // duplicate
    const v = reg.values();
    assert.deepEqual(v, ["sk-aaaa", "sk-bbbb"]);
    assert.equal(Object.isFrozen(v), true);
  });

  it("patterns 字段为冻结的编译集（构造期编译，运行期不重编译）", () => {
    const reg = createSecretRegistry();
    assert.equal(Object.isFrozen(reg.patterns), true);
    assert.equal(reg.patterns.length, 7); // the 7 DEFAULT_SECRET_PATTERNS
  });

  it("自定义 patterns：注入 extras 后 patterns 长度 = 7 + extras", () => {
    const reg = createSecretRegistry({ patterns: ["MY_[0-9]{6}"] });
    assert.equal(reg.patterns.length, 8);
    assert.equal(reg.patterns[7]!.source, "MY_[0-9]{6}");
  });

  it("非法 extras pattern 被剔除（compilePatterns dropped 语义）", () => {
    const reg = createSecretRegistry({ patterns: ["(", "MY_[0-9]{6}"] });
    // "(": invalid → dropped → not in compiled; MY_: valid → in compiled
    assert.equal(reg.patterns.length, 8);
    assert.equal(reg.patterns[7]!.source, "MY_[0-9]{6}");
  });
});

describe("restore — 占位符 → value 还原", () => {
  it('A3：restore("echo <<<SECRET_1>>>", registry) === "echo sk-..."', () => {
    const reg = createSecretRegistry();
    reg.register("sk-aaaaaaaaaaaaaaaaaaaa");
    assert.equal(
      restore("echo <<<SECRET_1>>>", reg),
      "echo sk-aaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("多占位符 + 重复：完整还原", () => {
    const reg = createSecretRegistry();
    const k1 = "sk-aaaaaaaaaaaaaaaaaaaa";
    const k2 = "AKIA1234567890ABCDEF";
    reg.register(k1);
    reg.register(k2);
    const input = `curl -H "X-Api: <<<SECRET_1>>>" -H "X-Aws: <<<SECRET_2>>>"; echo <<<SECRET_1>>>`;
    const expected = `curl -H "X-Api: ${k1}" -H "X-Aws: ${k2}"; echo ${k1}`;
    assert.equal(restore(input, reg), expected);
  });

  it("空 registry：原样返回", () => {
    const reg = createSecretRegistry();
    assert.equal(restore("echo <<<SECRET_1>>>", reg), "echo <<<SECRET_1>>>");
    assert.equal(restore("plain text", reg), "plain text");
  });

  it("未知占位符透传不抛（graceful degradation）", () => {
    const reg = createSecretRegistry();
    reg.register("sk-aaaa");
    // <<<SECRET_99>>> is unregistered
    assert.equal(
      restore("a <<<SECRET_1>>> b <<<SECRET_99>>> c", reg),
      "a sk-aaaa b <<<SECRET_99>>> c"
    );
  });

  it("占位符前缀不误匹配（<<<SECRET_1>>> 不匹配 <<<SECRET_10>>>）", () => {
    // split/join safety: split("<<<SECRET_1>>>") finds no complete literal
    // "<<<SECRET_1>>>" inside "<<<SECRET_10>>>" (the latter closes at 10>>>), so sibling IDs are unaffected.
    const reg = createSecretRegistry();
    // Register 10 values → numbering covers exactly up to <<<SECRET_10>>> (the old fixture registered
    // only 2 values, so <<<SECRET_10>>> was unregistered → restore passed it through, never exercising the prefix boundary)
    for (let i = 0; i < 10; i++) reg.register(`value-${i + 1}`);
    const input = "<<<SECRET_1>>> + <<<SECRET_10>>>";
    assert.equal(restore(input, reg), "value-1 + value-10");
  });

  it("占位符作为非密钥子串：不被误识别", () => {
    // When <<<SECRET_1>>> appears in plain text, restore emits it verbatim (placeholders are the registry's private namespace)
    const reg = createSecretRegistry();
    assert.equal(
      restore("text <<<SECRET_1>>> more", reg),
      "text <<<SECRET_1>>> more"
    );
  });
});

describe("createSecretRegistry — 并发与不可变", () => {
  it("同一 registry 上多次调用 register 顺序产 ID 单调递增", () => {
    const reg = createSecretRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(reg.register(`v${i}`));
    for (let i = 0; i < 10; i++) {
      assert.equal(ids[i], `<<<SECRET_${i + 1}>>>`);
    }
  });

  it("ID 永不重用：reset 概念不在本计划（per-engine 共享）", () => {
    const reg = createSecretRegistry();
    reg.register("sk-aaaa"); // ID 1
    reg.register("sk-bbbb"); // ID 2
    // Even with repeated same-shaped values in the sequence, the ID never rolls back
    reg.register("sk-aaaa"); // still ID 1
    assert.equal(reg.register("sk-cccc"), "<<<SECRET_3>>>");
  });

  it("registry 顶层 Object.freeze（消费者无法 mutate API）", () => {
    const reg = createSecretRegistry();
    assert.equal(Object.isFrozen(reg), true);
  });
});
