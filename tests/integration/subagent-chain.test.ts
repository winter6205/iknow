/**
 * #356 T7 — subagent 父子进程链集成测试 (SC2 / SC11 / SC16)。
 *
 * 不真 spawn iknow worker 子进程 (避免依赖真 LLM key — worker 装配 real
 * Anthropic adapter 需要 key)。改为 spawn 一个真 fake 二进制
 * (`process.execPath -e "process.stdout.write(JSON.stringify(...)+'\\n')"`),
 * 由 SubAgentManager 解析其 stdout,验证 queryBuffer 状态收敛到 completed。
 *
 * 注意: fake 脚本必须用 `process.stdout.write` 精确输出 newline-JSON —
 * `console.log(JSON.stringify(...))` 会对 JSON 字符串做 util.inspect,产出
 * 单引号非 JSON 格式,manager 侧 parse 会按 protocolError 处理。
 *
 * 覆盖:
 *   1. fake 二进制 emit 合法 envelope → manager queryBuffer → completed (status:ok)
 *   2. 多行 stdout (首行合法 envelope + 多余行) → 首行 parsed (D1 首条独立 JSON)
 *   3. fake 二进制立即 exit 2 (无 stdout envelope) → manager queryBuffer → crashed
 *   4. exit 0 + 无 envelope → failed protocolError 并释放槽位
 *   5. shutdown 后 buffer 清空 → not_found
 *   6. 非法 envelope (缺 result) → failed reason=protocolError
 *
 * 真 worker 子进程链路 (node <iknow-bin> --subagent-worker) 的 stdout-wire 行为
 * 已由 cli.ts dispatch + worker.test.ts 的 runWorkerOnce 覆盖;本测试专注
 * manager ↔ 子进程 spawn 协议的集成收敛。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";

const OK_ENVELOPE = JSON.stringify({
  status: "ok",
  summary: "fake summary",
  result: "fake result body",
});

/** 生成 node -e 脚本: 精确输出 newline-JSON (避免 console.log 的 util.inspect)。 */
function printJsonScript(json: string): string {
  return `process.stdout.write(${JSON.stringify(json + "\n")})`;
}

/** 等 child exit 完成 (manager 侧 stdout 解析是同步事件,exit 后 buffer 已定)。 */
function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (typeof child.exitCode === "number" || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

describe("subagent-chain: manager ↔ 子进程 spawn 协议集成", () => {
  it("fake 二进制 emit 合法 envelope → queryBuffer completed (status:ok)", async () => {
    const fake = spawn(process.execPath, ["-e", printJsonScript(OK_ENVELOPE)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    await waitExit(fake);
    const q = mgr.queryBuffer(taskId);
    assert.equal(q.status, "ok");
    if (q.status === "ok") {
      assert.equal(q.summary, "fake summary");
      assert.equal(q.result, "fake result body");
    }
    await mgr.shutdown();
  });

  it("多行 stdout → 逐行 parse,最后一条 wins (manager 逐行处理,取最后 envelope)", async () => {
    // manager 的 stdout 解析是逐行 (split on newline,每行 parseParentEnvelope),
    // 每条 envelope 覆盖前一条 → 最后一条 wins (与 manager.test.ts 同语义)。
    const first = JSON.stringify({
      status: "ok",
      summary: "first",
      result: "first body",
    });
    const script = printJsonScript(first) + "; " + printJsonScript(OK_ENVELOPE);
    const fake = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    await waitExit(fake);
    const q = mgr.queryBuffer(taskId);
    assert.equal(q.status, "ok");
    if (q.status === "ok") assert.equal(q.result, "fake result body");
    await mgr.shutdown();
  });

  it("D1 acceptance 3: parseParentEnvelope 只取首条独立 JSON (内嵌 newline)", async () => {
    // envelope.ts 的 parseEnvelope 用 input.split("\n", 1)[0] — 多 newline 的
    // 单条输入只 parse 首行,第二条独立 JSON 被忽略。这是 envelope 层语义,
    // 与 manager 的逐行 stdout 处理互补。
    const { parseParentEnvelope } =
      await import("../../src/harness/subagent/envelope.ts");
    const env = parseParentEnvelope(
      JSON.stringify({ status: "ok", summary: "s", result: "r" }) +
        "\n" +
        '{"status":"ok","summary":"IGNORED","result":"x"}'
    );
    assert.equal(env.status, "ok");
    assert.equal(env.result, "r");
  });

  it("fake 二进制立即 exit 2 (无 stdout envelope) → queryBuffer crashed", async () => {
    const fake = spawn(process.execPath, ["-e", "process.exit(2)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    await waitExit(fake);
    const q = mgr.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /worker exit code=2/);
    }
    await mgr.shutdown();
  });

  it("exit code 0 + 无 envelope → failed protocolError 并释放槽位", async () => {
    const fake = spawn(process.execPath, ["-e", "/* no stdout */"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    await waitExit(fake);
    const q = mgr.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "protocolError");
      assert.match(q.summary, /without envelope/);
    }
    assert.deepEqual(mgr.listActive(), []);
    await mgr.shutdown();
  });

  it("shutdown 后 buffer 清空 → not_found", async () => {
    const fake = spawn(process.execPath, ["-e", printJsonScript(OK_ENVELOPE)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    await waitExit(fake);
    assert.equal(mgr.queryBuffer(taskId).status, "ok");
    await mgr.shutdown();
    assert.deepEqual(mgr.queryBuffer(taskId), { status: "not_found" });
  });

  it("非法 envelope (缺 result) → failed reason=protocolError", async () => {
    const bad = JSON.stringify({ status: "ok", summary: "s" }); // 缺 result
    const fake = spawn(process.execPath, ["-e", printJsonScript(bad)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    await waitExit(fake);
    const q = mgr.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") assert.equal(q.reason, "protocolError");
    await mgr.shutdown();
  });
});
