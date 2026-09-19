/**
 * tests/harness/secret-roundtrip/sentinel-false-positive.test.ts
 *
 * specs/egress-credential-sentinel.md T5 / invariant 4 / Assumption 14 ——
 * sentinel 假值的三重误报防线（各层一具名钉）。假凭据进围栏后，用户文本、
 * 屏上输出、工具参数三面都会携带 `fake_value_<uuid>` 系假值；三层实现
 * （recognize / output-mask / secrets guard）若把假值当 secret 处理，
 * 「屏上可诊断性」即告失（echo $GH_TOKEN 被掩成 ***，模型看不见假值）。
 * 本文件是反向钉子测试：三层源文件零 diff（Assumption 14），只钉
 * 「假值不被三层触发」。
 *
 * 全部 fixture 为生成假凭据；宿主真值 / .env* 不进任何断言输出。
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
// 测试专用深路径（SC10 只钉 src/；upstream.ts 未 re-export 该纯生成件，
// T5 diff 仅测试文件、不得扩 upstream —— 先例：egress-proxy-behavior.test.ts）。
import { mintFakeJwt } from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-decode.js";

/**
 * 三类假值形态（与铸造面逐字同形）：
 *  a) 基础 sentinel `fake_value_<uuid4>`（credential-sentinel.js:24-34）；
 *  b) JWT 同形假值（mintFakeJwt：三段 HS256，payload sub = sentinel 身份）；
 *  c) 配平长假值 —— 真值更长时 pad 到等字节长（SENTINEL_ALPHABET 同字符类）。
 *     pad 用确定性轮转字母表（真实铸造为随机 pad；轮转序列不含任何
 *     内置模式的必需子串，避免 0.4%/例的随机 flake，形态等价）。
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

/** 假 JWT 用固定 uuid4 形态：mintFakeJwt 输出全由 uuid 决定，钉死避免
 *  base64 段随机撞上 `sk-`/`xox?` 模式的百万分级 flake。 */
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
      assert.deepEqual([...r.matched], [], `matched 非空：${fake.slice(0, 24)}…`);
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
        // g 无副作用新建；与 recognize/守卫共用的就是这一组源串。
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
    // 生成的假「真值」fixture（不是宿主任何真实凭据）。
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
    // echo $GH_TOKEN 经 mask 层输出原样含假值（屏上可诊断性）。
    const line = `echo $GH_TOKEN → ${sentinel}`;
    assert.equal(mask.mask(line), line);
    // 阳性对照：真值在遮蔽集内、会被掩（否则本钉是假绿）。
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

  it("阳性对照：ghp_ 形态 fixture 被拦（guard 活着，非空规则假绿）", () => {
    const hook = createSecretsGuardHook();
    const verdict = hook({
      tool: "bash",
      input: { command: "export X=ghp_" + "a".repeat(36) },
    });
    assert.ok(verdict && verdict.reason.includes("secret pattern matched"));
  });
});
