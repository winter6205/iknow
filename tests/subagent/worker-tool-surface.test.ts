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
import { mkdtemp, rm } from "node:fs/promises";
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
 * 本测试通过显式注 skillCatalog 把 skill / skill_search 计入（条件化：
 * skillCatalog 在场时入注册表），具体件数以 WORKER_BASE_SURFACE 数组长度为准。
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
  "skill_search",
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
// #440 T5: D6 worker ownership isolation — todo_write 不入 worker 工具面
// 装配路径 createWorkerDeps → createDefaultAciRegistry(无 todoDir)
// → factories 缺 todo_write → 双面（inner + visibleSchemas）俱缺席。
// 即使主 loop 注册表装配了 todo_write（buildHarnessEngine + todoDir），
// worker 子进程仍是 25 件（25 - subagent2 - memory2 - todo_write = 21，
// 加 skill 2 = 23；详见 D6 决策 + #440 T4 todoDir seam）。
// ---------------------------------------------------------------------------

describe("worker tool surface: #440 T5 D6 ownership — todo_write 缺席", () => {
  it("worker 装配路径不传 memoryDir → memory_recall / memory_save 均缺席", async () => {
    const deps = await buildWorkerWithFullSkillCatalog();
    const names = deps.registry.list().map((d) => d.name);
    assert.ok(!names.includes("memory_recall"));
    assert.ok(!names.includes("memory_save"));
  });

  it("worker 装配路径不传 todoDir → inner.list() 不含 todo_write", async () => {
    const deps = await buildWorkerWithFullSkillCatalog();
    const names = deps.registry.list().map((d) => d.name);
    assert.ok(
      !names.includes("todo_write"),
      `worker surface should exclude todo_write, got: ${names.join(", ")}`
    );
  });

  it("worker 装配路径不传 todoDir → promptTools() 不含 todo_write", async () => {
    const deps = await buildWorkerWithFullSkillCatalog();
    if (!deps.promptTools) {
      // promptTools 缺席本身是合法（无注册表 → 无可见面），跳过本断言
      return;
    }
    const names = deps.promptTools().map((d) => d.name);
    assert.ok(
      !names.includes("todo_write"),
      `worker promptTools should exclude todo_write, got: ${names.join(", ")}`
    );
  });

  it("worker 装配路径不传 todoDir → reg.catalog.get(todo_write) === undefined（双层防护）", async () => {
    const deps = await buildWorkerWithFullSkillCatalog();
    // 通过 dynamic registry wrapper 测试（executor 实际可见的查找路径）
    const found = (deps.registry as { get?: (n: string) => unknown }).get?.(
      "todo_write"
    );
    assert.equal(found, undefined);
  });
});

/**
 * 走真实 createWorkerDeps 装配：注入 stub-model + 空 skill catalog 让
 * skill/skill_search 静态在场（Gate 3 锁），不加 subagentManager 与
 * memoryDir（worker 装配特征），不传 todoDir（D6 ownership）。返回值
 * 含 deps.registry（executor 真实可见）+ deps.promptTools（模型可见）。
 */
async function buildWorkerWithFullSkillCatalog(): Promise<LoopEngineDeps> {
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
  const opts: CreateWorkerDepsOptions = {
    envelope: {} as WorkerEnvelope,
    env,
    model: createStubModel({ responses: [] }),
    sandboxRoot: "/tmp/sandbox-worker-t5",
    trace: createNoopTraceService(),
    skillCatalog: createSkillCatalog([]),
  };
  return createWorkerDeps(opts);
}
