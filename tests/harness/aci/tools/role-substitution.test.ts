/**
 * ADR-0117 tool-role substitution refusal — bash arm contract.
 *
 * Invariants certified:
 *   - bash must not impersonate the grep family (grep/egrep/fgrep/rg): ANY
 *     top-level shell segment whose first token is one of these is refused
 *     fail-closed, in foreground and background alike.
 *   - The refusal is NOT a hard-wall: message starts with
 *     ROLE_SUBSTITUTION_PREFIX, points only to the proper-role tools (ACI
 *     grep / find_symbol), and carries no VIOLATION_PREFIXES token.
 *   - First-token rule only: `git grep` passes; `sed`/`cat`/`nl` line-window
 *     reads pass AND keep their last-read booking (ADR-0084 unchanged).
 *   - The refusal reaches the model as `[execution_failed]` via the
 *     ToolExecutionError contract (executor sanitize → tool-result encode).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createBashTool } from "../../../../src/harness/aci/tools/bash.ts";
import { createLastReadLedgerHost } from "../../../../src/harness/aci/last-read-ledger.ts";
import { VIOLATION_PREFIXES } from "../../../../src/harness/permission/prefixes.ts";
import { toAnthropicToolResults } from "../../../../src/harness/tools/tool-result.ts";
import type { ToolExecutionResult } from "../../../../src/harness/tools/types.ts";
import {
  ROLE_SUBSTITUTION_PREFIX,
  GREP_FAMILY_TOKENS,
  detectBashGrepSubstitution,
} from "../../../../src/harness/aci/tools/role-substitution.ts";
import type { AciToolDef } from "../../../../src/harness/aci/types.ts";

interface BashEnvelope {
  readonly output: string;
}

async function runBash(
  tool: AciToolDef,
  input: unknown
): Promise<{ code: number; stdout: string; stderr: string }> {
  const envelope = (await tool.handler(input)) as BashEnvelope;
  return JSON.parse(envelope.output) as {
    code: number;
    stdout: string;
    stderr: string;
  };
}

async function expectRefusal(tool: AciToolDef, command: string): Promise<string> {
  let caught: unknown;
  try {
    await tool.handler({ command });
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ToolExecutionError,
    `${command} → 必须以 ToolExecutionError 拒绝（fail-closed），实际: ${String(caught)}`
  );
  return caught.message;
}

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("bash 替岗拒绝 — grep 族 / rg 首 token（ADR-0117）", () => {
  it("grep 族四件套作为段首 token 一律拒绝", async () => {
    const cwd = await makeScratch("role-sub-bash-family-");
    const bash = createBashTool(cwd);
    const commands = [
      "grep needle a.ts",
      "egrep needle a.ts",
      "fgrep needle a.ts",
      "rg needle a.ts",
    ];
    assert.deepEqual([...GREP_FAMILY_TOKENS].sort(), [...commands.map((c) => c.split(" ")[0]!)].sort());
    for (const command of commands) {
      const message = await expectRefusal(bash, command);
      assert.ok(
        message.startsWith(ROLE_SUBSTITUTION_PREFIX),
        `${command} 拒绝消息必须以 ${ROLE_SUBSTITUTION_PREFIX} 开头`
      );
    }
  });

  it("管道 / 分号段中的 grep 也被拒（cat f | grep x）", async () => {
    const cwd = await makeScratch("role-sub-bash-pipe-");
    await writeFile(join(cwd, "f.txt"), "x\n");
    const bash = createBashTool(cwd);
    for (const command of [
      "cat f.txt | grep x",
      "ls; grep x f.txt",
      "true && rg x f.txt",
      "false || /usr/bin/grep x f.txt",
    ]) {
      await expectRefusal(bash, command);
    }
  });

  it("git grep 放行（首 token 是 git）；echo 含 grep 字样放行", async () => {
    const cwd = await makeScratch("role-sub-bash-firsttoken-");
    const bash = createBashTool(cwd);
    const echoResult = await runBash(bash, { command: "echo grep-in-a-sentence" });
    assert.equal(echoResult.code, 0);
    assert.ok(echoResult.stdout.includes("grep-in-a-sentence"));
    // git grep in a non-repo exits non-zero but must NOT throw a refusal —
    // the gate is first-token based only.
    const gitResult = await runBash(bash, { command: "git grep needle" });
    assert.equal(typeof gitResult.code, "number");
  });

  it("sed -n / cat / nl 行窗不被拦，且 last-read 照常入账", async () => {
    const cwd = await makeScratch("role-sub-bash-line-window-");
    await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");
    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });

    for (const command of ["cat a.txt", "nl a.txt", "sed -n 1,2p a.txt"]) {
      await bash.handler({ command }, { conversationId: "conv-role-sub" });
    }
    assert.equal(
      ledger.ledgerFor("conv-role-sub")?.has(join(cwd, "a.txt")),
      true,
      "行窗读仍入账（ADR-0084 记账面不因替岗闸缩水）"
    );
  });

  it("background: true 的 grep 同样被拒（两臂共用验证链）", async () => {
    const cwd = await makeScratch("role-sub-bash-bg-");
    const bash = createBashTool(cwd);
    let caught: unknown;
    try {
      await bash.handler({ command: "rg needle a.ts", background: true });
    } catch (error) {
      caught = error;
    }
    assert.ok(
      caught instanceof ToolExecutionError &&
        caught.message.startsWith(ROLE_SUBSTITUTION_PREFIX),
      `后台臂必须 fail-closed，实际: ${String(caught)}`
    );
  });

  it("拒绝消息形态：前缀 + 只指向正职（grep / find_symbol），零 hard-wall 词", async () => {
    const message = detectBashGrepSubstitution("grep x f");
    assert.equal(message, "grep");
    const cwd = await makeScratch("role-sub-bash-shape-");
    const bash = createBashTool(cwd);
    const refusal = await expectRefusal(bash, "grep needle f.ts");
    assert.ok(refusal.includes("grep"), "回执指向 ACI grep");
    assert.ok(refusal.includes("find_symbol"), "回执指向符号工具 find_symbol");
    assert.ok(!refusal.includes("hard_wall"), "不得含 hard_wall 字样");
    assert.ok(!/hard-wall/i.test(refusal), "不得含 hard-wall 规则 id");
    for (const prefix of Object.values(VIOLATION_PREFIXES)) {
      assert.ok(!refusal.includes(prefix), `不得含违例前缀 ${prefix}`);
    }
  });

  it("ToolExecutionError 经执行器契约编码为 [execution_failed]（模型可见回执）", async () => {
    const cwd = await makeScratch("role-sub-bash-encode-");
    const bash = createBashTool(cwd);
    const message = await expectRefusal(bash, "grep needle f.ts");
    // executor.buildFailureResult keeps ToolExecutionError.message verbatim
    // (sanitizeFailure model-facing arm); tool-result encoding prepends the
    // failure label. Reproduce the two hops without registry plumbing.
    const failure: ToolExecutionResult = {
      kind: "execution_failed",
      toolUseId: "tu_role_sub_1",
      message,
    };
    const [block] = toAnthropicToolResults([failure]);
    assert.ok(block && block.type === "tool_result" && block.is_error === true);
    const text =
      block && block.type === "tool_result" && Array.isArray(block.content)
        ? (block.content[0] as { text: string }).text
        : "";
    assert.ok(text.startsWith("[execution_failed] "), `模型侧回执须以 [execution_failed] 开头，实际: ${text}`);
    assert.ok(text.includes(ROLE_SUBSTITUTION_PREFIX), "拒绝前缀必须原样抵达模型");
  });
});
