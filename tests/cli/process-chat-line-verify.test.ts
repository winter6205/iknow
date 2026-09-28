/**
 * processChatLine wiring test for the verify-loop assembly.
 *
 * Fully real assembly chain, no test seams:
 *   - real VerifyConfig (command points at a script inside cwd);
 *   - runVerifyLoop's default runVerify = runInSandbox + bwrap (real sandbox
 *     execution, canRunSandbox capability probe, same discipline as the
 *     verify-loop tests);
 *   - runFn goes through processChatLine into the real runHarness (stub model).
 *
 * Proof that the closed loop activated = the verification command **really ran**:
 * the script writes a marker file into cwd and the case asserts the marker
 * exists (without verifyConfig the marker is absent → the original path runs
 * no verification, byte-for-byte unchanged).
 *
 * Coverage:
 *   1. verifyConfig absent → original runHarness path: completed result +
 *      append-only history + verification command NOT executed (marker absent);
 *   2. verifyConfig set + verify exit 0 → loop activated (marker exists) +
 *      single-turn pass, answer text preserved;
 *   3. verifyConfig set + verify really fails → failure envelope injected
 *      (user message has [VALIDATION FAILED] + attempt/command/exit_code/signature);
 *   4. verifyConfig set + verify always fails (same-signature stall) → loop
 *      stops, no completion.
 *
 * The verification script writes into an isolated tmpdir (runVerifyLoop cwd =
 * process.cwd()); the script is executable (chmod 755) and depends on /bin/sh
 * (bwrap read-binds /bin). HOME unset → the sandbox binds the default
 * homedir() (matching production).
 *
 * Never touches the real ~/.iknow or the project workspace (command reads/writes only inside cwd).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";

/**
 * Physical-sandbox capability probe. `hasBwrap()` (binary presence) is not the
 * right gate here: on a GitHub Actions runner bwrap is installed, so the binary
 * check passes, but the container disallows user-namespace network isolation, so
 * `createBwrapFence`'s constant `--unshare-net` fails at spawn (RTM_NEWADDR:
 * Operation not permitted) → the default runVerify throws → the loop never
 * executes the check. The gate must therefore test execution, not mere presence:
 * run the same `--unshare-net` spawn the default runVerify performs and require
 * exit 0. True only on a host that can actually build the fence (local WSL).
 */
function canRunSandbox(): boolean {
  const r = spawnSync(
    "bwrap",
    [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-net",
      "--",
      "/bin/true",
    ],
    { stdio: "ignore" }
  );
  return r.status === 0;
}

// -- isolated workdir (cwd for the closed loop's sandbox) ---------------------
const prevCwd = process.cwd();

/**
 * Content-gate signal for the stub turns: an attempted `npm test` bash call.
 * The tool is unregistered in this harness (registry = noop), so the executor
 * records tool_not_found — the transcript still proves a test command ran,
 * which opens the upstream verify gate (a text-only turn is gated out and the
 * verify command never executes).
 */
const gateTestCall = (id: string) => ({
  id,
  name: "bash",
  input: { command: "npm test" },
});
const gateTurn = (id: string) =>
  assistantResult({
    texts: ["ran the suite"],
    toolCalls: [gateTestCall(id)],
  });
let workDir: string;
/** Marker the verification script writes, proving the loop really ran the check. */
let markerPath: string;
let passScript: string; // exit 0 (and writes the marker)
let failScript: string; // exit 1 + FAIL line (stable failure signature) + writes the marker

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "iknow-verify-chat-"));
  markerPath = join(workDir, "verify-ran.marker");
  passScript = join(workDir, "verify-pass.sh");
  failScript = join(workDir, "verify-fail.sh");
  writeFileSync(passScript, `#!/bin/sh\ntouch "${markerPath}"\nexit 0\n`, {
    mode: 0o755,
  });
  writeFileSync(
    failScript,
    `#!/bin/sh\ntouch "${markerPath}"\necho 'FAIL  tests/auth.test.ts:login rejects bad token'\nexit 1\n`,
    { mode: 0o755 }
  );
  chmodSync(passScript, 0o755);
  chmodSync(failScript, 0o755);
  // The loop's sandbox cwd = process.cwd() → chdir into the isolated work dir;
  // scripts bind into the sandbox via createFsPolicy(cwd) (never the real workspace).
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(workDir, { recursive: true, force: true });
});

describe("processChatLine — verify-loop 装配 (T8)", () => {
  it("verifyConfig 缺席 → 原 runHarness 路径: completed + append-only + 验证未执行", async () => {
    rmSync(markerPath, { force: true });
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["answer-1"] })],
    });
    const r = await processChatLine({ line: "hello", ctx });
    assert.equal(r.quit, false);
    assert.equal(r.ranQuery, true);
    assert.match(r.output, /answer-1/);
    assert.equal(ctx.state.messages.length, 2); // [user, assistant]
    assert.equal(ctx.state.messages[1]!.role, "assistant");
    const lastText = (
      ctx.state.messages[1]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(lastText, "answer-1");
    // Without verifyConfig → the verification command must never execute.
    assert.equal(
      existsSync(markerPath),
      false,
      "未配置 verifyConfig 时验证命令不得执行"
    );
  });

  it.skipIf(!canRunSandbox())(
    "verifyConfig 配置 + 验证 exit 0 → 闭环激活 + 单轮通过",
    async () => {
      rmSync(markerPath, { force: true });
      const ctx = makeCtx({
        responses: [
          gateTurn("pc-g1"),
          assistantResult({ texts: ["answer-ok"] }),
        ],
      });
      Object.assign(ctx, {
        verifyConfig: { command: passScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "fix this", ctx });
      assert.equal(r.ranQuery, true);
      assert.match(r.output, /answer-ok/);
      // Hard proof: the verification command really executed (loop activated).
      assert.equal(
        existsSync(markerPath),
        true,
        "配置 verifyConfig + 门开 turn → 验证命令应经沙箱执行"
      );
      // Single-round pass: the history carries the model's own tool roundtrip
      // and nothing else — a passing turn adds no verify bookkeeping.
      assert.equal(ctx.state.messages.length, 4);
      assert.equal(ctx.state.messages[1]!.role, "assistant");
      assert.equal(ctx.state.messages[3]!.role, "assistant");
      const envelopes = ctx.state.messages.filter(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) =>
              b.type === "text" &&
              (b.text as string).includes("[VALIDATION FAILED]")
          )
      );
      assert.equal(envelopes.length, 0, "通过轮不得注入信封");
    }
  );

  it.skipIf(!canRunSandbox())(
    "verifyConfig 配置 + 验证真失败 → 注入失败信封",
    async () => {
      rmSync(markerPath, { force: true });
      const ctx = makeCtx({
        responses: [
          gateTurn("pc-g2"),
          assistantResult({ texts: ["fix-attempt-1"] }),
          assistantResult({ texts: ["fix-attempt-2"] }),
        ],
      });
      Object.assign(ctx, {
        verifyConfig: { command: failScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "make tests pass", ctx });
      assert.equal(r.ranQuery, true);
      assert.equal(existsSync(markerPath), true, "验证命令应真实执行");
      // failScript always exits 1 → first-turn failure injects the envelope →
      // second verify with the same signature stalls → loop stops. History has
      // three assistant messages (gate roundtrip + the two fix rounds).
      assert.equal(
        ctx.state.messages.filter((m) => m.role === "assistant").length,
        3
      );
      const envelopes = ctx.state.messages.filter(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) =>
              b.type === "text" &&
              (b.text as string).includes("[VALIDATION FAILED]")
          )
      );
      assert.equal(envelopes.length, 1, "应恰有一条注入信封");
      const envText = (
        envelopes[0]!.content[0] as { type: "text"; text: string }
      ).text;
      assert.match(envText, /attempt=1\/12/);
      assert.match(envText, /exit_code: 1/);
      assert.match(envText, /signature: exit=1\|tests\/auth\.test\.ts/);
    }
  );

  it("装配层默认启用: command 缺失 (verifyConfig = { command: '' }) + subagentManager 在场 → runVerifyLoop + runClassifier 接管 (spec #128 Objective)", async () => {
    rmSync(markerPath, { force: true });
    // Judge envelope script: 1st spawn → pass (first turn completed → judge
    // passes → loop passed, never silently closed). History shape matches a bare run (a pass doesn't change the assembly surface).
    // ADR-0122: the judge spawn def carries no model — the judge inherits the
    // worker route, so only `task` is captured for the spawn-count assert.
    const spawnedDefs: Array<{ task: string | undefined }> = [];
    const manager: SubAgentManager = {
      spawn: (def) => {
        spawnedDefs.push({ task: def.task });
        return { taskId: "judge-1" };
      },
      queryBuffer: () => ({ status: "completed" }),
      waitFor: async () =>
        ({
          status: "ok",
          summary: "judge done",
          result: JSON.stringify({
            kind: "pass",
            reason: "evidence present",
            evidence: [{ command: "noop", result: "pass" }],
          }),
        }) satisfies SubAgentEnvelope,
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: () => false,
      // The interface gained read-only enumeration members — the fake completes them to stay structurally compatible.
      getCapacity: () => 15,
      listSubagents: () => [],
    };

    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["answer-classified"] })],
    });
    Object.assign(ctx, {
      verifyConfig: { command: "" } satisfies VerifyConfig,
      subagentManager: manager,
    });
    const r = await processChatLine({ line: "research a topic", ctx });

    assert.equal(r.ranQuery, true);
    assert.match(r.output, /answer-classified/);
    // Plan T1 HITL: no pinned goal → completion judge spawn = 0.
    assert.equal(
      spawnedDefs.length,
      0,
      "HITL (no goal) must not spawn completion-facing judge"
    );
    // Loop passed: history shape matches a bare run (a pass doesn't alter the message surface).
    // HITL small talk must not print the green check.
    assert.equal(
      r.output.includes("[验证] 验证通过"),
      false,
      "HITL chat must not print passed green check"
    );
    assert.equal(ctx.state.messages.length, 2);
    assert.equal(ctx.state.messages[1]!.role, "assistant");
    // The verification command (empty command, no such script) must never execute.
    assert.equal(
      existsSync(markerPath),
      false,
      "command 缺失 → 无验证命令执行"
    );
  });

  it("verifyConfig 配置 + 验证始终失败 → 闭环停止, 不判完成", async () => {
    rmSync(markerPath, { force: true });
    const ctx = makeCtx({
      responses: [
        gateTurn("pc-g3"),
        assistantResult({ texts: ["fix-attempt-1"] }),
        assistantResult({ texts: ["fix-attempt-2"] }),
      ],
    });
    Object.assign(ctx, {
      verifyConfig: { command: failScript } satisfies VerifyConfig,
    });
    const r = await processChatLine({ line: "make tests pass", ctx });
    assert.equal(r.ranQuery, true);
    assert.ok(r.output.length > 0, "输出应非空 (如实报告)");
    // The final verification verdict must surface into chat output — the user
    // must see "verification failed", not a normal completion. Assert the output carries the report marker.
    assert.match(
      r.output,
      /\[验证\] 验证未通过（\d+ 轮）/,
      "chat 输出必须 surface 验证失败报告 (M3)"
    );
    // The stalled turn injects no second envelope (same-signature stall → trend stop, only one round recorded).
    const envelopes = ctx.state.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) =>
            b.type === "text" &&
            (b.text as string).includes("[VALIDATION FAILED]")
        )
    );
    assert.equal(envelopes.length, 1);
  });

  // ADR-0092: chat's verify command surface must carry the same tier as the bash tool surface.
  // Discriminating design: the verify script **tries to write home**. Under the
  // workspace tier home is ro-bind, so the write must fail with EROFS; if the
  // holder never reached the verify surface (regression), the sandbox would be
  // global-tier and the write would succeed — both outcomes are directly
  // observable, not just an opts-field check.
  it.skipIf(!canRunSandbox())(
    "fsMode=workspace → verify 命令落在工作区档围栏 (写 home 被 EROFS 拒)",
    async () => {
      const homeProbe = join(osHomedir(), ".iknow-verify-fsmode-probe");
      rmSync(homeProbe, { force: true });
      const probeScript = join(workDir, "verify-write-home.sh");
      writeFileSync(
        probeScript,
        `#!/bin/sh\necho probe > "${homeProbe}"\nexit 0\n`,
        { mode: 0o755 }
      );
      chmodSync(probeScript, 0o755);

      const ctx = makeCtx({
        responses: [
          gateTurn("pc-g4"),
          assistantResult({ texts: ["answer-ws"] }),
        ],
        fsMode: createFsModeContext("workspace"),
      });
      Object.assign(ctx, {
        verifyConfig: { command: probeScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "fix this", ctx });
      assert.equal(r.ranQuery, true);
      // The tier really reached the verify surface → home write rejected by the kernel → nothing lands host-side.
      assert.equal(
        existsSync(homeProbe),
        false,
        "workspace 档下 verify 命令写 home 必须 EROFS 拒绝且宿主侧不落盘"
      );
      rmSync(homeProbe, { force: true });
    }
  );

  // Negative control (rules out a false green from "the write always fails"):
  // the same script writing home under the global tier must succeed. Only the
  // pair proves the assertion is about the **tier difference**, not the script being unwriteable.
  it.skipIf(!canRunSandbox())(
    "fsMode=global（对照）→ 同一 verify 脚本写 home 成功",
    async () => {
      const homeProbe = join(osHomedir(), ".iknow-verify-fsmode-probe-global");
      rmSync(homeProbe, { force: true });
      const probeScript = join(workDir, "verify-write-home-global.sh");
      writeFileSync(
        probeScript,
        `#!/bin/sh\necho probe > "${homeProbe}"\nexit 0\n`,
        { mode: 0o755 }
      );
      chmodSync(probeScript, 0o755);

      const ctx = makeCtx({
        responses: [
          gateTurn("pc-g5"),
          assistantResult({ texts: ["answer-g"] }),
        ],
        fsMode: createFsModeContext("global"),
      });
      Object.assign(ctx, {
        verifyConfig: { command: probeScript } satisfies VerifyConfig,
      });
      const r = await processChatLine({ line: "fix this", ctx });
      assert.equal(r.ranQuery, true);
      assert.equal(
        existsSync(homeProbe),
        true,
        "global 档下 verify 命令写 home 应成功（对照: 证明确实是档位在起作用）"
      );
      rmSync(homeProbe, { force: true });
    }
  );
});
