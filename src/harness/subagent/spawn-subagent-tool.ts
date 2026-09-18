/**
 * #356 T4 / #361 V1.5 / #556 T3 — spawn_subagent ACI 工具（主代理第 24/25 件之一）。
 *
 * **#361 前景 spawn 反转（ADR-0014 V1.5）**：默认 `wait:true` — 模型调一次 →
 * handler `await manager.waitFor(taskId, undefined, ctx.signal)`（缺省超时
 * 由 manager 三层链 `def.timeoutMs ?? taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`
 * 决定，spawn timer 同源），阻塞至子代理终态，把父可见短交差（summary /
 * changed paths / status / stop_reason）作 tool_result 返回。多个独立任务
 * 可在同一 turn 并行发多条 spawn_subagent（wait:true 各自阻塞，executor
 * 并发安全）。`wait:false` → 立即返 `{task_id}`（异步臂），chat / tui / serve
 * 由 host mailbox/subscribe 终态唤醒 silent run；subagent_result 仍可主动查询。
 *
 * **#556 T3 subagent_type routing**：可选参数 `subagent_type`（CC Agent
 * tool 字面名）→ 解析为 catalog id → 写入 `def.role`（T2 装配链路已透传到
 * envelope.role → worker 注入 persona 段）。缺省 = `general-purpose`；
 * ajv enum = catalog id 列表（运行时从 resolveAgentCatalog 派生，不写死字面）；
 * 未知值 ajv fail-fast。
 *
 * **依赖注入形态**：工厂收 `manager`（T2 提供）+ `catalog?`（T3 新增，
 * 可选 — 缺省走内部默认 `resolveAgentCatalog`）。装配层
 * `createDefaultAciRegistry` 在 `subagentManager` opts 传入时实例化；
 * 缺席时不装配（`ask` 入口零件场景；与 `memoryDir` / `skillCatalog` 条件化
 * 同形态，registry.ts Gate 3 toolsetNames 镜像过滤）。
 *
 * **append-only**：`name` 与 `ACI_TOOLSET_NAMES` 末位一一对应；不重排既有 23 件。
 *
 * 错误形态（C5 归因表）：
 *   - input 校验失败 → `ToolExecutionError` 同步抛（executor → execution_failed）；
 *   - `background:true` v1 拒收 → `ToolExecutionError`；
 *   - C1 并发超限（manager.spawn 抛 SubAgentCapacityError）→ handler catch →
 *     `ToolExecutionError`（消息含 capacity + active/limit）；
 *   - `ctx.signal` abort → waitFor reject SubAgentAbortError → handler catch →
 *     `ToolExecutionError` → executor 因 `signal.aborted === true` 归一
 *     `execution_failed: "cancelled"`（归因 = 调用侧取消）。
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentDefinition } from "./role.js";
import type { QueryBufferResult, SubAgentManager } from "./manager.js";
import {
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentWaitTimeoutError,
} from "./manager.js";
import type {
  SubagentCapacityHolder,
  SubagentCapacityValue,
} from "./manager.js";
import type { SubAgentEnvelope } from "./envelope.js";
import { projectParentVisibleEnvelope } from "./envelope.js";
import { ToolExecutionError, SubAgentSandboxRootError } from "../errors.js";
import type { AgentCatalogResolver } from "./catalog.js";
import { createMergedCatalogResolver } from "./user-catalog.js";
import { resolveSubagentCapabilities } from "./capability.js";

/**
 * Spec Layer 1 item 1 / SC4 — the dispatch lesson is one SSOT string: the
 * description embeds it verbatim and the guards read this same constant, so a
 * guard reds when a discipline clause (or the whole lesson) is dropped without
 * pinning the wording of any single clause.
 *
 * Clauses: start with an `explore` sub-agent before dispatching any work that
 * writes; keep the operator concurrency discipline — an explicit numeric
 * ceiling plus the concurrent/workers vocabulary, below the enforced cap;
 * build the isolation tree via `create-worktree` before dispatching mutating
 * work; check the skill catalog before improvising a procedure.
 */
export const SPAWN_DISPATCH_LESSON =
  "\n\nDispatch lesson: start with an `explore` sub-agent before dispatching any work that writes; " +
  "keep at most 3 sub-agents in flight for operator workflows (a working discipline, not the enforced cap); " +
  "when the task mutates files under isolation, run `create-worktree` first so the workers land in the isolated tree; " +
  "check the skill catalog before improvising a procedure.";

/**
 * Mechanical form of the lesson's concurrency-discipline clause: a numeric
 * ceiling followed, in the same clause, by the concurrent/workers vocabulary.
 * Digit and spelled-out numerals both count, and the noun may be `workers`,
 * `sub-agents`, or `in flight` — the invariant is "the ceiling is written
 * out", not one phrasing of it. The window after the ceiling is bounded so an
 * unrelated lone digit elsewhere in the lesson cannot satisfy the clause.
 */
export const SPAWN_DISPATCH_LESSON_CONCURRENCY_PATTERN =
  /\b(?:at most|up to|no more than|max(?:imum)?(?: of)?)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b[^.;]{0,60}\b(?:concurrent(?:ly)?|in flight|workers?|sub-?agents?)\b/i;

/**
 * 依赖注入：`manager` 父代理侧子代理生命周期 / 状态机 / buffer / shutdown 链
 * （T2 createSubAgentManager 的输出）。本工具消费 `spawn(def)` 同步入口 +
 * `waitFor(taskId, timeoutMs, signal)` 前景阻塞入口；drain 由 host 侧独占
 * （spec Never 暴露给 agent）。
 *
 * `catalog?` 是 #556 T3 新增 seam：可选 — 缺省走内部默认 merged catalog
 * （`createMergedCatalogResolver`：builtin + `~/.iknow/agents/` 用户角色，
 * 双面 list + get），production 装配 `registry.ts` 不显式注入
 * （plan T3 决议：registry 职责是工具面，不是 agent 路由 — 不动 registry.ts）。
 * 测试可显式注入 fake resolver 验证 factory 真的在用 deps.catalog。
 */
export interface SpawnSubAgentToolDeps {
  readonly manager: SubAgentManager;
  /**
   * #556 T3: agent catalog resolver (双面 list + get)。
   * 可选 — 缺省 = merged catalog (`createMergedCatalogResolver`)。
   * list() 供 enum + prose list 派生；get(id) 供 handler 单 id 校验。
   */
  readonly catalog?: AgentCatalogResolver;
  /**
   * ADR-0096 T2：并发上限 holder —— description N 与 SubAgentCapacityError
   * 同源（同一 holder.get() 现读，闸值变化即时反映给模型）。manager 自身已
   * 持有一份 holder（spawn 闸读同一处），本字段是描述层镜像，避免 description
   * 与回执数字漂移。缺席 → 退回 `manager.getCapacity()`（manager 内部
   * 暴露的等价 getter；fallback 路径与既有静态描述 N=15 字节级一致）。
   */
  readonly capacityHolder?: SubagentCapacityHolder;
}

/**
 * SC13 / plan task 7：子代理墙钟到期，父可见 tool result kind **不得**为 ok。
 *
 * 超时是唯一破例：crashed / maxTurnsExceeded / protocolError 仍是「任务结局是
 * 数据」，走 ok envelope（C5）；墙钟到期没有可读的终态交差，只有把它抛成
 * `execution_failed` 才能让模型把「子代理卡死在墙钟」和「子代理跑完但失败」
 * 区分开。envelope.status 本就是 "failed"，规格说的是 result kind。
 *
 * message **不得**恰好等于 `"cancelled"` —— `computeToolStopFlags`
 * (loop-engine.ts) 仍用 `execution_failed && message === "cancelled"` 判
 * 整回合取消，撞字面量会把单个子任务的墙钟误升级成整回合停因。`"timeout"`
 * 标签在 ADR-0091 后对回合停因 inert（只作该条 result 归因），但仍避开，
 * 免得同波下游按标签做归因时把它读成时钟信号。
 */
/**
 * ADR-0102 T4 — label 参数化：前景 continue 的超时归因若仍署
 * "spawn_subagent:"，模型会把一次续跑读成一次新派发。缺省标签保持
 * spawn 臂既有文案逐字节不变；continue 工具传自己的标签。
 */
export function throwWallClockTimeout(
  taskId: string,
  detail: string,
  label = "spawn_subagent"
): never {
  const suffix = detail.length > 0 ? ` (${detail})` : "";
  throw new ToolExecutionError(
    `${label}: task ${taskId} hit its wall-clock timeout${suffix}; ` +
      `the sub-agent has no completed result to hand back`
  );
}

/**
 * SC14 / plan task 8：`SubAgentAbortError` → 父可见 `ToolExecutionError`。
 *
 * 两种 abort 来源必须能分开：
 *   - **调用侧 abort**（Ctrl+C / `/quit`）：ctx.signal 已 abort，executor 的
 *     `buildFailureResult` 随后把 message 归一成严格 `"cancelled"`（整回合
 *     取消，loop-engine 消费）—— 这里保留 caller 文本只为不丢归因来源；
 *   - **操作员强杀**（TUI Ctrl+X → `manager.abortTask`，SC14）：ctx.signal
 *     **没有** abort，executor 不归一，message 原样透出 —— 所以这条文本就是
 *     模型能看见的全部归因。若沿用调用侧那句「caller aborted」，强杀会被读成
 *     调用方取消；若沿用墙钟那句，则与 SC13 的超时归因撞脸。
 *
 * 两者的共同点是**绝不**恰好等于 `"cancelled"`：撞字面量会把单个子任务的
 * 结局误升级成整回合取消（`computeToolStopFlags` 的 result 标签分支）。
 *
 * 放在 handler 外：整个归因判定（含 `ctx?.signal` 读）不占 handler 的圈复杂度
 * （S5 硬门：handler 已在基线上，任何新分支都会判回归）。
 */
export function throwAbortAttribution(
  err: SubAgentAbortError,
  ctx: ToolExecutionContext | undefined,
  label = "spawn_subagent"
): never {
  if (ctx?.signal?.aborted === true) {
    throw new ToolExecutionError(
      `${label}: cancelled (caller aborted while waiting for task ${err.taskId})`
    );
  }
  throw new ToolExecutionError(
    `${label}: cancelled (the operator killed task ${err.taskId}; ` +
      `it returned no completed result)`
  );
}

/** 已带 timeout 终态的信封 → 非 ok（详见 throwWallClockTimeout）。 */
export function assertNotWallClockTimeout(
  env: SubAgentEnvelope,
  taskId: string,
  label = "spawn_subagent"
): void {
  if (env.status === "failed" && env.reason === "timeout") {
    throwWallClockTimeout(taskId, env.summary, label);
  }
}

/** 父可见投影 + SC13 超时闸（终态信封交回模型的唯一出口）。 */
export function projectEnvelopeOrThrow(
  env: SubAgentEnvelope,
  taskId: string,
  label = "spawn_subagent"
): SubAgentEnvelope {
  const projected = projectParentVisibleEnvelope(env);
  assertNotWallClockTimeout(projected, taskId, label);
  return projected;
}

/**
 * waitFor 墙钟拒绝后按 queryBuffer 分流。SubAgentWaitTimeoutError 复用于
 * unknown task / shutdown 清 map / failed-without-envelope / 真墙钟，不能一律合成 timeout。
 */
export function envelopeFromWaitTimeout(
  buffer: QueryBufferResult,
  taskId: string,
  label = "spawn_subagent"
): SubAgentEnvelope {
  // EXIT: not_found — 任务从未存在或 shutdown 已清 map；对模型是调用错误，不是 timeout 数据。
  if (buffer.status === "not_found") {
    throw new ToolExecutionError(
      `${label}: task ${taskId} not found after wait timeout`
    );
  }
  // EXIT: running — 墙钟到但 worker 未终态（真墙钟；SC13 非 ok）。
  if (buffer.status === "running") {
    throwWallClockTimeout(
      taskId,
      "worker still running when the wait expired",
      label
    );
  }
  if (buffer.status === "failed") {
    // EXIT: buffer 已是失败投影（含 protocolError / crashed / timeout envelope）。
    if ("result" in buffer && typeof buffer.result === "string") {
      return projectEnvelopeOrThrow(buffer, taskId, label);
    }
    if (buffer.reason === "timeout") {
      throwWallClockTimeout(taskId, buffer.summary, label);
    }
    return {
      status: "failed",
      reason: buffer.reason,
      summary: buffer.summary,
      result: buffer.summary,
    };
  }
  // EXIT: completed ok envelope 已在 buffer（status=failed 的终态信封也走这里，
  // 由 SC13 闸按 reason 分流）。
  return projectEnvelopeOrThrow(buffer, taskId, label);
}

/**
 * 前景臂的终态通道互斥（plans/session-fg-handoff-interrupt.md Locked
 * sentence 1）：`wait:true` 时 handler 正阻塞在 waitFor 上，同一份信封**由
 * 这一次 tool_result 当跳交付**；若再让 host drain 收走或 mailbox silent
 * wake 叫醒父回合，同一交差会二次进父 messages（被画成一条 user message /
 * 重复一份）。故 fg 任务一律排除出 host drain；`wait:false` 的异步臂才需要
 * 那两条通道，不设此位（Postel：非 true 时字段整个省略）。
 *
 * 两条理由放在模块级而不是 handler 的 def 字面量里：
 *   - **给这个位一个名字**：`excludeFromHostDrain` 是「交付通道」语义（见
 *     `SubagentInfo.foreground` 头注），不是「还在跑」；spread 进 def 字面
 *     量后它只剩一个无名布尔，接线点读不出这一位为什么在这；
 *   - **handler 的圈复杂度是逐函数棘轮**（`lint:s5` 对 HEAD 比同函数基线）：
 *     handler 是 `spawn-subagent-tool.ts` 里的 ArrowFunctionExpression，
 *     基线 41，内联这个三元会把它推到 42 判回归（实测）。
 */
export function foregroundDrainExclusion(wait: boolean): {
  readonly excludeFromHostDrain?: boolean;
} {
  return wait ? { excludeFromHostDrain: true } : {};
}

export function createSpawnSubAgentTool(
  deps: SpawnSubAgentToolDeps
): AciToolDef {
  // #556 T3: catalog resolver 闭包 — factory 内部 default = merged catalog
  // (builtin + ~/.iknow/agents/ 用户角色, 记忆化; 双面 list + get)。
  // registry.ts 不传 catalog, factory 兜底 (plan T3 决议: registry 职责是
  // 工具面, 不是 agent 路由)。enum + prose list 在装配期从 merged list
  // 派生, 用户角色文件在进程启动后即出现在工具面上。
  const catalog: AgentCatalogResolver =
    deps.catalog ?? createMergedCatalogResolver();
  const catalogIds = catalog.list().map((e) => e.id);
  const proseLines = catalog
    .list()
    .map((e) => `- ${e.id}: ${e.description}`)
    .join("\n");
  // ADR-0096 T2：description N 与 SubAgentCapacityError 同源（同一
  // holder.get() 现读；回执数字与 description 永同步）。闸值变化 →
  // 下一次模型拉取工具描述即看到新 N，无需重启。holder 缺席时退化到
  // `manager.getCapacity()` —— manager 自身持有同一 holder 副本，
  // 闸值形态等价；唯一缺 holder 的场景 = 装配期 manager 直造（如
  // 既有 manager.test.ts makeHarness 路径），fallback 与既有静态 N=15
  // 字节级一致。
  const readCapacity = (): SubagentCapacityValue => {
    if (deps.capacityHolder !== undefined) return deps.capacityHolder.get();
    return deps.manager.getCapacity();
  };
  // description 拆成两段拼接模板：固定前缀 + 闸值描述 + 闸值文案 + 固定后缀。
  // 拼接闭包每次重读 holder；模型读 description 时即看到当前 N。
  const descriptionPrefix = `Delegate a self-contained task when it needs multi-step exploration, independent verification, or parallelizable work. Omit \`subagent_type\` and the sub-agent runs as \`general-purpose\` — the writable, full-tool-surface default; \`explore\` is the read-only type, request it explicitly. Keep every task self-contained. Default \`wait:true\` — the call blocks until the sub-agent finishes and returns the parent-visible short handoff with summary, changed paths, status, and stop_reason when available (timeout 2 hours default; override via \`timeoutMs\`). Issue multiple \`spawn_subagent\` calls in one turn only for independent tasks. Pass \`wait:false\` for fire-and-forget: returns \`{task_id}\` immediately. In chat/tui/serve, terminal completion wakes the host through the mailbox/subscribe path and starts a silent run; this is the primary completion path. Use \`subagent_result\` only for an explicit status query. `;
  const descriptionSuffix =
    `\n\nAvailable subagent types (set \`subagent_type\` to route):\n` +
    proseLines +
    SPAWN_DISPATCH_LESSON;
  const capClause = (cap: SubagentCapacityValue): string => {
    if (cap === "unlimited") {
      return "Concurrency cap is unlimited in this session; the OS / memory budget is still the practical limit. When a spawn would clearly overload the host, reduce parallelism.";
    }
    return `At most ${cap} workers run simultaneously in this session; when at capacity, reduce concurrency and retry after a worker completes — requests are rejected rather than queued.`;
  };
  return Object.freeze({
    name: "spawn_subagent",
    // ADR-0096 T2：description = getter — Object.freeze 锁住 accessor，调用方
    // 每次 `.description` 现读 `readCapacity()`，闸值变化立即反映（不动
    // handler / schema / aci 元数据）。
    get description(): string {
      const cap = readCapacity();
      return descriptionPrefix + capClause(cap) + descriptionSuffix;
    },
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description for the sub-agent.",
        },
        subagent_type: {
          type: "string",
          // #556 T3: enum = catalog ids (运行时 resolveAgentCatalog 派生,
          // 不写死字面)。ajv fail-fast 拒未知 id (typed error 走 ToolExecutionError
          // handler 路径, 见 plan T3 防御契约)。
          enum: catalogIds,
          description:
            "Optional (#556 T3): route the sub-agent through one of the available subagent types listed above. Omit it and the sub-agent runs as `general-purpose` — the writable, full-tool-surface default. `explore` is the read-only type: ask for it explicitly when the task only reads.",
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
        wait: {
          type: "boolean",
          description:
            "When true (default), block until the sub-agent finishes and return the parent-visible short handoff (summary, changed paths, status, and stop_reason when available). When false, return {task_id} immediately; in chat/tui/serve, terminal completion wakes a silent run through the host mailbox/subscription. Use subagent_result only for an explicit status query.",
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
            "Optional: per-sub-agent wallclock; default 2 hours if absent.",
        },
        sandboxRoot: {
          type: "string",
          description:
            "Optional (#357 T1): restrict the sub-agent to this directory. Must be a path inside the parent sandbox root (realpath-resolved, symlinks must point inside parent). Out-of-range or non-existent paths are rejected before any spawn occurs.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // 工具面归类为 read-only（执行耗时但不改文件系统）—— see ACR verdict 1
      lazy: false, // 常驻 prompt：spawn 是核心能力，discover 没意义
      timeoutTier: "unbounded", // wait:true 寿命 = manager per-task 钟；ACI 不 timer。long(30min) < PER_TASK(2h) 会提前 abort
      isConcurrencySafe: true, // 多个 spawn_subagent 并行调用合法（不同 task_id）
      interruptBehavior: "cancel", // 前景入口；ctx.signal abort → waitFor reject → ToolExecutionError → execution_failed:cancelled
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // input 已由 ajv strict 校验过形状（createAciRegistry 装配时编译）。
      // 此处再做运行时防御：schema 之外的 null / 数组 / 字符串都不应到此。
      const obj = (input ?? {}) as Record<string, unknown>;
      const task = obj.task;
      if (typeof task !== "string" || task.length === 0) {
        throw new ToolExecutionError(
          "spawn_subagent: missing or invalid `task`"
        );
      }
      // v1 拒绝 background:true（spec Code Style 原文 + SC4 acceptance）。
      if (obj.background === true) {
        throw new ToolExecutionError("background:true not implemented in v1");
      }
      // #361：默认值在 handler 内解析（ACI schema 不表达默认值）。缺省 = 前景。
      const wait = obj.wait !== false;
      // #556 T3 / T7: subagent_type → role 解析 (additive)。
      //   - 缺省 (undefined) → catalog.get("general-purpose") (T7 默认角色)
      //   - 已知 id → 写入 def.role (= catalog id, 透传到 envelope.role → worker
      //     装配期查 catalog 取 body 注入 persona 段, T2 链路)
      //   - 未知 id → ajv enum 已在 executor 入口拒;此处 catch 防御 (ajv 漏
      //     网 / 直接调 handler) → 转 ToolExecutionError (不静默吞掉)
      // #556 T3 + Spec review 收口: 捕获 catalog entry 用于 merge disallowedTools
      // —— 否则 explore 角色的 [edit_file, write_file] 不进入 wire,worker 工具
      // 面仍含这两个工具 (T8 acceptance "tool surface 无 edit_file/write_file" 失守)。
      const subagentType = obj.subagent_type;
      if (subagentType !== undefined && typeof subagentType !== "string") {
        // ajv strict 已拒, 此处防御
        throw new ToolExecutionError(
          "spawn_subagent: subagent_type must be a string"
        );
      }
      const requestedRole = subagentType ?? "general-purpose";
      // catalog entry.disallowedTools 与 obj.disallowedTools union (Set 去重)。
      // 两者均缺省 → undefined (V1 baseline,不动 def.disallowedTools 字段)。
      // 仅有 catalog → 应用 catalog deny (e.g. explore → [edit_file, write_file])。
      // 仅有 parent → 应用 parent deny (V1 行为)。
      // 双有 → union,parent 可 ADD 更多 deny,不可 subtract catalog 默认。
      const parentDisallowed = Array.isArray(obj.disallowedTools)
        ? (obj.disallowedTools as ReadonlyArray<string>)
        : undefined;
      let capabilities: ReturnType<typeof resolveSubagentCapabilities>;
      try {
        capabilities = resolveSubagentCapabilities({
          role: requestedRole,
          parentDisallowedTools: parentDisallowed,
          catalog,
        });
      } catch (err) {
        // Preserve the pre-extraction policy: an invalid custom catalog is
        // converted for an explicit type, while the default-role lookup
        // remains a direct typed catalog failure.
        if (subagentType === undefined) throw err;
        throw new ToolExecutionError(
          `spawn_subagent: unknown subagent_type '${subagentType}'`
        );
      }
      if (capabilities.catalogError !== undefined) {
        if (subagentType === undefined) throw capabilities.catalogError;
        throw new ToolExecutionError(
          `spawn_subagent: unknown subagent_type '${subagentType}'`
        );
      }
      const resolvedRole =
        subagentType === undefined
          ? (capabilities.catalogRole ?? requestedRole)
          : requestedRole;
      const mergedDisallowed = capabilities.disallowedTools;
      // 装配 SubAgentDefinition：可选字段透传，缺失字段从 def 上省略（manager
      // 端按 SubAgentDefinition 自身字段约束走 default deny / 默认 maxTurns 等）。
      // #356 High #1 修复：task 必填透传进 def（此前漏掉 → buildWorkerPayload
      // 读到 def.task ?? "" 永远空串 → 子代理跑空任务）。
      // #358 T2: timeoutMs 缺席时整个字段省略 —— 不在此把 percall/常量塞进
      // def.timeoutMs。理由:manager 三层链 `def.timeoutMs ?? env.subagent.
      // taskTimeoutMs ?? PER_TASK_TIMEOUT_MS` 必须让中段（settings 可配的
      // taskTimeoutMs）在模型未显式给 timeout 时生效;若这里永远补死常量,
      // 中段变成死代码(SC4 消费点证明)。
      const def: SubAgentDefinition = {
        task,
        // T4: terminal notices must be attributable to the session that
        // spawned the worker so a TUI session cannot wake another one.
        ...(ctx?.conversationId !== undefined
          ? { conversationId: ctx.conversationId }
          : {}),
        // F-4: 归属回合 —— manager 把它抄进 subagent_spawn / _state_change /
        // _stop 三类 record。ctx 缺 turnId(worker / ask / 直接调 handler)时
        // 字段整个省略,Postel 不落空值。
        ...(ctx?.turnId !== undefined ? { parentTurnId: ctx.turnId } : {}),
        // T5 (ADR-0071 / SC8): 反查父 loop 那次
        // 工具调用 —— executor 已把 call.id (Anthropic tool_use_id) 装进
        // ctx.toolUseId,manager 把它抄进 .meta.json 的 toolUseId 字段。
        // 缺省(ask / 直调 handler / 测试注入)整字段省略。
        ...(ctx?.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
        // #556 T3 / T7: subagent_type 解析结果 (缺省也解析为 general-purpose)
        ...(resolvedRole !== undefined ? { role: resolvedRole } : {}),
        ...(typeof obj.systemPrompt === "string"
          ? { systemPrompt: obj.systemPrompt }
          : {}),
        // #556 T3 + Spec review 收口: catalog entry.disallowedTools 与 parent
        // disallowedTools union 后写入;两者均缺省 → 字段省略 (V1 byte-stable)。
        ...(mergedDisallowed !== undefined
          ? { disallowedTools: mergedDisallowed }
          : {}),
        ...(typeof obj.model === "string" ? { model: obj.model } : {}),
        ...(typeof obj.maxTurns === "number" ? { maxTurns: obj.maxTurns } : {}),
        ...(typeof obj.timeoutMs === "number"
          ? { timeoutMs: obj.timeoutMs }
          : {}),
        // #357 T1: 透传 sandboxRoot;manager.buildWorkerPayload 单点校验 prefix-of-parent。
        ...(typeof obj.sandboxRoot === "string"
          ? { sandboxRoot: obj.sandboxRoot }
          : {}),
        // 前景臂的终态通道互斥 —— 见 foregroundDrainExclusion 头注。
        ...foregroundDrainExclusion(wait),
      };
      let taskId: string;
      try {
        taskId = deps.manager.spawn(def).taskId;
      } catch (err) {
        // #357 T1: sandboxRoot 越界 / 不存在 → ToolExecutionError(message 面向模型)。
        if (err instanceof SubAgentSandboxRootError) {
          throw new ToolExecutionError(err.message);
        }
        // #361 C1: capacity → ToolExecutionError（消息含 capacity + active/limit）。
        if (err instanceof SubAgentCapacityError) {
          throw new ToolExecutionError(err.message);
        }
        // Fallback: fake / 外部代码抛带 capacity 文案的 Error —— 仍归因。
        if (err instanceof Error && /capacity/i.test(err.message)) {
          throw new ToolExecutionError(err.message);
        }
        throw err;
      }
      // #361 wait:false 异步臂：立即返 {task_id}，不等待。
      if (!wait) {
        return JSON.stringify({ task_id: taskId });
      }
      try {
        // 前景臂： waitFor 缺省走 manager 三层链 (def.timeoutMs ??
        // env.subagent.taskTimeoutMs ?? 7200s)。def 在 handler 内只在模型
        // 显式给 timeoutMs 时携带该字段（缺省省略），故此处传 undefined
        // 让 spawn timer 与 waitFor 的缺省值由同一 effectiveTaskTimeoutMs
        // 链决定 —— 中段 taskTimeoutMs 生效时两者天然对齐。
        const envelope = await deps.manager.waitFor(
          taskId,
          undefined,
          ctx?.signal
        );
        // C5：成功 tool_result = envelope（executor 20000 截断,天然复用）。
        // 非超时的失败 envelope 仍作 ok 数据返回（crashed / maxTurnsExceeded /
        // protocolError 是任务结局,模型读 summary/reason）。
        // SC13：reason=timeout 的终态信封（manager per-task timer / worker
        // SIGTERM 收尾）改抛 ToolExecutionError → 非 ok（projectEnvelopeOrThrow）。
        return projectEnvelopeOrThrow(envelope, taskId);
      } catch (err) {
        // #361 C5 / SC14 abort 归因：调用侧 abort（executor 再归一成严格
        // "cancelled"）与操作员强杀（原样透出）用不同文本，见
        // throwAbortAttribution 头注。
        if (err instanceof SubAgentAbortError) {
          throwAbortAttribution(err, ctx);
        }
        // concurrent: ACI/caller abort 与 wait poll 竞态时 abort 优先，
        // 不把 WaitTimeoutError 合成 timeout envelope。
        if (ctx?.signal?.aborted) {
          throw new ToolExecutionError(
            "spawn_subagent: cancelled by caller abort"
          );
        }
        if (err instanceof SubAgentWaitTimeoutError) {
          return envelopeFromWaitTimeout(
            deps.manager.queryBuffer(taskId),
            taskId
          );
        }
        throw err;
      }
    },
  });
}
