/**
 * SessionHub postMessage verify-loop wiring test.
 *
 * Fully real assembly chain, no test seams:
 *   - SessionHubOptions.verifyConfig (command points at a script in cwd);
 *   - runVerifyLoop default runVerify = runInSandbox + bwrap (real sandboxed
 *     execution, canRunSandbox capability probe, same discipline as verify-loop
 *     tests);
 *   - runFn goes through hub.postMessage into the real run() (stub model deps).
 *
 * Hard proof the loop activated = the verify command really executed: the
 * script writes a marker file into cwd.
 *
 * Coverage:
 *   1. verifyConfig absent → plain run path: completed result + verify
 *      command not executed (no marker);
 *   2. verifyConfig set + verify exit 0 → loop activated (marker exists) +
 *      single-round pass, wire finalText preserved;
 *   3. verifyConfig set + verify genuinely fails → envelope injected (next
 *      round's priorMessages contains a [VALIDATION FAILED] user message).
 *
 * Same discipline as the chat-side assembly tests: the verify command reads
 * and writes only inside an isolated tmpdir (cwd).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

/**
 * Physical-sandbox capability probe. `hasBwrap()` (binary presence) is the wrong
 * gate: a GitHub Actions runner installs bwrap but disallows user-namespace
 * network isolation, so the fence's constant `--unshare-net` fails at spawn
 * (RTM_NEWADDR) → the default runVerify throws → the loop never executes the
 * check. Test execution, not mere presence, so the physical cases only run on a
 * host that can actually build the fence (local WSL).
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

/**
 * Content-gate signal for the stub-model turns: an attempted `npm test` bash
 * call. The tool is unregistered in this harness (registry = noop), so the
 * executor records tool_not_found — the transcript still shows a test command
 * was run, which opens the upstream verify gate (a text-only turn would be
 * gated out of verify and the verify command would never execute).
 */
const gateTestCall = (id: string) => ({
  id,
  name: "bash",
  input: { command: "npm test" },
});

// -- isolated workdir (cwd for the closed loop's sandbox) ---------------------
const prevCwd = process.cwd();
let dataDir: string;
let workDir: string;
let markerPath: string;
let passScript: string;
let failScript: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "iknow-hub-verify-data-"));
  workDir = mkdtempSync(join(tmpdir(), "iknow-hub-verify-work-"));
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
  // Loop sandbox cwd = process.cwd() → chdir into an isolated work dir (never touch the real workspace).
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

/** Assemble a hub with verifyConfig; responses default empty (caller passes them explicitly). */
function makeHub(opts: {
  verifyConfig?: VerifyConfig;
  responses?: Parameters<typeof makeDeps>[0];
}) {
  const store = new SessionStore(dataDir, process.cwd());
  return new SessionHub({
    store,
    workspaceRoot: process.cwd(),
    deps: makeDeps(opts.responses ?? []),
    ...(opts.verifyConfig !== undefined
      ? { verifyConfig: opts.verifyConfig }
      : {}),
  });
}

describe("SessionHub postMessage — verify-loop 装配 (T8)", () => {
  it("verifyConfig 缺席 → 原 run 路径: completed + 验证未执行 (SC7)", async () => {
    rmSync(markerPath, { force: true });
    const hub = makeHub({
      responses: [assistantResult({ texts: ["hello world"] })],
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.finalText, "hello world");
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
      const hub = makeHub({
        verifyConfig: { command: passScript },
        responses: [
          assistantResult({
            texts: ["ran the suite"],
            toolCalls: [gateTestCall("v1")],
          }),
          assistantResult({ texts: ["fixed"] }),
        ],
      });
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "fix this",
      });
      assert.equal(res.turn.answer.stopReason, "completed");
      assert.equal(res.turn.answer.finalText, "fixed");
      assert.equal(
        existsSync(markerPath),
        true,
        "配置 verifyConfig + 门开 turn → 验证命令应经沙箱执行"
      );
    }
  );

  // When the verify loop's final verdict is passed,
  // VerifyAnswerView.outcome must be "passed" with rounds on the wire DTO
  // (the old three-value whitelist lacked passed → field absent, contradicting
  // passed being a legitimate terminal state).
  // abort / disabled still omit the field (not covered here, see contract.test.ts).
  it.skipIf(!canRunSandbox())(
    'verifyConfig 配置 + 验证 exit 0 → DTO 出现 verify.outcome="passed" rounds=N (T2 wire)',
    async () => {
      rmSync(markerPath, { force: true });
      const hub = makeHub({
        verifyConfig: { command: passScript },
        responses: [
          assistantResult({
            texts: ["ran the suite"],
            toolCalls: [gateTestCall("v2")],
          }),
          assistantResult({ texts: ["fixed"] }),
        ],
      });
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "fix this",
      });
      // passed is a legitimate terminal state and must surface on the
      // VerifyAnswerView DTO — same surface as failed/unstable/escalated;
      // abort/disabled still omit the field (byte-stable, pinned only by the
      // contract tests).
      assert.deepEqual(res.turn.answer.verify, {
        outcome: "passed",
        rounds: 1,
      });
    }
  );

  it.skipIf(!canRunSandbox())(
    "verifyConfig 配置 + 验证真失败 → 注入失败信封 (下轮 priorMessages)",
    async () => {
      rmSync(markerPath, { force: true });
      // Two stub runs (one tool attempt each side): first run returns
      // (completed) → verify fails → envelope injected; second run (envelope
      // in priorMessages) returns → verify still fails → stall stops it.
      const hub = makeHub({
        verifyConfig: { command: failScript },
        responses: [
          assistantResult({
            texts: ["ran the suite"],
            toolCalls: [gateTestCall("v3")],
          }),
          assistantResult({ texts: ["fix-1"] }),
          assistantResult({ texts: ["fix-2"] }),
        ],
      });
      const { session } = await hub.createSession();
      const res = await hub.postMessage({
        conversationId: session.conversation_id,
        text: "make tests pass",
      });
      assert.equal(res.turn.answer.stopReason, "completed");
      assert.equal(existsSync(markerPath), true, "验证命令应真实执行");
      // The envelope lands in the second run's priorMessages (messages contain
      // a [VALIDATION FAILED] user message). postMessage already persisted via
      // conditionalSave — load the newest file from disk and assert there.
      const saved = await new SessionStore(dataDir, process.cwd()).load(
        session.conversation_id
      );
      const envelopes = saved.messages.filter(
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
    }
  );
});
