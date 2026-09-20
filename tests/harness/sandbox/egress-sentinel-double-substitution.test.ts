/**
 * tests/harness/sandbox/egress-sentinel-double-substitution.test.ts
 *
 * Double-substitution protection (invariant 6 of
 * specs/egress-credential-sentinel.md), assembly-layer fixtures:
 *   - substring-contract violation: mint two nested fake values → typed
 *     EgressCredentialMintError (kind=sentinel_substring_contract) travelling the
 *     same ToolExecutionError failure channel, so no session starts with a partial
 *     substitution; message hygiene: the error text echoes no sentinel and no
 *     real-value material.
 *   - a crafted "real value prefixed by a fake value" through the body transform
 *     → substitution output is never rescanned and the real value never re-enters
 *     the scan (earliest-position-then-advance semantics in body-substitution.js
 *     plus the carry across chunk boundaries); header substitution is one-way
 *     split/join (credential-sentinel.js).
 *
 * egress-credential-mint.test.ts already pins that violations are detected; this
 * file hardens it: failure-channel type + message hygiene + the byte-level
 * no-rescan criterion of the substitution engine. All fixtures are generated fake
 * credentials — no host real values or .env* enter any input or assertion.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "vitest";

import {
  assertSentinelSubstringContract,
  EgressCredentialMintError,
} from "../../../src/harness/sandbox/egress/credential-mint.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import {
  matchesDomainPattern,
  SentinelRegistry,
} from "../../../src/harness/sandbox/egress/upstream.js";
// Test-only deep path: the body transform is not re-exported through upstream and
// this stays test-only without extending upstream (precedent: egress-proxy-behavior.test.ts).
import { createBodySubstitutionTransform } from "@anthropic-ai/sandbox-runtime/dist/sandbox/body-substitution.js";

const HOSTS = ["github.com", "*.github.com", "*.githubusercontent.com"];

function fakeSentinel(): string {
  return `fake_value_${randomUUID()}`;
}

/** Generated fake "real value" fixture (never an actual credential). */
function fakeReal(tag: string): string {
  return `gho_FAKEONLY_${tag}_${randomBytes(8).toString("hex")}`;
}

/** Run one body-transform pass: feed the given chunk sequence, collect all output. */
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
    assert.ok(err instanceof ToolExecutionError); // the same failure channel a session uses
    assert.equal(err.kind, "sentinel_substring_contract");
    // message hygiene: echoes no sentinel itself, let alone any real-value material.
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
  // Construction: the real value is prefixed by a sentinel — rescanning the output
  // would substitute the sentinel sitting at the real value's head again → unbounded
  // growth / duplicated suffix. Under one-way semantics the output is exactly one
  // substitution product.
  const sentinel = fakeSentinel();
  const real = `${sentinel}_REAL`;
  const pairs = [
    {
      sentinel: Buffer.from(sentinel, "utf8"),
      realValue: Buffer.from(real, "utf8"),
    },
  ];

  it("body transform 单 chunk：两处 sentinel 各代换一次，real 不回扫", async () => {
    const input = `prefix ${sentinel} middle ${sentinel} suffix`;
    const expected = `prefix ${real} middle ${real} suffix`;
    const out = await runBodyTransform(pairs, [input]);
    assert.equal(out, expected);
    // direct no-rescan criterion: no cascading-growth output.
    assert.ok(!out.includes(`${sentinel}_REAL_REAL`));
    assert.equal(out.split("_REAL").length - 1, 2);
  });

  it("body transform 跨 chunk：sentinel 被切在边界仍整替，且不回扫", async () => {
    const input = `A${sentinel}B`;
    // split mid-sentinel to force the carry hold-back path.
    const cut = 1 + Math.floor(sentinel.length / 2);
    const out = await runBodyTransform(pairs, [
      input.slice(0, cut),
      input.slice(cut),
    ]);
    assert.equal(out, `A${real}B`);
    assert.equal(out.split(sentinel).length - 1, 1); // once only, inside the real value's prefix
  });

  it("headers 代换 split/join 单向：real 含 sentinel 前缀也只替一轮", () => {
    const registry = new SentinelRegistry();
    registry.registerWithSentinel("X", sentinel, real, [...HOSTS]);
    const headers: Record<string, string | undefined> = {
      authorization: `Bearer ${sentinel}`,
    };
    registry.substituteInHeaders(headers, "github.com", matchesDomainPattern);
    assert.equal(headers.authorization, `Bearer ${real}`);
    // one-way criterion: the sentinel appears exactly once in the output (from the
    // real value's own prefix), no _REAL growth from a second substitution round.
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
