/**
 * #620 T3 (spec session-jsonl-resume D4):turn 内 commit —— assistant 消息与
 * 每个 tool_result 落权威历史后,立刻经 host 注入的 `commitMessages` 钩子上盘;
 * loop-engine 自身零 IO(Gate B:无 session-api 类型 / 无 store IO 入内核)。
 *
 * 覆盖:
 *   1. acceptance(plan T3 验收):stub 两工具串行,第一个 tool_result 已
 *      commit 后中断(第二次 tool_result commit 抛错模拟崩溃)→ 盘上 JSONL
 *      有 assistant 事件与第一条 tool_result,无第二条;
 *   2. ordering/content:commit 序列 = [assistant] → [user(tr_a)] →
 *      [user(tr_b)] → [assistant final];tool_result 事件内容与进权威历史的
 *      encoded block 逐块一致(encodeToolResults 是逐元素 map);内存侧仍是
 *      单条 user message 装全部 tool_result(byte-identical 纪律);
 *   3. failure policy:assistant commit 抛错 → MessageCommitError(cause
 *      保留)中止 run,工具阶段不执行;不重试、不吞咽;
 *   4. static guard:loop 路径源码(loop-engine.ts / tools/executor.ts /
 *      index.ts)无 store IO 词(appendEvents / store.save / writeFile /
 *      appendFile / readFile / checkpoint / session-api import);全
 *      src/harness 无 appendEvents / store.save 引用。
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { run } from "../../src/harness/loop-engine.ts";
import { MessageCommitError } from "../../src/harness/errors.ts";
import type {
  AnthropicNativeMessage,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  projectSessionLog,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";

// -- fixtures ----------------------------------------------------------------

const tempDirs: string[] = [];
async function storeFor(): Promise<{
  readonly store: SessionStore;
  readonly sessionDir: string;
}> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-t3-commit-"));
  tempDirs.push(tmp);
  return {
    store: new SessionStore(tmp, process.cwd()),
    sessionDir: resolveProjectSessionDir(tmp, process.cwd()),
  };
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function emptySessionFile(id: string): SessionFileV1 {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    title: "",
    cwd: process.cwd(),
    sanitized_at: new Date().toISOString(),
    checkpoints: [],
  };
}

/** 两工具串行的 stub 装配:alpha → "result-a",beta → "result-b"。 */
function twoToolDeps(opts: {
  readonly commitMessages?: LoopEngineDeps["commitMessages"];
  readonly onToolRun?: (name: string) => void;
}): LoopEngineDeps {
  const alpha = createStubTool({
    name: "alpha",
    next: () => {
      opts.onToolRun?.("alpha");
      return "result-a";
    },
  });
  const beta = createStubTool({
    name: "beta",
    next: () => {
      opts.onToolRun?.("beta");
      return "result-b";
    },
  });
  const registry = createRegistry([alpha, beta]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [
          { id: "a", name: "alpha", input: {} },
          { id: "b", name: "beta", input: {} },
        ],
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  return {
    adapter,
    executor,
    registry,
    maxTurns: 5,
    ...(opts.commitMessages !== undefined
      ? { commitMessages: opts.commitMessages }
      : {}),
  };
}

// -- 1. acceptance: 边跑边写,半截 turn 盘上可见 ------------------------------

describe("T3 acceptance: 第一个 tool_result commit 后中断", () => {
  it("盘上 JSONL 有 assistant 事件与第一条 tool_result,无第二条", async () => {
    const { store, sessionDir } = await storeFor();
    const id = "t3-acceptance";
    // host 侧前置:会话 JSONL 已存在(hub createSession / chat bootstrap 语义)。
    await store.save({ id, file: emptySessionFile(id) });

    const boom = new Error("simulated crash on second tool_result commit");
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    let calls = 0;
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      calls += 1;
      if (calls === 3) throw boom; // 第 2 条 tool_result 的 commit = 崩溃点
      committed.push(messages);
      await store.appendEvents({ id, events: messages });
    };

    await assert.rejects(
      run("go", twoToolDeps({ commitMessages })),
      (err: unknown) => {
        assert.ok(
          err instanceof MessageCommitError,
          `expected MessageCommitError, got ${String(err)}`
        );
        assert.equal(err.cause, boom);
        return true;
      }
    );

    // commit 恰好被调 3 次:assistant、tr_a、tr_b(崩溃);前两次已落盘。
    assert.equal(calls, 3);
    const raw = await readFile(join(sessionDir, `${id}.jsonl`), "utf8");
    const log = parseSessionJsonl(raw);
    assert.equal(log.events.length, 2);
    // e0 = assistant(含两个 tool_use),e1 = 第一条 tool_result 的 user message。
    assert.equal(log.events[0]!.id, "e0");
    assert.equal(log.events[0]!.parent, null);
    assert.equal(log.events[0]!.message.role, "assistant");
    assert.equal(log.events[1]!.id, "e1");
    assert.equal(log.events[1]!.parent, "e0");
    assert.equal(log.events[1]!.message.role, "user");
    // 盘上 tool_result 块 = encoded form(与进权威历史的块同形)。
    assert.deepEqual(log.events[1]!.message.content, [
      {
        type: "tool_result",
        tool_use_id: "a",
        content: [{ type: "text", text: "result-a" }],
      },
    ]);
    // head 指向第一条 tool_result;第二条 tool_result 绝不在盘上。
    assert.equal(log.head, "e1");
    assert.ok(
      !raw.includes('"tool_use_id":"b"'),
      "second tool_result must NOT be on disk"
    );
    // 投影 = 崩溃时刻的权威 transcript 前缀。
    const projected = projectSessionLog(log);
    assert.equal(projected.messages.length, 2);
    assert.equal(projected.messages[0]!.role, "assistant");
    assert.equal(projected.messages[1]!.role, "user");
  });
});

// -- 2. ordering / content ---------------------------------------------------

describe("T3 ordering: commit 序列与内容", () => {
  it("[assistant] → [user(tr_a)] → [user(tr_b)] → [assistant final];内存仍单条 user message", async () => {
    const commits: AnthropicNativeMessage[][] = [];
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      commits.push([...messages]);
    };
    const { result } = await run("go", twoToolDeps({ commitMessages }));
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);

    // 4 次 commit,每次恰好一条消息,顺序与权威历史一致。
    assert.equal(commits.length, 4);
    for (const batch of commits) assert.equal(batch.length, 1);
    assert.equal(commits[0]![0]!.role, "assistant");
    assert.equal(commits[1]![0]!.role, "user");
    assert.equal(commits[2]![0]!.role, "user");
    assert.equal(commits[3]![0]!.role, "assistant");

    // 内存侧 byte-identical 纪律:两个 tool_result 仍合并在单条 user message。
    assert.equal(result.messages.length, 4);
    const memoryToolMsg = result.messages[2]!;
    assert.equal(memoryToolMsg.role, "user");
    assert.equal(memoryToolMsg.content.length, 2);

    // 盘上(钩子所见)块与内存块逐块一致 —— encoded form 同源。
    assert.deepEqual(commits[1]![0]!.content[0], memoryToolMsg.content[0]);
    assert.deepEqual(commits[2]![0]!.content[0], memoryToolMsg.content[1]);
    // assistant / final assistant 与内存同形。
    assert.deepEqual(commits[0]![0], result.messages[1]);
    assert.deepEqual(commits[3]![0], result.messages[3]);
  });
});

// -- 3. failure policy ---------------------------------------------------------

describe("T3 failure policy: commit 失败", () => {
  it("assistant commit 抛错 → MessageCommitError 中止 run,工具阶段不执行", async () => {
    const boom = new Error("disk full");
    const ran: string[] = [];
    const commitMessages = async (): Promise<void> => {
      throw boom;
    };
    await assert.rejects(
      run(
        "go",
        twoToolDeps({
          commitMessages,
          onToolRun: (name) => ran.push(name),
        })
      ),
      (err: unknown) => {
        assert.ok(err instanceof MessageCommitError);
        assert.equal(err.cause, boom);
        return true;
      }
    );
    assert.deepEqual(ran, []);
  });

  it("钩子缺席 → 零 commit 零 IO,run 正常完成(行为不变)", async () => {
    const { result } = await run("go", twoToolDeps({}));
    assert.equal(result.stopReason, "completed");
    assert.equal(result.messages.length, 4);
  });
});

// -- 4. static guard: loop 路径零 store IO -------------------------------------

describe("T3 static guard: harness 零 IO 守门", () => {
  const HARNESS_DIR = join(import.meta.dirname, "..", "..", "src", "harness");

  function listSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) out.push(...listSources(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  function collectViolations(
    files: ReadonlyArray<string>,
    patterns: ReadonlyArray<{ readonly name: string; readonly re: RegExp }>
  ): string[] {
    const violations: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        for (const p of patterns) {
          if (p.re.test(line)) {
            violations.push(`${f}:${idx + 1} (${p.name}) ${line.trim()}`);
          }
        }
      });
    }
    return violations;
  }

  it("全 src/harness 无 appendEvents / store.save 引用", () => {
    const violations = collectViolations(listSources(HARNESS_DIR), [
      { name: "appendEvents", re: /appendEvents/ },
      { name: "store.save", re: /store\.save/ },
    ]);
    assert.deepEqual(violations, []);
  });

  it("loop 路径(loop-engine.ts / tools/executor.ts / index.ts)零 store IO 词", () => {
    const loopFiles = [
      join(HARNESS_DIR, "loop-engine.ts"),
      join(HARNESS_DIR, "tools", "executor.ts"),
      join(HARNESS_DIR, "index.ts"),
    ];
    const violations = collectViolations(loopFiles, [
      { name: "appendEvents", re: /appendEvents/ },
      { name: "store.save", re: /store\.save/ },
      { name: "writeFile", re: /writeFile/ },
      { name: "appendFile", re: /appendFile/ },
      { name: "readFile", re: /readFile/ },
      { name: "checkpoint", re: /checkpoint/i },
      { name: "session-api import", re: /from\s+["'][^"']*session-api/ },
    ]);
    assert.deepEqual(violations, []);
  });
});
