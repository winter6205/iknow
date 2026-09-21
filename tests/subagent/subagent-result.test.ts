/**
 * subagent_result ACI tool unit tests (fake SubAgentManager, no real child process).
 *
 * Coverage (11 assertions):
 *   1. taskId="unknown" → JSON {status:"not_found"}
 *   2. taskId="running" → JSON {status:"running"}
 *   3. taskId="ok" → completed envelope passed through (status:"ok" + summary + result
 *      + fileRefs/usage fields)
 *   4. taskId="crashed" → {status:"failed", reason:"crashed", summary}
 *   5. taskId="maxTurnsExceeded" → reason:"maxTurnsExceeded"
 *   6. taskId="timeout" → reason:"timeout"
 *   7. taskId="protocolError" → reason:"protocolError"
 *   8. handler returns synchronously (return shape, not wall clock)
 *   9. task_id missing → throws ToolExecutionError
 *   10. task_id:123 (non-string) → throws ToolExecutionError
 *   11. aci metadata: category:"read-only" / timeoutTier:"fast" / lazy:false
 *
 * Extra fields {task_id:"x", foo:"bar"} strictness is enforced by the registry's
 * ajv strict validation (createAciRegistry compiles inputSchema with
 * additionalProperties:false); the handler receives already-validated input —
 * not re-tested here.
 */
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSubAgentResultTool } from "../../src/harness/subagent/subagent-result-tool.ts";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import { FINAL_TEXT_PAD_NAME } from "../../src/harness/subagent/envelope.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { workerFenceTmpPath } from "../../src/harness/sandbox/fence-tmp.ts";

/** fake manager: queryBuffer maps taskId to one of four states; other members are stubs. */
function makeFakeManager(): SubAgentManager {
  return {
    spawn: () => ({ taskId: "fake-id" }),
    queryBuffer: (taskId: string) => {
      switch (taskId) {
        case "unknown":
          return { status: "not_found" };
        case "running":
          return { status: "running" };
        case "ok": {
          const env: SubAgentEnvelope = {
            status: "ok",
            summary: "found the answer",
            result: "42",
            fileRefs: ["/tmp/a.txt", "/tmp/b.txt"],
            usage: { inputTokens: 10, outputTokens: 20 },
          };
          return env;
        }
        case "crashed":
          return {
            status: "failed",
            reason: "crashed",
            summary: "worker crashed",
          };
        case "maxTurnsExceeded":
          return {
            status: "failed",
            reason: "maxTurnsExceeded",
            summary: "turns exhausted",
          };
        case "timeout":
          return {
            status: "failed",
            reason: "timeout",
            summary: "wallclock exceeded",
          };
        case "protocolError":
          return {
            status: "failed",
            reason: "protocolError",
            summary: "bad envelope",
          };
        default:
          return { status: "not_found" };
      }
    },
    waitFor: () => Promise.reject(new Error("not used")),
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // interface gained a read-only enumeration surface — fake fills it in for structural compatibility.
    getCapacity: () => 15,
    listSubagents: () => [],
  };
}

describe("subagent_result — 正常路径", () => {
  it("unknown taskId → JSON {status:'not_found'}", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "unknown" });
    expect(out).toBe(JSON.stringify({ status: "not_found" }));
  });

  it("running taskId → JSON {status:'running'}", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "running" });
    expect(out).toBe(JSON.stringify({ status: "running" }));
  });

  it("completed → JSON 含 status:'ok' + summary + result,fileRefs/usage 透传", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "ok" });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.status).toBe("ok");
    expect(parsed.summary).toBe("found the answer");
    expect(parsed.result).not.toBe("42");
    expect(String(parsed.result)).toMatch(/found the answer/);
    expect(String(parsed.result)).toMatch(/\/tmp\/a\.txt/);
    expect(parsed.fileRefs).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("failed crashed → JSON {status:'failed', reason:'crashed', summary}", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const out = tool.handler({ task_id: "crashed" });
    expect(out).toBe(
      JSON.stringify({
        status: "failed",
        reason: "crashed",
        summary: "worker crashed",
      })
    );
  });

  it("failed maxTurnsExceeded → reason 一致", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const parsed = JSON.parse(
      tool.handler({ task_id: "maxTurnsExceeded" })
    ) as Record<string, unknown>;
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("maxTurnsExceeded");
    expect(parsed.summary).toBe("turns exhausted");
  });

  it("failed timeout → reason 一致", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const parsed = JSON.parse(tool.handler({ task_id: "timeout" })) as Record<
      string,
      unknown
    >;
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("timeout");
    expect(parsed.summary).toBe("wallclock exceeded");
  });

  it("failed protocolError → reason 一致", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const parsed = JSON.parse(
      tool.handler({ task_id: "protocolError" })
    ) as Record<string, unknown>;
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("protocolError");
    expect(parsed.summary).toBe("bad envelope");
  });

  it("handler 同步返回（返回值而非 Promise）", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    // Synchronous non-blocking is a structural contract: the handler is a plain
    // function that only checks buffer/pad — no await, no waitFor/drain. Pin it by
    // return shape; a wall-clock bound is only a proxy for machine speed and false-
    // reds under load (same fix as build-engine's time-bound removal).
    const out = tool.handler({ task_id: "ok" });
    expect(typeof out).toBe("string");
    expect(out).not.toBeInstanceOf(Promise);
  });
});

describe("subagent_result — 非法输入(抛 ToolExecutionError)", () => {
  it("task_id 缺失 → 抛 ToolExecutionError", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler({})).toThrow(ToolExecutionError);
    expect(() => tool.handler({})).toThrow(/missing or invalid/);
  });

  it("task_id:123（非 string）→ 抛", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler({ task_id: 123 })).toThrow(ToolExecutionError);
    expect(() => tool.handler({ task_id: 123 })).toThrow(/missing or invalid/);
  });

  it("task_id 空串 → 抛", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler({ task_id: "" })).toThrow(ToolExecutionError);
  });

  it("input 为 null → 按空对象处理,抛 missing task_id", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(() => tool.handler(null)).toThrow(ToolExecutionError);
  });
});

describe("subagent_result — AciToolDef 元数据", () => {
  it("name = subagent_result,aci read-only/fast/cancel/concurrencySafe/lazy:false", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    expect(tool.name).toBe("subagent_result");
    expect(tool.aci.category).toBe("read-only");
    expect(tool.aci.timeoutTier).toBe("fast");
    expect(tool.aci.interruptBehavior).toBe("cancel");
    expect(tool.aci.isConcurrencySafe).toBe(true);
    expect(tool.aci.lazy).toBe(false);
  });

  it("description 说明父可见短交差字段，不宣称 full envelope 是唯一真值", () => {
    const description = createSubAgentResultTool({
      manager: makeFakeManager(),
    }).description;
    expect(description).toMatch(/parent-visible/i);
    expect(description).toMatch(/short (?:handoff|summary)/i);
    expect(description).toMatch(/summary/i);
    expect(description).toMatch(/paths?/i);
    expect(description).toMatch(/status/i);
    expect(description).toMatch(/stop[_ ]reason/i);
    expect(description).not.toMatch(/full envelope/i);
    expect(description).not.toMatch(/sole ground truth|ground truth/i);
    expect(description).not.toMatch(/Fork|worktree/i);
  });

  it("inputSchema 冻结:required=['task_id'],additionalProperties:false", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const schema = tool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["task_id"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.tmp_path).toEqual({
      type: "string",
      description: expect.stringMatching(/relative/i),
    });
    expect(Object.isFrozen(tool)).toBe(true);
  });
});

/**
 * T5 (parent-visible-tmp): list / read worker pad via subagent_result.
 * Real manager + on-disk pad — fake queryBuffer cannot prove SC3/S2-B.
 */
interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makePadChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    exitCode: null,
    signalCode: null,
    pid: 1001,
  }) as unknown as FakeChild;
}

function emitPadEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(`${JSON.stringify(env)}\n`);
  child.emit("exit", env.status === "ok" ? 0 : 1, null);
}

function flushPadTicks(): Promise<void> {
  return new Promise((r) => setImmediate(r)).then(
    () => new Promise((r) => setImmediate(r))
  );
}

const padScratch: string[] = [];

function makePadScratch(): { root: string; subagentsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "iknow-t5-pad-"));
  padScratch.push(root);
  const subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  return { root, subagentsDir };
}

describe("subagent_result — T5 pad list/read (SC3 / SC6 / S2-B)", () => {
  let subagentsDir: string;
  let sessionRoot: string;

  beforeEach(() => {
    const made = makePadScratch();
    sessionRoot = made.root;
    subagentsDir = made.subagentsDir;
  });

  afterEach(() => {
    for (const path of padScratch.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  async function spawnSettled(fileOnPad?: { name: string; body: string }) {
    const child = makePadChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "pad" });
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    mkdirSync(pad, { recursive: true });
    if (fileOnPad !== undefined) {
      writeFileSync(join(pad, fileOnPad.name), fileOnPad.body, "utf8");
    }
    emitPadEnvelope(child, { status: "ok", summary: "done", result: "done" });
    await flushPadTicks();
    const tool = createSubAgentResultTool({ manager });
    return { manager, tool, taskId, pad };
  }

  it("S2-B empty: 合法 task_id + 垫底只有 host 落稿 → 不报错，名单只含 final.md", async () => {
    // After Locked sentence 2, any pad holding a final draft at least contains the
    // host-written final.md; the invariant stays "valid task_id + no worker artifact
    // → not an error", with the name list derived from the SSOT constant, no hardcoded literal.
    const { tool, taskId } = await spawnSettled();
    const parsed = JSON.parse(tool.handler({ task_id: taskId })) as {
      status: string;
      tmp_names?: unknown;
    };
    expect(parsed.status).not.toBe("not_found");
    expect(parsed.status).not.toBe("rejected");
    expect(parsed.tmp_names).toEqual([FINAL_TEXT_PAD_NAME]);
  });

  it("SC3: 只传 task_id → 顶层名字含 worker 写下的文件", async () => {
    const { tool, taskId } = await spawnSettled({
      name: "z",
      body: "worker-pad-body",
    });
    const parsed = JSON.parse(tool.handler({ task_id: taskId })) as {
      tmp_names?: string[];
    };
    expect(parsed.tmp_names).toContain("z");
  });

  it("SC3: 再传相对 tmp_path → 读到内容（截断形态同 read_file）", async () => {
    const { tool, taskId } = await spawnSettled({
      name: "z",
      body: "worker-pad-body\n",
    });
    const parsed = JSON.parse(
      tool.handler({ task_id: taskId, tmp_path: "z" })
    ) as { status: string; content?: string; truncated?: boolean };
    expect(parsed.status).toBe("ok");
    expect(parsed.content).toMatch(/worker-pad-body/);
    expect(parsed.content).toMatch(/^\s*1\tworker-pad-body$/m);
    expect(parsed.truncated).toBe(false);
  });

  it("SC6 / S2-B negative: 未知 task_id → typed not_found", () => {
    const manager = createSubAgentManager({
      spawn: () => makePadChild() as unknown as ChildProcess,
      subagentsDir,
    });
    const tool = createSubAgentResultTool({ manager });
    const out = tool.handler({ task_id: "no-such-task" });
    expect(out).toBe(JSON.stringify({ status: "not_found" }));
  });

  it("SC6 / S2-B exception: tmp_path 含 .. 或逃逸垫底 → typed reject，不读垫底外文件", async () => {
    const secret = join(sessionRoot, "secret.txt");
    writeFileSync(secret, "SESSION-SECRET", "utf8");
    const { tool, taskId, pad } = await spawnSettled({
      name: "z",
      body: "inside",
    });
    const escaped = JSON.parse(
      tool.handler({ task_id: taskId, tmp_path: "../secret.txt" })
    ) as { status: string; reason?: string; content?: string };
    expect(escaped.status).toBe("rejected");
    expect(escaped.reason).toBe("path_escape");
    expect(JSON.stringify(escaped)).not.toContain("SESSION-SECRET");
    expect(readFileSync(secret, "utf8")).toBe("SESSION-SECRET");

    const dotted = JSON.parse(
      tool.handler({ task_id: taskId, tmp_path: "z/../../secret.txt" })
    ) as { status: string; reason?: string };
    expect(dotted.status).toBe("rejected");
    expect(dotted.reason).toBe("path_escape");

    const abs = JSON.parse(
      tool.handler({ task_id: taskId, tmp_path: secret })
    ) as { status: string; reason?: string };
    expect(abs.status).toBe("rejected");
    expect(abs.reason).toBe("path_escape");

    expect(readFileSync(join(pad, "z"), "utf8")).toBe("inside");
  });

  it("S2-B overflow: 超过 read_file 默认 200 行 → 截断，不灌全文", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `L${i + 1}`);
    const { tool, taskId } = await spawnSettled({
      name: "big.txt",
      body: `${lines.join("\n")}\n`,
    });
    const parsed = JSON.parse(
      tool.handler({ task_id: taskId, tmp_path: "big.txt" })
    ) as { content?: string; truncated?: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.content).toMatch(/L200/);
    expect(parsed.content).not.toMatch(/L201/);
    expect(parsed.content).not.toMatch(/L250/);
  });

  it("handler 带 tmp_path 仍同步非阻塞（不暴露 waitFor/drain）", async () => {
    const { tool, taskId, manager } = await spawnSettled({
      name: "z",
      body: "x",
    });
    // Same as above: synchrony is pinned by return shape, not wall clock (false-red under load).
    const out = tool.handler({ task_id: taskId, tmp_path: "z" });
    expect(typeof out).toBe("string");
    expect(out).not.toBeInstanceOf(Promise);
    expect(manager.waitFor).not.toBe(tool.handler);
  });
});
