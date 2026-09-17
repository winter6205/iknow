import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import {
  BASE_ENV_WHITELIST,
  createEnvIsolation,
} from "../../../src/harness/sandbox/env-isolation.js";

function readSandboxSource(): string {
  return readdirSync("src/harness/sandbox")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join("src/harness/sandbox", name), "utf8"))
    .join("\n");
}

describe("sandbox secret literal guard", () => {
  it("does not hardcode the canonical LLM key name", () => {
    assert.equal(readSandboxSource().includes("ANTHROPIC_AUTH_TOKEN"), false);
  });
});

// ── ADR-0097:fence secret env 半区不依赖网络轴 ─────────────────────────────
// 网络轴在 fence 层已整体退场(`--unshare-net` 恒在);secret env 处理路径
// 与默认分支恒字节一致(envIsolation.filter 截断 host 侧命中,任何 fence 选项
// 都不再引入新通道)。本 suite 留作回归:任何「fence 形态变化都可能引入
// env 通道」的回归被它捕获。
//
// T3 闭世界适配:合同根(taskRoot/tmp)盘上校验 → fixtures 用真实目录
// (mkdtemp),不再用不存在的 "/workspace" + "/tmp/job" 假路径。
const FIXTURE_CWD = mkdtempSync(join(tmpdir(), "secrets-no-leak-cwd-"));

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
});

describe("sandbox secret env path (network axis retired)", () => {
  function buildArgv(): readonly string[] {
    // 模拟 bash.ts 装配期的环境:bwrap fence 接收的 env 是经 envIsolation.filter
    // 截断过的 process.env。注入一个 SECRET_PATTERN 形态的环境变量,断言它
    // 不会出现在 --setenv 列表里。
    const rawEnv = {
      PATH: "/bin",
      HOME: homedir(),
      SANDBOX_NET_SECRET_KEY: "sk-test-not-real-12345",
    };
    const filtered = createEnvIsolation({
      allowEnv: BASE_ENV_WHITELIST,
    }).filter(rawEnv);
    assert.equal(
      filtered.SANDBOX_NET_SECRET_KEY,
      undefined,
      "env-isolation must strip SECRET_PATTERN hits"
    );
    return createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({
        tmpDir: tmpdir(),
      }),
      env: filtered,
      cwd: FIXTURE_CWD,
    }).argv;
  }

  it("fence argv 不含 secret env 名/值,且 --unshare-net 恒在", () => {
    const argv = buildArgv();
    // 网络轴恒断:secret env 半区与 netns 形状互不依赖(ADR-0097 SC1)。
    assert.equal(
      argv.includes("--unshare-net"),
      true,
      "--unshare-net is constant (spec SC1)"
    );
    // secret env 名/值都不在 argv 里
    const flat = argv.join("\n");
    assert.equal(
      flat.includes("SANDBOX_NET_SECRET_KEY"),
      false,
      "fence must not smuggle secret var name"
    );
    assert.equal(
      flat.includes("sk-test-not-real-12345"),
      false,
      "fence must not smuggle secret var value"
    );
  });
});
