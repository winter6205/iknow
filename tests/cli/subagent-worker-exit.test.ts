/**
 * ADR-0111 T4 — `iknow __subagent_worker__` 真子进程的 exit-code 语义。
 *
 * 观测手段 = 真实 CLI 子进程（tsx 启动，同 tests/cli/llm-provider-error.test.ts
 * 的结论：cli.ts 顶层自跑 main()，catch 分流的承重面只有黑盒可证）。
 *
 * 钉住的不变式（ADR-0111 不变式 (b)，成文化 assumption 16 / SC13）：
 *   1. exit 2 = **仅**信封协议错误（stdin JSON parse 失败 / WorkerEnvelope
 *      字段缺失 → 无信封可写）→ stderr `[subagent-worker] fatal`；
 *   2. parse 之后的 run 阶段逃逸（本例：loadIknowEnv 抛 typed plain object）
 *      → best-effort failed envelope 写 stdout + exit 1，**不再冒用 2**，
 *      stderr 无 `[subagent-worker] fatal` 误报。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 与 tests/cli/llm-provider-error.test.ts 同款 tsx 定位（worktree node_modules）。 */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续向上
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();

const UNSET_KEY = "IKNOW_T4_PROCESS_UNSET_KEY";

let scratch: string;
let home: string;
let sandboxRoot: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-worker-exit-"));
  home = join(scratch, "home");
  sandboxRoot = join(scratch, "task");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(sandboxRoot, { recursive: true });
  mkdirSync(join(scratch, "cwd"), { recursive: true });
  // provider `acme` 的 apiKeyEnv 显式不设 → 合法信封 parse 之后 loadIknowEnv
  // 必抛（run 阶段逃逸面）。信封协议错误路径在 settings 之前抛出，两态互不干扰。
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify({
      llm: {
        model: "acme/foo",
        providers: [
          {
            id: "acme",
            baseUrl: "http://127.0.0.1:41999/v1",
            apiKeyEnv: UNSET_KEY,
            models: [{ id: "foo" }],
          },
        ],
      },
    })
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** 跑一次真 worker 子进程：stdin 喂一行文本，收 stdout/stderr/exit code。 */
function runWorkerProcess(
  stdinLine: string
): Promise<{ code: number | null; out: string; err: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete childEnv[UNSET_KEY];
  const child = spawn(
    process.execPath,
    [tsxCli, join(repoRoot, "src", "cli.ts"), "--subagent-worker"],
    {
      cwd: join(scratch, "cwd"),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  child.stdin.write(stdinLine);
  child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", () => resolve({ code: null, out, err }));
  });
}

describe("iknow --subagent-worker exit-code 语义（ADR-0111 不变式 (b)）", () => {
  it("stdin 非法 JSON → 仍 exit 2 + [subagent-worker] fatal + stdout 无信封（SC13 回归护栏）", async () => {
    const { code, out, err } = await runWorkerProcess("not-json\n");
    assert.equal(code, 2, `expected exit 2, stderr=${err}`);
    assert.match(err, /\[subagent-worker\] fatal/);
    assert.equal(out.trim(), "", `stdout must stay envelope-only; got=${out}`);
  }, 90_000);

  it("信封缺必填 task → 仍 exit 2（WorkerEnvelope 字段缺失 = 协议层崩溃）", async () => {
    const { code, err } = await runWorkerProcess(
      JSON.stringify({ sandboxRoot }) + "\n"
    );
    assert.equal(code, 2, `expected exit 2, stderr=${err}`);
    assert.match(err, /\[subagent-worker\] fatal/);
  }, 90_000);

  it("合法信封 + run 阶段装配逃逸 → exit 1 + stdout best-effort failed envelope（reason=crashed）+ stderr 无 fatal 误报", async () => {
    const { code, out, err } = await runWorkerProcess(
      JSON.stringify({ task: "any", sandboxRoot }) + "\n"
    );
    assert.equal(code, 1, `expected exit 1, stderr=${err}, stdout=${out}`);
    const envelope = JSON.parse(out.trim()) as {
      status: string;
      reason?: string;
      summary: string;
    };
    assert.equal(envelope.status, "failed");
    assert.equal(envelope.reason, "crashed");
    // typed plain-object 逃逸按字段渲染（不塌缩 [object Object]），exit 2 专码归还。
    assert.equal(envelope.summary.includes("[object Object]"), false);
    assert.match(envelope.summary, /acme/);
    assert.equal(
      err.includes("[subagent-worker] fatal"),
      false,
      `run-phase escape must not reuse fatal; stderr=${err}`
    );
  }, 90_000);
});
