/**
 * #356 subagent role — SubAgentDefinition + deny-list 装配裁剪 (D1 / SC9)。
 *
 * SubAgentDefinition 是子代理角色声明的类型化形态 (envelope.ts 的
 * systemPrompt / disallowedTools / model / maxTurns / timeoutMs 字段同构),
 * 由 manager 层从 user 配置装配后封进 worker envelope。
 *
 * deny-list 装配裁剪分两层语义:
 *   - applyRoleDenyList: 严格模式 (SC9 越界 fail-fast)。disallowed 任一工具名
 *     不在 available → throw RegistryConstructionError (用户 deny 名 typo 守门)。
 *   - buildWorkerToolSurface: 宽容模式。merged (默认 deny + 用户 deny) 中
 *     available 不含的项静默跳过。原因: 默认 deny 含 spawn_subagent,而 worker
 *     进程装配期 (createDefaultAciRegistry 不传 subagentManager) 工具集本就不含
 *     spawn_subagent —— 默认 deny 是冗余保护,声明 deny intent 而非真实剔除目标,
 *     若走严格模式每次 worker 装配都会误抛。
 *
 * 返回值一律 frozen,防下游 (worker 内部 / envelope 序列化路径) 意外修改。
 */
import { RegistryConstructionError } from "../errors.js";
import { mergeDisallowedTools } from "./capability.js";

export interface SubAgentDefinition {
  readonly systemPrompt?: string;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  /**
   * #356 High #1 修复:子代理任务文本(WorkerEnvelope.task 必填,本地定义
   * 兼容可选)。spawn_subagent 工具负责写入 def.task(此前漏掉 → 子进程
   * 收到 task:"")。manager.buildWorkerPayload 用 def.task ?? "" 兜底。
   */
  readonly task?: string;
  /**
   * #356 High #1 修复:子代理软沙箱根(WorkerEnvelope.sandboxRoot 必填)。
   * spawn_subagent 工具不直接采集 —— 由 manager 装配期根据父 cwd 补齐;
   * 本地定义为可选,缺省空串兜底。
   */
  readonly sandboxRoot?: string;
  /**
   * #556 T2: catalog persona id → WorkerEnvelope.role → worker 注入。
   * Copied onto WorkerEnvelope. Orthogonal to excludeFromHostDrain.
   */
  readonly role?: string;
  /**
   * Parent-only: 派出这个子代理的那一回合的 trace turn id（F-4）。manager 把它
   * 抄进 subagent_spawn / _state_change / _stop 三类 record 的 `parentTurnId`，
   * `?parent_turn_id=` 因此能一次捞出某回合派出的全部子代理。
   * Not copied onto WorkerEnvelope —— 子进程不需要、也不该知道父侧回合身份。
   */
  readonly parentTurnId?: string;
  /**
   * Parent-only: conversation that owns this worker. Used to keep terminal
   * wakeups and host drains scoped to one interactive session.
   */
  readonly conversationId?: string;
  /**
   * Parent-only: skip host-drain (wait:false wakeup channel).
   * Judge / wait:true consumers already await waitFor; leaking their
   * envelope into the next user turn would paint it as a user message.
   * Not copied onto WorkerEnvelope.
   */
  readonly excludeFromHostDrain?: boolean;
  /**
   * Host truncated dialogue for the judge. Copied onto WorkerEnvelope.
   * Independent of `task` (exam question stays identity).
   */
  readonly finalText?: string;
  /**
   * Evidence prompt for the judge (not the exam question). Copied onto
   * WorkerEnvelope as an independent field; never concatenated into `task`.
   */
  readonly evidenceContext?: object;
  /**
   * T5 (ADR-0071 / SC8 .meta.json):
   * 派出这个子代理的那一次 tool_use 的 id (= spawn_subagent 的 tool_use_id)。
   * 透传到 per-agent `.meta.json` 的 `toolUseId` 字段(spawn 时落盘一次),
   * 用于把子代理记录反查回父 loop 的那一次工具调用;缺席 → meta 键省略(Postel)。
   * Parent-only:不复制到 WorkerEnvelope(子进程不需要、也不该知道)。
   */
  readonly toolUseId?: string;
  /**
   * T5 (ADR-0071 / SC8 .meta.json):
   * 子代理嵌套深度。1 = 父代理直接派出的子代理;2+ = 子代理内部再次 spawn
   * 出来的孙代理(SC9 v1 嵌套禁派发,当前永远 = 1,留 seam 给将来)。
   * 缺席 → meta 键省略(Postel)。
   * Parent-only:不复制到 WorkerEnvelope。
   */
  readonly spawnDepth?: number;
}

/** 默认 deny-list: 子代理禁止再派生子代理 (防递归爆炸)。frozen。 */
export const DEFAULT_DISALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "spawn_subagent",
]);

/**
 * 严格模式 deny-list 裁剪 (SC9 fail-fast)。
 *
 * - deny 为空数组 / undefined → 原样返回 available (frozen)。
 * - deny 名在 available 中 → 剔除。
 * - deny 名不在 available → throw RegistryConstructionError
 *   (`disallowed_tools contains unknown tool: <name>`),用户 deny 名 typo 守门。
 *
 * 返回值 frozen。
 */
export function applyRoleDenyList<T extends { readonly name: string }>(
  available: ReadonlyArray<T>,
  disallowed: ReadonlyArray<string> | undefined
): ReadonlyArray<T> {
  if (disallowed === undefined || disallowed.length === 0) {
    return Object.freeze([...available]);
  }
  const disallowedSet = new Set(disallowed);
  const availableNames = new Set(available.map((t) => t.name));
  for (const name of disallowedSet) {
    if (!availableNames.has(name)) {
      throw new RegistryConstructionError(
        `disallowed_tools contains unknown tool: ${name}`
      );
    }
  }
  return Object.freeze(available.filter((t) => !disallowedSet.has(t.name)));
}

/**
 * 宽容模式工具面装配: 合并默认 deny-list + 用户 deny-list (用户优先 +
 * Set 去重),再剔除 available 中含有的 deny 项。
 *
 * 与 applyRoleDenyList 的关键差异: merged 中 available 不含的项 (典型是默认
 * deny 的 spawn_subagent —— worker 工具集装配期本就不含) 静默跳过,不抛错。
 * 用户显式 deny 了一个 unknown 工具名同样静默跳过 (宽容面),由 worker 侧
 * registry 校验兜底。
 *
 * 返回值 frozen。
 */
export function buildWorkerToolSurface<T extends { readonly name: string }>(
  available: ReadonlyArray<T>,
  userDisallowed?: ReadonlyArray<string>
): ReadonlyArray<T> {
  const merged = mergeDisallowedTools(
    DEFAULT_DISALLOWED_TOOLS,
    userDisallowed
  )!;
  if (merged.length === 0) {
    return Object.freeze([...available]);
  }
  const denySet = new Set(merged);
  const availableNames = new Set(available.map((t) => t.name));
  // 宽容: merged 中 available 不含的项跳过 (默认 deny 的 spawn_subagent 在
  // worker 装配期已不在 available,属合法冗余)。
  return Object.freeze(
    available.filter(
      (t) => !(denySet.has(t.name) && availableNames.has(t.name))
    )
  );
}
