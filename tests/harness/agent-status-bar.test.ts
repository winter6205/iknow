/**
 * ADR-0028: the status bar — before each upcoming model call, freshly
 * computed current state (last_tool + unchecked todo lines) is appended as a
 * user message at the tail of the live messages; old bars are kept, never
 * spliced, and deps.system is not written.
 *
 * Each acceptance section below maps to one spec point; the "existing loop
 * stop-semantics tests must not degrade" requirement is held by the full runs
 * of tests/harness/loop-engine.test.ts, tests/harness/compress/integration.test.ts
 * and tests/harness/loop-engine-commit.test.ts (not re-asserted here).
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createTodoWriteTool } from "../../src/harness/aci/tools/todo-write.ts";
import { readOpenTodoLines } from "../../src/harness/agent-status.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import {
  barTexts,
  isBarBlock,
  makeSpyAdapter,
  makeTodoDir,
  okEchoTool,
  parseBar,
} from "./_agent-status-fixtures.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";

// ---------------------------------------------------------------------------
// This file's private fixtures; shared parts (makeTodoDir / makeSpyAdapter /
// okEchoTool / bar text extraction & parsing) live in
// tests/harness/_agent-status-fixtures.ts
// ---------------------------------------------------------------------------

// tmp dirs that the build-engine / worker assembly cases mkdtemp directly
// (makeTodoDir registers and cleans its own dirs inside the shared module).
const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function textOfLastMessage(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string | undefined {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "user") return undefined;
  const b = last.content.find(isBarBlock);
  return b !== undefined ? b.text : undefined;
}

function failTool(name: string): ReturnType<typeof createStubTool> {
  return createStubTool({
    name,
    next: (): never => {
      throw new Error(`${name} always fails`);
    },
  });
}

// ---------------------------------------------------------------------------
// A new bar is appended before every model call within one user turn;
// historical bars are retained.
// ---------------------------------------------------------------------------

describe("agent status bar T1: append-before-every-model-call", () => {
  it("① 同一回合多步:每步请求末尾都是新栏,历史栏仍在(含无工具步)", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha task\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t2", name: "echo", input: { value: "b" } }],
        }),
      },
      // Step 3: plain-text wrap-up with no tool call — its request must still end with a fresh bar.
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 3);

    // Each step's request ends with that step's bar (user role, `<agent_status>` text).
    for (let i = 0; i < captured.length; i++) {
      const tail = textOfLastMessage(captured[i]!);
      assert.ok(
        tail !== undefined,
        `step ${i + 1} request should end with a bar user message`
      );
    }

    // History preserved: the k-th request contains exactly k bars (append-only, no splice).
    assert.equal(barTexts(captured[0]!).length, 1);
    assert.equal(barTexts(captured[1]!).length, 2);
    assert.equal(barTexts(captured[2]!).length, 3);

    // The bar text injected at step 1 is still byte-identical in steps 2/3 (never rewritten).
    const bar1 = barTexts(captured[0]!)[0]!;
    assert.ok(barTexts(captured[2]!).includes(bar1));

    // Bars flow into RunResult.messages together with the authoritative history.
    assert.equal(barTexts(result.messages).length, 3);
    // Bar messages carry the user role.
    const barMsg = result.messages.find(
      (m) => m.role === "user" && m.content.some(isBarBlock)
    );
    assert.ok(barMsg !== undefined);
  });
});

// ---------------------------------------------------------------------------
// Empty slots are not advertised: absent / empty file / all checked / read
// failure → no todo section, and the turn must not fail.
// ---------------------------------------------------------------------------

describe("agent status bar T1: empty slots are not advertised", () => {
  async function runOnce(todoDir: string): Promise<string> {
    const noop = okEchoTool("noop");
    const reg = createRegistry([noop]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    const { result } = await run("hi", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });
    assert.equal(result.stopReason, "completed", "turn must not fail");
    const bars = barTexts(captured[0]!);
    assert.equal(bars.length, 1, "exactly one bar before the single call");
    return bars[0]!;
  }

  it("② todos.md 缺席 → 栏内无 todo 段", async () => {
    const todoDir = await makeTodoDir();
    const bar = await runOnce(todoDir);
    const parsed = parseBar(bar);
    assert.equal(parsed.lastTool, "idle");
    assert.deepEqual(parsed.todoLines, []);
    assert.ok(!bar.includes("todos:"), "no empty todo section may be printed");
  });

  it("② todos.md 空文件 → 栏内无 todo 段", async () => {
    const todoDir = await makeTodoDir("");
    const bar = await runOnce(todoDir);
    assert.deepEqual(parseBar(bar).todoLines, []);
    assert.ok(!bar.includes("todos:"));
  });

  it("② todos.md 只剩 - [x] 行 → 栏内无 todo 段", async () => {
    const todoDir = await makeTodoDir(
      "- [x] finished one\n- [x] finished two\n"
    );
    const bar = await runOnce(todoDir);
    assert.deepEqual(parseBar(bar).todoLines, []);
    assert.ok(!bar.includes("todos:"));
    assert.ok(!bar.includes("- [x]"), "checked lines never enter the bar");
  });

  it("② todos.md 读取失败(todoDir 是普通文件)→ 静默当无 todo 段,不抛", async () => {
    const notADir = join(await makeTodoDir(), "todos.md");
    await writeFile(notADir, "- [ ] never seen\n", "utf8");
    const bar = await runOnce(notADir);
    assert.deepEqual(parseBar(bar).todoLines, []);
    assert.ok(!bar.includes("todos:"));
  });
});

// ---------------------------------------------------------------------------
// The todo section projects unchecked lines only.
// ---------------------------------------------------------------------------

describe("agent status bar T1: todo section projects unchecked lines only", () => {
  it("③ 有未勾项 → todo 段逐字只含那些 - [ ] 行(无已勾、无散文)", async () => {
    const todoDir = await makeTodoDir(
      [
        "- [ ] alpha task",
        "- [x] done task",
        "some prose line that is not a checkbox",
        "- [ ] beta task",
        "- [x] another done",
        // Malformed line: bare "- [ ]" with no trailing space — the ledger grammar
        // (ITEM_LINE) rejects it, so parsing skips it; it also consumes no id slot
        // (projection anchors on the grammar SSOT, not on a line prefix).
        "- [ ]malformed-no-space",
      ].join("\n") + "\n"
    );
    const noop = okEchoTool("noop");
    const reg = createRegistry([noop]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    await run("hi", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });
    const bar = barTexts(captured[0]!)[0]!;
    const parsed = parseBar(bar);
    assert.deepEqual(parsed.todoLines, [
      "- [ ] [t1] alpha task",
      "- [ ] [t3] beta task",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Recompute per hop: when the last unchecked item is resolved via update, the
// new bar drops the todo section while the old bar stays untouched (real todo_write).
// ---------------------------------------------------------------------------

describe("agent status bar T1: recompute per hop (real todo_write)", () => {
  it("④ update 掉最后未勾项后:新栏无 todo 段,当跳开始前注入的旧栏不变", async () => {
    const todoDir = await makeTodoDir("- [ ] Task A\n");
    const todoWrite = createTodoWriteTool({ todoDir });
    const reg = createRegistry([todoWrite]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "t1",
              name: "todo_write",
              // The seed is a legacy line → parse synthesizes id t1; the update matches by id.
              input: { mode: "update", id: "t1", status: "completed" },
            },
          ],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run("finish it", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      agentStatus: { todoDir },
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 2);

    // Step 1 (bar injected before the update): carries the todo section with that unchecked line.
    const barBefore = barTexts(captured[0]!)[0]!;
    assert.deepEqual(parseBar(barBefore).todoLines, ["- [ ] [t1] Task A"]);

    // Step 2: the new (tail) bar has no todo section; the old bar is byte-identical in the same request.
    const tailBar = textOfLastMessage(captured[1]!);
    assert.ok(tailBar !== undefined);
    assert.deepEqual(parseBar(tailBar).todoLines, []);
    assert.ok(!tailBar.includes("todos:"));
    const barsInStep2 = barTexts(captured[1]!);
    assert.equal(barsInStep2.length, 2);
    assert.equal(barsInStep2[0], barBefore, "old bar must be untouched");
  });
});

// ---------------------------------------------------------------------------
// last_tool: idle on the first hop; a successful tool sets its name; in a
// multi-tool batch the last successful name wins.
// ---------------------------------------------------------------------------

describe("agent status bar T1: last_tool semantics", () => {
  it("⑤ 首跳 idle;成功工具后为该工具名;批内取最后一个成功名;全失败保持原值", async () => {
    const todoDir = await makeTodoDir();
    const alpha = okEchoTool("alpha");
    const beta = failTool("beta");
    const reg = createRegistry([alpha, beta]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      // Step 1: batch [beta (fails), alpha (succeeds)] → last success = alpha.
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [
            { id: "t1", name: "beta", input: {} },
            { id: "t2", name: "alpha", input: { value: "x" } },
          ],
        }),
      },
      // Step 2: batch [alpha (succeeds), beta (fails)] → still alpha (failures never update).
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [
            { id: "t3", name: "alpha", input: { value: "y" } },
            { id: "t4", name: "beta", input: {} },
          ],
        }),
      },
      // Step 3: batch [beta (fails)] with no success → keep the previous value alpha.
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t5", name: "beta", input: {} }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 6,
      agentStatus: { todoDir },
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 4);

    // First hop (no tool has run in this turn) = idle.
    assert.equal(parseBar(barTexts(captured[0]!)[0]!).lastTool, "idle");
    // Batch [beta fails, alpha succeeds] → alpha.
    assert.equal(parseBar(textOfLastMessage(captured[1]!)!).lastTool, "alpha");
    // Batch [alpha succeeds, beta fails] → alpha (failure never updates).
    assert.equal(parseBar(textOfLastMessage(captured[2]!)!).lastTool, "alpha");
    // Batch [beta fails] (no success) → stays alpha.
    assert.equal(parseBar(textOfLastMessage(captured[3]!)!).lastTool, "alpha");
  });
});

// ---------------------------------------------------------------------------
// When a compact happens in this hop, the bar is appended after it (the
// newest bar in the request is the last message).
// ---------------------------------------------------------------------------

describe("agent status bar T1: bar lands after compact", () => {
  it("⑥ reactive compact 后的重试请求:末尾是 compact 之后追加的新栏", async () => {
    const todoDir = await makeTodoDir("- [ ] survive compact\n");
    const noop = okEchoTool("noop");
    const reg = createRegistry([noop]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      { kind: "promptTooLong" },
      {
        kind: "reply",
        result: assistantResult({
          texts: ["done after compact"],
          toolCalls: [],
        }),
      },
    ]);

    const longPrior = Array.from({ length: 12 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `prior-${i}` }],
    }));

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
        agentStatus: { todoDir },
      },
      undefined,
      { priorMessages: longPrior }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(captured.length, 2, "first attempt + one compacted retry");

    const retry = captured[1]!;
    // The retry request's last message = the fresh bar appended after compaction (with the todo section).
    const tailBar = textOfLastMessage(retry);
    assert.ok(tailBar !== undefined, "retry request must end with a fresh bar");
    assert.deepEqual(parseBar(tailBar).todoLines, [
      "- [ ] [t1] survive compact",
    ]);

    // The boundary placeholder (reactive compact's fallback path) precedes the new bar.
    const placeholderIndex = retry.findIndex((m) =>
      m.content.some(
        (b) =>
          b.type === "text" &&
          b.text === "[compaction boundary — earlier messages cleared]"
      )
    );
    const barIndex = retry.findIndex((m) => m.content.some(isBarBlock));
    assert.ok(placeholderIndex >= 0, "compact boundary placeholder expected");
    assert.ok(
      placeholderIndex < barIndex,
      "bar must be appended AFTER the compact boundary"
    );
  });
});

// ---------------------------------------------------------------------------
// ask / worker paths do not inject the bar.
// ---------------------------------------------------------------------------

/** Deterministic env — same shape as makeEnv in tests/harness/build-engine.test.ts. */
function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    // Roots are supplied explicitly to buildHarnessEngine; the env
    // side keeps its "unset" default.
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

describe("agent status bar T1: gating (ask / worker do not inject)", () => {
  it("⑦ worker 形态 deps(无 agentStatus 字段)→ 全程无栏,即使 todos.md 有未勾项", async () => {
    const todoDir = await makeTodoDir("- [ ] open item\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    // worker.ts createWorkerDeps builds deps without agentStatus — this case drives
    // the loop with the same shape (field absent); the absence at the assembly
    // source is pinned by the real createWorkerDeps case below.
    const { result } = await run("go", {
      adapter,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      compress: { contextWindow: 200_000, thresholdTokens: undefined },
    });
    assert.equal(result.stopReason, "completed");
    for (const messages of captured) {
      assert.deepEqual(
        barTexts(messages),
        [],
        "worker-shaped deps must not append any bar"
      );
    }
    assert.deepEqual(barTexts(result.messages), []);
    void todoDir;
  });

  it("⑦ 真实 createWorkerDeps 装配输出 agentStatus === undefined(装配源头钉死)", async () => {
    // The leanest seam, same style as hermeticOpts in tests/subagent/bash-mode-channel.test.ts
    // and tests/harness/mcp/zero-linkage-guard.test.ts: stub model + empty skill catalog +
    // noop trace + tmp userHome/cwd — zero real IO or network during assembly.
    const tmp = await mkdtemp(join(tmpdir(), "iknow-agent-status-worker-"));
    tempDirs.push(tmp);
    const deps = await createWorkerDeps({
      env: makeEnv("sk-agent-status-t1"),
      sandboxRoot: tmp,
      model: createStubModel({ responses: [] }),
      skillCatalog: createSkillCatalog([]),
      system: async () => undefined,
      trace: createNoopTraceService(),
      userHome: tmp,
      cwd: tmp,
    });
    assert.equal(
      deps.agentStatus,
      undefined,
      "worker assembly must not populate agentStatus (bar not injected in worker paths)"
    );
  });

  it("⑦ build-engine:ask surface 即使注入 todoDir 也不装 agentStatus;chat surface 装配", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-agent-status-build-"));
    tempDirs.push(tmp);
    const todoDir = join(tmp, "todos");

    // This case verifies the agentStatus surface gating only, not tool overflow or
    // index demotion (dedicated tests: build-engine-tool-overflow.test.ts, disclosure-index-align/).
    // countTokens is bypassed at assembly time; see the BuildEngineOpts.skipCountTokens comment for the seam's semantics.
    const ask = await buildHarnessEngine({
      env: makeEnv("sk-agent-status-t1"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      todoDir,
      userHome: tmp,
      cwd: tmp,
      skipCountTokens: true,
    });
    assert.equal(
      ask.deps.agentStatus,
      undefined,
      "ask surface must not populate agentStatus"
    );

    const chat = await buildHarnessEngine({
      env: makeEnv("sk-agent-status-t1"),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir,
      userHome: tmp,
      cwd: tmp,
      skipCountTokens: true,
    });
    assert.deepEqual(chat.deps.agentStatus, { todoDir });

    await chat.shutdown?.();
  });
});

// ---------------------------------------------------------------------------
// ADR-0028 / ADR-0046: the bar projects only unchecked lines of the current
// todo ledger (`todos.md`). When todo_write replace renames the previous
// current file to a same-directory snapshot (`todos.<unixMs>.<hex>.md`),
// still-open old items in that snapshot must NEVER appear in the bar text.
// The implementation satisfies this naturally (`readOpenTodoLines` only
// readFile's the current `todos.md` — no glob, no readdir, no snapshot reads),
// but this invariant is pinned by snapshots written through the real replace
// path, guarding against drift into "concatenate history from the root dir".
// ---------------------------------------------------------------------------

describe("agent status bar T1: replace does not leak snapshot lines into the bar", () => {
  it("⑨ replace 后 readOpenTodoLines 只含新未勾项;快照里仍开着的旧项不出现", async () => {
    // Real todo_write path with a real conversationId (per-conversation ledger):
    // add two old items → current non-empty; replace with two new items → the old
    // current is renamed to a same-dir snapshot; assert readOpenTodoLines holds only the new items.
    const todoDir = await makeTodoDir();
    const todoWrite = createTodoWriteTool({ todoDir });
    const ctx = { conversationId: "conv-bar-snapshot-leak" };

    await todoWrite.handler({ mode: "add", item: "old-keep-open-1" }, ctx);
    await todoWrite.handler({ mode: "add", item: "old-keep-open-2" }, ctx);
    await todoWrite.handler(
      { mode: "replace", items: ["new-1", "new-2"] },
      ctx
    );

    // 1. The snapshot really exists — otherwise this test would false-pass due to
    //    "replace failed and created no snapshot"; a real replace renames the old
    //    current into a same-dir snapshot.
    const dir = join(todoDir, ctx.conversationId);
    const { readdir } = await import("node:fs/promises");
    const snapshotNames = (await readdir(dir)).filter((n) =>
      /^todos\.\d+\.[0-9a-f]{12}\.md$/.test(n)
    );
    assert.equal(
      snapshotNames.length,
      1,
      "exactly one snapshot file expected after replace on non-empty current"
    );

    // 2. Still-open old items inside the snapshot never enter readOpenTodoLines.
    const openLines = await readOpenTodoLines(todoDir, ctx.conversationId);
    assert.deepEqual(
      [...openLines],
      ["- [ ] [t1] new-1", "- [ ] [t2] new-2"],
      `bar must only project current ledger, got: ${[...openLines].join(" | ")}`
    );
    // Backstop: the old items' literal strings are absent from the return (the snapshot stays on disk; the bar reads the current file).
    assert.ok(
      !openLines.some((l) => l.includes("old-keep-open")),
      `snapshot open lines must not surface in bar, got: ${[...openLines].join(" | ")}`
    );
  });

  it("⑨ 同目录手工塞快照文件(模拟脏目录)→ readOpenTodoLines 仍只读现行", async () => {
    // Stronger still: does not depend on todo_write replace actually producing a
    // snapshot (avoiding coupling to that tool's implementation) — hand-place
    // snapshot-shaped files into the per-conversation dir and assert the bar stays
    // clean, directly pinning readOpenTodoLines' "only readFile the current todos.md" invariant.
    const todoDir = await makeTodoDir();
    const conversationId = "conv-bar-dirty-snapshots";
    const dir = join(todoDir, conversationId);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    // Current file: two open items.
    await writeFile(
      join(dir, "todos.md"),
      "- [ ] live-1\n- [ ] live-2\n",
      "utf8"
    );
    // Snapshots (hand-placed): one still-open and one already-checked old line — neither shape may appear.
    await writeFile(
      join(dir, "todos.1700000000000.deadbeefcafe.md"),
      "- [ ] ghost-still-open\n- [x] ghost-already-checked\n",
      "utf8"
    );
    await writeFile(
      join(dir, "todos.1700000000001.0123456789ab.md"),
      "- [ ] ghost-second-snapshot\n",
      "utf8"
    );

    const openLines = await readOpenTodoLines(todoDir, conversationId);
    assert.deepEqual(
      [...openLines],
      ["- [ ] [t1] live-1", "- [ ] [t2] live-2"],
      `dirty snapshot dir must not leak into bar projection, got: ${[...openLines].join(" | ")}`
    );
    // Keyword backstop: no snapshot text reaches the bar (snapshot-shaped file names and the ghost line literals must all be absent from the result).
    assert.ok(
      !openLines.some((l) => l.includes("ghost")),
      `snapshot text must not surface, got: ${[...openLines].join(" | ")}`
    );
  });

  it("⑨ 无 conversationId(legacy shared-root 形态)→ 同样只读现行 todos.md,不读同目录快照", async () => {
    // Backward-compat surface: without a conversationId the path resolves to
    // `<todoDir>/todos.md` (the same path the todo_write handler lands on when
    // ctx.conversationId is absent); the invariant holds the same way — the bar never reads snapshots.
    const todoDir = await makeTodoDir();
    await writeFile(
      join(todoDir, "todos.md"),
      "- [ ] live-shared-root\n",
      "utf8"
    );
    // Hand-placed same-dir snapshot.
    await writeFile(
      join(todoDir, "todos.1700000000000.aaaabbbbcccc.md"),
      "- [ ] ghost-shared-root\n",
      "utf8"
    );

    const openLines = await readOpenTodoLines(todoDir);
    assert.deepEqual(
      [...openLines],
      ["- [ ] [t1] live-shared-root"],
      `shared-root read must ignore same-dir snapshots, got: ${[...openLines].join(" | ")}`
    );
  });
});

// ---------------------------------------------------------------------------
// The bar projects only unfinished items (pending + in_progress); completed
// never enters. Projected lines come from the ledger grammar SSOT (parseLedger
// / formatLedgerLine); legacy id-less lines get an id synthesized by the parser
// and are rendered in canonical form.
// ---------------------------------------------------------------------------

describe("agent status bar SC10: unfinished items only", () => {
  /** Read the projection of a real todos.md (no model turn — this section pins the projection itself). */
  async function projectLines(seed: string): Promise<readonly string[]> {
    const todoDir = await makeTodoDir(seed);
    return readOpenTodoLines(todoDir);
  }

  it("(a) 只有 in_progress 项 → 段在场,行保留 `- [~]` 标记与 id", async () => {
    const lines = await projectLines("- [~] [t1] wip task\n");
    assert.deepEqual([...lines], ["- [~] [t1] wip task"]);
  });

  it("(b) pending + in_progress + completed 混合 → 恰为未完成子集,绝不出现 `- [x]`", async () => {
    const lines = await projectLines(
      "- [ ] [t1] alpha\n- [~] [t2] beta wip\n- [x] [t3] gamma done\n"
    );
    assert.deepEqual(
      [...lines],
      ["- [ ] [t1] alpha", "- [~] [t2] beta wip"],
      `projection must be exactly the unfinished subset, got: ${[...lines].join(" | ")}`
    );
    assert.ok(
      !lines.some((l) => l.includes("[x]")),
      "completed items must never enter the bar"
    );
  });

  it("(c) legacy 无 id 的 in_progress 行 → 解析器补 id,输出规范形态", async () => {
    const lines = await projectLines("- [~] legacy wip\n");
    assert.deepEqual([...lines], ["- [~] [t1] legacy wip"]);
  });

  it("(d) in_progress + 全 completed → 只投影 in_progress 那条", async () => {
    const lines = await projectLines(
      "- [x] [t1] done a\n- [~] [t2] wip b\n- [x] [t3] done c\n"
    );
    assert.deepEqual([...lines], ["- [~] [t2] wip b"]);
  });
});
