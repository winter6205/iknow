/**
 * #468 T3 — Sub-agent worker 工具面端到端断言
 * （声明面 = 实际面 / 判官只读 / 向后兼容）。
 *
 * 走真实 `createWorkerDeps` 装配路径（不引入 stub 替身 registry），
 * 用 stub-model + noop trace + 空 skill catalog 保持 hermetic —— 不真发
 * LLM / 不写盘 / 不扫 fs。
 *
 * 断言形状（依 spec Code Style 既定 + Boundaries Always）：
 *   - AciRegistry.inner（executor 实际可执行面，构造期冻结快照，loop-engine
 *     通过 deps.registry.list() 读）+ AciRegistry.visibleSchemas（模型
 *     promptTools 可见面，deps.promptTools() 读）双面同步 —— 声明面 =
 *     实际面由构造保证（registry.ts:280-296 def-list 期裁剪 + buildWorkerToolSurface
 *     幂等兜底），非事后修补。
 *
 * worker 装配特征：createWorkerDeps 不传 subagentManager / memoryDir /
 * todoDir / mcpManager / backgroundManager / graphAssembly（worker.ts:141-146
 * + #502 T3 旁注）→ 9 件条件化缺席（具体名单见下方 WORKER_BASE_SURFACE 注释）。
 * 本测试额外显式传 `skillCatalog: createSkillCatalog([])` 让 skill /
 * skill_search 在场以保持全量面可断言。具体件数 = WORKER_BASE_SURFACE.length,
 * 以数组为 source of truth（旧 10 件 lsp_* 已退役，不在 WORKER_BASE_SURFACE 中）。
 */

import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  createWorkerDeps,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createSpawnSubAgentTool } from "../../src/harness/subagent/spawn-subagent-tool.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import { ACI_TOOLSET_NAMES } from "../../src/harness/aci/tools/registry.ts";
import {
  createTodoWriteTool,
  resolveConversationTodoPath,
} from "../../src/harness/aci/tools/todo-write.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { assessSubagentIsolation } from "../../src/harness/subagent/capability.ts";
import {
  FILE_WRITE_TOOL_NAMES,
  SYMBOL_MUTATE_TOOL_NAMES,
} from "../../src/harness/aci/tools/symbol-mutate.ts";

// ---------------------------------------------------------------------------
// Constants & fixtures
// ---------------------------------------------------------------------------

/**
 * #357 T2 — 镜像 JUDGE_ROLE 真值源（run-classifier-adapter.ts:35-41 module-private，
 * 不可 import，drift 由本测试守护）。
 *
 * 判官 allow-list 推导（fail-closed）：
 *   deny = ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE
 *
 * 与真值源同源：若 JUDGE_ROLE 白名单真值漂移，本测试失败 = 显式信号。
 * 加白名单 = 显式改 JUDGE_ALLOWED_BASELINE 常量 + operator 拍板（spec 357
 * Objective 2 + plans T2 acceptance 2）。
 */
const JUDGE_ALLOWED_BASELINE: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** 镜像 = 全量面 − 白名单基线（与 run-classifier-adapter 推导公式同源）。 */
const JUDGE_DENY: ReadonlyArray<string> = Object.freeze(
  [...ACI_TOOLSET_NAMES].filter((n) => !JUDGE_ALLOWED_BASELINE.includes(n))
);

/** 测试用 minimal IknowEnv —— createWorkerDeps 路径类型要求，不真发请求。 */
const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

/**
 * worker 装配后 "全量面" 名集（无 deny-list 时）。具体件数 =
 * `WORKER_BASE_SURFACE.length`，以数组为 source of truth（注释里不写加法
 * 叙事 — 加法易漂）。T5 旧 10 lsp_* 已退役；WORKER_BASE_SURFACE 不再含
 * lsp_* 名。
 *
 * 条件化缺席（worker 不装配,详见 #468 + D6 决议）：
 *   - memory_recall / memory_save（memoryDir 缺席）
 *   - spawn_subagent / subagent_result（subagentManager 缺席）
 *   - todo_write（todoDir 缺席）
 *   - list_mcp_resources / read_mcp_resource（mcpManager 缺席）
 *   - bash_output / bash_stop（backgroundManager 缺席,#502 T3 同门）
 *   - run_graph（graphAssembly 缺席,D-α T3）
 *
 * 本测试通过显式注 skillCatalog 把 skill 计入（条件化：skillCatalog 在场
 * 时入注册表;disclosure-index-align T2 / SC5 删 skill_search 后只剩 1 件）,
 * 具体件数以 WORKER_BASE_SURFACE 数组长度为准。
 */
const WORKER_BASE_SURFACE: ReadonlyArray<string> = Object.freeze([
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
  "tool_search",
  "skill",
  "query_trace",
  // symbol-primary-aci T2:符号查询 10 件常驻（不依赖 manager，与 lsp.ts SSOT
  // 共享 lspCtx；旧 10 件 lsp_* 已在 T5 退役）。
  "find_symbol",
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_hover",
  "get_diagnostics_for_file",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
  // symbol-primary-aci T4:符号改 5 件常驻（category=write；与查询同门共享
  // lspCtx；onEdit 走 worker 装配层的 lspNotifier.invalidate 接缝，
  // 写盘后 textDocument/didChange 与 edit_file 同链路）。
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
  "safe_delete_symbol",
  // trace-mcp-read-side-split T5b — operator 裁定：list_sessions 入 worker 基础面。
  // 理由与 query_trace 同门：worker 拿到的 conversation_id 是否真存在，只有目录轴
  // 能答；category=read-only、无装配条件（任何 surface 都建 traceDir），故不条件化。
  // 位置在末位 = registry.list() 跟随 ACI_TOOLSET_NAMES 的 append-only 顺序。
  "list_sessions",
  // trace-mcp-read-side-split T6 — get_record 沿用 T5b 为 list_sessions 立的那条
  // operator 裁定，同门进 worker 基础面：worker 手里已有 conversation_id /
  // record_id 时，「这条记录到底长什么样、要不要继续下钻」只有内容轴能答，
  // 缺了它 worker 只能靠 query_trace 的行投影猜。category=read-only、无装配条件
  // （任何 surface 都建 traceDir），故不条件化。位置在末位 = registry.list()
  // 跟随 ACI_TOOLSET_NAMES 的 append-only 顺序。
  "get_record",
]);

// ---------------------------------------------------------------------------
// Parameterized helper —— 双面断言（inner + visibleSchemas）
// ---------------------------------------------------------------------------

/**
 * 收集 worker 装配后的工具面双面名集（inner 协议 registry + promptTools
 * 模型可见），断言：
 *   - 所有 `denied` 名在双面均缺席（声明面 = 实际面）
 *   - 所有 `kept` 名在双面均在场（保留工具不被误裁）
 *
 * Reused across normal / failure / boundary / judge 四类（per plan T3 acceptance 3）。
 */
function assertSurface(
  deps: LoopEngineDeps,
  denied: readonly string[],
  kept: readonly string[]
): void {
  const innerNames = deps.registry.list().map((t) => t.name);
  const promptNames = deps.promptTools().map((t) => t.name);
  for (const name of denied) {
    assert.ok(
      !innerNames.includes(name),
      `inner.list() 不应含禁项 ${name}（declared = actual）`
    );
    assert.ok(
      !promptNames.includes(name),
      `promptTools() 不应含禁项 ${name}（declared = actual）`
    );
  }
  for (const name of kept) {
    assert.ok(innerNames.includes(name), `inner.list() 应含保留工具 ${name}`);
    assert.ok(promptNames.includes(name), `promptTools() 应含保留工具 ${name}`);
  }
}

/** hermetic 装配缝：stub-model + 空 skill catalog + noop trace + stub system。 */
function hermeticOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A. 正常 / happy path —— declared deny-list 全生效（声明面 = 实际面）
// ---------------------------------------------------------------------------

describe("worker tool surface: 正常路径 — declared deny-list 全生效", () => {
  it("deny JUDGE 禁项（allow-list 推导）→ inner+visibleSchemas 双面 = 白名单三件", async () => {
    // #357 T2 判官 allow-list 推导：deny = 全量面 − {read_file, grep, glob}，
    // 装配后双面仅剩白名单三件。fail-closed：白名单外一律禁。
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    assertSurface(deps, JUDGE_DENY, ["read_file", "grep", "glob"]);
  });

  it("deny JUDGE 禁项 → 双面集合恰为白名单基线（与 WORKER_BASE_SURFACE - JUDGE_DENY 完全相等）", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    const expected = WORKER_BASE_SURFACE.filter((n) => !JUDGE_DENY.includes(n));
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...expected]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...expected]
    );
  });
});

// ---------------------------------------------------------------------------
// B. 失败路径 —— 宽容模式（buildWorkerToolSurface 静默跳过未知名）
// ---------------------------------------------------------------------------

describe("worker tool surface: 失败路径 — 未知名宽容忽略（lenient）", () => {
  it("deny 含未知名 → 仅剔除已知名 bash,不抛、其余工具俱在", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        disallowedTools: ["bash", "foo_tool_does_not_exist"],
      })
    );
    // 已知项被裁，未知名被宽容忽略（buildWorkerToolSurface 语义）。
    assertSurface(deps, ["bash"], ["read_file", "grep", "glob", "tool_search"]);
  });

  it("deny 全部为未知名 → 不裁剪, 工具面 = 全量面", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        disallowedTools: ["typo_a", "typo_b", "typo_c"],
      })
    );
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    assert.deepEqual(innerNames, [...WORKER_BASE_SURFACE]);
    assert.deepEqual(promptNames, [...WORKER_BASE_SURFACE]);
  });
});

// ---------------------------------------------------------------------------
// C. 边界 —— undefined / 空 / deny-all
// ---------------------------------------------------------------------------

describe("worker tool surface: 边界 — undefined / 空 / deny-all", () => {
  it("undefined → 双面 = WORKER_BASE_SURFACE 全量面", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
  });

  it("空数组 → 双面 = WORKER_BASE_SURFACE 全量面（与 undefined byte-identical）", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ disallowedTools: [] }));
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
  });

  it("deny 全量实际工具 → inner+promptTools 双面为空, createWorkerDeps 不 crash", async () => {
    // Gate 3 镜像过滤：deny 全量后 toolsetNames 与 factories 键集同时为空
    // （都=∅），由构造期保证不抛，run 路径可走纯文本回答。
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...WORKER_BASE_SURFACE] })
    );
    assert.equal(deps.registry.list().length, 0);
    assert.equal(deps.promptTools().length, 0);
  });
});

// ---------------------------------------------------------------------------
// D. 权限 / 判官只读 —— JUDGE_ROLE allow-list 推导（SC3 + SC4 权限行）
// ---------------------------------------------------------------------------

describe("worker tool surface: 权限 — 判官只读（allow-list 推导）", () => {
  it("判官面双面恰为白名单三件（inner.list() 与 promptTools() = {read_file, grep, glob}）", async () => {
    // #357 T2：判官 deny = 全量面 − {read_file, grep, glob}，装配后双面
    // 恰为白名单三件（fail-closed allow-list）。与「A 正常」测试重叠语义但
    // 独立断言 —— 显式命名让判官白名单变更时定位到此用例。
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    assert.deepEqual(innerNames, [...JUDGE_ALLOWED_BASELINE]);
    assert.deepEqual(promptNames, [...JUDGE_ALLOWED_BASELINE]);
  });

  it("白名单外全部工具在 inner.list() 与 promptTools() 双面均缺席", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: [...JUDGE_DENY] })
    );
    const innerNames = deps.registry.list().map((t) => t.name);
    const promptNames = deps.promptTools().map((t) => t.name);
    for (const denied of JUDGE_DENY) {
      assert.ok(
        !innerNames.includes(denied),
        `判官 inner.list() 不应含 ${denied}`
      );
      assert.ok(
        !promptNames.includes(denied),
        `判官 promptTools() 不应含 ${denied}`
      );
    }
  });

  it("白名单外工具在 reg.catalog 也缺席（catalog 双层防护 / executor + permission middleware）", async () => {
    // 单独调一次 createDefaultAciRegistry 验证 catalog 端（registry.inner 不直接
    // 暴露 catalog，但 createWorkerDeps 内部已用 createDefaultAciRegistry，
    // 故这里通过其返回的 registry 内层结构拿 catalog —— 仅在 catalog 暴露
    // 时断言；不暴露则只锁 inner + visibleSchemas 双面）。
    const { createDefaultAciRegistry } =
      await import("../../src/harness/aci/tools/registry.ts");
    const reg = createDefaultAciRegistry({
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
      skillCatalog: createSkillCatalog([]),
      disallowedTools: [...JUDGE_DENY],
    });
    // 双面已通过 worker 装配路径覆盖；catalog 是次级断言（permission 中间件
    // 与延迟加载共用，缺席即 catalog.get 也返回 undefined）。
    for (const denied of JUDGE_DENY) {
      assert.equal(
        reg.catalog.get(denied),
        undefined,
        `判官 catalog.get(${denied}) 应返回 undefined`
      );
    }
  });
});

describe("worker tool surface: 隔离门禁 — symbol 写工具", () => {
  it("真实 explore worker 工具面不含 symbol 写工具且判为只读", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const workerToolNames = deps.registry.list().map((tool) => tool.name);

    for (const name of SYMBOL_MUTATE_TOOL_NAMES) {
      assert.ok(
        !workerToolNames.includes(name),
        `真实 worker 工具面不应包含 ${name}`
      );
    }

    const decision = assessSubagentIsolation({
      role: "explore",
      availableTools: workerToolNames,
    });
    assert.equal(decision.conclusion, "readonly");
    assert.equal(decision.reason, "write_tools_denied_bash_readonly");
  });

  it("真实 explore worker 工具面不含文件写工具时仍判为只读", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        role: "explore",
        disallowedTools: [...FILE_WRITE_TOOL_NAMES],
      })
    );
    const workerToolNames = deps.registry.list().map((tool) => tool.name);

    for (const name of FILE_WRITE_TOOL_NAMES) {
      assert.ok(
        !workerToolNames.includes(name),
        `真实 worker 工具面不应包含 ${name}`
      );
    }

    const decision = assessSubagentIsolation({
      role: "explore",
      availableTools: workerToolNames,
      disallowedTools: [...FILE_WRITE_TOOL_NAMES],
    });
    assert.equal(decision.conclusion, "readonly");
    assert.equal(decision.reason, "write_tools_denied_bash_readonly");
  });
});

describe("worker tool surface: T3 catalog deny contract", () => {
  it("intentionally narrows an explore worker surface while preserving the role wire bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t3-role-worker-"));
    const payloads: WorkerEnvelope[] = [];
    const manager = createSubAgentManager({
      sandboxRoot: root,
      spawn: (_def, _taskId, payload) => {
        payloads.push(payload);
        return spawnChild(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          {
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
      },
    });

    try {
      // T3-before measurement: the same role/no-parent-deny input exposed
      // edit_file and write_file. Current assembly deliberately consumes the
      // catalog deny because leaving those tools available is a write bypass.
      const deps = await createWorkerDeps(
        hermeticOpts({ sandboxRoot: root, role: "explore" })
      );
      const workerToolNames = deps.registry.list().map((tool) => tool.name);
      assert.ok(!workerToolNames.includes("edit_file"));
      assert.ok(!workerToolNames.includes("write_file"));
      assert.ok(!workerToolNames.includes("rename_symbol"));

      const tool = createSpawnSubAgentTool({ manager });
      await tool.handler({
        task: "explore-only",
        subagent_type: "explore",
        wait: false,
      });

      assert.equal(payloads.length, 1);
      assert.equal(
        JSON.stringify(payloads[0]),
        JSON.stringify({
          task: "explore-only",
          sandboxRoot: root,
          disallowedTools: [...FILE_WRITE_TOOL_NAMES],
          role: "explore",
          // T6: 缺 isolationOn 时,manager 默认按隔离 OFF + sandboxRoot(非
          // 树形) → writable_main;与改造前 worker prior 形态逐字节相等。
          writeSituation: "writable_main",
        })
      );
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E. 空 / 非法 / 旧 wire —— WorkerEnvelope 缺 disallowedTools（向后兼容 SC6）
// ---------------------------------------------------------------------------

describe("worker tool surface: 向后兼容 — 旧 wire 无 disallowedTools 字段", () => {
  it("WorkerEnvelope 缺 disallowedTools → createWorkerDeps 透传 undefined → 双面 = 全量面", async () => {
    // 旧 wire 不带 disallowedTools 字段（manager.ts 序列化前可能未声明 deny-list，
    // 或更早版本 envelope 完全缺字段）—— 手构 envelope 模拟。
    const oldEnvelope: WorkerEnvelope = {
      task: "investigate legacy wire",
      sandboxRoot: "/tmp/sb",
    };
    assert.equal(
      oldEnvelope.disallowedTools,
      undefined,
      "测试 fixture: 旧 wire 缺 disallowedTools"
    );
    const deps = await createWorkerDeps(
      hermeticOpts({ disallowedTools: oldEnvelope.disallowedTools })
    );
    assert.deepEqual(
      deps.registry.list().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
    assert.deepEqual(
      deps.promptTools().map((t) => t.name),
      [...WORKER_BASE_SURFACE]
    );
  });
});

// ---------------------------------------------------------------------------
// F. 并发 —— N/A（worker 装配是进程启动期一次性同步裁剪，无并发窗口）
//     spec Testing Strategy "并发 N/A（worker 装配是进程启动期一次性同步裁剪）"。
// ---------------------------------------------------------------------------

describe("worker tool surface: 并发 N/A — 占位说明", () => {
  it("worker 装配路径同步一次性, 无并发窗口", () => {
    // 注释占位 —— 详见 spec Testing Strategy。
    // worker 装配路径 = createWorkerDeps 内 createDefaultAciRegistry 同步调用，
    // def-list 期裁剪在 createAciRegistry(tools) 之前（构造期保证 inner 是
    // 冻结快照 aci-registry.ts:20）。无并发窗口，无需并发用例。
    assert.equal(true, true);
  });
});

// ---------------------------------------------------------------------------
// ADR-0085 / SC9 — worker 与父会话共用同一本账（原 #440 D6「worker 无
// todo_write」契约已被 ADR-0085 推翻）。
//
// 新不变式（替代旧四条）：
//   1. envelope.todoLedger 在场 → todo_write **在** worker 双面工具面上
//      （不是「工具缺席」——模型要读得到 `add` 的拒绝原因）；
//   2. worker 的 read / update 落在父会话账本（同一个 todos.md 文件）；
//   3. worker 的 `add` 是工具自身的 typed 拒绝（ToolExecutionError +
//      `[todo_write]` 前缀），文件不动；
//   4. 两个父会话的账本互不交叉（每 conversationId 一本，id 不串）。
//   5. envelope 缺 todoLedger（旧 wire）→ 仍退回缺席形态，byte-stable。
// ---------------------------------------------------------------------------

describe("worker tool surface: ADR-0085 SC9 — worker 共用父会话账本", () => {
  it("worker 装配路径不传 memoryDir → memory_recall / memory_save 均缺席(条件化未回退)", async () => {
    const deps = await buildWorkerWithFullSkillCatalog();
    const names = deps.registry.list().map((d) => d.name);
    assert.ok(!names.includes("memory_recall"));
    assert.ok(!names.includes("memory_save"));
  });

  it("envelope.todoLedger 缺席（旧 wire）→ inner + promptTools 双面均不含 todo_write", async () => {
    // 旧 wire / 跨版本 resume 形态：worker 工具面维持 ADR-0085 之前的 25 件，
    // 不因新字段的存在而漂移。
    const deps = await buildWorkerWithFullSkillCatalog();
    assertSurface(deps, ["todo_write"], [...WORKER_BASE_SURFACE]);
  });

  it("envelope.todoLedger 在场 → todo_write 在 inner + promptTools 双面（工具在场,非静默缺席）", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-worker-"));
    try {
      const deps = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId: "conv-parent" },
      });
      assertSurface(deps, [], [...WORKER_BASE_SURFACE, "todo_write"]);
      // 双面件数 = 基础面 + 1（todo_write 是唯一增量）。
      assert.equal(deps.registry.list().length, WORKER_BASE_SURFACE.length + 1);
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });

  it("worker read / update 落在父会话账本上（同一个 todos.md）", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-shared-"));
    try {
      const conversationId = "conv-parent-shared";
      // 父会话先写两条（父路径 = 同一 projectDir + 同一 conversationId）。
      const parent = createTodoWriteTool({ todoDir, actor: { canAdd: true } });
      await parent.handler(
        { mode: "add", items: ["parent step 1", "parent step 2"] },
        { conversationId }
      );

      const deps = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId },
      });
      const tool = deps.registry.get("todo_write");
      assert.ok(tool, "worker surface 必须含 todo_write");

      // worker 无 ctx（worker 进程 executor 不合成 conversationId）——
      // 路径由 deps.actor.conversationId 回退解析到父账本。
      const seen = (await tool.handler({ mode: "read" })) as string;
      assert.match(seen, /\[t1\] parent step 1/);
      assert.match(seen, /\[t2\] parent step 2/);

      const receipt = await tool.handler({
        mode: "update",
        id: "t1",
        status: "completed",
      });
      assert.equal(receipt, "Updated t1: status=completed");

      // 父会话回读：看到 worker 的更动 —— 同一本账（物理文件即父会话路径）。
      const parentView = (await parent.handler(
        { mode: "read" },
        { conversationId }
      )) as string;
      assert.match(parentView, /\[x\] \[t1\] parent step 1/);
      assert.match(
        await readFile(
          resolveConversationTodoPath({
            projectDir: todoDir,
            conversationId,
          }),
          "utf8"
        ),
        /\[x\] \[t1\] parent step 1/
      );
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });

  it("worker `add` → 工具自身 typed 拒绝（[todo_write] 前缀 + parent-only），文件不动", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-add-"));
    try {
      const conversationId = "conv-parent-add";
      const parent = createTodoWriteTool({ todoDir });
      await parent.handler(
        { mode: "add", item: "parent owns additions" },
        { conversationId }
      );

      const deps = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId },
      });
      const tool = deps.registry.get("todo_write");
      assert.ok(tool);

      await assert.rejects(
        tool.handler({ mode: "add", item: "worker addition" }),
        (err: unknown) => {
          assert.ok(
            err instanceof ToolExecutionError,
            "typed error,非静默丢弃"
          );
          assert.match((err as Error).message, /^\[todo_write\]/);
          assert.match((err as Error).message, /parent-only/);
          return true;
        }
      );

      // 拒绝发生在任何写盘之前：父账本只有父会话那一条。
      const onDisk = await readFile(
        resolveConversationTodoPath({ projectDir: todoDir, conversationId }),
        "utf8"
      );
      assert.equal(onDisk, "- [ ] [t1] parent owns additions\n");
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });

  it("两个父会话的账本互不交叉：A 的 worker 读不到也改不到 B 的条目", async () => {
    const todoDir = await mkdtemp(join(tmpdir(), "iknow-sc9-isolation-"));
    try {
      const convA = "conv-aaa";
      const convB = "conv-bbb";
      const parent = createTodoWriteTool({ todoDir });
      await parent.handler(
        { mode: "add", item: "A-item" },
        { conversationId: convA }
      );
      await parent.handler(
        { mode: "add", item: "B-item" },
        { conversationId: convB }
      );

      // A 的 worker（装配锚点 = A 的 conversationId）。
      const depsA = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId: convA },
      });
      const toolA = depsA.registry.get("todo_write");
      assert.ok(toolA);

      const seenByA = (await toolA.handler({ mode: "read" })) as string;
      assert.match(seenByA, /A-item/);
      assert.ok(!seenByA.includes("B-item"), "A 的 worker 不得看见 B 的账本");

      // A 的 worker 用 B 的 id 去 update → 在 A 的账本里 t1 是 A 的条目，
      // 故此处以「B 账本逐字节不动」为判据（id 空间本就会重叠，文件轴才是
      // 隔离轴）。
      await toolA.handler({ mode: "update", id: "t1", status: "completed" });

      const pathA = resolveConversationTodoPath({
        projectDir: todoDir,
        conversationId: convA,
      });
      const pathB = resolveConversationTodoPath({
        projectDir: todoDir,
        conversationId: convB,
      });
      assert.notEqual(pathA, pathB);
      assert.equal(await readFile(pathA, "utf8"), "- [x] [t1] A-item\n");
      assert.equal(
        await readFile(pathB, "utf8"),
        "- [ ] [t1] B-item\n",
        "B 的账本不得被 A 的 worker 触碰"
      );

      // B 的 worker 同样看不到 A 的更动之外的任何 A 内容。
      const depsB = await buildWorkerLedgerDeps({
        todoLedger: { projectDir: todoDir, conversationId: convB },
      });
      const seenByB = (await depsB.registry.get("todo_write")!.handler({
        mode: "read",
      })) as string;
      assert.ok(!seenByB.includes("A-item"));
      assert.match(seenByB, /B-item/);
    } finally {
      await rm(todoDir, { recursive: true, force: true });
    }
  });
});

/**
 * 走真实 createWorkerDeps 装配：注入 stub-model + 空 skill catalog 让
 * skill 静态在场（Gate 3 锁,disclosure-index-align T2 删 skill_search 后只剩
 * 1 件），不加 subagentManager 与 memoryDir（worker 装配特征）。默认不传
 * todoLedger —— 旧 wire 形态（ADR-0085 之前的 worker 工具面）。
 * 返回值含 deps.registry（executor 真实可见）+ deps.promptTools（模型可见）。
 */
async function buildWorkerWithFullSkillCatalog(
  extra?: Partial<CreateWorkerDepsOptions>
): Promise<LoopEngineDeps> {
  return createWorkerDeps(workerBaseOpts(extra));
}

/** ADR-0085 SC9 用例专用：装配锚定父会话账本的 worker registry。 */
async function buildWorkerLedgerDeps(extra: {
  readonly todoLedger: { projectDir: string; conversationId: string };
}): Promise<LoopEngineDeps> {
  return buildWorkerWithFullSkillCatalog(extra);
}

/** createWorkerDeps 的最小 hermetic opts（stub-model + 空 skill + noop trace）。 */
function workerBaseOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-worker-t5",
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
  return {
    env,
    model: createStubModel({ responses: [] }),
    sandboxRoot: "/tmp/sandbox-worker-t5",
    trace: createNoopTraceService(),
    skillCatalog: createSkillCatalog([]),
    ...extra,
  };
}

/**
 * T8 (plans/parent-visible-tmp.md) — bash + 写工具 description：进项目写
 * taskRoot；不必进仓写 `/tmp`。写根段仍只说交付根（见 envelope-write-situation）。
 */
describe("T8 parent-visible-tmp — bash / write-tool descriptions", () => {
  it("bash, write_file, and edit_file say write into the project at taskRoot; write /tmp when it need not enter the repo", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const names = ["bash", "write_file", "edit_file"] as const;
    for (const name of names) {
      const tool = deps.registry.list().find((t) => t.name === name);
      assert.ok(tool, `worker surface missing ${name}`);
      assert.match(
        tool.description,
        /write into the project at taskRoot/i,
        `${name} description must name taskRoot as the project write`
      );
      assert.match(
        tool.description,
        /write \/tmp when it need not enter the repo/i,
        `${name} description must name /tmp for files that need not enter the repo`
      );
    }
  });

  it("symbol mutate tools do not carry fence-write /tmp guidance", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    for (const name of SYMBOL_MUTATE_TOOL_NAMES) {
      const tool = deps.registry.list().find((t) => t.name === name);
      assert.ok(tool, `worker surface missing ${name}`);
      assert.doesNotMatch(
        tool.description,
        /write into the project at taskRoot/i,
        `${name} must not reuse bash/write_file fence-write guidance`
      );
      assert.doesNotMatch(
        tool.description,
        /write \/tmp when it need not enter the repo/i,
        `${name} must not tell the model to write /tmp`
      );
    }
  });
});
