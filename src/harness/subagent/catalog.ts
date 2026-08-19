/**
 * #556 T1 — builtin subagent catalog (resolver + entries)。
 *
 * 单一权威:builtin subagent 角色定义 = 冻结数组 `BUILTIN_CATALOG`,
 * 通过 `resolveAgentCatalog()` / `getAgentEntry(id)` 两条 resolver 暴露。
 *
 * 设计要点 (plan T1 Inherits):
 *   - `AgentCatalogEntry { id, description, body, bashMode?, disallowedTools? }`
 *     是 worker 装配期的 additive 字段载体 (envelope.role additive 通道在 T2
 *     接入;bashMode 通道在 T6 接入;disallowedTools 经既有 buildWorkerToolSurface
 *     合并,不新造抽象)。
 *   - explore = 只读探索 agent:disallowedTools 禁 edit_file / write_file,
 *     bashMode="readonly" (双层强制:validator + fence ro-bind, 后续 bullet);
 *     body 是 persona 文本 (T2 注入 worker system prompt)。
 *   - general-purpose = 全工具面,不额外 deny (默认 deny spawn_subagent 由
 *     buildWorkerToolSurface 自动叠加,worker toolset 本来就不含,静默)。
 *   - 数组 + 每条 entry + disallowedTools 全 Object.freeze,防下游意外修改。
 *
 * 错误:未知 id → AgentCatalogLookupError (typed, local — 仿 manager.ts
 * SubAgentCapacityError precedent, 不进 errors.ts 单点)。worker 装配
 * 期 (T2) catch 此 error 走 fallback 路径 (无 persona / 无额外 deny /
 * bashMode="any" = V1 逐字节)。
 */
export interface AgentCatalogEntry {
  readonly id: string;
  readonly description: string;
  readonly body: string;
  readonly bashMode?: "any" | "readonly";
  readonly disallowedTools?: ReadonlyArray<string>;
}

/**
 * 未知 catalog id fail-fast typed 错误 (T2 fallback 守门)。
 *
 * Local error class — 仿 manager.ts SubAgentCapacityError / SubAgentAbortError
 * precedent (manager-local, 不入 errors.ts)。message 包含 id 便于 fallback
 * 路径打 log;无 context 字段 (lookup error 不承载额外诊断信息)。
 */
export class AgentCatalogLookupError extends Error {
  override readonly name = "AgentCatalogLookupError";
  readonly id: string;
  constructor(id: string) {
    super(`subagent catalog: unknown agent id '${id}'`);
    this.id = id;
  }
}

/** explore — 只读探索 agent。persona body 注入 worker system prompt (T2)。 */
const EXPLORE_ENTRY: AgentCatalogEntry = Object.freeze({
  id: "explore",
  description:
    "Read-only exploration agent: searches code, reads files, and gathers information without modifying anything.",
  body: "You are an explore agent. Your role is read-only exploration and information gathering: search the codebase, read files, and report findings. Do not modify any files. Use read_file, grep, glob, and lsp_* tools to investigate. When asked to make changes, recommend instead that the caller perform the edits.",
  bashMode: "readonly",
  disallowedTools: Object.freeze(["edit_file", "write_file"]),
});

/** general-purpose — 全工具面 agent。persona body 注入 worker system prompt (T2)。 */
const GENERAL_PURPOSE_ENTRY: AgentCatalogEntry = Object.freeze({
  id: "general-purpose",
  description:
    "General-purpose agent for multi-step tasks that may use any available tool.",
  body: "You are a general-purpose agent. Use any available tool to accomplish the task delegated by the parent. Prefer concise, evidence-backed results and return a structured summary.",
});

/** builtin catalog 单一权威源 (frozen array singleton)。 */
const BUILTIN_CATALOG: ReadonlyArray<AgentCatalogEntry> = Object.freeze([
  EXPLORE_ENTRY,
  GENERAL_PURPOSE_ENTRY,
]);

/**
 * 返回 builtin catalog 全部 entry (frozen array singleton)。
 *
 * 调用方可安全持有返回引用 (frozen → 不可写, 同一引用 → 多次调用相等);
 * entry 自身 + disallowedTools 也全部 frozen。
 */
export function resolveAgentCatalog(): ReadonlyArray<AgentCatalogEntry> {
  return BUILTIN_CATALOG;
}

/**
 * 按 id 查 entry。未知 id 抛 AgentCatalogLookupError (typed, fail-fast)。
 *
 * T2 fallback:worker 装配期 catch 此 error 后走 V1 baseline 路径 (无 persona
 * 段 / 无额外 deny / bashMode 缺省 "any")。
 */
export function getAgentEntry(id: string): AgentCatalogEntry {
  const entry = BUILTIN_CATALOG.find((e) => e.id === id);
  if (entry === undefined) {
    throw new AgentCatalogLookupError(id);
  }
  return entry;
}
