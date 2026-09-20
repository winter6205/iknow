/**
 * SubAgentManager parent↔child process chain integration test.
 *
 * Does not spawn a real iknow worker (that would need a real LLM key — worker
 * assembly wires a real Anthropic adapter). Instead it spawns a real fake
 * binary (`process.execPath -e "process.stdout.write(JSON.stringify(...)+'\\n')"`),
 * lets SubAgentManager parse its stdout and verifies queryBuffer converges to
 * completed.
 *
 * Note: the fake script must emit newline-JSON via `process.stdout.write` —
 * `console.log(JSON.stringify(...))` runs util.inspect on the string, producing
 * single-quoted non-JSON that the manager side treats as protocolError.
 *
 * Covers:
 *   1. fake binary emits a valid envelope → manager queryBuffer → completed (status:ok)
 *   2. multi-line stdout (valid first envelope + extra lines) → first line parsed (D1: first standalone JSON)
 *   3. fake binary exits 2 immediately (no stdout envelope) → manager queryBuffer → crashed
 *   4. exit 0 + no envelope → failed protocolError, slot released
 *   5. buffer cleared after shutdown → not_found
 *   6. invalid envelope (missing result) → failed reason=protocolError
 *   7. stream-break e2e: failed(modelTransient)+transcript → real continue gate
 *      admits → second stub succeeds → parent sees completed
 *
 * The real worker chain (node <iknow-bin> --subagent-worker) stdout-wire
 * behavior is covered by cli.ts dispatch + runWorkerOnce in worker.test.ts;
 * this test focuses on manager ↔ spawn-protocol convergence.
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

/** node -e script that emits newline-JSON exactly (avoids console.log's util.inspect). */
function printJsonScript(json: string): string {
  return `process.stdout.write(${JSON.stringify(json + "\n")})`;
}

/** Wait for child exit (manager-side stdout parsing is synchronous, so the buffer is settled once exited). */
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
    // The manager parses stdout line by line (split on newline, each line through
    // parseParentEnvelope); each envelope overwrites the previous one → last wins
    // (same semantics as manager.test.ts).
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
    // parseEnvelope in envelope.ts uses input.split("\n", 1)[0] — a single input
    // with multiple newlines parses only the first line; a second standalone
    // JSON is ignored. That is envelope-layer semantics, complementary to the
    // manager's line-by-line stdout handling.
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
      // ADR-0071 per-agent layout: once subagentsDir is injected into the
      // manager, lifecycle / content trace lands in
      // `<subagentsDir>/agent-<taskId>.jsonl` (replacing the
      // `<traceOut>/subagent.jsonl` aggregate single file; the
      // conversationId:"subagent" fake scope is retired).
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
    const bad = JSON.stringify({ status: "ok", summary: "s" }); // missing result
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

  // The whole chain uses the real manager + the real ADR-0102 continue gate +
  // real subprocesses; the gate is not mocked. stub-1 = the transient-failure worker (appends
  // the worker transcript while running, then emits failed(modelTransient) +
  // exit 0, i.e. upstream-transient and resumable); stub-2 = the resumed run succeeding.
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
          // Stream-break stub: read the stdin payload → per ADR-0102 Decision 3
          // persist the worker transcript (append) → emit the failed(modelTransient)
          // envelope. No process.exit: natural exit keeps stdout flushed (fake precedent in this file).
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
        // Resume stub: succeeds (truth of transcript-head loading is certified by worker-side tests).
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
      // The worker's ledger is truly written by stub-1 — the gate's existence check reads the real file.
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
      // Parent-visible surface = projectParentVisibleEnvelope's short handoff (summary-derived handoff).
      assert.match(resumed.result, /resumed done/);
    } finally {
      await mgr.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
