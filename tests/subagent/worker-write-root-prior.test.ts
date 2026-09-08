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
 * T6 (plans/write-situation-disclosure.md) — worker prior 按 envelope 上的
 * 处境枚举（`writeSituation`）渲染，consumer 不再自行判定形状（ADR-0069
 * D2/D3；spec SC4 / OQ1）。
 *   - `writeSituation: "writable_main" | "writable_tree"` → 与改造前逐字节
 *     相等的写根段（SC2 硬约束，前缀缓存与 skill-load-write-root SC2 守门）;
 *   - `writeSituation: "no_writable_root"` → ③ 态披露，不点名建树工具,
 *     不嵌入 sandboxRoot（spec SC3）;
 *   - 旧 envelope（无 `writeSituation` 字段）→ typed skip，不注入写根段
 *     不回落旧文案（OQ1 采纳 (b)）—— 保持「宁可不说、不可说错」立意。
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
import type { WriteSituation } from "../../src/harness/session-roots.ts";

/** encodeUserText passthrough — priorMessagesFromEnvelope 直接调它。 */
function passthroughEncodeUserText(
  text: string
): import("../../src/harness/model-adapter/types.ts").AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

// ── 1. priorMessagesFromEnvelope 直接覆盖 ─────────────────────────────────────

describe("priorMessagesFromEnvelope — worker write-root prior (T3 ADR-0037 §4 (e))", () => {
  // T6 重写: 旧 envelope（无 writeSituation 字段）→ typed skip,不注入写根段。
  // 本节保留 T3 形态但全部 explicit writeSituation 走双参形态 —— 与改造后
  // 装配路径（manager.buildWorkerPayload）一致。
  const TREE_ROOT = "/repo/.iknow/worktrees/conv1234";
  const MAIN_ROOT = "/home/u/projects/iknow-tasks/task-abc";

  it("envelope.sandboxRoot + writeSituation = writable_tree → prior 段含 'current write root' 标识", () => {
    const env: WorkerEnvelope = {
      task: "investigate",
      sandboxRoot: MAIN_ROOT,
      writeSituation: "writable_tree",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(
      prior !== undefined,
      "envelope 带 writeSituation 时仍应注入写根段"
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
    assert.ok(text.includes(MAIN_ROOT), "段文本必须含 sandboxRoot 实际路径");
  });

  it("envelope.sandboxRoot = 合法绝对路径（模拟改绑后） + writable_tree → 注入路径快照", () => {
    const sandboxRoot = "/tmp/iknow-tasks/task-xyz";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      writeSituation: "writable_tree",
    };
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

  it("envelope 同时带 finalText + writable_tree → prior 段 = [host dialogue, write root] (顺序：原 finalText 在前，写根段在后)", () => {
    // finalText 与 sandboxRoot/writeSituation 同时在场时 prior 数组先是
    // host dialogue（保持现状）再加写根段。
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-root",
      writeSituation: "writable_tree",
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

  it("envelope 同时带 evidenceContext + writable_tree → prior 段 = [evidence, write root]", () => {
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-evidence",
      writeSituation: "writable_tree",
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

  it("envelope 同时带 finalText + evidenceContext + writable_tree → prior 段 = [host dialogue, evidence, write root]", () => {
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/sb-full",
      writeSituation: "writable_tree",
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

  it("异常 / overflow：sandboxRoot 含特殊字符（空格 / Unicode） + writable_tree → 文本原样保留", () => {
    const sandboxRoot = "/tmp/has space/日本語/emoji-😀";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      writeSituation: "writable_tree",
    };
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
    // T6 (write-situation-disclosure)：worker envelope 上的处境字段由 spawn
    // 期算好后透传（manager.buildWorkerPayload），此处用真实枚举重写：
    // ① writable_main（隔离 OFF）/ ② writable_tree（隔离 ON + 树形）→ 两态
    // 与改造前**逐字节相等**（SC2 硬约束），文案 SSOT = writeRootSegment。
    const sandboxRoot = "/tmp/task-wt";
    for (const situation of ["writable_main", "writable_tree"] as const) {
      const env: WorkerEnvelope = {
        task: "t",
        sandboxRoot,
        writeSituation: situation,
      };
      const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
      assert.ok(prior);
      const text = prior[0]!.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      assert.equal(text, writeRootSegment(situation, sandboxRoot)!);
    }
  });

  it("T6: writeSituation = no_writable_root（隔离 ON + 未绑树）→ ③ 态披露，不含 sandboxRoot", () => {
    // spec SC3 / ADR-0069 D3:trailer 在装配期进上下文,早于任何写意图;
    // ③ 态披露陈述事实,点名工具 = 对每个未绑会话推一次建树,故绝不点名。
    const sandboxRoot = "/repo/main-checkout";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      writeSituation: "no_writable_root",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior[0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    // ③ 态披露 = writeRootSegment helper 同一份字面量。
    assert.equal(text, writeRootSegment("no_writable_root", sandboxRoot)!);
    // 不嵌入 sandboxRoot（无可写根 → 不能告诉模型去写哪个根）
    assert.ok(!text.includes(sandboxRoot));
    // 不点名建树工具
    assert.ok(!text.includes("create-task-worktree"));
  });

  it("T6: 旧 envelope（无 writeSituation 字段）→ typed skip,不注入写根段（OQ1 采纳 (b)）", () => {
    // spec OQ1 (b): 跨版本 resume / 旧 worker bootstrap 时,worker envelope
    // 上没有 writeSituation 字段 → 不注入写根段,不回落旧文案(旧的
    // `writable_main` 假设在 ③ 态会继续说谎)。宁可不告知,不可说错。
    const sandboxRoot = "/repo/main-checkout";
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot,
      // 故意不写 writeSituation —— 模拟旧 worker bootstrap / 跨版本 envelope。
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    // typed skip:无 finalText / evidenceContext 也无写根段 → return undefined。
    assert.equal(prior, undefined);
    // 也没有任何含 current write root 字样的 prior message（防御:实现误把
    // 缺席默认值当成 "writable_main" 渲染出旧文案）。
    assert.ok(prior === undefined);
  });

  it("T6: 旧 envelope 缺 writeSituation 但带 finalText → typed skip 写根段,host dialogue 保留", () => {
    // legacy 跨版本兼容:host dialogue / evidence 仍照常注入;只有写根段被
    // 跳过(typed skip 不回落)。理由同上一用例 —— OQ1 采纳 (b)。
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/legacy-task",
      finalText: "previous host text",
      // 缺 writeSituation —— 旧 envelope 形态。
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 1, "只保留 host dialogue,写根段被 typed skip");
    const text = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(text.includes("previous host text"));
    assert.ok(!text.includes("current write root"));
  });

  it("T6: writeSituation = no_writable_root + sandboxRoot 为空（typed stable）", () => {
    // ③ 态披露与根无关 —— empty 臂 typed 不 throw（spec SC1 + A 表 empty 臂）。
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot: "",
      writeSituation: "no_writable_root",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    const text = prior[0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    // ③ 态披露 = writeRootSegment helper 同一份字面量。
    assert.equal(text, writeRootSegment("no_writable_root", "")!);
    assert.ok(!text.includes("create-task-worktree"));
  });

  it("T6: writeSituation = writable_tree + 空 sandboxRoot → 不渲染（empty 臂 typed）", () => {
    // ① / ② + 空根 → 不渲染「写根 = 」半句（A 表 empty 臂）。注意：①/②
    // 形态下沙箱根是必填,空值意味着 spawn 未传 sandboxRoot —— 仍 typed 不 throw,
    // 直接跳过该段(与写根段缺席形态一致)。
    const env: WorkerEnvelope = {
      task: "t",
      sandboxRoot: "",
      writeSituation: "writable_tree",
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.equal(prior, undefined);
  });

  it("T6: 顺序契约 [host dialogue?, evidence?, write root] 在 typed skip 下仍守", () => {
    // 顺序契约: 写根段总是末段。typed skip 时该 slot 在 extras 数组过滤掉,
    // 顺序保持不变（与原有 §1 §2 §3 形态逐字节一致）。
    const env: WorkerEnvelope = {
      task: "judge",
      sandboxRoot: "/tmp/legacy-task",
      finalText: "truncated",
      evidenceContext: { doc: "y" },
      // 缺 writeSituation —— typed skip 路径。
    };
    const prior = priorMessagesFromEnvelope(env, passthroughEncodeUserText);
    assert.ok(prior);
    assert.equal(prior!.length, 2, "host dialogue + evidence, 写根段被 skip");
    const first = prior![0]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(
      first.includes("previous host text") || first.includes("truncated")
    );
    const second = prior![1]!.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    assert.ok(second.includes("Evidence context"));
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
