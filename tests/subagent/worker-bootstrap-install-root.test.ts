/**
 * T5 (plans/worktree-session-roots.md / ADR-0037 §4) — worker bootstrap 用
 * `installRoot`，裸 task worktree 上不 fatal。
 *
 * 验收（硬要求 6、7）：在**无 `node_modules`、无 `.iknow`** 的目录上以该目录
 * 为 cwd spawn 真 `__subagent_worker__`，stderr 无 `[subagent-worker] fatal`、
 * 无 `scandir` ENOENT、无 `Cannot find package`；不要求操作员先 symlink
 * `node_modules`。
 *
 * 这里真起子进程（LLM 是本机 stub HTTP 服务，形态照 tests/cli/
 * chat-subagent-trace.test.ts），因为被测的正是「bootstrap 解析走哪个根」——
 * 装配层 mock 掉进程边界就把该合同一起 mock 掉了。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

import {
  resolveSubagentWorkerSpawnArgs,
  SubagentWorkerSpawnArgsError,
} from "../../src/harness/subagent/spawn.ts";
import { resolveInstallRoot } from "../../src/harness/session-roots.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntry = join(repoRoot, "src", "cli.ts");

const finalResponse = {
  id: "msg_final",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "worker booted on a naked tree" }],
  model: "test-model",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

let server: Server | undefined;
let child: ChildProcess | undefined;
const scratches: string[] = [];

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child?.once("close", () => resolve()));
  }
  child = undefined;
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  for (const dir of scratches.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}

async function startStubModel(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(finalResponse));
  });
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("T5: subagent worker boots on a naked task worktree", () => {
  it("real worker on a cwd with no node_modules and no .iknow → ok envelope, clean stderr", async () => {
    const nakedRoot = scratch("iknow-t5-naked-tree-");
    const home = scratch("iknow-t5-home-");
    // apiKey / model 只从 user 级 settings 来 —— 裸树上没有项目 settings，
    // 这正是被测形态。
    mkdirSync(join(home, ".iknow"), { recursive: true });
    writeFileSync(
      join(home, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { model: "test-model", apiKey: "sk-test-t5-naked" },
      })
    );
    // 前置断言：树真的是裸的（没有 node_modules，没有 .iknow）。
    assert.equal(existsSync(join(nakedRoot, "node_modules")), false);
    assert.equal(existsSync(join(nakedRoot, ".iknow")), false);

    const baseUrl = await startStubModel();
    // bootstrap 参数走生产解析器 —— tsx loader 锚 installRoot，不锚子进程 cwd。
    const args = resolveSubagentWorkerSpawnArgs({
      execPath: process.execPath,
      argv1: cliEntry,
      installRoot: resolveInstallRoot(),
    });

    child = spawn(process.execPath, args, {
      cwd: nakedRoot,
      env: {
        ...process.env,
        HOME: home,
        IKNOW_LLM_BASE_URL: baseUrl,
        IKNOW_LLM_STREAM: "off",
        IKNOW_LLM_TIMEOUT_MS: "10000",
        IKNOW_LLM_MAX_OUTPUT_TOKENS: "1024",
        IKNOW_PERMISSION_MODE: "full_auto",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => {
      child?.once("close", (code) => resolve(code));
    });
    child.stdin?.end(
      `${JSON.stringify({ task: "say hi", sandboxRoot: nakedRoot })}\n`
    );
    const code = await exited;

    assert.equal(code, 0, `stdout=${stdout} stderr=${stderr}`);
    assert.equal(
      stderr.includes("[subagent-worker] fatal"),
      false,
      `stderr=${stderr}`
    );
    assert.equal(stderr.includes("scandir"), false, `stderr=${stderr}`);
    assert.equal(
      stderr.includes("Cannot find package"),
      false,
      `stderr=${stderr}`
    );
    const envelope = JSON.parse(stdout.trim().split("\n").pop()!) as {
      status: string;
    };
    assert.equal(envelope.status, "ok", stdout);
    // 裸树保持裸：worker 不往树上 seed `.iknow`，也不需要 node_modules。
    assert.equal(existsSync(join(nakedRoot, "node_modules")), false);
  }, 60_000);

  it("resolves the tsx loader from installRoot, and fails closed when that root has no tsx", () => {
    const installRoot = resolveInstallRoot();
    const args = resolveSubagentWorkerSpawnArgs({
      execPath: "/usr/bin/node",
      argv1: cliEntry,
      installRoot,
    });
    assert.equal(args[0], "--import");
    // 解析出的是 iknow 自己安装的 tsx。（不断言路径前缀 = installRoot：dev
    // 里 `node_modules` 常是指向主 checkout 的 symlink，require.resolve 交出
    // realpath。锚是不是 installRoot 由下面的 fail-closed 用例证明。）
    assert.ok(
      args[1]!.includes(join("node_modules", "tsx")),
      `loader ${args[1]} should be the installed tsx`
    );

    // 锚真的是 installRoot：换一个没有 tsx 的根 → typed 失败，不静默回退到
    // 子进程 cwd 解析（那条路正是 `Cannot find package 'tsx'` 的来源）。
    const bareRoot = scratch("iknow-t5-no-tsx-");
    assert.throws(
      () =>
        resolveSubagentWorkerSpawnArgs({
          execPath: "/usr/bin/node",
          argv1: cliEntry,
          installRoot: bareRoot,
        }),
      SubagentWorkerSpawnArgsError
    );
  });

  it("non-TypeScript entries need no loader (bundled install shape)", () => {
    const args = resolveSubagentWorkerSpawnArgs({
      execPath: "/usr/bin/node",
      argv1: "/opt/iknow/dist/cli.js",
      installRoot: resolveInstallRoot(),
    });
    assert.deepEqual(args, ["/opt/iknow/dist/cli.js", "--subagent-worker"]);
  });
});
