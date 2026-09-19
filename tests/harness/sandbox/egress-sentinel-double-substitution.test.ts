/**
 * tests/harness/sandbox/egress-sentinel-double-substitution.test.ts
 *
 * specs/egress-credential-sentinel.md T5 —— 双重代换防护（invariant 6）
 * 装配层夹具：
 *   ④ 子串契约违例 fixture：铸两个嵌套假值 → typed
 *      EgressCredentialMintError（kind=sentinel_substring_contract，走
 *      ToolExecutionError 同一失败通道，不起带部分代换的 session）；
 *      message hygiene：错误文案不回显任何 sentinel / 真值材料。
 *   ⑤ 「真值含假值前缀」构造体过 body transform → 替换产物不回扫、
 *      real value 永不回扫（body-substitution.js:94-115 的
 *      earliest-position-then-advance 语义 + carry 跨 chunk 边界）；
 *      headers 代换 split/join 单向（credential-sentinel.js:203）。
 *
 * T2 已钉「违例被检出」（egress-credential-mint.test.ts F4 段）；本文件
 * 是其补强钉：失败通道类型 + 文案卫生 + 代换引擎不回扫的字节级判据。
 * 全部 fixture 为生成假凭据，宿主真值 / .env* 不进任何输入或断言。
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "vitest";

import {
  assertSentinelSubstringContract,
  EgressCredentialMintError,
} from "../../../src/harness/sandbox/egress/credential-assembly.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import {
  matchesDomainPattern,
  SentinelRegistry,
} from "../../../src/harness/sandbox/egress/upstream.js";
// 测试专用深路径（SC10 只钉 src/；body transform 未经 upstream re-export，
// T5 diff 仅测试文件不扩 upstream —— 先例：egress-proxy-behavior.test.ts）。
import { createBodySubstitutionTransform } from "@anthropic-ai/sandbox-runtime/dist/sandbox/body-substitution.js";

const HOSTS = ["github.com", "*.github.com", "*.githubusercontent.com"];

function fakeSentinel(): string {
  return `fake_value_${randomUUID()}`;
}

/** 生成的假「真值」fixture（非任何真实凭据）。 */
function fakeReal(tag: string): string {
  return `gho_FAKEONLY_${tag}_${randomBytes(8).toString("hex")}`;
}

/** 跑一帧 body transform：按给定 chunk 序列喂入，收集全部输出。 */
async function runBodyTransform(
  pairs: ReadonlyArray<{ sentinel: Buffer; realValue: Buffer }>,
  chunks: readonly string[]
): Promise<string> {
  const t = createBodySubstitutionTransform(pairs);
  const out: Buffer[] = [];
  const done = new Promise<void>((resolve) => t.on("end", resolve));
  t.on("data", (c: Buffer) => out.push(c));
  for (const c of chunks.slice(0, -1)) t.write(Buffer.from(c, "utf8"));
  t.end(Buffer.from(chunks[chunks.length - 1], "utf8"));
  await done;
  return Buffer.concat(out).toString("utf8");
}

describe("T5④ F4 违例 fixture —— 嵌套假值 = 装配失败 typed 错误", () => {
  it("两个互为子串的假值 → EgressCredentialMintError(sentinel_substring_contract)，走 ToolExecutionError 同一失败通道", () => {
    const registry = new SentinelRegistry();
    const inner = fakeSentinel();
    const outer = `pre_${inner}_post`;
    const realInner = fakeReal("inner");
    const realOuter = fakeReal("outer");
    registry.registerWithSentinel("A", inner, realInner, [...HOSTS]);
    registry.registerWithSentinel("B", outer, realOuter, [...HOSTS]);
    let err: unknown;
    try {
      assertSentinelSubstringContract(registry);
      assert.fail("嵌套假值未被拦 = invariant 6 破防");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof EgressCredentialMintError);
    assert.ok(err instanceof ToolExecutionError); // session 同一失败通道
    assert.equal(err.kind, "sentinel_substring_contract");
    // 文案卫生：不回显 sentinel 本身，更不携带任何真值材料。
    assert.ok(!err.message.includes(inner));
    assert.ok(!err.message.includes(outer));
    assert.ok(!err.message.includes(realInner));
    assert.ok(!err.message.includes(realOuter));
  });

  it("对照组：随机铸造的 uuid sentinel 名册不误报（契约只钉真违例）", () => {
    const registry = new SentinelRegistry();
    registry.register("A", fakeReal("a"), [...HOSTS]);
    registry.register("B", fakeReal("b").repeat(9), [...HOSTS]);
    registry.register("C", fakeReal("c"), [...HOSTS]);
    assert.doesNotThrow(() => assertSentinelSubstringContract(registry));
  });
});

describe("T5⑤ 双重代换防护 —— 替换产物不回扫、real value 永不回扫", () => {
  // 构造体：real 以某 sentinel 为前缀 —— 若代换后回扫输出，real 头部的
  // sentinel 会再次被代换 → 无限扩张 / 重复 suffix。单向语义下输出恰为
  // 一次代换产物。
  const sentinel = fakeSentinel();
  const real = `${sentinel}_REAL`;
  const pairs = [
    { sentinel: Buffer.from(sentinel, "utf8"), realValue: Buffer.from(real, "utf8") },
  ];

  it("body transform 单 chunk：两处 sentinel 各代换一次，real 不回扫", async () => {
    const input = `prefix ${sentinel} middle ${sentinel} suffix`;
    const expected = `prefix ${real} middle ${real} suffix`;
    const out = await runBodyTransform(pairs, [input]);
    assert.equal(out, expected);
    // 不回扫的直接判据：无级联扩张产物。
    assert.ok(!out.includes(`${sentinel}_REAL_REAL`));
    assert.equal(out.split("_REAL").length - 1, 2);
  });

  it("body transform 跨 chunk：sentinel 被切在边界仍整替，且不回扫", async () => {
    const input = `A${sentinel}B`;
    // 切在 sentinel 中段，逼 carry hold-back 路径。
    const cut = 1 + Math.floor(sentinel.length / 2);
    const out = await runBodyTransform(pairs, [
      input.slice(0, cut),
      input.slice(cut),
    ]);
    assert.equal(out, `A${real}B`);
    assert.equal(out.split(sentinel).length - 1, 1); // 仅 real 头部一次
  });

  it("headers 代换 split/join 单向：real 含 sentinel 前缀也只替一轮", () => {
    const registry = new SentinelRegistry();
    registry.registerWithSentinel("X", sentinel, real, [...HOSTS]);
    const headers: Record<string, string | undefined> = {
      authorization: `Bearer ${sentinel}`,
    };
    registry.substituteInHeaders(headers, "github.com", matchesDomainPattern);
    assert.equal(headers.authorization, `Bearer ${real}`);
    // 单向判据：输出里 sentinel 只出现一次（来自 real 自身前缀），
    // 无二次代换造成的 _REAL 扩张。
    assert.equal(headers.authorization!.split(sentinel).length - 1, 1);
    assert.ok(!headers.authorization!.includes("_REAL_REAL"));
  });

  it("per-sentinel 门不动：destHost 不命中 injectHosts 时假值原样（invariant 2 方向）", () => {
    const registry = new SentinelRegistry();
    registry.registerWithSentinel("X", sentinel, real, [...HOSTS]);
    const headers: Record<string, string | undefined> = {
      authorization: `Bearer ${sentinel}`,
    };
    registry.substituteInHeaders(headers, "evil.example", matchesDomainPattern);
    assert.equal(headers.authorization, `Bearer ${sentinel}`);
  });
});
