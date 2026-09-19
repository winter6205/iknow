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
 *   7. (plan T5) 断流 e2e: failed(modelTransient)+transcript → 真闸放行
 *      continue → 第二 stub 成功 → 父侧 completed
 *
 * 真 worker 子进程链路 (node <iknow-bin> --subagent-worker) 的 stdout-wire 行为
 * 已由 cli.ts dispatch + worker.test.ts 的 runWorkerOnce 覆盖;本测试专注
 * manager ↔ 子进程 spawn 协议的集成收敛。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workerStderrPath } from "../../src/harness/sandbox/fence-tmp.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createSubAgentContinueTool } from "../../src/harness/subagent/subagent-continue-tool.ts";
import {
  clearActiveExtraSecrets,
  setActiveExtraSecrets,
} from "../../src/harness/sandbox/env-isolation.ts";

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

  it("fake 二进制 emit failed envelope reason=modelTransient + exit 0 → queryBuffer failed reason=modelTransient (ADR-0111 第五值透传)", async () => {
    const failed = JSON.stringify({
      status: "failed",
      reason: "modelTransient",
      summary: "model stream transient",
      result: "",
      stop_reason: "protocolError",
    });
    const fake = spawn(process.execPath, ["-e", printJsonScript(failed)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    await waitExit(fake);
    const q = mgr.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "modelTransient");
      assert.equal(q.summary, "model stream transient");
    }
    await mgr.shutdown();
  });

  it("fake 二进制立即 exit 2 (无 stdout envelope) → queryBuffer crashed", async () => {
    const fake = spawn(process.execPath, ["-e", "process.exit(2)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    const q = await mgr.waitFor(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /worker exit code=2/);
    }
    await mgr.shutdown();
  });

  it("fake 二进制 stderr + exit 2 → crashed summary 携带 stderr", async () => {
    const fake = spawn(
      process.execPath,
      ["-e", "process.stderr.write('boom\\n'); process.exit(2)"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const mgr = createSubAgentManager({ spawn: () => fake });
    const { taskId } = mgr.spawn({});
    const q = await mgr.waitFor(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /worker exit code=2 signal=null/);
      assert.match(q.summary, /boom/);
    }
    await mgr.shutdown();
  });

  it("crash diagnostics writes a masked stderr pointer for a real OS pipe", async () => {
    const diagnosticsDir = mkdtempSync(
      join(tmpdir(), "iknow-subagent-diagnostics-")
    );
    const secret = "T2_FAKE_SECRET_9f8e7d6c";
    setActiveExtraSecrets([secret]);
    try {
      // T5 (ADR-0071 / SC8 + L2): per-agent 形态 ——
      // subagentsDir 注入 manager 后, lifecycle / content trace 落
      // `<subagentsDir>/agent-<taskId>.jsonl`(取代 `<traceOut>/subagent.jsonl`
      // 聚合单文件, conversationId:"subagent" 假 scope 已退役)。
      const subagentsDir = join(diagnosticsDir, "subagents");
      const fake = spawn(
        process.execPath,
        [
          "-e",
          `process.stderr.write(${JSON.stringify(
            `boom-diagnostic ${secret}\n`
          )}); process.exit(2)`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const mgr = createSubAgentManager({
        spawn: () => fake,
        diagnosticsDir: subagentsDir,
        subagentsDir,
      });
      const { taskId } = mgr.spawn({});
      await waitExit(fake);
      await new Promise((resolve) => setImmediate(resolve));

      const q = mgr.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.match(q.summary, /boom-diagnostic/);
        assert.doesNotMatch(q.summary, new RegExp(secret));
      }
      const stderrPath = workerStderrPath(subagentsDir, taskId);
      assert.equal(existsSync(stderrPath), true);
      const stderrLog = readFileSync(stderrPath, "utf8");
      assert.match(stderrLog, /boom-diagnostic/);
      assert.doesNotMatch(stderrLog, new RegExp(secret));
      await new Promise((resolve) => setImmediate(resolve));
      const records = readFileSync(
        join(subagentsDir, taskId, `agent-${taskId}.jsonl`),
        "utf8"
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const stop = records.find(
        (record) => record.record_type === "subagent_stop"
      );
      assert.equal(stop?.stderr_path, stderrPath);
      assert.equal(typeof stop?.stderr_bytes, "number");
      await mgr.shutdown();
    } finally {
      clearActiveExtraSecrets();
      rmSync(diagnosticsDir, { recursive: true, force: true });
    }
  });

  it("caps each crash log at 1MiB and isolates concurrent task IDs", async () => {
    const diagnosticsDir = mkdtempSync(
      join(tmpdir(), "iknow-subagent-diagnostics-cap-")
    );
    const children: ChildProcess[] = [];
    try {
      const mgr = createSubAgentManager({
        spawn: (_def, taskId) => {
          const child = spawn(
            process.execPath,
            [
              "-e",
              `process.stderr.write(${JSON.stringify(
                `${taskId} `
              )} + 'x'.repeat(1024 * 1024 + 128) + '\\n'); process.exit(2)`,
            ],
            { stdio: ["pipe", "pipe", "pipe"] }
          );
          children.push(child);
          return child;
        },
        diagnosticsDir,
      });
      const first = mgr.spawn({});
      const second = mgr.spawn({});
      await Promise.all(children.map(waitExit));
      for (let attempt = 0; attempt < 100; attempt++) {
        const firstPath = workerStderrPath(diagnosticsDir, first.taskId);
        const secondPath = workerStderrPath(diagnosticsDir, second.taskId);
        if (existsSync(firstPath) && existsSync(secondPath)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      for (const taskId of [first.taskId, second.taskId]) {
        const path = workerStderrPath(diagnosticsDir, taskId);
        assert.equal(existsSync(path), true, `missing diagnostics log ${path}`);
        assert.ok(statSync(path).size <= 1024 * 1024);
        assert.match(readFileSync(path, "utf8"), new RegExp(taskId));
      }
      assert.notEqual(first.taskId, second.taskId);
      assert.notEqual(
        readFileSync(workerStderrPath(diagnosticsDir, first.taskId), "utf8"),
        readFileSync(workerStderrPath(diagnosticsDir, second.taskId), "utf8")
      );
      await mgr.shutdown();
    } finally {
      rmSync(diagnosticsDir, { recursive: true, force: true });
    }
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

  // plan T5 demo:整链走真实 manager + 真实 ADR-0102 续跑闸 + 真实子进程,
  // 不 mock 闸。stub-1 = T4 产物 (边跑边 append 工人 transcript → 交
  // failed(modelTransient) 信封 + exit 0, 上游瞬时可续);stub-2 = 续跑成功。
  it("断流 e2e:modelTransient+transcript → 闸放行 continue → 第二 stub 成功 → 父侧 completed", async () => {
    const root = mkdtempSync(join(tmpdir(), "iknow-transient-e2e-"));
    const subagentsDir = join(root, "subagents");
    const transientEnvelope = JSON.stringify({
      status: "failed",
      reason: "modelTransient",
      summary: "",
      result: "",
    });
    const okEnv = JSON.stringify({
      status: "ok",
      summary: "resumed done",
      result: "resumed answer",
    });
    let launches = 0;
    const mgr = createSubAgentManager({
      subagentsDir,
      spawn: (_def, _taskId) => {
        launches += 1;
        if (launches === 1) {
          // 断流 stub:收 stdin payload → 按 ADR-0102 Decision 3 落工人
          // transcript(append) → 发射 T4 的 failed(modelTransient) 信封。
          // 不调 process.exit:自然退出保 stdout flush (本文件 fake 先例)。
          const script =
            `let d="";` +
            `process.stdin.on("data",(c)=>{d+=c});` +
            `process.stdin.on("end",()=>{` +
            `const p=JSON.parse(d);const fs=require("fs");const path=require("path");` +
            `fs.mkdirSync(path.dirname(p.transcriptPath),{recursive:true});` +
            `fs.appendFileSync(p.transcriptPath,JSON.stringify({type:"message",role:"user",text:p.task})+"\\n");` +
            `process.stdout.write(${JSON.stringify(transientEnvelope + "\n")});` +
            `});`;
          return spawn(process.execPath, ["-e", script], {
            stdio: ["pipe", "pipe", "pipe"],
          });
        }
        // 续跑 stub:成功交差 (transcript head 加载真值由 worker 侧测试认证)。
        return spawn(process.execPath, ["-e", printJsonScript(okEnv)], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    const tool = createSubAgentContinueTool({ manager: mgr });
    try {
      const { taskId } = mgr.spawn({
        task: "work interrupted by upstream",
        conversationId: "c1",
      });
      const first = await mgr.waitFor(taskId, 10000);
      assert.equal(first.status, "failed");
      if (first.status === "failed") {
        assert.equal(first.reason, "modelTransient");
      }
      // 工人账由 stub-1 真实落盘 —— 闸的存在性判据吃真文件。
      assert.equal(
        existsSync(join(subagentsDir, taskId, `${taskId}.jsonl`)),
        true
      );

      const resumed = (await tool.handler(
        { task_id: taskId, message: "carry on after the blip" },
        { conversationId: "c1" }
      )) as { status: string; result: string };
      assert.equal(launches, 2);
      assert.equal(resumed.status, "ok");
      // 父可见面 = projectParentVisibleEnvelope 短交差 (summary 派生 handoff)。
      assert.match(resumed.result, /resumed done/);
    } finally {
      await mgr.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
