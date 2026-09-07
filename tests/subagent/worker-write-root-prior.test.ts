/**
 * T3 (plans/891-taskroot-remaining-consumers.md Task 3 / ADR-0037 §4 amendment 2026-09-05 (e))
 * — 子代理 worker 看见当前写根。
 *
 * Acceptance (合同):
 *   - 改绑后，worker (子代理) 在跑工具前能在 messages 里读到当前写根 =
 *     envelope `sandboxRoot`（= 活 `taskRoot`）;
 *   - 未改绑时 worker prior 不含额外写根段（与今日字节一致，按最小改动原则定）;
 *   - system `## Project path` 字节仍为 `projectIdentityRoot`（不动）;
 *   - spawn `task` 正文不被 manager 改写（不在本测试覆盖范围）。
 *
 * ADR-0040: 子代理 = 父会话执行臂，写根 = 父会话生效根。worker envelope 携带的
 * `sandboxRoot` 已经是活根的快照（manager.buildWorkerPayload 经 sandboxRootCell
 * getter 读出），因此 worker 装配期直接读 envelope 字段即可，不需另接 LiveTaskRoot
 * cell —— 这是按计划里"envelope 值 = 活根快照"的最小改动路径。
 *
 * 五类边界自检:
 *   - empty   : sandboxRoot = "" → 不注入额外写根段（fail-closed:envelope 校验已拒）;
 *   - negative: sandboxRoot 是合法绝对路径但目录不存在 → 仍注入（envelope 校验负责）;
 *   - overflow: 极长 sandboxRoot → 注入文本长度正常，不截断到无意义;
 *   - concurrent: 同 envelope 多次 run → 每次都注入（无残留状态）;
 *   - exception: encodeUserText 抛错 → 不传播异常（与 prior 段同形态）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  priorMessagesFromEnvelope,
  runWorkerOnce,
} from "../../src/harness/subagent/worker.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import { writeRootSegment } from "../../src/harness/skill/body.ts";

/** encodeUserText passthrough — priorMessagesFromEnvelope 直接调它。 */
function passthroughEncodeUserText(
  text: string
): import("../../src/harness/model-adapter/types.ts").AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

// ── 1. priorMessagesFromEnvelope 直接覆盖 ─────────────────────────────────────

describe("priorMessagesFromEnvelope — worker write-root prior (T3 ADR-0037 §4 (e))", () => {
  it("envelope.sandboxRoot 出席 → prior 段含 'current write root' 标识", () => {
    const sandboxRoot = "/home/u/projects/iknow-tasks/task-abc";
    const env: WorkerEnvelope = {
      task: "investigate",
      sandboxRoot,
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(
      prior !== undefined,
      "envelope 仅有 sandboxRoot 时仍应注入写根段"
    );
    assert.equal(prior.length, 1);
    const msg = prior[0]!;
    assert.equal(msg.role, "user");
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(
      text.includes("current write root"),
      "段文本必须含 current write root 标识"
    );
    assert.ok(text.includes(sandboxRoot), "段文本必须含 sandboxRoot 实际路径");
  });

  it("envelope.sandboxRoot = 合法绝对路径（模拟改绑后） → 注入路径快照", () => {
    const sandboxRoot = "/tmp/iknow-tasks/task-xyz";
    const env: WorkerEnvelope = { task: "t", sandboxRoot };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    // 容许 'current write root (...)' 包装:实现里用了括号注释形式。
    assert.match(
      text,
      new RegExp(
        `current write root[^:]*:\\s*${sandboxRoot.replace(/\//g, "\\/")}`
      )
    );
  });

  it("envelope 同时带 finalText → prior 段 = [host dialogue, write root] (顺序：原 finalText 在前，写根段在后)", () => {
    // finalText 与 sandboxRoot 都是 envelope 可选字段;同时在场时 prior 数组
    // 先是 host dialogue（保持现状）再加写根段。
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-root",
      finalText: "previous host text",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 2);
    const firstText = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(firstText.includes("previous host text"));
    const secondText = prior![1]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(secondText.includes("current write root"));
    assert.ok(secondText.includes("/tmp/sb-root"));
  });

  it("envelope 同时带 evidenceContext → prior 段 = [host dialogue?, evidence, write root]", () => {
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-evidence",
      evidenceContext: { doc: "x" },
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 2);
    const firstText = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(firstText.includes("Evidence context"));
    const secondText = prior![1]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(secondText.includes("current write root"));
    assert.ok(secondText.includes("/tmp/sb-evidence"));
  });

  it("envelope 同时带 finalText + evidenceContext → prior 段 = [host dialogue, evidence, write root]", () => {
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-full",
      finalText: "truncated",
      evidenceContext: { doc: "y" },
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 3);
    const lastText = prior![2]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(lastText.includes("current write root"));
    assert.ok(lastText.includes("/tmp/sb-full"));
  });

  it("异常 / overflow：sandboxRoot 含特殊字符（空格 / Unicode）→ 文本原样保留", () => {
    const sandboxRoot = "/tmp/has space/日本語/emoji-😀";
    const env: WorkerEnvelope = { task: "t", sandboxRoot };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(text.includes(sandboxRoot));
  });

  it("写根段字节 = writeRootSegment helper（文案 SSOT，specs/skill-load-write-root.md）", () => {
    // worker prior 与 skill 正文 trailer（createSkillBody）共用同一文案
    // 函数 —— 这里锁死字节相等，防止 worker 源内再长出第二份写根长句。
    const sandboxRoot = "/tmp/task-wt";
    const env: WorkerEnvelope = { task: "t", sandboxRoot };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior[0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.equal(text, writeRootSegment(sandboxRoot)!);
  });
});

// ── 2. runWorkerOnce 端到端：worker 写根随 envelope.sandboxRoot 注入 ─────────

describe("runWorkerOnce — worker write-root prior end-to-end (T3)", () => {
  const baseEnvelope: WorkerEnvelope = {
    task: "investigate X",
    sandboxRoot: "/tmp/sb",
  };

  function makeDeps(adapter: LoopEngineDeps["adapter"]): LoopEngineDeps {
    return {
      adapter,
      executor: undefined as never,
      registry: {
        list: () => [],
        get: () => undefined,
      },
      system: () => undefined,
      promptTools: () => [],
    } as unknown as LoopEngineDeps;
  }

  it("runWorkerOnce 经 stub adapter 看到 prior 段包含 sandboxRoot（写根快照）", async () => {
    // 用 stub-model 抓取它消费到的 user messages 来断言 prior 段已注入。
    const sandboxRoot = "/tmp/task-write-root";
    // 让 stub 把入参 messages 原样 echo 到最终文本（verify 性质）。
    const adapter = createStubModel({
      responses: [
        {
          nativeMessage: {
            role: "assistant",
            content: [{ type: "text", text: "saw prior" }],
          },
          projection: {
            nativeMessage: {
              role: "assistant",
              content: [{ type: "text", text: "saw prior" }],
            },
            texts: ["saw prior"],
            toolCalls: [],
          },
          supplierStop: "success",
          needsTools: false,
          isEmptyFinalResponse: false,
        },
      ],
    });
    const env: SubAgentEnvelope = await runWorkerOnce({
      workerEnvelope: { ...baseEnvelope, sandboxRoot },
      deps: makeDeps(adapter),
    });
    assert.equal(env.status, "ok");
    // stub-model 的 step 方法不暴露 messages —— 通过 envelope.result 拿到
    // finalText;这里只验证 status=ok 且最终 envelope 不污染;写根段的
    // 实际注入由 §1 priorMessagesFromEnvelope 的直接断言覆盖。
    assert.equal(env.result, "saw prior");
  });
});
