/**
 * ACI 能力层：类型契约。
 *
 * 权限三层毕业（#122 Q5）后：删 pass_through（决策改 allow/deny/ask），
 * 删 AciMeta.isReadOnly / isDestructive（category 已是真值单一权威）；
 * 保留 category / isConcurrencySafe / interruptBehavior（#124 中断/超时）；
 * 新增 timeoutTier（T5 接入）：按工具静态分级超时。
 *
 * 决策 / 规则 / 策略对象均移至 `src/harness/permission/` 模块，
 * 见 permission/index.ts 公共出口。
 */

import type { ToolDef } from "../tools/types.js";

/** ch04 四类安全级别（category 是 read-only / write / execute / collaborate 真值）。 */
export type AciCategory = "read-only" | "write" | "execute" | "collaborate";

/**
 * 超时分级（T5 / #124）：工具的静态超时档位。
 *
 *   fast       = 5 s       单次文件读 / glob 列表（轻量原子操作）
 *   default    = 30 s      写入 / grep 大仓库（常规 IO + 子进程）
 *   build      = 5 min     bash 长命令（构建 / 测试 / 部署）
 *   long       = 30 min    罕见大作业（MCP 等）
 *   unbounded  = 0         不设 ACI 层 timer（createAciExecutor `tierTimeoutMs > 0`
 *                          门）；寿命由工具自己的钟决定。spawn_subagent wait:true
 *                          必须用此档：`long`(30min) < PER_TASK(2h) 会提前 abort。
 *
 * 由 `TIMEOUT_TIER_MS` 提供毫秒值；`createAciExecutor` 在 #124 决策
 * 3-4 之下，把工具的 tier 视为权威覆盖 Loop Engine 传入的 timeoutMs。
 */
export type TimeoutTier = "fast" | "default" | "build" | "long" | "unbounded";

/** 各 tier 的毫秒值（frozen — 实现层 + 测试层共源）。 */
export const TIMEOUT_TIER_MS: Readonly<Record<TimeoutTier, number>> =
  Object.freeze({
    fast: 5_000,
    default: 30_000,
    build: 300_000,
    long: 1_800_000,
    unbounded: 0,
  });

/** ACI 安全/调度元数据（延迟加载 / 并发安全 / 中断行为 / 超时分级 / 溢出候选）。 */
export interface AciMeta {
  readonly category: AciCategory;
  readonly isConcurrencySafe: boolean;
  readonly interruptBehavior: "cancel" | "block";
  /** true = 延迟加载：默认不进 prompt schema，需 discover() 检索注入。默认 false（核心常驻）。 */
  readonly lazy?: boolean;
  /**
   * B6 / ADR-0043 §3:溢出候选标记 —— true = 进入可延迟池(首轮装配
   * countTokens 实测超过 context window 的 10% 时可退到名字目录)。与
   * `lazy` 区分:`lazy` = 已加载即常驻(schema 仍可能在可见前缀),`deferrable`
   * = 溢出时可退到名字目录。**核心七件永不退场**(bash / read_file /
   * edit_file / write_file / grep / glob / spawn_subagent),即使标
   * deferrable 也被判定层忽略 —— 见 `tool-overflow.ts` `CORE_TOOL_NAMES`。
   * 默认 false(常驻)。MCP 工具天然 deferrable(B4 §2);内建低频件按调用
   * 频次数据定(本 plan B6 §3 预置:trace 读侧三件 + web_search / web_fetch)。
   */
  readonly deferrable?: boolean;
  /** 静态超时分级；createAciExecutor 据此生成 per-call 超时（覆盖 engine 传入 timeoutMs）。 */
  readonly timeoutTier: TimeoutTier;
}

/** ACI 工具定义 = 冻结 ToolDef + aci 元数据（扩展，不改协议）。 */
export interface AciToolDef extends ToolDef {
  readonly aci: AciMeta;
}

/** ACI 目录：按名定位 AciToolDef（权限层与延迟加载共用）。 */
export interface AciCatalog {
  readonly get: (name: string) => AciToolDef | undefined;
  readonly all: () => ReadonlyArray<AciToolDef>;
  /**
   * B4 / ADR-0043 §2:检某名字是否已被 `discover()` 标记为「模型已检索」。
   * 缺席(`undefined`)→ 闸门放过(非 ACI registry 装配的路径,如 hub runDeps
   * 用 build-engine 之外的 registry,行为与 B4 之前一致)。
   */
  readonly isDiscovered?: (name: string) => boolean;
  /**
   * T3 / ADR-0046 §3:hydrate 副作用入口 —— gateOne 对未 discover 的 mcp__
   * 工具调此函数把名字纳入 discovered set(下一轮 visibleSchemas 尾部
   * 追加 schema)。缺席(`undefined`)→ 闸门视作「非 ACI registry 装配
   * 的路径」,行为与 T3 之前一致(直接交给 inner)。
   */
  readonly discover?: (name: string) => void;
}

/**
 * ⚠️ Compatibility re-exports — the prototype layer used PermissionDecision,
 * PermissionOutcome, PermissionRule, AciPermissionPolicy. Those shapes live in
 * `src/harness/permission/` now (graduated as part of #122). Re-exporting them
 * here avoids breaking any prototype-importing tests while the new module
 * (the new home of these symbols) is the canonical source.
 */
export type {
  PermissionDecision,
  PermissionOutcome,
  AskUser,
  PreHookBlock,
  PreToolUseHook,
  PostToolUseHook,
} from "../permission/types.js";
export type { NormalRuleSpec as PermissionRule } from "../permission/types.js";
export type { PermissionPolicy as AciPermissionPolicy } from "../permission/policy.js";
