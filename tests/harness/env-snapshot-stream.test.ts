/**
 * T5 (#653 G1 / 包1-感知): `env_snapshot` 流事件 —— 与 `agent_status` 平行的
 * 独立事件流(人读 chrome 的数据源),在「每次即将调用模型前」的回合边界发出。
 *
 * 验收映射:
 *   ① 事件携带完整 EnvSnapshot 字段(cwd / gitBranch / dirtyCount /
 *      diffPreview),与 agent_status 事件物理隔离(不同 type,字段零重叠);
 *   ② emit 时序:每次 appendAgentStatusBar 之后(同一回合边界计算点),
 *      且先于该次模型调用到达(entrySamples 同款采样交叉断言);
 *   ③ readEnvSnapshot 失败(degraded)→ 事件仍发,cwd 在场、git/diff 字段
 *      全 null —— 不 throw、不吞事件;
 *   ④ deps.envSnapshot 缺席 → 零事件(byte-identical 纪律:ask / worker /
 *      既有 stub 装配零行为变化);
 *   ⑤ 观察者 throw 不反流(safeEmitStream 契约);
 *   ⑥ env_snapshot 不进 messages(栏纯度反向契约:请求尾消息不含 cwd/git)。
 *
 * spec: specs/653-horizon-pkg1-perception.md §"环境现势";
 * 决议: docs/design/DESIGN-ENVIRONMENT-PRESENT.md(平行独立流,不复用
 * agent_status);plan: plans/653-horizon-pkg1-perception.md T5。
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import { makeSpyAdapter, okEchoTool } from "./_agent-status-fixtures.ts";

// ---------------------------------------------------------------------------
// 本文件私有 fixtures
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTmpDir(prefix: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(tmp);
  return tmp;
}

async function makeTodoDir(initialContent?: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-env-agentstatus-"));
  tempDirs.push(tmp);
  if (initialContent !== undefined) {
    await writeFile(join(tmp, "todos.md"), initialContent, "utf8");
  }
  return tmp;
}

/** 事件收集器:env_snapshot 与 agent_status 分开记(type 双流互斥采样)。 */
interface EnvProbe {
  readonly onStream: (event: HarnessStreamEvent) => void;
  readonly envSnapshots: Extract<
    HarnessStreamEvent,
    { type: "env_snapshot" }
  >[];
  readonly agentStatusEvents: Extract<
    HarnessStreamEvent,
    { type: "agent_status" }
  >[];
}

function makeEnvProbe(): EnvProbe {
  const envSnapshots: Extract<HarnessStreamEvent, { type: "env_snapshot" }>[] =
    [];
  const agentStatusEvents: Extract<
    HarnessStreamEvent,
    { type: "agent_status" }
  >[] = [];
  const onStream = (event: HarnessStreamEvent): void => {
    if (event.type === "env_snapshot") envSnapshots.push(event);
    if (event.type === "agent_status") agentStatusEvents.push(event);
  };
  return { onStream, envSnapshots, agentStatusEvents };
}

/** 把 messages 里所有 text block 拼成一段(供「不进 messages」反向断言)。 */
function allText(messages: ReadonlyArray<AnthropicNativeMessage>): string {
  return messages
    .map((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// AC ① 事件形状:EnvSnapshot 字段齐全,与 agent_status 物理隔离
// ---------------------------------------------------------------------------

describe("HarnessStreamEvent env_snapshot variant", () => {
  it("① env_snapshot 事件包含 EnvSnapshot 字段 (cwd, gitBranch, dirtyCount, diffPreview)", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: { cwd: process.cwd() },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(probe.envSnapshots.length, 1);
    const ev = probe.envSnapshots[0]!;
    assert.equal(ev.type, "env_snapshot");
    assert.ok(typeof ev.snapshot.cwd === "string");
    assert.ok(ev.snapshot.cwd.length > 0);
    assert.ok(typeof ev.snapshot.gitBranch === "string");
    assert.ok(typeof ev.snapshot.dirtyCount === "number");
    assert.ok(
      ev.snapshot.diffPreview === null ||
        typeof ev.snapshot.diffPreview === "string"
    );
    // 反向契约:与 agent_status 字段零重叠(env_snapshot 不带 lastTool /
    // openTodoLines)。agent_status 字段缺席检查另见 ②(同回合并存)。
    assert.ok(!("lastTool" in ev));
    assert.ok(!("openTodoLines" in ev));
  });

  it("② emit 时序在 appendAgentStatusBar 之后、模型调用之前(每回合边界一条)", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
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

    const { result } = await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
        envSnapshot: { cwd: process.cwd() },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    // 2 次模型调用 → 2 条 env_snapshot + 2 条 agent_status(同款回合边界
    // 节律,平行独立)。captured.length === 2 证明调用确实发生。
    assert.equal(probe.envSnapshots.length, 2);
    assert.equal(probe.agentStatusEvents.length, 2);
    assert.equal(captured.length, 2);
  });

  it("③ readEnvSnapshot 抛错 → emit env_snapshot 含 cwd 但 git/diff = null (不 throw)", async () => {
    // degraded 形态由 deps.envSnapshot.cwd 指向非 git 目录驱动:
    // readEnvSnapshot 对非 git 工作区收敛为全 null 字段(永不 throw 契约,
    // T4 已测);本用例钉死 loop-engine 对 degraded 快照照常 emit、不 throw。
    const nonGitDir = await makeTmpDir("iknow-env-nongit-");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run(
      "hi",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: { cwd: nonGitDir },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(probe.envSnapshots.length, 1);
    const snap = probe.envSnapshots[0]!.snapshot;
    assert.equal(snap.cwd, nonGitDir);
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.gitStatus, null);
    assert.equal(snap.dirtyCount, null);
    assert.equal(snap.diffPreview, null);
  });

  it("④ deps.envSnapshot 缺席 → 零 env_snapshot 事件(ask / worker 零变化)", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(probe.envSnapshots.length, 0, "no envSnapshot dep → no event");
    assert.equal(probe.agentStatusEvents.length, 0);
  });

  it("⑤ 观察者 throw 不反流:hostile env_snapshot 消费者不破坏回合", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    const hostile = (event: HarnessStreamEvent): void => {
      if (event.type === "env_snapshot") {
        throw new Error("hostile env_snapshot observer");
      }
    };

    const { result } = await run(
      "hi",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: { cwd: process.cwd() },
      },
      undefined,
      { onStream: hostile }
    );

    assert.equal(result.stopReason, "completed");
    // hostile 仅抛 env_snapshot;agentStatus 缺席 → 无栏,尾消息仅 stub user prompt。
    assert.equal(captured.length, 1);
  });

  it("⑥ env_snapshot 数据不进 messages:请求尾不含 <env_snapshot> 栏或 cwd/git 文本", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: { cwd: process.cwd() },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(captured.length, 1);
    const text = allText(captured[0]!);
    assert.ok(!text.includes("<env_snapshot>"), "never a user-message bar");
    assert.ok(!text.includes(process.cwd()), "cwd never enters messages");
    assert.ok(!text.includes("gitBranch"), "git fields never enter messages");
  });
});
