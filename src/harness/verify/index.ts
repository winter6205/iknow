/**
 * verify bounded context 公共出口 (GH #128 失败自动修正闭环, T8)。
 *
 * 最小面: 只 re-export 装配层 (cli / session-api) 需要的类型与函数 ——
 *   - VerifyConfig: settings.verify 段 → 装配层构造闭环配置;
 *   - runVerifyLoop / VerifyLoopOptions / VerifyLoopResult / VerifyLoopOutcome:
 *     chat / serve 的 run() 包裹点;
 *   - 纯函数层 (verdict / inject) 是 verify-loop 内部契约, 装配层不消费,
 *     不在此暴露 (避免面膨胀, bounded-context-guardian)。
 */
export type { VerifyConfig } from "./types.js";
export type { VerificationRecord } from "./types.js";

export {
  runVerifyLoop,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_ROUNDS,
} from "./verify-loop.js";
export type {
  RunOutcome,
  RunVerifyFn,
  VerifyLoopOptions,
  VerifyLoopResult,
  VerifyLoopOutcome,
} from "./verify-loop.js";
