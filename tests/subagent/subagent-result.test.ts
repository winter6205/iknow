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
 *
 * The appended "T4 / T1" sections at the bottom of this file cover the shipped
 * pad contract: bounded continuation (paged / wide reports past the line
 * window), concurrent readers on the same and on distinct tasks, and the
 * failure / path-privacy surfaces that must keep holding.
 */
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import {
  PAD_ROSTER_LINE_LIMIT,
  READ_FILE_MAX_FILE_BYTES,
} from "../../src/harness/subagent/pad-inspect.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import type { AciToolDef } from "../../src/harness/aci/types.ts";
import { workerFenceTmpPath } from "../../src/harness/sandbox/fence-tmp.ts";
import { hasLoneSurrogate, padLineCount } from "./pad-text-invariants.ts";

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
    // T3 terminal-notification subscription: this fake registers no subscriber.
    subscribe: () => () => {},
  };
}

/**
 * `ToolHandler` is typed `unknown` (a handler may return any JSON value), but
 * subagent_result always serializes to a JSON string. Narrow at the call site
 * with a runtime guard instead of a cast, so a future shape change fails the
 * test rather than silently type-checking.
 */
function pollJson(tool: AciToolDef, input: unknown): string {
  const out = tool.handler(input);
  if (typeof out !== "string") {
    throw new Error(
      `subagent_result handler returned ${typeof out}, expected a JSON string`
    );
  }
  return out;
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
    const parsed = JSON.parse(pollJson(tool, { task_id: "ok" })) as Record<
      string,
      unknown
    >;
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
      pollJson(tool, { task_id: "maxTurnsExceeded" })
    ) as Record<string, unknown>;
    expect(parsed.status).toBe("failed");
    expect(parsed.reason).toBe("maxTurnsExceeded");
    expect(parsed.summary).toBe("turns exhausted");
  });

  it("failed timeout → reason 一致", () => {
    const tool = createSubAgentResultTool({ manager: makeFakeManager() });
    const parsed = JSON.parse(pollJson(tool, { task_id: "timeout" })) as Record<
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
      pollJson(tool, { task_id: "protocolError" })
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
 * Pad list / read (parent-visible tmp): list / read worker pad via subagent_result.
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

describe("subagent_result — pad list/read", () => {
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
    const parsed = JSON.parse(pollJson(tool, { task_id: taskId })) as {
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
    const parsed = JSON.parse(pollJson(tool, { task_id: taskId })) as {
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
      pollJson(tool, { task_id: taskId, tmp_path: "z" })
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
      pollJson(tool, { task_id: taskId, tmp_path: "../secret.txt" })
    ) as { status: string; reason?: string; content?: string };
    expect(escaped.status).toBe("rejected");
    expect(escaped.reason).toBe("path_escape");
    expect(JSON.stringify(escaped)).not.toContain("SESSION-SECRET");
    expect(readFileSync(secret, "utf8")).toBe("SESSION-SECRET");

    const dotted = JSON.parse(
      pollJson(tool, { task_id: taskId, tmp_path: "z/../../secret.txt" })
    ) as { status: string; reason?: string };
    expect(dotted.status).toBe("rejected");
    expect(dotted.reason).toBe("path_escape");

    const abs = JSON.parse(
      pollJson(tool, { task_id: taskId, tmp_path: secret })
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
      pollJson(tool, { task_id: taskId, tmp_path: "big.txt" })
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

// ── Bounded pad continuation ────────────────────────────────────────────────
//
// The pad reader stays synchronous, relative-path-only, and inside the worker
// fence, while a report longer than one window stays fully retrievable: a
// tail witness lands on a later bounded page, and assembling the pages
// reproduces the original in order — with the line and byte caps still
// present and no hidden truncation. The failure and path-privacy cases below
// lock the typed rejection surface, which must stay free of raw filesystem
// text.
//
// The exact parameter and field names are pinned ONCE here — one adapter, four
// constants — so the contract assertions stay about observable behavior rather
// than spelling.

/** Input key naming where the next page continues (0-based, like read_file's `offset`). */
const PAD_PAGE_OFFSET_ARG = "offset";
/** Result key naming the offset to pass on the following call (absent at EOF). */
const PAD_PAGE_CURSOR_FIELD = "next_offset";
/** Result key flagging that this page ended at end-of-file. */
const PAD_PAGE_EOF_FIELD = "eof";
/** The executor's serialized-output floor (ADR-0006 `OUTPUT_HARD_CAP`). */
const EXECUTOR_OUTPUT_HARD_CAP = 20_000;
/**
 * Pad caps that must SURVIVE pagination. `EXECUTOR_OUTPUT_HARD_CAP` mirrors a
 * private src constant on purpose: it is the gate the pages are sized *against*,
 * so re-stating it here makes the test fail if the pad budget ever drifts from
 * the executor floor it was derived from.
 */

interface PadPage {
  readonly raw: string;
  readonly content: string;
  readonly cursor: number;
  readonly eof: boolean;
}

/**
 * One bounded page: same public boundary as the model (the `subagent_result`
 * handler), with the continuation offset applied. A page body is the RAW slice
 * including its own line separators — the continuation signal lives in
 * metadata (`PAD_PAGE_CURSOR_FIELD` / `PAD_PAGE_EOF_FIELD`), never inside
 * `content`, so successive bodies concatenate to the original byte for byte.
 */
function readPadPage(
  tool: AciToolDef,
  taskId: string,
  tmpPath: string,
  offset: number
): PadPage {
  const raw = pollJson(tool, {
    task_id: taskId,
    tmp_path: tmpPath,
    [PAD_PAGE_OFFSET_ARG]: offset,
  });
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(parsed.status).toBe("ok");
  const content = parsed.content;
  expect(typeof content).toBe("string");
  expect(raw.length).toBeLessThanOrEqual(EXECUTOR_OUTPUT_HARD_CAP);
  const eof = parsed[PAD_PAGE_EOF_FIELD];
  expect(
    typeof eof,
    "a bounded page must say explicitly whether more remains"
  ).toBe("boolean");
  const cursor = parsed[PAD_PAGE_CURSOR_FIELD];
  if (eof === false) {
    expect(
      typeof cursor,
      "a page that stopped short must report where to continue"
    ).toBe("number");
    expect(cursor as number).toBeGreaterThan(offset);
  }
  return {
    raw,
    content: content as string,
    cursor: typeof cursor === "number" ? cursor : offset,
    eof: eof === true,
  };
}

/** Follow the continuation until EOF; a page that stops making progress fails. */
function collectPadPages(
  tool: AciToolDef,
  taskId: string,
  tmpPath: string,
  maxPages = 40
): { readonly content: string; readonly pages: readonly PadPage[] } {
  const pages: PadPage[] = [];
  let offset = 0;
  for (let attempt = 0; attempt < maxPages; attempt += 1) {
    const page = readPadPage(tool, taskId, tmpPath, offset);
    pages.push(page);
    if (page.eof) {
      return { content: pages.map((p) => p.content).join(""), pages };
    }
    expect(page.cursor).toBeGreaterThan(offset);
    offset = page.cursor;
  }
  throw new Error(`paged pad read did not reach EOF within ${maxPages} pages`);
}

const contractScratch: string[] = [];

function makeContractSubagentsDir(): string {
  const root = mkdtempSync(join(tmpdir(), "iknow-t4-contract-"));
  contractScratch.push(root);
  const subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  return subagentsDir;
}

afterEach(() => {
  for (const path of contractScratch.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/**
 * Real manager + on-disk pad (a fake queryBuffer cannot prove page contents).
 * Same driver shape as `spawnSettled` above, parameterized by pad root so the
 * new suites can each own a scratch directory.
 */
async function settleWithPadFiles(
  subagentsDir: string,
  files: ReadonlyArray<{ readonly name: string; readonly body: string }>,
  envelope: { readonly summary: string; readonly result: string } = {
    summary: "done",
    result: "done",
  }
): Promise<{
  readonly manager: SubAgentManager;
  readonly tool: AciToolDef;
  readonly taskId: string;
  readonly pad: string;
}> {
  const child = makePadChild();
  const manager = createSubAgentManager({
    spawn: () => child as unknown as ChildProcess,
    subagentsDir,
  });
  const { taskId } = manager.spawn({ task: "pad" });
  const pad = workerFenceTmpPath(subagentsDir, taskId);
  mkdirSync(pad, { recursive: true });
  for (const file of files) {
    writeFileSync(join(pad, file.name), file.body, "utf8");
  }
  emitPadEnvelope(child, {
    status: "ok",
    summary: envelope.summary,
    result: envelope.result,
  });
  await flushPadTicks();
  return { manager, tool: createSubAgentResultTool({ manager }), taskId, pad };
}

/**
 * Two settled tasks under ONE real manager and ONE `subagent_result` tool:
 * each spawn gets its own fake child and its own pad, so a second task_id is a
 * real second worker rather than a routing stub.
 */
async function settleTwoPadTasks(
  subagentsDir: string,
  filesA: ReadonlyArray<{ readonly name: string; readonly body: string }>,
  filesB: ReadonlyArray<{ readonly name: string; readonly body: string }>
): Promise<{
  readonly manager: SubAgentManager;
  readonly tool: AciToolDef;
  readonly taskIdA: string;
  readonly taskIdB: string;
  readonly padA: string;
  readonly padB: string;
}> {
  const children = [makePadChild(), makePadChild()];
  let nextChild = 0;
  const manager = createSubAgentManager({
    spawn: () => children[nextChild++] as unknown as ChildProcess,
    subagentsDir,
  });
  const { taskId: taskIdA } = manager.spawn({ task: "pad A" });
  const { taskId: taskIdB } = manager.spawn({ task: "pad B" });
  const pads = [taskIdA, taskIdB].map((taskId) => {
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    mkdirSync(pad, { recursive: true });
    return pad;
  });
  for (const [index, files] of [filesA, filesB].entries()) {
    for (const file of files) {
      writeFileSync(join(pads[index]!, file.name), file.body, "utf8");
    }
  }
  emitPadEnvelope(children[0]!, {
    status: "ok",
    summary: "done A",
    result: "done A",
  });
  emitPadEnvelope(children[1]!, {
    status: "ok",
    summary: "done B",
    result: "done B",
  });
  await flushPadTicks();
  return {
    manager,
    tool: createSubAgentResultTool({ manager }),
    taskIdA,
    taskIdB,
    padA: pads[0]!,
    padB: pads[1]!,
  };
}

describe("subagent_result — paged pad read (continuation contract)", () => {
  let subagentsDir: string;

  beforeEach(() => {
    subagentsDir = makeContractSubagentsDir();
  });

  it("the public input schema accepts the continuation offset and stays closed to unknown keys", () => {
    const schema = createSubAgentResultTool({
      manager: makeFakeManager(),
    }).inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type?: string; minimum?: number }>;
    };
    // Existing frozen shape must survive: task_id required, no extra keys.
    expect(schema.required).toEqual(["task_id"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.tmp_path).toBeDefined();
    // The continuation argument — a non-negative integer, optional.
    expect(schema.properties[PAD_PAGE_OFFSET_ARG]).toBeDefined();
    expect(schema.properties[PAD_PAGE_OFFSET_ARG]?.type).toBe("integer");
    expect(schema.properties[PAD_PAGE_OFFSET_ARG]?.minimum).toBe(0);
  });

  it("a call without a page argument keeps the current decorated first-window behavior and its 200-line cap", async () => {
    const lines = Array.from({ length: 460 }, (_, i) => `P${i + 1}`);
    const body = `${lines.join("\n")}\n`;
    const { tool, taskId } = await settleWithPadFiles(subagentsDir, [
      { name: "pages.txt", body },
    ]);
    const legacy = JSON.parse(
      pollJson(tool, { task_id: taskId, tmp_path: "pages.txt" })
    ) as { status: string; content: string; truncated: boolean };
    expect(legacy.status).toBe("ok");
    expect(legacy.truncated).toBe(true);
    expect(legacy.content).toMatch(/^\s{5}1\tP1$/m);
    expect(legacy.content).toMatch(/P200$/m);
    expect(legacy.content).not.toMatch(/P201\b/);
    expect(padLineCount(legacy.content)).toBe(PAD_ROSTER_LINE_LIMIT);
  });

  it("a report beyond the first 200 lines exposes a NEXT page holding the tail witness", async () => {
    const lines = Array.from({ length: 460 }, (_, i) => `P${i + 1}`);
    lines[459] = "P460 <<TAIL-WITNESS-PAGED>>";
    const body = `${lines.join("\n")}\n`;
    const { tool, taskId } = await settleWithPadFiles(subagentsDir, [
      { name: "pages.txt", body },
    ]);
    expect(
      lines.length,
      "the fixture must exceed the pad's 200-line window, otherwise the first page already shows the tail"
    ).toBeGreaterThan(PAD_ROSTER_LINE_LIMIT);

    const first = readPadPage(tool, taskId, "pages.txt", 0);
    expect(first.eof).toBe(false);
    expect(first.content).not.toContain("<<TAIL-WITNESS-PAGED>>");
    expect(padLineCount(first.content)).toBeLessThanOrEqual(
      PAD_ROSTER_LINE_LIMIT
    );

    const { pages, content } = collectPadPages(tool, taskId, "pages.txt");
    expect(pages.length).toBeGreaterThan(1);
    expect(
      pages.some((page) => page.content.includes("<<TAIL-WITNESS-PAGED>>"))
    ).toBe(true);
    expect(content).toContain("<<TAIL-WITNESS-PAGED>>");
  });

  it("successive pages concatenated reproduce the original file in order, exactly", async () => {
    const lines = Array.from({ length: 460 }, (_, i) => `P${i + 1}`);
    const body = `${lines.join("\n")}\n`;
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "pages.txt", body },
    ]);
    const { content, pages } = collectPadPages(tool, taskId, "pages.txt");
    expect(content).toBe(readFileSync(join(pad, "pages.txt"), "utf8"));
    expect(content).toBe(body);
    // No page may reorder or repeat: order is line 1 first, line 460 last.
    expect(pages[0]?.content.startsWith("P1")).toBe(true);
    expect(pages[pages.length - 1]?.content).toContain("P460");
    for (const page of pages) {
      expect(padLineCount(page.content)).toBeLessThanOrEqual(
        PAD_ROSTER_LINE_LIMIT
      );
    }
  });

  it("a decorated first window that truncates hands over a raw cursor", async () => {
    const lines = Array.from({ length: 460 }, (_, i) => `P${i + 1}`);
    const body = `${lines.join("\n")}\n`;
    const { tool, taskId } = await settleWithPadFiles(subagentsDir, [
      { name: "pages.txt", body },
    ]);
    const first = JSON.parse(
      pollJson(tool, { task_id: taskId, tmp_path: "pages.txt" })
    ) as {
      status: string;
      content: string;
      truncated: boolean;
      eof?: boolean;
      next_offset?: number;
    };
    expect(first.truncated).toBe(true);
    // The model-visible contract is "pass next_offset back as offset"; a
    // truncated read without a cursor would strand the reader on page one.
    expect(first.eof).toBe(false);
    expect(typeof first.next_offset).toBe("number");

    const second = readPadPage(tool, taskId, "pages.txt", first.next_offset!);
    expect(second.content.startsWith("P201\n")).toBe(true);
    expect(second.content).not.toContain("P200\n");
    // The hand-off is gap-free: the cursor is exactly where the raw remainder
    // begins, so no line is skipped and none is shown twice.
    expect(first.next_offset).toBe(body.indexOf("P201\n"));
  });

  it("a complete decorated window reports no cursor because nothing remains", async () => {
    const body = "one\ntwo\nthree\n";
    const { tool, taskId } = await settleWithPadFiles(subagentsDir, [
      { name: "short.txt", body },
    ]);
    const read = JSON.parse(
      pollJson(tool, { task_id: taskId, tmp_path: "short.txt" })
    ) as Record<string, unknown>;
    expect(read.truncated).toBe(false);
    expect("eof" in read).toBe(false);
    expect("next_offset" in read).toBe(false);
  });

  it("an offset landing inside a surrogate pair opens the page on the next code point", async () => {
    // One emoji is two UTF-16 units; an offset between them would otherwise
    // hand back a lone low surrogate the consumer cannot render.
    const body = `head🙂tail\n${"x".repeat(200)}\n`;
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "pair.txt", body },
    ]);
    const misaligned = body.indexOf("🙂") + 1;
    expect(body.charCodeAt(misaligned)).toBeGreaterThanOrEqual(0xdc00);
    const page = readPadPage(tool, taskId, "pair.txt", misaligned);
    expect(hasLoneSurrogate(page.content)).toBe(false);
    // The stray low half is snapped forward past, never emitted alone.
    expect(page.content.startsWith("tail\n")).toBe(true);
    expect(readFileSync(join(pad, "pair.txt"), "utf8")).toBe(body);
  });

  it("an invalid continuation offset is a typed input error, never a silent first page", async () => {
    const body = `${Array.from({ length: 460 }, (_, i) => `P${i + 1}`).join("\n")}\n`;
    const { tool, taskId } = await settleWithPadFiles(subagentsDir, [
      { name: "pages.txt", body },
    ]);
    expect(() =>
      tool.handler({
        task_id: taskId,
        tmp_path: "pages.txt",
        [PAD_PAGE_OFFSET_ARG]: -1,
      })
    ).toThrow(ToolExecutionError);
    expect(() =>
      tool.handler({
        task_id: taskId,
        tmp_path: "pages.txt",
        [PAD_PAGE_OFFSET_ARG]: 1.5,
      })
    ).toThrow(ToolExecutionError);

    // An offset past the end has nothing to show: a typed rejection naming the
    // cursor problem, never a fabricated full page or a silent restart at 0.
    let beyond: string | undefined;
    try {
      beyond = pollJson(tool, {
        task_id: taskId,
        tmp_path: "pages.txt",
        [PAD_PAGE_OFFSET_ARG]: Number.MAX_SAFE_INTEGER,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError);
    }
    if (beyond !== undefined) {
      const parsed = JSON.parse(beyond) as {
        status: string;
        content?: string;
        reason?: string;
      };
      expect(parsed.status).toBe("rejected");
      expect(typeof parsed.reason).toBe("string");
      expect(parsed.content).toBeUndefined();
    }
  });
});

// ── Concurrent readers on the pad ───────────────────────────────────────────
//
// `subagent_result` is declared concurrency-safe, so a parent may issue several
// pad reads in one turn — repeat calls at the same cursor, two chains walking
// the same file, or two tasks read side by side. The reader holds no per-file
// cursor, so every one of those must be independent: a page is decided by its
// own (task_id, tmp_path, offset) arguments alone, and each chain still
// concatenates to its own file.

/** One async batch: the calls run as separate tasks, interleaved at awaits. */
function readConcurrently<T>(
  thunks: ReadonlyArray<() => T>
): Promise<Awaited<T>[]> {
  return Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk)));
}

function padPageContents(
  tool: AciToolDef,
  taskId: string,
  tmpPath: string,
  offset: number
): string {
  return readPadPage(tool, taskId, tmpPath, offset).content;
}

describe("subagent_result — concurrent pad readers", () => {
  let subagentsDir: string;

  beforeEach(() => {
    subagentsDir = makeContractSubagentsDir();
  });

  it("repeated concurrent reads at the same task_id and offset return the same page", async () => {
    const lines = Array.from({ length: 460 }, (_, i) => `P${i + 1}`);
    const body = `${lines.join("\n")}\n`;
    const { tool, taskId } = await settleWithPadFiles(subagentsDir, [
      { name: "pages.txt", body },
    ]);
    const pages = await readConcurrently(
      Array.from(
        { length: 5 },
        () => () => padPageContents(tool, taskId, "pages.txt", 0)
      )
    );
    for (const page of pages) {
      expect(page).toBe(pages[0]);
    }
    expect(pages[0].startsWith("P1\n")).toBe(true);
    expect(hasLoneSurrogate(pages[0])).toBe(false);
  });

  it("two chains walking one file at different offsets stay independent when interleaved", async () => {
    const lines = Array.from({ length: 660 }, (_, i) => `P${i + 1}`);
    lines[659] = "P660 <<TAIL-WITNESS-CONCURRENT>>";
    const body = `${lines.join("\n")}\n`;
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "pages.txt", body },
    ]);
    // Chain A from the start, chain B from the middle, advanced one step per
    // round so the calls genuinely interleave rather than run to completion.
    const collect = async (start: number): Promise<string> => {
      let offset = start;
      let acc = "";
      for (let page = 0; page < 40; page += 1) {
        const view = readPadPage(tool, taskId, "pages.txt", offset);
        acc += view.content;
        if (view.eof) return acc;
        offset = view.cursor;
        // Yield between pages: the other chain gets a turn at every step.
        await Promise.resolve();
      }
      throw new Error("chain did not reach EOF");
    };
    const [fromZero, fromMiddle] = await Promise.all([
      collect(0),
      collect(body.indexOf("P201\n")),
    ]);
    expect(fromZero).toBe(readFileSync(join(pad, "pages.txt"), "utf8"));
    const middle = body.slice(body.indexOf("P201\n"));
    expect(fromMiddle).toBe(middle);
    expect(fromZero).toContain("<<TAIL-WITNESS-CONCURRENT>>");
    expect(fromMiddle).toContain("<<TAIL-WITNESS-CONCURRENT>>");
  });

  it("two distinct task_ids read their own files when paged concurrently", async () => {
    const bodyA = `${Array.from({ length: 460 }, (_, i) => `A${i + 1}`).join("\n")}\n`;
    const bodyB = `${Array.from({ length: 460 }, (_, i) => `B${i + 1}`).join("\n")}\n`;
    const { tool, taskIdA, taskIdB, padA, padB } = await settleTwoPadTasks(
      subagentsDir,
      [{ name: "pages.txt", body: bodyA }],
      [{ name: "pages.txt", body: bodyB }]
    );
    expect(taskIdA).not.toBe(taskIdB);
    const [chainA, chainB] = await Promise.all([
      Promise.resolve().then(() => collectPadPages(tool, taskIdA, "pages.txt")),
      Promise.resolve().then(() => collectPadPages(tool, taskIdB, "pages.txt")),
    ]);
    // Each chain is independent: its own file, its own bytes, no cross-talk.
    expect(chainA.content).toBe(readFileSync(join(padA, "pages.txt"), "utf8"));
    expect(chainB.content).toBe(readFileSync(join(padB, "pages.txt"), "utf8"));
    expect(chainA.content).toBe(bodyA);
    expect(chainB.content).toBe(bodyB);
    expect(chainB.content).not.toContain("A1\n");
  });
});

describe("subagent_result — wide-report pages", () => {
  let subagentsDir: string;

  beforeEach(() => {
    subagentsDir = makeContractSubagentsDir();
  });

  it("one line longer than the page budget still arrives complete, with no silently dropped tail", async () => {
    const single = `${"W".repeat(50_000)}\n`;
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "wide.txt", body: single },
    ]);
    const { content, pages } = collectPadPages(tool, taskId, "wide.txt");
    expect(pages.length).toBeGreaterThan(1);
    expect(content).toBe(readFileSync(join(pad, "wide.txt"), "utf8"));
    expect(content).toBe(single);
  });

  it("wide Unicode lines split across pages preserve CRLF endings and code points exactly", async () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) =>
        `#${i + 1} ${"漢字".repeat(400)} ${"🙂".repeat(400)} e\u0301 combining ${i + 1}`
    );
    const body = `${lines.join("\r\n")}\r\n<<TAIL-WITNESS-WIDE>>\r\n`;
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "wide-lines.txt", body },
    ]);
    const { content, pages } = collectPadPages(tool, taskId, "wide-lines.txt");
    expect(pages.length).toBeGreaterThan(1);
    expect(content).toBe(readFileSync(join(pad, "wide-lines.txt"), "utf8"));
    expect(content).toBe(body);
    expect(content.includes("\r\n")).toBe(true);
    for (const page of pages) {
      expect(
        hasLoneSurrogate(page.content),
        "a page boundary may not split a surrogate pair"
      ).toBe(false);
      expect(page.content.includes("\uFFFD")).toBe(false);
      expect(page.raw.length).toBeLessThanOrEqual(EXECUTOR_OUTPUT_HARD_CAP);
    }
    expect(Array.from(content).length).toBe(Array.from(body).length);
  });
});

describe("subagent_result — failure surfaces at the public pad boundary", () => {
  let subagentsDir: string;

  beforeEach(() => {
    subagentsDir = makeContractSubagentsDir();
  });

  it("empty or whitespace-only final text fabricates no final.md and reads as a typed rejection", async () => {
    for (const result of ["", "   \n\t "]) {
      const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [], {
        summary: "done",
        result,
      });
      expect(existsSync(join(pad, FINAL_TEXT_PAD_NAME))).toBe(false);
      const listed = JSON.parse(pollJson(tool, { task_id: taskId })) as {
        tmp_names?: string[];
        output_path?: string;
      };
      expect(listed.output_path).toBeUndefined();
      expect(listed.tmp_names ?? []).not.toContain(FINAL_TEXT_PAD_NAME);
      const read = JSON.parse(
        pollJson(tool, { task_id: taskId, tmp_path: FINAL_TEXT_PAD_NAME })
      ) as { status: string; reason?: string; content?: string };
      expect(read.status).toBe("rejected");
      expect(typeof read.reason).toBe("string");
      expect(read.content).toBeUndefined();
    }
  });

  it("a pad file over the 1 MiB cap is a structured rejection with no raw fs text or host path", async () => {
    const oversized = "A".repeat(READ_FILE_MAX_FILE_BYTES + 1);
    expect(oversized.length).toBeGreaterThan(READ_FILE_MAX_FILE_BYTES);
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "huge.txt", body: oversized },
    ]);
    // The cap constrains a paged read exactly like a plain one (T4 keeps it).
    for (const offset of [undefined, 0, 500]) {
      const input: Record<string, unknown> = {
        task_id: taskId,
        tmp_path: "huge.txt",
      };
      if (offset !== undefined) input[PAD_PAGE_OFFSET_ARG] = offset;
      const out = pollJson(tool, input);
      const parsed = JSON.parse(out) as {
        status: string;
        reason?: string;
        content?: string;
      };
      expect(parsed.status).toBe("rejected");
      expect(typeof parsed.reason).toBe("string");
      expect(parsed.content).toBeUndefined();
      expect(out).not.toContain(pad);
      expect(out).not.toMatch(/ENOENT|EACCES|EISDIR|ENOTDIR|Error:/);
    }
  });

  it("a binary (NUL byte) pad file is a structured rejection, never raw bytes", async () => {
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "blob.bin", body: "head\u0000tail" },
    ]);
    const out = pollJson(tool, { task_id: taskId, tmp_path: "blob.bin" });
    const parsed = JSON.parse(out) as {
      status: string;
      reason?: string;
      content?: string;
    };
    expect(parsed.status).toBe("rejected");
    expect(typeof parsed.reason).toBe("string");
    expect(parsed.content).toBeUndefined();
    expect(out).not.toContain("head");
    expect(out).not.toContain(pad);
  });

  it("an unreadable pad file (EACCES) is a typed rejection, not a thrown stack or a host path", async () => {
    // EACCES cannot be produced for uid 0, so the case is exercised only where
    // the filesystem can actually deny the read (same environment precondition
    // as tests/subagent/worker-identity-record.test.ts); it is not a way to skip
    // the contract — the assertions run on any unprivileged runner.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "locked.txt", body: "SECRET-PAD-BODY" },
    ]);
    chmodSync(join(pad, "locked.txt"), 0o000);
    try {
      const out = pollJson(tool, { task_id: taskId, tmp_path: "locked.txt" });
      const parsed = JSON.parse(out) as {
        status: string;
        reason?: string;
        content?: string;
      };
      expect(parsed.status).toBe("rejected");
      expect(typeof parsed.reason).toBe("string");
      expect(parsed.content).toBeUndefined();
      expect(out).not.toContain("SECRET-PAD-BODY");
      expect(out).not.toContain("EACCES");
      expect(out).not.toContain(pad);
      expect(out).not.toMatch(/at .*\.ts:\d+/);
    } finally {
      chmodSync(join(pad, "locked.txt"), 0o600);
    }
  });

  it("a pad whose final.md could not be written stays a typed rejection at the read boundary", async () => {
    const child = makePadChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "pad write failed" });
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    mkdirSync(join(pad, FINAL_TEXT_PAD_NAME), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      emitPadEnvelope(child, {
        status: "ok",
        summary: "done",
        result: "body that cannot land",
      });
      await flushPadTicks();
      const tool = createSubAgentResultTool({ manager });
      const out = pollJson(tool, {
        task_id: taskId,
        tmp_path: FINAL_TEXT_PAD_NAME,
      });
      const parsed = JSON.parse(out) as {
        status: string;
        reason?: string;
        content?: string;
      };
      expect(parsed.status).toBe("rejected");
      expect(typeof parsed.reason).toBe("string");
      expect(out).not.toContain("body that cannot land");
      expect(out).not.toContain(pad);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("subagent_result — path privacy of the pad fence", () => {
  let subagentsDir: string;
  let sessionRoot: string;

  beforeEach(() => {
    sessionRoot = mkdtempSync(join(tmpdir(), "iknow-t4-outer-"));
    contractScratch.push(sessionRoot);
    subagentsDir = makeContractSubagentsDir();
  });

  it("absolute and `..` attempts stay typed rejects and echo no host path", async () => {
    const secret = join(sessionRoot, "secret.txt");
    writeFileSync(secret, "SESSION-SECRET-PRIVACY", "utf8");
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "inside.txt", body: "inside-pad" },
    ]);
    for (const attempt of [
      secret,
      "../secret.txt",
      "inside.txt/../../secret.txt",
      "./../secret.txt",
    ]) {
      const out = pollJson(tool, { task_id: taskId, tmp_path: attempt });
      const parsed = JSON.parse(out) as {
        status: string;
        reason?: string;
        content?: string;
      };
      expect(parsed.status).toBe("rejected");
      expect(parsed.reason).toBe("path_escape");
      expect(parsed.content).toBeUndefined();
      expect(out).not.toContain("SESSION-SECRET-PRIVACY");
      expect(out).not.toContain(sessionRoot);
      expect(out).not.toContain(pad);
    }
    expect(readFileSync(secret, "utf8")).toBe("SESSION-SECRET-PRIVACY");
  });

  it("a symlink inside the pad pointing outside is a typed reject and its target is never read", async () => {
    const secret = join(sessionRoot, "linked-secret.txt");
    writeFileSync(secret, "SYMLINK-TARGET-SECRET", "utf8");
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "real.txt", body: "inside-pad" },
    ]);
    symlinkSync(secret, join(pad, "escape-link"));
    const out = pollJson(tool, { task_id: taskId, tmp_path: "escape-link" });
    const parsed = JSON.parse(out) as {
      status: string;
      reason?: string;
      content?: string;
    };
    expect(parsed.status).toBe("rejected");
    expect(parsed.reason).toBe("path_escape");
    expect(parsed.content).toBeUndefined();
    expect(out).not.toContain("SYMLINK-TARGET-SECRET");
    expect(out).not.toContain(sessionRoot);
    expect(readFileSync(join(pad, "real.txt"), "utf8")).toBe("inside-pad");
  });

  it("a pad root removed after the terminal write reads as a typed rejection, not a filesystem error", async () => {
    const { tool, taskId, pad } = await settleWithPadFiles(subagentsDir, [
      { name: "gone.txt", body: "was-here" },
    ]);
    rmSync(pad, { recursive: true, force: true });
    const out = pollJson(tool, { task_id: taskId, tmp_path: "gone.txt" });
    const parsed = JSON.parse(out) as {
      status: string;
      reason?: string;
      content?: string;
    };
    expect(parsed.status).toBe("rejected");
    expect(typeof parsed.reason).toBe("string");
    expect(parsed.content).toBeUndefined();
    expect(out).not.toContain("ENOENT");
    expect(out).not.toContain(pad);
  });
});
