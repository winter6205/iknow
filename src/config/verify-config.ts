/**
 * settings.verify 段 → VerifyConfig 装配（#128 失败自动修正闭环，T8 去重）。
 *
 * 单一装配点：cli / serve / tui 三入口共用，消除 resolveVerifyConfig 双份拷贝
 * （code-review SSOT finding）。CLI 层共享模块，不 import harness ——
 * settings.verify 的默认值兜底在消费点（verify-loop 的 DEFAULT_* 常量）。
 *
 * #128 装配层修复（spec 128-verify-classifier.md Objective 硬约束）：
 *  - `verify` 段缺失（用户零配置）→ 仍产出 `{ command: "" }`（而非 undefined）。
 *    spec Objective 白纸黑字：未配 verify.command 时闭环**不再**透明关闭，而是
 *    由子代理判官（分类器）对任务完成度做带证据判断。command 空串 → verify-loop
 *    在装配了 runClassifier seam（chat/serve/tui 的 subagentManager 在场）时
 *    走分类器分支（verify-loop.ts:796-798）。
 *  - `verify` 段存在但 command 缺失 → 同样 `{ command: "" }`（同一语义）。
 *  - `command` 已配 → 原样透传，行为零回归（字段级非法值仍丢弃，与 settings.ts
 *    drop-not-throw 纪律一致）。
 *
 * 成本与边界（诚实注释，SC1 生产装配）：
 *  - 零配置用户会话（chat/tui/serve）每轮 completed 结束会 spawn 判官子代理
 *    —— 这是 spec 要的行为（未配 command 由分类器接管），但有 LLM 成本 + 延迟。
 *  - 未装配 subagentManager 的入口（ask oneshot 形态）→ 装配层不传
 *    runClassifier，verify-loop 在 command="" 时仍透明关闭（向后兼容 SC7），
 *    ask 形态行为零变化。
 *  - classifierModel 缺省：command 缺失时 runClassifierLoop 的 model 字段
 *    可能 undefined → run-classifier-adapter 透传 manager.spawn(def)，manager
 *    只在 def.model !== undefined 时写 model（manager.ts:349），worker 兜底
 *    env.llm.model（worker.ts:119）。因此不在此层强行填模型。
 */
import type { IknowSettingsVerify } from "./settings.js";
import type { VerifyConfig } from "../harness/verify/index.js";

/**
 * 将 settings.verify 段解析为 VerifyConfig。
 * command 缺席（含 verify 段完全缺失）→ `{ command: "" }`（#128：分类器接管，
 * 不再透明关闭；装配了 runClassifier 才生效，未装配仍透明关闭向后兼容）。
 * 其余字段随行透传（默认值由 verify-loop 消费点兜底）。
 */
export function resolveVerifyConfig(
  verify: IknowSettingsVerify | undefined
): VerifyConfig {
  const config: VerifyConfig = {
    command: verify?.command ?? "",
    ...(verify?.rerunTemplate !== undefined
      ? { rerunTemplate: verify.rerunTemplate }
      : {}),
    ...(verify?.countRegex !== undefined
      ? { countRegex: verify.countRegex }
      : {}),
    ...(verify?.timeoutSec !== undefined
      ? { timeoutSec: verify.timeoutSec }
      : {}),
    ...(verify?.onExhausted !== undefined
      ? { onExhausted: verify.onExhausted }
      : {}),
    ...(verify?.maxRounds !== undefined ? { maxRounds: verify.maxRounds } : {}),
    ...(verify?.classifierModel !== undefined
      ? { classifierModel: verify.classifierModel }
      : {}),
  };
  return config;
}
