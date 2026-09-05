/**
 * Issue #888 root cause: 注入类消息（#645 agent_status 状态栏 / ADR-0041
 * graph 切换提示）以 user 消息 immutable 追加进内存权威历史，但从不经过
 * `commitMessages` 落 JSONL 链。run 结束后 host 的 save（hub
 * conditionalSave / chat persistChatSessionCheckpoint）把含注入消息的内存
 * 投影与纯 commit 链做 LCP 对齐 —— 在第一条注入消息处分叉，`planSessionSave`
 * 判为 fork，`parent` 回落到链上更早的事件（故障实测 parent=e0）。fork 投影
 * 成为新 head 后，下一个 run 的 `session.messages` 投影丢失被孤立的前缀，
 * 模型从原始 query 重放整轮（#888 现象）。
 *
 * 本套件钉住的不变式（SSOT：loop-engine 的 commit 纪律）：
 *   1. 注入消息必须在下一次 assistant / tool_result commit 时随批 flush
 *      （loop-detected envelope 的既有先例同形态），使「内存权威历史 − query」
 *      ==「盘上 commit 链 − 宿主懒提交的 query 前缀」。
 *   2. cancelled 停止路径：appendSystemInterrupt 前把 pending 注入 +
 *      system interrupt 一起 flush —— checkpoint save 的投影与链对齐，
 *      不再 fork。
 *   3. protocolError / emptyFinalResponse 维持 #120 裁决（turn 不进历史），
 *      pending 注入随之丢弃，save 仍判 prefix 并把 head 移回（既有语义，
 *      零新增 fork 面）。
 *   4. 端到端（store 级）：agentStatus 在场的一轮 cancelled run，收尾 save
 *      之后盘上投影无孤儿分支（fork 不发生），head 链 == 内存投影。
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/harness/loop-engine.ts";
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
import { makeTodoDir } from "./_agent-status-fixtures.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  // 清理失败直接让 afterAll 失败（S3：不留空 catch 吞错）。
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

function emptySessionFile(id: string, workspaceRoot: string): SessionFileV1 {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    title: "",
    cwd: workspaceRoot,
    sanitized_at: new Date().toISOString(),
    checkpoints: [],
    workspaceRoot,
  };
}

/** 一轮「模型先调一次工具、第一次 commit 落地后 abort → cancelled」。
 * abort 由首次 commitMessages 批同步触发，确定性保证取消发生在
 * assistant/tool_result 已 commit、下一次模型调用之前——正是 #888 中
 * save 投影与盘上链在注入消息处分叉所需的时序（setTimeout 赛跑会随机
 * 落在首次 commit 前，链为空、无 fork，无法钉住不变式）。 */
function interruptAfterFirstCommitDeps(
  commitMessages: LoopEngineDeps["commitMessages"],
  todoDir: string,
  controller: AbortController
): LoopEngineDeps {
  const tool = createStubTool({ name: "alpha", next: () => "result-a" });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "a", name: "alpha", input: {} }],
      }),
      assistantResult({
        texts: ["never arrives"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  let firstCommitSeen = false;
  return {
    adapter,
    executor,
    registry,
    maxTurns: 5,
    agentStatus: { todoDir },
    commitMessages: async (messages) => {
      await commitMessages?.(messages);
      if (!firstCommitSeen) {
        firstCommitSeen = true;
        controller.abort();
      }
    },
  };
}

// -- 1. completed run：注入随批 flush，展平 commit = 权威历史 − query ----------

describe("#888 commit discipline: injected messages ride the next commit", () => {
  it("completed run: 展平 commit 批 == 权威历史（除 query），注入栏在批内", async () => {
    const todoDir = await makeTodoDir("- [ ] pending task\n");
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      committed.push(messages);
    };
    const tool = createStubTool({ name: "alpha", next: () => "result-a" });
    const registry = createRegistry([tool]);
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const { result } = await run("go", {
      adapter,
      executor: createExecutor(registry),
      registry,
      maxTurns: 5,
      agentStatus: { todoDir },
      commitMessages,
    });
    assert.equal(result.stopReason, "completed");
    // 全部 commit 批展平 = 权威历史（除 query —— query 由宿主懒提交纪律持有，
    // run() 的 commit 流不含它；对比基线去掉首条 user seed）。
    const flat = committed.flat();
    const tail = result.messages.slice(1); // 去掉 seed query
    assert.deepEqual(
      flat,
      tail,
      "flattened commit batches must equal the authoritative history minus the query"
    );
  });

  it("cancelled run: pending 注入 + system interrupt 在停止路径 flush", async () => {
    const todoDir = await makeTodoDir();
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const controller = new AbortController();
    const deps = interruptAfterFirstCommitDeps(
      async (messages) => {
        committed.push(messages);
      },
      todoDir,
      controller
    );
    const { result } = await run("x", deps, controller.signal);
    assert.equal(result.stopReason, "cancelled");
    // 权威历史 = [seed query, bar(idle), assistant(a), tool_result, bar(2nd), system interrupt]
    const tail = result.messages.slice(1);
    const flat = committed.flat();
    assert.deepEqual(
      flat,
      tail,
      "cancelled stop must flush pending injected messages + system interrupt so the persisted chain matches the checkpoint projection"
    );
    // 栏确实出现在 flush 批里（不是被静默丢弃）。
    assert.ok(
      committed
        .flat()
        .some((m) =>
          m.content.some(
            (b) => b.type === "text" && b.text.startsWith("<agent_status>")
          )
        ),
      "status-bar messages must be present in the flushed batches"
    );
  });

  it("protocolError run: pending 注入随 #120 裁决丢弃，不进 commit 流", async () => {
    const todoDir = await makeTodoDir();
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const tool = createStubTool({ name: "alpha", next: () => "result-a" });
    const registry = createRegistry([tool]);
    // 单条响应 + agentStatus 在场：第一条 assistant 消费响应，第二次
    // 模型调用时队列耗尽 → stub 抛 ProtocolError（stop, turn 不进历史）。
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
      ],
    });
    const { result } = await run("go", {
      adapter,
      executor: createExecutor(registry),
      registry,
      maxTurns: 5,
      agentStatus: { todoDir },
      commitMessages: async (messages) => {
        committed.push(messages);
      },
    });
    assert.equal(result.stopReason, "protocolError");
    // 第一次 assistant commit 批头正常 flush 首条 bar（已落地 turn 的合法
    // 批序 [bar_idle, assistant]）；protocolError 前记录的第二条 bar 不得
    // 进 commit 流：#120 裁决 turn 不进历史，save 判 strict prefix 把
    // head 移回，零 fork 面。
    const flat = committed.flat();
    assert.deepEqual(
      committed.map((b) => b.length),
      [2, 1],
      "batches are [bar_idle, assistant] then [tool_result]; second turn's pending bar must not commit"
    );
    assert.ok(
      !flat
        .slice(2)
        .some((m) =>
          m.content.some(
            (b) => b.type === "text" && b.text.startsWith("<agent_status>")
          )
        ),
      "second pending bar must be dropped on protocolError (no leak into commit stream)"
    );
    // 既有 #120 语义：turn 未落地但内存权威历史保留调模型前注入的 bar
    // （bar 在 runModelPhase 前已 append）。收尾 save 以内存投影为准
    // fork-copy 重建（投影完整、语义无损），与无注入时的既有形态一致。
    // 本断言钉住：pending 缓冲不引入第二次 commit 泄露，盘上只有 [bar, assistant, tr]。
    assert.ok(
      result.messages.some((m) =>
        m.content.some(
          (b) => b.type === "text" && b.text.startsWith("<agent_status>")
        )
      ),
      "in-memory history keeps the pre-model bar (existing #120 semantics, injected before runModelPhase)"
    );
  });
});

// -- 2. 端到端（store 级）：cancelled run 收尾 save 后盘上无 fork -------------

describe("#888 end-to-end: cancelled run with injected bars saves without fork", () => {
  it("收尾 save 投影与盘上链对齐：head 链 == 内存投影，无孤儿分支", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-888-e2e-"));
    tempDirs.push(tmp);
    const store = new SessionStore(tmp, process.cwd());
    const sessionDir = resolveProjectSessionDir(tmp, process.cwd());
    const id = "issue-888-e2e";
    const workspaceRoot = process.cwd();
    await store.save({ id, file: emptySessionFile(id, workspaceRoot) });

    const todoDir = await makeTodoDir();
    const controller = new AbortController();
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    // 镜像 hub 懒提交 query 纪律（hub.ts:1413–1434 queryCommitPending latch）：
    // 引擎不 commit seed query，宿主在第一次 commit 批头拼上 query 后透传。
    // 前缀必须与 run() 的 seed 构造逐字节一致（encodeUserText("x")）。
    let queryCommitPending = true;
    const deps: LoopEngineDeps = interruptAfterFirstCommitDeps(
      async (messages) => {
        const events = queryCommitPending
          ? [deps.adapter.encodeUserText("x"), ...messages]
          : messages;
        queryCommitPending = false;
        await store.appendEvents({ id, events });
        committed.push(events);
      },
      todoDir,
      controller
    );
    const { result } = await run("x", deps, controller.signal);
    assert.equal(result.stopReason, "cancelled");

    // 宿主收尾 save（chat persistChatSessionCheckpoint / hub conditionalSave
    // 的 save 形态：整体 file.messages = run 结果投影）。
    await store.save({
      id,
      file: {
        ...emptySessionFile(id, workspaceRoot),
        messages: result.messages,
        turnCount: result.turnCount,
      },
    });

    // 盘上投影必须与内存投影一致 —— fork 意味着丢失 e1..eN 前缀（#888 现象）。
    const raw = await readFile(join(sessionDir, `${id}.jsonl`), "utf8");
    const log = parseSessionJsonl(raw);
    const projected = projectSessionLog(log).messages;
    assert.deepEqual(
      projected,
      [...result.messages],
      "persisted head-chain projection must equal the run's authoritative history (no fork, no orphaned prefix)"
    );

    // 无孤儿分支：每个事件都在 head 链上。
    const onChain = new Set<string>();
    let cur = log.head;
    while (cur !== null) {
      onChain.add(cur);
      const ev = log.events.find((e) => e.id === cur);
      if (!ev) break;
      cur = ev.parent;
    }
    const orphans = log.events.filter((e) => !onChain.has(e.id));
    assert.equal(
      orphans.length,
      0,
      `no orphan branch events expected, got: ${orphans.map((e) => e.id).join(", ")}`
    );
    void committed;
  });
});
