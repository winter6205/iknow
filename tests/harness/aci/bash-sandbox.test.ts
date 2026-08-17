/**
 * bash sandbox 物理/逻辑双轨测试（T4 配套回归）。
 *
 * 覆盖：
 *   - bash.timeout.partialOutput   real spawn，验证 cancellation 命中后
 *                                    partial stdout 不被丢弃（SC13）。
 *   - bash.bwrap.argvHasUnshareNet  纯逻辑，构造 fence argv 并断言关键旗标。
 *   - bash.missingBwrap.failLoud    bwrap 不在 PATH 时 fail-loud。
 *
 * 守护：hasBwrap() 守卫在没有 bwrap 的 CI 环境 skip 真实 spawn 测试，
 * argv 纯逻辑测试不受影响。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { waitForPidFile } from "./tools/spawn-test-utils.ts";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.ts";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.ts";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.ts";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

describe("bash.bwrap.argvHasUnshareNet", () => {
  it("argv contains the canonical fence flags (no spawn)", () => {
    const cwd = "/workspace";
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({
        cwd,
        home: homedir(),
        tmpDir: "/tmp/job",
      }),
      networkPolicy: createNetworkPolicy(),
      resourceLimits: createResourceLimits(),
      env: { PATH: "/bin" },
      cwd,
    }).argv;

    assert.equal(argv[0], "bwrap");
    assert.ok(argv.includes("--unshare-net"));
    // --ro-bind /etc /etc (三个连续 argv 项)
    const etcIdx = argv.indexOf("/etc");
    assert.notEqual(etcIdx, -1);
    assert.deepEqual(argv.slice(etcIdx - 1, etcIdx + 2), [
      "--ro-bind",
      "/etc",
      "/etc",
    ]);
    // --bind <cwd> <cwd> 出现一次以上
    const bindCwdIdx = argv.findIndex(
      (arg, index) => arg === "--bind" && argv[index + 1] === cwd
    );
    assert.notEqual(bindCwdIdx, -1, "expected --bind <cwd> <cwd> in argv");
    assert.equal(argv[bindCwdIdx + 2], cwd);
    // --size <N> --tmpfs /tmp（连续三项）。
    // 注意：sensitive-path overlay 会先插入若干 --tmpfs <HOME>/.xxx，
    // 所以从 bindCwdIdx 之后找第一个 --tmpfs,前面两项必是 --size <N>。
    const tmpfsIdx = argv.indexOf("--tmpfs", bindCwdIdx);
    assert.notEqual(tmpfsIdx, -1);
    // 注意：sensitive-path overlay 会先插入若干 --tmpfs <HOME>/.xxx，
    // 所以要从 argv 后段再确认是 /tmp（而非 .ssh / .aws / ...）。
    // 在 --tmpfs 后移找到第一个 --tmpfs 后跟 /tmp 的位置。
    let realTmpfsIdx = -1;
    for (let i = tmpfsIdx; i < argv.length; i++) {
      if (argv[i] === "--tmpfs" && argv[i + 1] === "/tmp") {
        realTmpfsIdx = i;
        break;
      }
    }
    assert.notEqual(realTmpfsIdx, -1, "expected --tmpfs /tmp in argv");
    assert.equal(argv[realTmpfsIdx - 2], "--size");
    assert.equal(argv[realTmpfsIdx + 1], "/tmp");
    // --tmpfs <HOME>/.ssh（敏感路径 overlay）
    assert.ok(
      argv.includes(`${homedir()}/.ssh`),
      "expected --tmpfs <HOME>/.ssh in argv"
    );
    const sshIdx = argv.indexOf(`${homedir()}/.ssh`);
    assert.equal(argv[sshIdx - 1], "--tmpfs");
    // --clearenv precedes every --setenv so the fence inherits only the
    // whitelisted entries, never the host env (#225).
    const clearenvIdx = argv.indexOf("--clearenv");
    assert.notEqual(clearenvIdx, -1, "expected --clearenv in argv");
    const setenvIdxs = argv
      .map((a, i) => (a === "--setenv" ? i : -1))
      .filter((i) => i !== -1);
    for (const i of setenvIdxs) {
      assert.ok(
        clearenvIdx < i,
        `--clearenv (${clearenvIdx}) must precede --setenv (${i})`
      );
    }
  });
});

describe("bash.missingBwrap.failLoud", () => {
  it("createBashTool throws with 'bwrap' in the message when bwrap is not on PATH", () => {
    // 直接修改 PATH 让 bwrap 找不到(createBashTool 内的 requireBwrap 用
    // spawnSync("bwrap", ["--version"]) 探测,继承 process.env.PATH)。
    const savedPath = process.env.PATH;
    const fakeEmptyDir = "/tmp/iknow-no-bwrap-" + String(Date.now());
    process.env.PATH = fakeEmptyDir;
    try {
      // sanity:在 fake PATH 下 bwrap 应找不到
      const probe = spawnSync("bwrap", ["--version"], {
        stdio: "ignore",
        env: { ...process.env, PATH: fakeEmptyDir },
      });
      if (probe.status === 0) {
        // fake PATH 居然还能找到 bwrap — 跳过
        return;
      }
      assert.throws(
        () => createBashTool("/tmp"),
        (error: unknown) =>
          error instanceof Error && error.message.includes("bwrap")
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("bash.timeout.partialOutput", () => {
  it.skipIf(!hasBwrap())(
    "abort mid-run preserves partial stdout (SC13)",
    async () => {
      const cwd = await makeScratch("bash-partial-");
      const tool = createBashTool(cwd);
      // 写脚本到 cwd 再 `node <file>` — "node" 在 allowlist;脚本内容
      // 不进 bash 解析,完全规避 shell metachar(`;` / `(` / `|`)。
      // fixture 用 fs.writeSync 直写 fd 1(绕过 Node piped stdout 的 libuv
      // 用户态缓冲)+ marker 屏障:先等 fixture 把行写出并落 marker,再 abort,
      // 消除"console.log 缓冲未 flush 就随 SIGTERM 丢失"的时序 flake。
      await writeFile(
        join(cwd, "echo-loop.cjs"),
        [
          'const fs = require("node:fs");',
          "for (let i = 1; i <= 20; i++) {",
          "  fs.writeSync(1, 'line ' + i + '\\n');",
          "}",
          `fs.writeFileSync(${JSON.stringify(join(cwd, "started"))}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      const controller = new AbortController();
      const execution = tool.handler(
        { command: "node echo-loop.cjs" },
        { signal: controller.signal }
      );
      await waitForPidFile(join(cwd, "started"));
      controller.abort();
      const result = (await execution) as {
        code: number;
        stdout: string;
        stderr: string;
      };
      assert.ok(
        typeof result.stdout === "string",
        `expected stdout string, got: ${String(result.stdout)}`
      );
      assert.ok(
        result.stdout.length > 0,
        `expected non-empty partial stdout, got: ${JSON.stringify(result.stdout)}`
      );
      assert.match(result.stdout, /line \d+/);
    },
    5_000
  );

  it.skipIf(!hasBwrap())(
    "abort before any output yields empty stdout (no phantom content)",
    async () => {
      const cwd = await makeScratch("bash-empty-");
      const pidFile = join(cwd, "child.pid");
      await writeFile(
        join(cwd, "sleep-script.cjs"),
        [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          'const child = spawn("sleep", ["30"], { stdio: "ignore" });',
          'writeFileSync("child.pid", String(child.pid));',
          'child.once("exit", () => process.exit(0));',
          "setInterval(() => {}, 1000);",
        ].join("\n")
      );
      const controller = new AbortController();
      const tool = createBashTool(cwd);
      const execution = tool.handler(
        { command: "node sleep-script.cjs" },
        { signal: controller.signal }
      );
      await waitForPidFile(pidFile);
      controller.abort();
      const result = (await execution) as {
        code: number;
        stdout: string;
        stderr: string;
      };
      assert.equal(result.stdout, "");
    },
    5_000
  );
});

describe("bash.fence.networkOptIn (argv shape, no spawn)", () => {
  // T9: network:true drops --unshare-net; every other fence flag stays.
  // Written at the fence-construction layer (createBwrapFence direct call)
  // because the bash tool's inputSchema network param lands in T10 — this
  // ticket owns only the bwrap argv branch, not the bash.ts schema.
  function fenceArgv(network?: boolean): string[] {
    const cwd = "/workspace";
    const opts: {
      command: string;
      args: string[];
      fsPolicy: ReturnType<typeof createFsPolicy>;
      networkPolicy: ReturnType<typeof createNetworkPolicy>;
      resourceLimits: ReturnType<typeof createResourceLimits>;
      env: NodeJS.ProcessEnv;
      cwd: string;
      network?: boolean;
    } = {
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({ cwd, home: homedir(), tmpDir: "/tmp/job" }),
      networkPolicy: createNetworkPolicy(),
      resourceLimits: createResourceLimits(),
      env: { PATH: "/bin" },
      cwd,
    };
    if (network !== undefined) {
      opts.network = network;
    }
    return createBwrapFence(opts).argv;
  }

  it("network:true removes --unshare-net but keeps every canonical fence flag", () => {
    const cwd = "/workspace";
    const argv = fenceArgv(true);
    assert.equal(argv.includes("--unshare-net"), false);
    // canonical fence flags spot-check (mirrors argvHasUnshareNet style)
    assert.equal(argv[0], "bwrap");
    assert.equal(argv[1], "--unshare-user-try");
    assert.ok(argv.includes("--die-with-parent"));
    const etcIdx = argv.indexOf("/etc");
    assert.deepEqual(argv.slice(etcIdx - 1, etcIdx + 2), [
      "--ro-bind",
      "/etc",
      "/etc",
    ]);
    const bindCwdIdx = argv.findIndex(
      (arg, index) => arg === "--bind" && argv[index + 1] === cwd
    );
    assert.notEqual(bindCwdIdx, -1, "expected --bind <cwd> <cwd> in argv");
    assert.ok(argv.includes("--clearenv"));
    assert.ok(argv.includes("--chdir"));
    assert.deepEqual(argv.slice(argv.indexOf("--"), argv.indexOf("--") + 3), [
      "--",
      "bash",
      "-c",
    ]);
  });

  it("network:false and absent network keep --unshare-net (default isolation)", () => {
    assert.ok(fenceArgv(false).includes("--unshare-net"));
    assert.ok(fenceArgv().includes("--unshare-net"));
  });
});
