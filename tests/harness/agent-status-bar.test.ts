/**
 * T1 (#645) / ADR-0028 / plans/agent-status-bar.md: 状态栏 —— 每次即将调用
 * 模型前,把代码现算的现势(last_tool + 未勾 todo 段)以 user 消息追加在
 * 当时 messages 尾;旧栏保留、不 splice、不写 deps.system。
 *
 * 验收 ①–⑦ 逐条对应 plans/agent-status-bar.md T1 Acceptance;⑧(既有 loop
 * 停止语义测试不降级)由 tests/harness/loop-engine.test.ts /
 * tests/harness/compress/integration.test.ts / tests/harness/loop-engine-commit.test.ts
 * 全量运行守住(本文件不重复其断言)。
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
// 本文件私有 fixtures(makeTodoDir / makeSpyAdapter / okEchoTool / bar 文本
// 提取与解析等共享部分见 tests/harness/_agent-status-fixtures.ts)
// ---------------------------------------------------------------------------

// build-engine / worker 装配用例直接 mkdtemp 的 tmp 目录(makeTodoDir 的
// 目录由共享模块自己登记并清理)。
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
// AC ① 同一用户回合内每个模型调用前各追加一条新栏,历史栏保留
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
      // 第三步:无工具的纯文本收尾 —— 该步请求同样以新栏收尾。
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

    // 每步请求的最后一条消息都是当时的栏(user role,<agent_status> 文本)。
    for (let i = 0; i < captured.length; i++) {
      const tail = textOfLastMessage(captured[i]!);
      assert.ok(
        tail !== undefined,
        `step ${i + 1} request should end with a bar user message`
      );
    }

    // 历史栏保留:第 k 步请求里能数到 k 条栏(追加、不 splice)。
    assert.equal(barTexts(captured[0]!).length, 1);
    assert.equal(barTexts(captured[1]!).length, 2);
    assert.equal(barTexts(captured[2]!).length, 3);

    // 第一步注入的栏文本在第 2/3 步请求里逐字节仍在(未改写)。
    const bar1 = barTexts(captured[0]!)[0]!;
    assert.ok(barTexts(captured[2]!).includes(bar1));

    // 栏随权威历史流到 RunResult.messages。
    assert.equal(barTexts(result.messages).length, 3);
    // 栏消息是 user role。
    const barMsg = result.messages.find(
      (m) => m.role === "user" && m.content.some(isBarBlock)
    );
    assert.ok(barMsg !== undefined);
  });
});

// ---------------------------------------------------------------------------
// AC ② 空槽不广告:缺席 / 空文件 / 全勾 / 读失败 → 无 todo 段,回合不失败
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
// AC ③ todo 段只投影未勾行
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
        // 畸形行:裸 "- [ ]" 后无空格 —— 非写入方 OPEN_PREFIX("- [ ] ")产出
        // 的形态,不投影(prefix 以写入方 todo-write.ts 导出常量为锚)。
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
    assert.deepEqual(parsed.todoLines, ["- [ ] alpha task", "- [ ] beta task"]);
  });
});

// ---------------------------------------------------------------------------
// AC ④ 同一跳 check 掉最后一条未勾 → 新栏去 todo 段,旧栏不动(真实 todo_write)
// ---------------------------------------------------------------------------

describe("agent status bar T1: recompute per hop (real todo_write)", () => {
  it("④ check 掉最后未勾项后:新栏无 todo 段,当跳开始前注入的旧栏不变", async () => {
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
              input: { mode: "check", item: "Task A" },
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

    // 第一步(栏注入时尚未 check):栏带 todo 段,含那条未勾行。
    const barBefore = barTexts(captured[0]!)[0]!;
    assert.deepEqual(parseBar(barBefore).todoLines, ["- [ ] Task A"]);

    // 第二步:新栏(尾部)无 todo 段;旧栏在同一请求里逐字节不变。
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
// AC ⑤ last_tool:首跳 idle;工具成功 → 工具名;多工具批取最后一个成功名
// ---------------------------------------------------------------------------

describe("agent status bar T1: last_tool semantics", () => {
  it("⑤ 首跳 idle;成功工具后为该工具名;批内取最后一个成功名;全失败保持原值", async () => {
    const todoDir = await makeTodoDir();
    const alpha = okEchoTool("alpha");
    const beta = failTool("beta");
    const reg = createRegistry([alpha, beta]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      // 第 1 步:批 [beta(失败), alpha(成功)] → 最后成功名 = alpha。
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
      // 第 2 步:批 [alpha(成功), beta(失败)] → 仍 alpha(失败者不更新)。
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
      // 第 3 步:批 [beta(失败)] 无成功 → 保持原值 alpha。
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

    // 首跳(本回合尚未跑过工具)= idle。
    assert.equal(parseBar(barTexts(captured[0]!)[0]!).lastTool, "idle");
    // 批 [beta 失败, alpha 成功] → alpha。
    assert.equal(parseBar(textOfLastMessage(captured[1]!)!).lastTool, "alpha");
    // 批 [alpha 成功, beta 失败] → alpha(失败永不更新)。
    assert.equal(parseBar(textOfLastMessage(captured[2]!)!).lastTool, "alpha");
    // 批 [beta 失败](无成功)→ 保持 alpha。
    assert.equal(parseBar(textOfLastMessage(captured[3]!)!).lastTool, "alpha");
  });
});

// ---------------------------------------------------------------------------
// AC ⑥ compact 发生在本跳 → 栏追加在 compact 之后(请求里最新一条栏在尾)
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
    // 重试请求最后一条消息 = compact 之后追加的新栏(含 todo 段)。
    const tailBar = textOfLastMessage(retry);
    assert.ok(tailBar !== undefined, "retry request must end with a fresh bar");
    assert.deepEqual(parseBar(tailBar).todoLines, ["- [ ] survive compact"]);

    // 边界占位(reactive compact 的 fallback 路径)在新栏之前。
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
// AC ⑦ ask / worker 路径不注入栏
// ---------------------------------------------------------------------------

/** Deterministic env — 与 tests/harness/build-engine.test.ts makeEnv 同形。 */
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
    // worker.ts createWorkerDeps 构造的 deps 不含 agentStatus —— 本用例按
    // 同一形状(字段缺席)驱动 loop;装配源头的缺席由下方真实 createWorkerDeps
    // 用例钉死。
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
    // 与 tests/subagent/bash-mode-channel.test.ts hermeticOpts / mcp
    // zero-linkage-guard.test.ts 同款最省缝:stub model + 空 skill catalog +
    // noop trace + tmp userHome/cwd,装配期零真实 IO / 网络。
    const tmp = await mkdtemp(join(tmpdir(), "iknow-agent-status-worker-"));
    tempDirs.push(tmp);
    const deps = await createWorkerDeps({
      env: makeEnv("sk-agent-status-t1"),
      sandboxRoot: tmp,
      model: createStubModel({ responses: [] }),
      skillCatalog: createSkillCatalog([]),
      system: () => undefined,
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

    const ask = await buildHarnessEngine({
      env: makeEnv("sk-agent-status-t1"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      todoDir,
      userHome: tmp,
      cwd: tmp,
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
    });
    assert.deepEqual(chat.deps.agentStatus, { todoDir });

    await chat.shutdown?.();
  });
});
