import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";
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

// ── #503 T11:network 分支的 secret 处理路径 ─────────────────────────────────
// 网络:true 只动 fence 形状(去 --unshare-net),env 半区行为必须与默认分支
// 逐字节一致 —— host 侧 secret 命中的环境变量在任何分支下都不进入 fence argv。
// 这是 sandbox 层在 T11 闭环新增的纵深防御:即使共享宿主 netns,secret env
// 仍由 createEnvIsolation.filter 截断后才进 createBwrapFence。
//
// T3 闭世界适配:合同根(taskRoot/tmp)盘上校验 → fixtures 用真实目录
// (mkdtemp),不再用不存在的 "/workspace" + "/tmp/job" 假路径。
const FIXTURE_CWD = mkdtempSync(join(tmpdir(), "secrets-no-leak-cwd-"));

afterAll(() => {
  rmSync(FIXTURE_CWD, { recursive: true, force: true });
});

describe("sandbox network:true secret env half", () => {
  function buildArgv(network: boolean): readonly string[] {
    // 模拟 bash.ts 装配期的环境:bwrap fence 接收的 env 是经 envIsolation.filter
    // 截断过的 process.env。注入一个 SECRET_PATTERN 形态的环境变量,断言它
    // 不会出现在 --setenv 列表里(network:true 与默认分支一致)。
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
      "env-isolation must strip SECRET_PATTERN hits regardless of network axis"
    );
    return createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({
        cwd: FIXTURE_CWD,
        home: homedir(),
        tmpDir: tmpdir(),
      }),
      networkPolicy: createNetworkPolicy(),
      resourceLimits: createResourceLimits(),
      env: filtered,
      cwd: FIXTURE_CWD,
      network,
    }).argv;
  }

  it("network:true 分支 argv 不含 secret env 名/值,与默认分支的 setenv 列表逐字节一致", () => {
    const argvDefault = buildArgv(false);
    const argvNet = buildArgv(true);
    // network:true 已确认去 unshare-net;其余 fence 旗标保持。
    assert.equal(argvNet.includes("--unshare-net"), false);
    assert.equal(argvDefault.includes("--unshare-net"), true);
    // secret env 名/值都不在 argv 里(network 半区不引入新环境通道)。
    const flat = argvNet.join("\n");
    assert.equal(
      flat.includes("SANDBOX_NET_SECRET_KEY"),
      false,
      "network:true fence must not smuggle secret var name"
    );
    assert.equal(
      flat.includes("sk-test-not-real-12345"),
      false,
      "network:true fence must not smuggle secret var value"
    );
    // --setenv 列表(network 分支 vs 默认)逐字节一致 —— 只有 --unshare-net
    // 一项差异;env 半区零变化。
    const setEnvList = (a: readonly string[]): string[] => {
      const list: string[] = [];
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] === "--setenv" && i + 2 < a.length) {
          list.push(`${a[i + 1]}=${a[i + 2]}`);
        }
      }
      return list;
    };
    assert.deepEqual(setEnvList(argvNet), setEnvList(argvDefault));
  });
});
