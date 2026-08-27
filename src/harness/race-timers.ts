/**
 * #742 T1 / CONTEXT「model-call idle / 模型调用硬顶」:单次 `adapter.step`
 * 上的两根钟。
 *
 * 从 `loop-engine.ts` 的 `createRaceOutcome` 抽出,而不是在 loop-engine 里
 * 嵌第二个状态机(ACR complexity-anti-drift):这里只管"什么时候到点",
 * 到点之后的胜出归属 / cleanup / single-wins 仍然只由 `createRaceOutcome`
 * 的 `settle` 一处决定。
 *
 * 两根钟:
 *   - **idle**:无模型输出增量的静默上限。仅流式臂有增量可重置它,
 *     故 `resolveModelClocks` 在非流式臂上直接把它解析成 undefined。
 *   - **硬顶**:从本次 step 起算的有限上限,到点即使仍有增量也到期
 *     (CONTEXT _Avoid_:硬顶调成无限当验收)。
 *
 * 两者到期都由调用方落既有 `StopReason: timeout`(cancelKind
 * `timerTimeout`),**不新增停因** —— `onExpire` 的 source 参数只是让本
 * 模块可被单测精确断言是哪根钟到点,loop-engine 侧把两者收敛成同一条
 * 超时路径。
 */
import type { HarnessStreamEvent } from "./stream.js";

/**
 * idle 重置事件闭集(计划 Harvest 已定项):只有**模型输出增量**算"还在
 * 出字"。`compaction_*` 是压缩子过程的进度,不是本次模型调用在出字,
 * 重置它等于让一次卡死的调用被压缩噪声续命(CONTEXT _Avoid_)。
 * `stop_summary` / `agent_status` / `env_snapshot` 同理不算。
 */
export function resetsModelIdle(event: HarnessStreamEvent): boolean {
  return (
    event.type === "thinking_delta" ||
    event.type === "text_delta" ||
    event.type === "tool_call_start" ||
    event.type === "tool_input_delta"
  );
}

/** 哪根钟到点。两者在 loop-engine 侧都收敛为 `StopReason: timeout`。 */
export type RaceExpirySource = "idle" | "hardCap";

export interface RaceTimers {
  /**
   * false = 本次调用只有硬顶一根钟(非流式臂 / idle 未配置)。调用方据此
   * 决定是否要包装 `onStream` —— 不启用时原样透传,行为与改前逐字节一致。
   */
  readonly idleEnabled: boolean;
  /** 流事件到达时喂给本函数;仅闭集内事件重置 idle,其余忽略。 */
  readonly noteStreamEvent: (event: HarnessStreamEvent) => void;
  /** settle 时调用,清掉两根钟;之后 `noteStreamEvent` 不再复活 idle。 */
  readonly cancel: () => void;
}

/**
 * 起两根钟。`onExpire` 至多被调用一次(先到点的那根赢,随后本 helper 自行
 * 停表)——胜出仲裁仍在调用方的 `settle`,这里只是不制造第二次噪声。
 *
 * 非正值等价关闭:`hardCapMs <= 0` 沿用既有「modelTimeoutMs=0 关掉竞速」
 * 语义;`idleTimeoutMs` 缺席 / <= 0 → idle 关闭。
 */
export function startRaceTimers(opts: {
  readonly hardCapMs: number;
  readonly idleTimeoutMs: number | undefined;
  readonly onExpire: (source: RaceExpirySource) => void;
}): RaceTimers {
  const idleEnabled =
    opts.idleTimeoutMs !== undefined && opts.idleTimeoutMs > 0;
  let stopped = false;
  let hardCapTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    stopped = true;
    if (hardCapTimer !== undefined) clearTimeout(hardCapTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    hardCapTimer = undefined;
    idleTimer = undefined;
  };

  const expire = (source: RaceExpirySource): void => {
    if (stopped) return;
    cancel();
    opts.onExpire(source);
  };

  if (opts.hardCapMs > 0) {
    hardCapTimer = setTimeout(() => expire("hardCap"), opts.hardCapMs);
  }
  const armIdle = (): void => {
    if (stopped || !idleEnabled) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire("idle"), opts.idleTimeoutMs);
  };
  armIdle();

  return Object.freeze({
    idleEnabled,
    noteStreamEvent: (event: HarnessStreamEvent): void => {
      if (resetsModelIdle(event)) armIdle();
    },
    cancel,
  });
}

/**
 * 把「今日单钟 + 流式臂两根钟配置」解析成本次 step 实际用的两根钟。
 *
 * - 非流式臂(`stream=off` / 离线替身):idle 无增量可重置,直接关掉;
 *   硬顶 = 今日 `timeoutMs` 解析结果 —— 改前行为逐字节不变。
 * - 流式臂:idle 生效;硬顶取显式覆盖,未配则回落今日单钟(不放大到
 *   无限)。
 *
 * 取原始数值而非 `LoopEngineDeps`,避免 race-timers ← loop-engine 的反向
 * 依赖(loop-engine 单向 import 本模块)。
 */
export function resolveModelClocks(input: {
  readonly modelTimeoutMs: number;
  readonly streamingArm: boolean;
  readonly idleTimeoutMs: number | undefined;
  readonly hardCapMs: number | undefined;
}): { readonly hardCapMs: number; readonly idleTimeoutMs: number | undefined } {
  if (!input.streamingArm) {
    return { hardCapMs: input.modelTimeoutMs, idleTimeoutMs: undefined };
  }
  return {
    hardCapMs: input.hardCapMs ?? input.modelTimeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
  };
}
