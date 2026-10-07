/**
 * tests/harness/secret-roundtrip/sentinel-false-positive.test.ts
 *
 * Triple false-positive defense for sentinel fake values
 * (specs/egress-credential-sentinel.md). Once fake credentials enter the egress
 * fence, `fake_value_<uuid>`-shaped fakes ride along in all three faces: user
 * text, on-screen output, and tool arguments. If any of the three layers
 * (recognize / output-mask / secrets guard) treated a fake as a secret,
 * on-screen diagnosability would be lost (echo $GH_TOKEN masked to ***, the
 * model never sees the fake value). This file is a reverse pin test: it changes
 * zero lines of the three layer sources and only pins "fakes never trigger the three layers".
 *
 * All fixtures are generated fake credentials; host real values / .env* never enter any assertion output.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "vitest";

import {
  DEFAULT_SECRET_PATTERNS,
  recognize,
} from "../../../src/harness/secret-roundtrip/index.js";
import { currentSecretValues } from "../../../src/harness/sandbox/env-isolation.js";
import { createOutputMask } from "../../../src/harness/sandbox/output-mask.js";
import { createSecretsGuardHook } from "../../../src/harness/permission/secrets-guard.js";
import { SentinelRegistry } from "../../../src/harness/sandbox/egress/upstream.js";
// Test-only deep import (the pin covers src/ only; upstream.ts does not re-export this
// pure generator, and this diff must stay test-only — must not extend upstream; precedent: egress-proxy-behavior.test.ts).
import { mintFakeJwt } from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-decode.js";

/**
 * Three fake-value shapes (byte-identical to the minting surface):
 *  a) basic sentinel `fake_value_<uuid4>` (credential-sentinel.js:24-34);
 *  b) JWT-shaped fake (mintFakeJwt: three-segment HS256, payload sub = sentinel identity);
 *  c) length-balanced fake — padded to the real value's byte length when the real
 *     value is longer (same character class as SENTINEL_ALPHABET). Padding uses a
 *     deterministic rotating alphabet (real minting pads randomly; the rotation
 *     sequence contains no substring any builtin pattern requires, avoiding a
 *     0.4%-per-case random flake while staying shape-equivalent).
 */
const PAD_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_-";
function paddedSentinel(realByteLength: number): string {
  const base = `fake_value_${randomUUID()}`;
  let out = base;
  while (Buffer.byteLength(out) < realByteLength) {
    out += PAD_ALPHABET[out.length % PAD_ALPHABET.length];
  }
  return out;
}

/** The fake JWT uses a fixed uuid4 shape: mintFakeJwt's output is fully determined by
 *  the uuid; pinning it avoids million-to-one flakes where a random base64 segment collides with the `sk-`/`xox?` patterns. */
const FIXED_FAKE_UUID = "3f2a9c1e-7b64-4d0a-9e5f-1c2b3d4e5f60";

function fakeFixtures(): string[] {
  return [
    `fake_value_${randomUUID()}`,
    mintFakeJwt(FIXED_FAKE_UUID),
    paddedSentinel(200),
  ];
}

describe("T5① recognize —— 假值零命中（matched=[] 且 replaced 逐字回）", () => {
  it("三类假值单独喂 recognize() → matched=[] 且 replaced === 输入", () => {
    for (const fake of fakeFixtures()) {
      const r = recognize(`echo ${fake}`);
      assert.deepEqual(
        [...r.matched],
        [],
        `matched 非空：${fake.slice(0, 24)}…`
      );
      assert.equal(r.replaced, `echo ${fake}`);
    }
  });

  it("三类假值合并多行喂 recognize()（含 fence env 语境）→ 仍零命中", () => {
    const [a, b, c] = fakeFixtures();
    const text = `GH_TOKEN=${a}\nAuthorization: Bearer ${b}\nbody field: ${c}`;
    const r = recognize(text);
    assert.deepEqual([...r.matched], []);
    assert.equal(r.replaced, text);
  });

  it("patterns SSOT（DEFAULT_SECRET_PATTERNS）对每类假值逐条零命中", () => {
    for (const fake of fakeFixtures()) {
      for (const source of DEFAULT_SECRET_PATTERNS) {
        // Fresh regex, no g-flag side effects; recognize and the guard share exactly this set of source strings.
        assert.equal(
          new RegExp(source).test(fake),
          false,
          `pattern "${source}" 不应命中假值`
        );
      }
    }
  });
});

describe("T5② output-mask —— 假值不进遮蔽集、屏上原样可诊断", () => {
  it("假值 ∉ currentSecretValues(process.env, registry 真值) → createOutputMask 不掩假值", () => {
    const registry = new SentinelRegistry();
    // A generated fake "real value" fixture (not any host credential).
    const realFixture = `gho_FAKEONLY_${randomBytes(12).toString("hex")}`;
    const sentinel = registry.register("GH_TOKEN", realFixture, [
      "github.com",
      "*.github.com",
      "*.githubusercontent.com",
    ]);
    const maskSet = currentSecretValues(
      process.env,
      [...registry.entries()].map(([, real]) => real)
    );
    assert.equal(maskSet.includes(sentinel), false);

    const mask = createOutputMask(maskSet);
    // Output through the mask layer keeps `echo $GH_TOKEN` plus the fake value verbatim (on-screen diagnosability).
    const line = `echo $GH_TOKEN → ${sentinel}`;
    assert.equal(mask.mask(line), line);
    // Positive control: the real value IS in the mask set and does get masked (otherwise this pin would be falsely green).
    assert.ok(!mask.mask(`leak ${realFixture} here`).includes(realFixture));
  });
});

describe("T5③ secrets guard（mode:block）—— 含假值的工具参数不被拦", () => {
  it("三类假值进 bash 工具参数 → hook 放行（undefined）", () => {
    const hook = createSecretsGuardHook();
    for (const fake of fakeFixtures()) {
      const verdict = hook({
        tool: "bash",
        input: { command: `gh pr create --body "token: ${fake}"` },
      });
      assert.equal(
        verdict,
        undefined,
        `假值被 block 档拦截：${fake.slice(0, 24)}…`
      );
    }
  });

  it("阳性对照：ghp_ 形态 fixture 被拦（guard 活着，非空规则假绿）", async () => {
    const hook = createSecretsGuardHook();
    // hooks may be async; the contract requires awaiting before reading the
    // verdict (an un-awaited Promise is always truthy).
    const verdict = await hook({
      tool: "bash",
      input: { command: "export X=ghp_" + "a".repeat(36) },
    });
    assert.ok(verdict && verdict.reason.includes("secret pattern matched"));
  });
});
