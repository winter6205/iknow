/**
 * In-turn commit: once the assistant message and each tool_result land in the
 * authoritative history, they flush to disk immediately through the
 * host-injected `commitMessages` hook; loop-engine itself performs zero IO
 * (Gate B: no session-api types / no store IO inside the kernel).
 *
 * Coverage:
 *   1. acceptance: stub with two sequential tools; abort after the first
 *      tool_result commit (second commit throws to simulate a crash) → on-disk
 *      JSONL holds the assistant event and the first tool_result, not the second;
 *   2. ordering/content: commit sequence = [assistant] → [user(tr_a)] →
 *      [user(tr_b)] → [assistant final]; tool_result event content matches the
 *      encoded blocks entering authoritative history block-by-block
 *      (encodeToolResults is an element-wise map); in memory all tool_results
 *      still sit in a single user message (byte-identical discipline);
 *   3. failure policy: assistant commit throws → run aborts with
 *      MessageCommitError (cause preserved) before the tool phase; no retry,
 *      no swallowing;
 *   4. static guard: loop-path sources (loop-engine.ts / tools/executor.ts /
 *      index.ts) contain no store-IO vocabulary (appendEvents / store.save /
 *      writeFile / appendFile / readFile / checkpoint / session-api import);
 *      all of src/harness has no appendEvents / store.save references.
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
  AssistantTurnResult,
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
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";

// -- fixtures ----------------------------------------------------------------

// Boundary fixture: shape-compatible with AnthropicNativeMessage without
// pulling a deep import graph (mirror of session-store.test.ts shape helpers).
function assistantMsgShape(text: string): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

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

/** Stub wiring with two sequential tools: alpha → "result-a", beta → "result-b". */
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

// -- 1. acceptance: commit-as-you-run, mid-turn state visible on disk --------

describe("T3 acceptance: 第一个 tool_result commit 后中断", () => {
  it("盘上 JSONL 有 assistant 事件与第一条 tool_result,无第二条", async () => {
    const { store, sessionDir } = await storeFor();
    const id = "t3-acceptance";
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    // Host-side precondition: the conversation JSONL already exists (hub createSession / chat bootstrap semantics).
    await store.save({ id, file: emptySessionFile(id) });

    const boom = new Error("simulated crash on second tool_result commit");
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    let calls = 0;
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      calls += 1;
      if (calls === 3) throw boom; // second tool_result's commit = crash point
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

    // commit called exactly 3 times: assistant, tr_a, tr_b (crash); the first two already flushed.
    assert.equal(calls, 3);
    const raw = await readFile(join(dir, `${id}.jsonl`), "utf8");
    const log = parseSessionJsonl(raw);
    assert.equal(log.events.length, 2);
    // e0 = assistant (carrying two tool_uses); e1 = the first tool_result's user message.
    assert.equal(log.events[0]!.id, "e0");
    assert.equal(log.events[0]!.parent, null);
    assert.equal(log.events[0]!.message.role, "assistant");
    assert.equal(log.events[1]!.id, "e1");
    assert.equal(log.events[1]!.parent, "e0");
    assert.equal(log.events[1]!.message.role, "user");
    // On-disk tool_result block = encoded form (same shape as what enters authoritative history).
    assert.deepEqual(log.events[1]!.message.content, [
      {
        type: "tool_result",
        tool_use_id: "a",
        content: [{ type: "text", text: "result-a" }],
      },
    ]);
    // head points at the first tool_result; the second tool_result must never reach disk.
    assert.equal(log.head, "e1");
    assert.ok(
      !raw.includes('"tool_use_id":"b"'),
      "second tool_result must NOT be on disk"
    );
    // projection = the authoritative transcript prefix as of the crash moment.
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
      messages: ReadonlyArray<AnthropicNativeMessage>,
      thinkingMs?: number
    ): Promise<void> => {
      commits.push([...messages]);
      // thinkingMs is carried only on assistant commit batches; tool_result
      // batches see thinkingMs === undefined (committed[1] / [2]).
      if (messages[0]?.role === "assistant") {
        assert.equal(
          thinkingMs,
          undefined,
          "stub 流式回合无 thinkingMs → assistant commit 也应传 undefined"
        );
      } else {
        assert.equal(
          thinkingMs,
          undefined,
          "tool_result commit 永远传 undefined(thinkingMs 仅 assistant 携带)"
        );
      }
    };
    const { result } = await run("go", twoToolDeps({ commitMessages }));
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 2);

    // 4 commits, exactly one message each, ordered as in authoritative history.
    assert.equal(commits.length, 4);
    for (const batch of commits) assert.equal(batch.length, 1);
    assert.equal(commits[0]![0]!.role, "assistant");
    assert.equal(commits[1]![0]!.role, "user");
    assert.equal(commits[2]![0]!.role, "user");
    assert.equal(commits[3]![0]!.role, "assistant");

    // Memory-side byte-identical discipline: both tool_results still merged into one user message.
    assert.equal(result.messages.length, 4);
    const memoryToolMsg = result.messages[2]!;
    assert.equal(memoryToolMsg.role, "user");
    assert.equal(memoryToolMsg.content.length, 2);

    // Blocks seen by the hook (disk side) match the memory blocks block-by-block — same encoded-form source.
    assert.deepEqual(commits[1]![0]!.content[0], memoryToolMsg.content[0]);
    assert.deepEqual(commits[2]![0]!.content[0], memoryToolMsg.content[1]);
    // assistant / final assistant same shape as memory.
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

// -- 4. thinkingMs commit seam ------------------------------------------------

describe("D2 acceptance: thinkingMs flows from adapter to JSONL event record", () => {
  // Stub harness: the stub streaming arm stamps thinkingMs manually before
  // step returns (real measurement lives in the SDK streaming path inside the
  // adapter, which the stub model does not simulate; writing the value on
  // stub-model's AssistantTurnResult mimics "adapter already measured" to
  // verify the commit-seam + hub wiring end to end).
  function stubWithThinkingMs(
    thinkingMsByStep: ReadonlyArray<number | undefined>
  ): AssistantTurnResult[] {
    return thinkingMsByStep.map((ms, i) => ({
      ...assistantResult({
        texts: i === thinkingMsByStep.length - 1 ? [`done-${i}`] : [""],
        toolCalls:
          i < thinkingMsByStep.length - 1
            ? [{ id: `tc-${i}`, name: "alpha", input: {} }]
            : [],
      }),
      ...(ms !== undefined ? { thinkingMs: ms } : {}),
    }));
  }

  it("stub 流式回合带 thinkingMs → 盘上 JSONL assistant 事件挂值", async () => {
    const { store, sessionDir } = await storeFor();
    const id = "d2-thinking";
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    await store.save({ id, file: emptySessionFile(id) });

    const responses = stubWithThinkingMs([1500, 2300]);
    const adapter = createStubModel({ responses });
    const alpha = createStubTool({ name: "alpha", next: () => "ok" });
    const registry = createRegistry([alpha]);
    const executor = createExecutor(registry);
    const committedThinking: (number | undefined)[] = [];
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>,
      thinkingMs?: number
    ): Promise<void> => {
      committedThinking.push(thinkingMs);
      await store.appendEvents({
        id,
        events: messages,
        ...(thinkingMs !== undefined ? { thinkingMs } : {}),
      });
    };
    const deps: LoopEngineDeps = {
      adapter,
      executor,
      registry,
      maxTurns: 5,
      commitMessages,
    };
    await run("go", deps);

    // 3 commits: assistant(1500) → tool_result user → assistant final(2300).
    assert.deepEqual(committedThinking, [1500, undefined, 2300]);
    const raw = await readFile(join(dir, `${id}.jsonl`), "utf8");
    const log = parseSessionJsonl(raw);
    assert.equal(log.events.length, 3);
    // e0 assistant — thinkingMs = 1500
    assert.equal(log.events[0]!.message.role, "assistant");
    assert.equal(log.events[0]!.thinkingMs, 1500);
    // e1 user (tool_result) — no thinkingMs key
    assert.equal(log.events[1]!.message.role, "user");
    assert.equal(
      "thinkingMs" in log.events[1]!,
      false,
      "user event must NOT carry thinkingMs"
    );
    // e2 assistant final — thinkingMs = 2300
    assert.equal(log.events[2]!.message.role, "assistant");
    assert.equal(log.events[2]!.thinkingMs, 2300);
  });

  it("无思考(thinkingMs 缺席) → 助手事件不挂 key(load projection 也不挂 array)", async () => {
    const { store, sessionDir } = await storeFor();
    const id = "d2-no-thinking";
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: id,
    });
    await store.save({ id, file: emptySessionFile(id) });

    const responses = stubWithThinkingMs([undefined, undefined]);
    const adapter = createStubModel({ responses });
    const alpha = createStubTool({ name: "alpha", next: () => "ok" });
    const registry = createRegistry([alpha]);
    const executor = createExecutor(registry);
    const committedThinking: (number | undefined)[] = [];
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>,
      thinkingMs?: number
    ): Promise<void> => {
      committedThinking.push(thinkingMs);
      await store.appendEvents({
        id,
        events: messages,
        ...(thinkingMs !== undefined ? { thinkingMs } : {}),
      });
    };
    const deps: LoopEngineDeps = {
      adapter,
      executor,
      registry,
      maxTurns: 5,
      commitMessages,
    };
    await run("go", deps);

    // All undefined → all absent.
    assert.deepEqual(committedThinking, [undefined, undefined, undefined]);
    const raw = await readFile(join(dir, `${id}.jsonl`), "utf8");
    const log = parseSessionJsonl(raw);
    for (const event of log.events) {
      assert.equal(
        "thinkingMs" in event,
        false,
        `event ${event.id} must NOT carry thinkingMs when adapter measures undefined`
      );
    }
    // Load projection follows spread discipline: nothing carries it → no key.
    const projected = projectSessionLog(log);
    assert.equal(
      "thinkingMs" in projected,
      false,
      "load must not grow thinkingMs key when no event carries it"
    );
  });

  it("边界非法(thinkingMs <= 0 / 非有限数) → appendEvents 过滤不挂 key", async () => {
    // Boundary shape verified at the store layer (the commit seam adds no
    // validation; the store entry filters): call store.appendEvents directly
    // with illegal values → no key stamped.
    const { store, sessionDir } = await storeFor();
    const id = "d2-boundary";
    await store.save({ id, file: emptySessionFile(id) });
    const illegal: unknown[] = [0, -1, NaN, Infinity, -Infinity];
    for (let i = 0; i < illegal.length; i++) {
      const seqId = `${id}-${i}`;
      await store.save({ id: seqId, file: emptySessionFile(seqId) });
      const seqDir = resolveConversationDir({
        projectDir: sessionDir,
        conversationId: seqId,
      });
      // ts-expect-error -- probe defensive behavior on illegal values
      await store.appendEvents({
        id: seqId,
        events: [assistantMsgShape(`a-${i}`)],
        thinkingMs: illegal[i] as number,
      });
      const lines = (await readFile(join(seqDir, `${seqId}.jsonl`), "utf8"))
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      // Find the appended message record (type:"message") — save() wrote 0
      // events but left a stale head:null, then appendEvents adds message + new
      // head, so the message is not necessarily at lines[1]; locate via filter.
      const messageRecord = lines.find((l) => l?.["type"] === "message") as
        Record<string, unknown> | undefined;
      assert.ok(messageRecord, "appended message record must exist in JSONL");
      assert.equal(
        "thinkingMs" in messageRecord,
        false,
        `illegal value ${String(illegal[i])} must not stamp thinkingMs`
      );
    }
  });
});

// -- 4. static guard: zero store IO on the loop path --------------------------

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
