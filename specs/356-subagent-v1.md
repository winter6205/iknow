# Spec: 356-subagent-v1 — 主代理 spawn_subagent 工具 + 子进程重入 + JSON 信封 + 角色机制（SPEC-1 种子）

> 输入 = [issue #356](https://github.com/winter6205/iknow/issues/356) + 父图 [wayfinder #331](https://github.com/winter6205/iknow/issues/331) Q1/Q2/Q4 决议 + 源格 [wayfinder #130](https://github.com/winter6205/iknow/issues/130) + #337 已落地的 `registerExternal` 动态注册缝 + mcp/manager 生命周期蓝本。
> 范围 = 主代理可 fork 子代理的 V1 形态：spawn_subagent ACI 工具、子进程 headless 重入、JSON 信封、独立 registry、角色机制（deny-list 优先）、host drain 主路径、subagent_result 兜底查询、生命周期管理。
> 不含 = 沙箱装配（→ SPEC-2 #357）/ verifier 角色裁剪（→ SPEC-2 #357）/ trace 事件接入（→ SPEC-3 #358）/ loop 配置可视化（→ SPEC-3 #358）/ 跨 run 多阶段编排 / 子代理互发消息 / 动态工作流（→ 后续独立地图）。
> 落地 = spec → ACR → writing-plans，本 spec 不含实施代码。

---

## ASSUMPTIONS（假设闸门）

编号列出本 spec 的全部隐含假设。1–12 由 tracker 决议锚定（#331 Decisions so far / #130 closed / #224 spec / #337 已落地 / CONTEXT.md 术语）；13–19 是 spec 层新增假设，self-audited（operator 显式授权 SPEC 自审，写入 SPEC 并在 §Open Questions 留复核口）。

### tracker 决议锚定

1. **入口 = `spawn_subagent` ACI 工具** — **confirmed by #130 Q1 + #331 Decisions so far "T1 / Q1-Q4"**
2. **子进程 = 同 binary headless 重入**：`node <iknow-bin> --subagent-worker`，stdin JSON-line / stdout JSON 信封 — **confirmed by #331 T1**
3. **主 loop 不阻塞**，返回 `{ task_id: string }` — **confirmed by #130 Q1 + #331 T1**
4. **子代理进程内独立 registry**（`createDefaultAciRegistry()`），不依赖父进程注册表 — **confirmed by #130 T1 + #331 T1**
5. **`spawn_subagent` 自身进 `ACI_TOOLSET_NAMES` SSOT**，surface 门控 = chat/tui/serve 挂载 / ask 不挂 — **confirmed by #331 T1**
6. **角色机制 = `SubAgentDefinition { system_prompt, disallowed_tools, model, background }`**，deny-list 优先 — **confirmed by #334 Q5 + #331 T1 + T4**
7. **默认角色 deny-list 掉 `spawn_subagent`**：v1 禁止嵌套派发 — **confirmed by #331 T4 verifier 角色 + 默认 deny**
8. **浓缩回传 JSON 信封**：`{status, summary, result, fileRefs, usage}`；**顶层 `status ∈ {ok, failed}`**；失败时 `reason` 字段细分 `crashed` / `maxTurnsExceeded` / `timeout` / `protocolError`（不引入 Q4 之外的新 status 枚举；查询面 queryBuffer 的 running/not_found 是**查询面状态**，不是顶层 status）。`maxTurnsExceeded` / `timeout` 细分由 #335 Q7 决议补 — **confirmed by #331 T1 + #335 Q7**
9. **结果回主会话 = host 层 drain 主路径**：子代理完成 → 浓缩回传作为 user 消息在下一轮 `run()` 注入 — **confirmed by #130 Q1 + #331 T1**
10. **`subagent_result(task_id)` 工具作为兜底查询面**：同步 poll，给 operator 主动查询；**派发规则和工具优先级由工具 description 引导**而非 deps.system 段（#331 T7 决议："派发规则放工具 description 而非主 system prompt"）。→ **self-correction**：将原措辞「deps.system 段或工具 description」更正为「工具 description」。— **confirmed by #130 Q1 + #331 T1 / T7**
11. **并行模型 = 多个独立子进程**，iknow executor **串行模型不动**；主代理在同一轮可发起多次 `spawn_subagent`，每条独立进程 — **confirmed by #130 Q3 + #331 T1**
12. **复用 mcp/manager 生命周期蓝本**（`shutdown` / `SIGTERM` / `abort in-flight`）作为子代理进程池的关闭实现参考 — **confirmed by #337 T8 + #331 T1**

### spec 层新增（self-audited）

13. **`spawn_subagent` / `subagent_result` 两件工具无条件进 `ACI_TOOLSET_NAMES`（append-only 静态名单），但装配期条件化（与 memory / skill 同形态）**：`registerExternal` 在 #337 落地时强制 `mcp__` 命名空间（aci-registry.ts:94-98），`spawn_subagent` 不是 mcp__ 工具，**不能复用**该动态缝。两件工具改走 `createDefaultAciRegistry` 的静态 factories 路径（`tools/registry.ts`），工厂依赖注入主代理本地 `SubAgentManager`；`manager` 在 `build-engine.ts` 按 surface 条件构造（chat/tui/serve 有、ask 无），`ask` 时两件工具 factory 不实例化、Gate 3 的 `toolsetNames` 镜像过滤（同 `skillCatalog` 条件化先例，registry.ts:215-218）。子代理 worker 进程内直接调 `createDefaultAciRegistry()`，不涉及 `registerExternal`。→ **自审通过；复核口见 Open Questions OQ1**
14. **子代理进程 crash / hang / 超时三类失败各自定义**：`crashed` = 进程非 0 退出码或被信号杀死（catch child.on('exit', {code !== 0 || signal})）；`timeout` = 子代理 `timeoutMs` 到期 → manager 主动 SIGTERM + 兜底 SIGKILL；`maxTurnsExceeded` = 子代理 run() 抛 MaxTurnsExceeded（按 host drain 协议落 reason）。本 spec 落地时这三类分别有判定函数 + test fixture（sc: subprocess.exit code ≠ 0 vs signal vs child_process.kill after timeout）。→ **自审通过**
15. **父代理的 `spawn_subagent` 工具的 `inputSchema` 用 ajv strict 编译过的对象**：与 #337 MCP 同步态（同一 ajv 实例在 `createAciRegistry` 内构造）—— 本 spec 实施时复用 `createAciRegistry` 已有的 `addFormats` + strict 编译路径，不在 aci-registry.ts 引入第二份 ajv。schema 字段名严格驼峰：`task` / `systemPrompt` / `disallowedTools` / `model` / `background` / `maxTurns` / `timeoutMs`。→ **自审通过**
16. **退出码约定**：子代理 worker 进程 0 = 收尾完整（即便 status=ok 也按 envelope 退出语义正常）；非 0 = 父代理 drain 走 `{status: "failed", reason: "crashed"}` 而非 exit code。**HOST 仅在协议层崩溃（JSON parse 失败 / 信封字段缺失）才走 exit ≠ 0**，并把 reason = `protocolError`。→ **自审通过**
17. **浓缩截断发生在 worker 进程 emit envelope 之前**，由 `src/harness/subagent/envelope.ts` 的 `truncateEnvelopeResult(env)` 负责（不归 executor —— 浓缩 result 是子代理 run() 自产，不是工具输出，contract X 不外延到这里）。策略 = 测 `env.result.length`、超 20000 chars 强制截断并合成 `[...truncated to 20000 chars; total NNNN; head 8000 chars prepended to tail 8000 chars]`，落入 `env.truncated = true` / `env.totalLength = NNNN` 字段。父代理只收已截断 envelope，不再二次截断。→ **自审通过**
18. **`subagent_result(task_id)` 同步兜底 = 工具非阻塞读**：agent 调用必须立即返回。已 completed 的 → 返回缓存的浓缩 envelope；running 的 → 返回 `{status: "running"}` 不阻塞；failed 的 → 返回 `{status: "failed", reason, summary}`；未知 task_id → `{status: "not_found"}`。**无 sleep / 无 await** —— 这是兜底查询面的核心约束（查询面状态 running/not_found/completed/failed 是四态，非顶层 status 枚举）。→ **自审通过**
19. **本 spec 实施不按单 commit 落地**：按依赖序拆 ≥3 个 commit（①subagent worker 二进制模式 + JSON 信封 + 独立 registry；②父代理 `SubAgentManager` + spawn_subagent ACI 工具 + 角色 deny-list；③host drain 实现 + `run({priorMessages: ...})` 接缝落地）。工作树既有的 `@types/node` / `.iknow/mcp.json` 漂移与本 spec 无关，实施前先单独 stash 隔离。→ **自审通过；跟踪 ADR-0014 收尾**

---

## Objective

把 iknow 主代理从「单进程顺序 loop」升级为「**主代理可 fork 子代理、并行调研/独立验证、仅回传浓缩结果、生命周期可追踪、完成事件可观测**」（V1 形态）：

1. **新增 `spawn_subagent` ACI 工具**：模型调一次，返回 `{task_id}`，不阻塞当前 run。子进程独立跑完整 loop（含工具面），父代理立即继续推模型下一轮。
2. **新增 `--subagent-worker` 二进制模式**：同 iknow 主 bin headless 重入，stdin/stdout JSON 信封通信；`process.argv` 解析为 worker 模式后跳过 chat/ask/serve 全部分发。
3. **新增 `SubAgentManager`**（父代理内置）：持有 `task_id → child_state` 映射、生命周期（spawn / completed / crashed / timeout）、浓缩结果缓冲、abort 控制器、shutdown 链。
4. **新增 `subagent_result(task_id)` 工具**（兜底查询）：同步非阻塞读 buffer，主路径之外的 operator 主动查询 / agent 兜底。
5. **角色机制**：`SubAgentDefinition { system_prompt, disallowed_tools, model, background }`；默认 deny-list 掉 `spawn_subagent` 自身，v1 禁止嵌套派发；`disallowed_tools` 超过子代理可用工具面 → 装配期 fail-fast。
6. **生命周期抽象**：`SubAgentManager.shutdown()` 仿 `mcp/manager.ts:266-306` 蓝本 —— handle.close + stdio 子孙 SIGTERM + abort in-flight + 兜底 SIGKILL；挂到 `registerShutdown` 进程退出钩子。
7. **host drain 主路径**：子代理 completed → manager 缓冲 → 注入下一轮 `run()` user text（在 chat REPL / serve / TUI 入口）—— 让模型在下一轮看到浓缩结果。

**用户**：iknow 单用户单项目本机产品；chat / serve / TUI 三入口显式挂 `spawn_subagent`，ask 不挂。

**成功形态**：

- `npm test` 全绿含新测试；
- stub-model 脚本化 E2E：`spawn_subagent → host drain → 下一轮模型可见浓缩结果`；
- crash / timeout / maxTurnsExceeded 三类失败各自有 fixture + 判定函数单测；
- `ask` 入口装配期不创建 manager（与 #337 ask 不装 mcp 对齐）；
- TUI/chat 显式 spawn 后 SIGTERM → 子代理孙子进程被关；
- `npm run probe:sandbox`（若 SPEC-2 落地后集成）/ 全 8 类探针无回归（SPEC-1 自身不动 sandbox）。

---

## Tech Stack

| 项          | 取值                                                                                                | 备注                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 语言        | TypeScript（5.x ESM，与 harness 一致）                                                              | —                                                                                               |
| 运行时      | Node.js                                                                                             | stdio JSON-line 信封：`process.stdin` / `process.stdout`（不触碰 `console.log`，避免污染 wire） |
| 进程 spawn  | `child_process.spawn`（`identity/host-init.ts:29` 既有先例；与 mcp/manager.ts:478 `sanitize` 同源） | 复用现有 spawn pattern；不发明 fork API                                                         |
| Schema 校验 | ajv `strict: true`（`createAciRegistry` 内既有）                                                    | spec 层新增假设 15：不引入第二份 ajv 实例                                                       |
| 协议        | JSON-line 信封：`\n` 分隔一条 JSON object，UTF-8                                                    | 单方向 = stdin 进 + stdout 出 + stderr = 日志（被父代理 forward 到 iknow stderr；无 wire 噪声） |
| 测试        | vitest                                                                                              | `npm test`                                                                                      |

本 spec **不引入新依赖**。lockfile 不变。

---

## Commands

```bash
# Build
npm run typecheck       # 类型校验

# Test（产品主路径）
npm test                # vitest: unit + harness + integration

# Lint
npm run lint

# 单一字段是否动 sandbox
npm run probe:sandbox   # 不在本 spec 范围（SPEC-2 集成时跑）
```

本 spec 不引入新命令。新增 CLI 形态：

```bash
iknow --subagent-worker                 # 进入 worker 模式（product 进程内自动 fork；operator 不直调）
```

---

## Project Structure

| 路径                                           | 形态   | 角色                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/harness/subagent/manager.ts`              | **新** | `SubAgentManager`：task_id → child_state 映射；spawn / waitFor / shutdown；abort 控制器；浓缩结果 buffer（与 mcp/manager.ts:266 蓝本镜像）                                                                                                                          |
| `src/harness/subagent/envelope.ts`             | **新** | 单向 JSON 信封：父侧写出 → 子侧 stdin 解析（`parseWorkerEnvelope`）；子侧 run() 结束 → stdout emit → 父侧 `parseParentEnvelope`；ajv strict 校验两侧；`truncateEnvelopeResult` 落 `truncated` + `totalLength` 字段；schema 缺字段/wrong type 一律 throw（协议错误） |
| `src/harness/subagent/worker.ts`               | **新** | worker 模式主线：`process.stdin` 接入、信封解析、spawn 子 run()、浓缩 envelope emit；`SIGTERM` 友好收尾；console 不污染 wire                                                                                                                                        |
| `src/harness/subagent/role.ts`                 | **新** | `SubAgentDefinition` 类型 + 默认 deny-list + 装配期工具面裁剪（基于 `disallowed_tools` × 当前 registry.byName set 交集）；越界 → RegistryConstructionError                                                                                                          |
| `src/harness/subagent/spawn-subagent-tool.ts`  | **新** | 第 24/25 件 `AciToolDef`：`spawn_subagent`（sync 入口，返回 `{task_id}`）                                                                                                                                                                                           |
| `src/harness/subagent/subagent-result-tool.ts` | **新** | 第 25/25 件 `AciToolDef`：`subagent_result`（同步非阻塞 query；查询面四态 not_found / running / completed / failed）                                                                                                                                                |
| `src/harness/aci/tools/registry.ts`            | 改动   | `ACI_TOOLSET_NAMES` 末尾 append `spawn_subagent` + `subagent_result`（23 → 25）；factories 联动 + Gate 3 不破（spec/337 precedents）                                                                                                                                |
| `src/harness/build-engine.ts`                  | 改动   | 装配 `SubAgentManager`：surface ∈ {chat, tui, serve} → 创建 + 启动；`ask` → 不创建；`BuiltEngine.shutdown` 多挂一个 `subagentManager.shutdown()`                                                                                                                    |
| `src/cli/runtime.ts` (`RuntimeBundle`)         | 改动   | 不动 bundle 形态 `{env, session}`，但 `registerShutdown` 顺序：`mcpManager.shutdown()` first → `subagentManager.shutdown()` second                                                                                                                                  |
| `src/cli.ts`                                   | 改动   | main dispatch 新增 `if (parsed.command === "__subagent_worker__")` 早返回 —— 在 `parse-args.ts` 解析 `--subagent-worker` 早 flag                                                                                                                                    |
| `src/cli/parse-args.ts`                        | 改动   | `CliCommand` 联合加 `"__subagent_worker__"`（双下划线前缀区别产品形态）；见 Boundaries Never                                                                                                                                                                        |
| `src/harness/subagent/host-drain.ts`           | **新** | `drainPendingSubagents(manager)` → 拉所有 completed 任务的浓缩 envelope → 拼成 user message 串；返回 `priorMessages` 接缝给 chat/serve/TUI 入口                                                                                                                     |
| `tests/subagent/manager.test.ts`               | **新** | 单测：spawn → waitFor 完整；crashed (非 0 exit) / timeout (SIGTERM) / maxTurnsExceeded (子 run throw) 三类失败各自 fixture；shutdown abort in-flight                                                                                                                |
| `tests/subagent/envelope.test.ts`              | **新** | JSON 信封校验（缺字段 / wrong type / 不是对象 → 协议错误）；stdout/stderr 隔离（worker 不写 console.log）                                                                                                                                                           |
| `tests/subagent/role.test.ts`                  | **新** | 默认 deny-list 含 `spawn_subagent`；自定义 deny-list 装配期裁剪工具面；越界工具名 fail-fast；空 deny-list 装配全 25 件                                                                                                                                              |
| `tests/subagent/spawn-subagent.test.ts`        | **新** | 单测 spawn_subagent 工具语义：handler ≤ 50ms 返回 `{task_id}` JSON（同步）；child 进程已 spawn（fake spawn 工厂断言）；`background:true` 抛 `ToolExecutionError`；`task` 缺失 → 抛错                                                                                |
| `tests/subagent/subagent-result.test.ts`       | **新** | 查询面四态断言：not_found / running / completed / failed                                                                                                                                                                                                            |
| `tests/subagent/host-drain.test.ts`            | **新** | host-drain：completed 浓缩 → user message 串；空 manager → 空串；混合 completed + running → 只 drain completed                                                                                                                                                      |
| `tests/integration/subagent-chain.test.ts`     | **新** | stub-model + 真 worker 进程：`spawn_subagent` → worker 跑 → 浓缩 envelope → 父收；crash 路径（worker throw）→ 父 drain 拿到 failed                                                                                                                                  |
| `tests/e2e/subagent-acceptance.test.ts`        | **新** | E2E A：stub-model 脚本化全链路（spawn → drain → 父 run 接 → 模型行为修改）                                                                                                                                                                                          |

---

## Code Style

沿用 `src/harness/aci/` 既有形态——工厂函数 + `AciToolDef` 冻结对象 + fail-fast 装配 + ajv strict。

```ts
// src/harness/subagent/manager.ts — SubAgentManager 形态真值
export function createSubAgentManager(opts: {
  readonly config: SubAgentConfig; // default role / forbidden tools / memory model
  readonly spawn: SubAgentSpawn; // DI: child_process.spawn 工厂（测试可注入 fake）
}): SubAgentManager {
  const tasks = new Map<string, SubAgentTask>();
  const completed = new Map<string, SubAgentEnvelope>();

  const spawn = (def: SubAgentDefinition): { taskId: string } => {
    const id = randomUUID(); // 唯一任务 id 真值（manager 内部生成，工具侧不注入）
    const task: SubAgentTask = { id, def, state: "starting", child: undefined };
    tasks.set(id, task);
    // spawn 独立子进程：stdin/stdout JSON 信封；不阻塞当前函数
    const child = opts.spawn(id, def);
    task.child = child;
    task.state = "running";
    child.stdout.on("data", (chunk: Buffer) => {
      /* envelope 解析 + completed buffer */
    });
    child.on("exit", (code, signal) => {
      /* crashed | failed 路由 */
    });
    child.on("error", (err) => {
      /* 协议错误 = crashed */
    });
    return id;
  };

  const waitFor = (
    id: string,
    timeoutMs?: number
  ): Promise<SubAgentEnvelope> => {
    /* ... */
  };

  const queryBuffer = (
    id: string
  ): SubAgentEnvelope | { status: "running" } => {
    /* 同步非阻塞 */
  };

  const shutdown = async (): Promise<void> => {
    /* 仿 mcp/manager.ts:266 蓝本 */
  };

  return Object.freeze({ spawn, waitFor, queryBuffer, shutdown });
}
```

```ts
// src/harness/subagent/spawn-subagent-tool.ts — 第 24/25 件工具
import { randomUUID } from "node:crypto";
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";

export interface SpawnSubAgentDeps {
  readonly manager: SubAgentManager;
}

export function createSpawnSubAgentTool(deps: SpawnSubAgentDeps): AciToolDef {
  return Object.freeze({
    name: "spawn_subagent",
    description:
      "Spawn a sub-agent to explore / verify in a separate process. Returns a task_id immediately; the sub-agent runs concurrently while the main loop continues. Use subagent_result(task_id) to poll status; completed results are auto-injected into the next turn as a user message (host drain). Pass system_prompt to scope the sub-agent's role; pass disallowed_tools to deny write tools (e.g. ['edit_file','write_file'] for a verifier). v1 forbids nested spawn_subagent — sub-agent worker processes cannot spawn further sub-agents.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description for the sub-agent.",
        },
        systemPrompt: {
          type: "string",
          description:
            "Optional override for the sub-agent's system prompt section.",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Denylist (priority over default). Defaults to ['spawn_subagent'].",
        },
        model: {
          type: "string",
          description:
            "Optional model override (inherits parent default if absent).",
        },
        background: {
          type: "boolean",
          description:
            "Reserved v2 flag — v1 rejects this. Leave undefined or false. Passing true returns ToolExecutionError immediately.",
        },
        maxTurns: {
          type: "integer",
          minimum: 1,
          description:
            "Optional: per-sub-agent turn cap; inherits from settings if absent.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description:
            "Optional: per-sub-agent wallclock; default 5 min if absent.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // 工具面归类为 read-only（执行耗时但不改文件系统）—— see ACR verdict 1
      lazy: false,
      timeoutTier: "fast", // 同步返 task_id 极快；真实等待由 host drain 异步接管
      isConcurrencySafe: true, // 多个 spawn_subagent 并行调用合法（不同 task_id）
      interruptBehavior: "cancel",
    } as const,
    handler: async (input, _ctx) => {
      const def = normalizeInput(input); // 校验 + 默认 deny-list = ['spawn_subagent']
      if (def === null) {
        throw new ToolExecutionError(
          "spawn_subagent: missing or invalid `task`"
        );
      }
      const { taskId } = deps.manager.spawn(def); // manager 内 randomUUID 唯一真值
      return JSON.stringify({ task_id: taskId });
    },
  });
}
```

```ts
// src/harness/subagent/worker.ts — worker 进程主线（精简）
import { run } from "../loop-engine.js";
import { createDefaultAciRegistry } from "../aci/tools/registry.js";
import { createIknowSystemResolver } from "../identity/index.js";
import { loadIknowEnv } from "../../config/env.js";
import { parseWorkerEnvelope } from "./envelope.js";

async function main(): Promise<void> {
  const buf: Buffer[] = [];
  for await (const chunk of process.stdin) buf.push(chunk as Buffer);
  const env = parseWorkerEnvelope(Buffer.concat(buf).toString("utf8"));
  const registry = createDefaultAciRegistry({ env, sandboxRoot: env.sandboxRoot, ... });
  const deps = { /* 装配独立 run() */ } as LoopEngineDeps;
  // 子代理进程跑独立 run()，结果浓缩后 emit stdout envelope
  const { trace } = await run(env.task, deps, env.signal);
  // emit {status, summary, result, fileRefs, usage} to stdout
  process.stdout.write(JSON.stringify(envelope) + "\n");
}
main().catch((err) => process.exit(2));  // 协议层崩溃 = exit ≠ 0
```

**命名 / 格式**：模块文件名 kebab-case；工厂 `create*` / `create*Tool`；错误用 `src/harness/errors.js` 既有错误类（`ToolExecutionError` / `RegistryConstructionError`）；warn 一行不泄露 env 值；stdout wire 严格 JSON-line（不夹 console.log）。

---

## Testing Strategy

| 层             | 位置                                       | 覆盖点                                                                                                                                                                                                                                                                            | 依赖                                               |
| -------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 单测           | `tests/subagent/manager.test.ts`           | spawn 后 task 进入 map；child.on('exit', code≠0/signal) 各自走对应状态；shutdown 取消 in-flight + SIGTERM；buffer 写入顺序；queryBuffer 查询面四态（not_found / running / completed / failed）                                                                                    | fake spawn 工厂（不真启进程）                      |
| 单测           | `tests/subagent/envelope.test.ts`          | 信封 schema 严校验：缺必填字段 → throw；wrong type → throw；多 newline → 第二条独立 parse；stdout 一条 newline 收尾；worker 进程不污染 console.log（写到 stderr 而非 stdout）                                                                                                     | Buffer fixture，无子进程                           |
| 单测           | `tests/subagent/role.test.ts`              | 默认 deny-list 含 spawn_subagent；自定义 deny 装配期裁剪工具面（看 registry catalog.all().map(name)）；越界 deny（"foo_tool" 不存在）→ RegistryConstructionError；空 deny-list = 全 25 件                                                                                         | 纯 unit                                            |
| 单测           | `tests/subagent/spawn-subagent.test.ts`    | handler 返回 valid JSON 含 task_id；spawn 被调一次；handler 不等待子进程完成（≤50ms 超时内返回）                                                                                                                                                                                  | fake manager                                       |
| 单测           | `tests/subagent/subagent-result.test.ts`   | 查询面四态断言：unknown id → `{status:"not_found"}`；running → `{status:"running"}`；completed → full envelope；failed → `{status:"failed", reason, summary}`（reason ∈ {crashed, maxTurnsExceeded, timeout, protocolError} 四类各自 fixture）；handler ≤ 10ms 内返回（无 sleep） | fake manager                                       |
| 单测           | `tests/subagent/host-drain.test.ts`        | drainPendingSubagents(manager) 返回 string；空 manager → ""；混合 completed + running → 只取 completed；completed envelope 格式：`## Sub-agent <id> result: <summary>\n\n[result]`                                                                                                | fake manager，null run deps                        |
| 集成           | `tests/integration/subagent-chain.test.ts` | stub-model + 真 worker 子进程：`spawn_subagent` → worker 跑 → envelope 回 → 父 manager 缓冲 → queryBuffer 看到 completed；worker 抛未捕获错误 → crash 路径（exit code 非 0）                                                                                                      | fixture stub worker（不调真 LLM）；fake stream env |
| E2E A（进 CI） | `tests/e2e/subagent-acceptance.test.ts`    | stub-model 脚本化全链路：父 run → 模型调 `spawn_subagent` → host drain 在下一轮 turn 把 envelope 拼入 user message → 模型收到浓缩结果后行为被引导（断言 model 收到 specific 系统段）                                                                                              | fixture stub subagent worker（env 不需真 LLM key） |

**前置探针**（实施阻塞项）：ajv strict 与 envelope schema 的兼容性（同 #337 同款前置风险；ci 中实施首日探）。

---

## Boundaries

### Always

- `ACI_TOOLSET_NAMES` append-only（Gate 3，spec 337 纪律）：只末尾追加 `spawn_subagent` / `subagent_result`，不重排既有 23 件；Gate 3 由 `createDefaultAciRegistry` 装配期校验。
- 子代理 worker 子进程 = 同 iknow binary headless 重入 `node <iknow-bin> --subagent-worker`，**不**发明第二条 spawn API；**不**引用 `upstream-openharness`（CONTEXT.md `gbrain vs iknow runtime` 纪律）。
- JSON 信封 stdout 严格 newline-JSON；worker 进程的 `console.log` 全部改 stderr（避免 wire 污染）。
- host drain 写入位置 = `chat` / `tui` / `serve` 三入口在每个 turn 收尾后，下一轮 `run()` 之前；`ask` 入口不挂 manager → 不做 drain。
- `SubAgentManager.shutdown()` 仿 mcp/manager 蓝本：handle.close（worker 子进程）+ SIGTERM 兜底 + abort in-flight；外加第二次 SIGKILL 兜底防僵尸。
- 不写日志时不泄露 env 值（沿用 #337 纪律，mgr 错误 warn 不含 token / key）。
- 不删除既有测试；不把失败测试改 skip（除非按假设 14/16 的显式 skip + Not run 格式）。
- 提交前 `npm test` + `npm run typecheck` 全绿。
- 子代理进程 crash / hang / timeout 三类失败各自走独立判定函数 + test fixture（不可合并为单测）。
- 子代理自产 envelope `result` 字段 ≥ 20000 chars 由 worker 进程 emit 前的 `truncateEnvelopeResult`（envelope.ts）截断并合成标记（假设 17、SC10）；父代理只收已截断 buffer。**不走 executor 路径**（契约 X 不外延到此处）。

### Ask first

- 除上面已列路径之外的任何新依赖（本期无预期，lockfile 不变）。
- 全局 ajv 配置改动（envelope 校验若失败仅允许 `envelope.ts` 内局部 strict 配置）。
- `ACI_TOOLSET_NAMES` 既有 23 件的任何重排（本 spec 只允许末尾 append）。
- 任何对 `LoopEngineDeps` 既有字段语义的改动（spec 不动 maxTurns / timeoutMs / system 字段含义，只在 host drain 路径通过 priorMessages 注入）。
- 任何对 `mcp/manager.ts:266-306` shutdown 蓝本的旁路（复用而非重写）。
- registry / catalog 的 Gate 2 防撞逻辑改动（mcp__ 防撞保留；spawn_subagent 不属于 mcp__ 走假设 13 的装配期条件化路径：manager 缺席 → factory 不实例化 + Gate 3 toolsetNames 镜像过滤）。

### Never

- 读 `~/.claude.json` / `.kiro/settings/mcp.json`（沿用 #337 G2 裁决）。
- `--subagent-worker` 在 `parseArgs` 公共 argv 形态中被允许为产品用户直触（operator 不手动 `iknow --subagent-worker` 调用 —— 双下划线 `__subagent_worker__` 在 `CliCommand` union 中故意与产品形态区分）。
- 引入 `upstream-openharness` 任何代码（项目根 gitignore + spec 历史裁决）。
- 把子代理 LLM key / token / 用户 env 写到日志、warn、wire、test snapshot。
- 删除或降级既有测试；把失败测试改 skip（除非按显式 skip 格式并记录原因）。
- 让子代理 worker 进程拥有 `spawn_subagent` 工具（v1 嵌套禁派发，假设 7）。
- `SubAgentManager.waitFor` 在 agent 视野内暴露阻塞语义（违反 018 Q4 决议："主 loop 不阻塞"）；仅 `queryBuffer` 同步非阻塞。

---

## Success Criteria

二元可判定，每条对应一个可执行检查：

- [ ] SC1 `ACI_TOOLSET_NAMES` 长度 = 25，末两位 `spawn_subagent` / `subagent_result`；Gate 3 装配校验通过（`npm test` 中 registry 测试断言）。
- [ ] SC2 子代理 worker 模式 = `node <iknow-bin> --subagent-worker`；`process.stdin` 一行 JSON = `{task_id?, task, systemPrompt?, disallowedTools?, maxTurns?, timeoutMs?, sandboxRoot, env_min}` 进 worker，子代理 worker 跑 `run()` 并 stdout newline-JSON emit `{status, summary, result, fileRefs, usage}` envelope；stderr 仅日志。
- [ ] SC3 `SubAgentManager` API 真值：`spawn(def): { taskId }`（manager 内部 `randomUUID()` 生成，**唯一任务 id 真值**）；`queryBuffer(task_id)` 永不 await、不抛 TimeoutError；`shutdown()` 取消 in-flight + SIGTERM + SIGKILL 兜底；`registerShutdown` 进程退出前同步触发（chat/serve/TUI 三入口）。host 内部独占 `waitFor`（不被 agent 工具面暴露）。
- [ ] SC4 `spawn_subagent` 工具语义：调用一次返回 `{task_id}` JSON，handler ≤ 50ms；agent 调多次并行（不同 task_id）均合法；`task` 缺失或不 string → `ToolExecutionError`；`background:true` → `ToolExecutionError("background:true not implemented in v1")`。
- [ ] SC5 `subagent_result(task_id)` **查询面四态**语义：not_found / running / completed / failed；completed 返 envelope 全字段（含 status=ok）；failed 返 `{status:"failed", reason, summary}`；其余按 schema 形态返。crashed / timeout / maxTurnsExceeded / protocolError 统一归入 failed 的 reason 字段，**不是**查询面独立 status。
- [ ] SC6 三类失败独立判定：`crashed` 来自 child.on('exit', code≠0 || signal)；`maxTurnsExceeded` 来自 worker run() 抛 MaxTurnsExceeded 后 envelope `status=failed,reason=maxTurnsExceeded`；`timeout` 来自 manager 主动 SIGTERM + 兜底 SIGKILL，每类有 fixture + 单测。
- [ ] SC7 host drain：在 `chat` / `tui` / `serve` 三入口的 `run()` 调用边界之间（即上一次 run 收尾后、下一次 run 启动前）调用 `drainPendingSubagents(manager)`，把 completed 浓缩 envelope 作为一条 user message 拼入下一次 `run(userText, deps, signal, {priorMessages})` 的 `priorMessages`；**loop-engine 自身零改动**（`run()` 签名与行为不变，drain 是 host 层职责）。
- [ ] SC8 `ask` 入口不创建 `SubAgentManager`（`build-engine.ts` 守门）；registry / executor / catalog 三方视图不含 `spawn_subagent` / `subagent_result`（build 测试断言）。
- [ ] SC9 角色机制默认 deny-list = `['spawn_subagent']`，子代理 worker 进程的 registry 不含 `spawn_subagent`（v1 嵌套禁派发）；自定义 deny-list 装配期裁剪工具面，越界工具名 → RegistryConstructionError。
- [ ] SC10 浓缩截断：envelope `result` 字段长度 ∈ [0, 20000]，超 20000 时由 worker 进程 emit 前截断并合成 `[...truncated to 20000 chars; total NNNN]`（`env.truncated=true` / `env.totalLength=NNNN`）；父代理收到已截断 envelope 不再二次截断。
- [ ] SC11 worker 进程 stdout 严格 newline-JSON（一条 envelope 一行）；`console.log` 全部改 stderr（log 走 process.stderr.write）；集成测试断言 stdout 不含任何非 JSON 行。
- [ ] SC12 进程退出链：CLI SIGINT → `registerShutdown` 触发 → mcpManager.shutdown() first → subagentManager.shutdown() second；worker 子进程被 SIGTERM 后 ≥ 5 秒未退出 → SIGKILL（fixture 断言）。
- [ ] SC13 信封 schema 严校验：缺必填字段 / wrong type / 不是对象 → throw → 子代理 worker exit code ≠ 0 → 父管理标 `crashed`（envelope schema 校验失败等价于协议错误）。
- [ ] SC14 E2E A 通过：stub-model 脚本 `spawn_subagent → drain → 下一轮模型可见浓缩结果`；`npm test` 内可复现，不依赖真 LLM key。
- [ ] SC15 `npm test` 与 `npm run typecheck` exit 0。
- [ ] SC16 并发：`subagent_result(task_id)` 与 worker 写入 buffer 并发时，返回值为「写入完成前」/「写入完成后」二者之一，确定性断言两种（不要悬挂 / 不要 race 失败）。

---

## Open Questions

- **OQ1**（假设 13 复核口）`spawn_subagent` 走「主代理本地 `SubAgentManager` 注入 → catalog allow-set」缝 vs 「envelope/ajv 旁路 + 不走 registry」路径；operator 评审实施后若发现 catalog.allow 概念与既有 `aci.category` 冲突，是否引入 `permissionCategory: "subagent-control"` 区分。复核期 = 实施后 30 天。
- **OQ2**（假设 14 复核口）`crashed` 判定是否要把「worker 主动抛 child_process.spawn ENOENT」（找不到 iknow 二进制）也归 crashed 还是新加 `error` 状态。本 spec 先归 crashed，按 v1 简洁起见不细分。
- **OQ3** worker 进程是否需要独立的 `~/.iknow/skills` 扫描（与父代理一致），还是简化为「复用父代理装配期扫描结果通过 envelope 传到 worker」。本 spec 先按「worker 自己再扫」实现（简化通信），后续可优化。
- **OQ4** settings 通道：`spawn_subagent` 的 `model` 参数默认值是否走 `settings.llm.model` 回退（与 #353 settings 通道对齐）；本 spec 留口但**不绑**。OQ4 答案必须在 SPEC-3 #358 落地前给出（settings.loop-config 落地一并处理）。
- **OQ5** `subagent_result` 是否在 agent 主路径被注入到下次 `run()` 已完成后还能再调？目前实现 = buffer 永久缓存直到 shutdown，**不限制**，但若发现 agent 反复 poll 消耗 token，OQ5 = 是否加 LRU 上限或过期时间。
- **OQ6** 与 #337 skill 工具的 interplay：sub-agent 自己的 `skill_search` 看到的是它自己进程的 skill 索引（独立目录扫描），还是通过 envelope 注入父代理索引。本 spec 留「独立扫描」默认，OQ6 待 SPEC-2 落地后的 E2E 反馈。

---

## Glossary

（摘自 `docs/CONTEXT.md`，原文不改写）

- **Loop Engine**: Foundation 的状态机运行内核，驱动模型 → 工具 → 真实结果 → 下一轮模型 → 明确停止；位于 `src/harness/`，作为 018 退役旧 loop 后的可靠运行时基础。
- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。
- **ToolExecutionContext**: Executor 透传给 handler 的执行上下文 `{ signal }`；run 第三参 signal 原样透传、不创建子 signal，超时由 Executor `Promise.race` 外包而非 ctx 携带。
- **in-flight closeout**: abort/timeout 发生时的收尾语义——模型在途则整回合不进历史（finalState = 入口 state）；工具在途则 assistant 回合已原子追加（不可回滚），在途 tool call 填 `execution_failed`（message 固定 "cancelled"/"timeout"），所有 tool_result 编码为一条 user message 原子追加后 stop。signal 优先于 timeout。
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威——自测序列化后字符数、自截断、自合成标记；工具返回纯数据、不带 truncated/total 元字段，executor 永不信任工具声称的截断字段（防 MCP 第三方伪造绕过封顶）。#140 裁决，ADR-0004 / ADR-0006。
- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移。本 spec 落地后件数 23→25（词条计数待 domain-modeling 晋升时更新）。
- **deps.system injection seam**: Each-turn 系统文本装配的唯一权威缝——loop-engine 调 `deps.system?.()`，结果透传 `adapter.step request.system`；`undefined` 时不发送 `system` 字段，KV cache 前缀字节级稳定。
- **surface split (identity vs memory)**: 入口面（`chat` / `tui` / `ask` / `serve`）的两层语义；本 spec 沿用：ask 全 opt-out memory 不动，但 `spawn_subagent` 仅挂 chat/tui/serve，ask 不挂（与 #337 mcp 装配条件一致）。
- **project stack defaults (SSOT boundary)**: iknow 的 LLM 栈（key 变量名 / model / provider/baseUrl）是**项目级决策**，焊进 `src/config/env.ts` 代码默认（ADR-0001）。本 spec 沿用：子代理 worker 进程的 Node env **从父进程继承**（LLM key 必需，#331 T2 Q5 决议）；`BASE_ENV_WHITELIST` 是 bwrap 边界而非 Node 进程边界（沙箱收窄归 SPEC-2 #357，本 spec 不做）。

（V1 子代理特有术语，待 domain-modeling 晋升时写入 CONTEXT.md）

- **subagent worker process**: 同 iknow binary headless 重入子进程，跑独立 `run()`，stdin/stdout JSON 信封；由 `spawn_subagent` 工具触发，由 `SubAgentManager` 管理生命周期。
- **host drain**: parent run 完成后由 chat/tui/serve 入口调用 `drainPendingSubagents(manager)`，把已 completed 子代理的浓缩 envelope 拼入下一轮 `run({priorMessages})` 的 user message，作为模型下一轮的可见输入。`ask` 入口无 manager 故无 drain。
- **SubAgentDefinition**: 用户传给 `spawn_subagent` 的子代理定义（`{systemPrompt, disallowedTools, model, maxTurns, timeoutMs}`）；deny-list 优先，默认 deny `spawn_subagent`（v1 嵌套禁派发）。
- **JSON envelope**: 子代理父子进程间通信契约 `{status, summary, result, fileRefs, usage}` + 失败时细分 `{status:"failed", reason: "maxTurnsExceeded"|"timeout"|"protocolError", ...}`；newline-JSON，stdout 严格单 wire。**不要混淆**：queryBuffer 的查询面状态不是 envelope status 枚举（查询面 = not_found / running / completed / failed，envelope = ok / failed + reason 四值）。
- **`background` 语义**：本期接收 `background: true` 但立即抛 `ToolExecutionError("background:true not implemented in v1")`。模型可见 description，明确表明未实现，防止模型误判可用。SPEC-3 #358 / SPEC-2 #357 不绑。

---

## Architectural Constraints

- **ADR-0004**（tool-layer）：新工具经 permission middleware + timeout tier 装饰；`spawn_subagent` 走 read-only default-allow，`subagent_result` 走 read-only default-allow；两者均通过 `aci.category` 字典归类，不引入第二份权限模型。
- **ADR-0006**（tool-output-capping 20000）：工具输出截断由 executor 统一执行（契约 X）。**外延说明**：浓缩 envelope `result` 不归契约 X，截断发生在 worker 进程 emit 前的 `envelope.truncateEnvelopeResult`（假设 17 / SC10）。
- **ADR-0001**（project stack defaults）：子代理 worker 进程不发明第二条 env 协议；Node env 从父进程继承（LLM key 必需，#331 T2 Q5）。bwrap 边界 env 收窄归 SPEC-2 #357（`BASE_ENV_WHITELIST` 路径）。
- **#337 spec**：`registerExternal` 强制 `mcp__` 命名空间（aci-registry.ts:94-98）—— 本 spec **不** 复用；spawn_subagent 走主代理本地 SubAgentManager 注入（假设 13）。
- **#224 spec**（`specs/224-tool-extension-path.md`）：lazy/discover/visibleSchemas + tool_search + 三闸门是 ACI 装饰层的地基；本 spec 的两件新工具都是 non-lazy（spawn_subagent 同步返 task_id，subagent_result 同步非阻塞读），不引入新的 lazy 行为。
- **#196 spec**（identity-assembly）：`deps.system` 注入缝在 host drain 路径通过 priorMessages 用户消息承载，**不**走 system prompt（保留 KV cache 字节稳定纪律）。
- **#331 map T1**（sub-agent 上下文隔离设计）：本 spec 是 T1 决议（Q1/Q2/Q4）的实施入口；T2 (#332)、T3 (#333)、T4 (#334)、T5 (#335) 已 cleared，Q5（verifier 角色 deny-list）由本 spec 假设 7 + SC9 承接；Q6（trace 事件）由 SPEC-3 #358 实施；Q7（loop 配置）由 SPEC-3 #358 实施；Q8（沙箱）由 SPEC-2 #357 实施。
- **security-guardrails spec**：权限三层零改动；`spawn_subagent` 不直接写到磁盘，子代理自身 bash 走 bwrap 的事情归 SPEC-2；子代理 stdout envelope 不含 env 值；warn 一行不泄露 token。
- **ADR-0014 收尾**（issue #331 Decisions so far：「反式付款」）：本 spec 假设 19 落 ADR-0014 收尾条款（commit 拆分 + 工作树漂移隔离）；完整 ADR 文本落地工作归 SPEC-2 #357（伴随 ADR-0015 一起走 `domain-modeling` 流程）。

---

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

self-audited，作为 agent architect 在本 spec 完成后即时复核（含两轮 self-correction 已落 spec 文本）：

- **bounded-context-guardian: yes** — `src/harness/subagent/` 为新增 bounded context；与 `harness/aci/`、`harness/mcp/`、`harness/skill/` 同层切片；产品路径（cli / runtime / build-engine）只通过 `SubAgentManager` 注入点交互，不反向依赖 subagent 内部；worker 子进程内复用既有 `createDefaultAciRegistry`（SSOT），不发明第二条 registry；无循环 import；两件新工具走静态 factory 路径（同 skill / skill_search 先例，#337），与 `registerExternal`（保留给 MCP 动态缝）切分清楚。
- **defensive-contract-validator: yes** — 五类边界齐备：empty（`drainPendingSubagents([])` → ""）/ negative（`subagent_result(unknown_id)` → `{status:"not_found"}`；`disallowed_tools` 越界 → RegistryConstructionError；`background:true` → ToolExecutionError）/ overflow（envelope `result` ≥ 20000 → worker emit 前 `truncateEnvelopeResult`）/ concurrent（`spawn_subagent` 多调用并行合法 `isConcurrencySafe:true`；`subagent_result` 与 worker buffer 写入并发不悬挂；manager.shutdown 与 in-flight 并发）/ exception（worker 抛未捕获错误 → crashed；envelope 校验失败 → protocolError → crashed）。
- **error-handling-enforcer: yes** — typed 错误用既有 `src/harness/errors.ts`（`ToolExecutionError` / `RegistryConstructionError`）；worker 进程协议层崩溃走 exit code ≠ 0 + envelope schema throw（明示协议错误 = `crashed`）；handler 校验失败早返回抛 typed `ToolExecutionError`；非空 catch 不存在；空 envelope 不静默吞。
- **complexity-anti-drift: yes** — 单文件最大新模块预计 ≤ 300 行（manager.ts 仿 mcp/manager 蓝本，无超 threshold 函数）；新工具 factory 都 ≤ 40 行；无嵌套 ≥ 4；新依赖零（lockfile 不变）。
- **minimal-change-verifier: yes** — 范围 = #331 Q1/Q2/Q4 + Q5 verifier deny-list 基础；commit 拆分 ≥ 3（假设 19）；工作树漂移（`@types/node` / `.iknow/mcp.json`）声明隔离；ADR-0014 / ADR-0015 候选归 SPEC-2 落地，本 spec 不重复写；loop-engine 自身零改动（run() 签名与行为不变，host drain 在 run() 边界之间注入 priorMessages）。

**Self-corrections applied during review**（已落 spec 文本，OQ 留复核口）：

1. 假设 13 重写：原措辞用 `catalog.allow` / `permissionCategory` / 子代理内 `registerExternal`——这三个概念在代码中均不存在。重写为「无条件进 `ACI_TOOLSET_NAMES` + 装配期条件化（ask 无 manager → 两件工具 factory 不实例化 + Gate 3 toolsetNames 镜像过滤）」，对齐 `skillCatalog` 条件化先例。
2. 假设 8 / SC5 状态枚举修正：原本「查询面六态」与「envelope status 二态 + reason 四值」混淆。改为「envelope status ∈ {ok, failed} + reason ∈ {crashed|maxTurnsExceeded|timeout|protocolError}；queryBuffer 查询面四态 not_found / running / completed / failed」。
3. 假设 10 措辞对齐 #331 T7：「派发规则放工具 description 而非主 system prompt」—— 原措辞「deps.system 段或工具 description」中「deps.system 段」删除。
4. 假设 17 修正：原措辞把浓缩截断归 executor 截断。契约 X 只覆盖工具输出，浓缩 result 是子代理 run() 自产，截断归 worker 进程 emit 前 `truncateEnvelopeResult`（envelope.ts）。
5. Glossary 修正 env 策略：原措辞说 worker env 走 `createEnvIsolation` 白名单——与 #331 T2 Q5「Node 进程从父进程继承（LLM key 必需）」矛盾。改为 worker Node env 继承父进程；`BASE_ENV_WHITELIST` 是 bwrap 边界，SPEC-2 实施。
6. Architectural Constraints ADR-0006 / ADR-0001 条款同步修上。
7. SC3 / SC4 / SC5 措辞同步：handler 错误抛 typed（`ToolExecutionError`）、`background:true` 拒绝、查询面四态。

All 5 verdicts yes → spec advances to writing-plans.
