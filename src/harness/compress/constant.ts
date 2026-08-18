// Q6b-D4 决议:7 个常量从 OpenHarness 照搬,2 个接逻辑,5 个留 L3b 门后
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const TOKEN_ESTIMATION_PADDING = 4 / 3;
export const DEFAULT_KEEP_RECENT = 6; // A4
export const COMPACTION_BOUNDARY_PLACEHOLDER =
  "[compaction boundary — earlier messages cleared]"; // A5
// #467 step 2:full-compact 超时默认值。SECONDS 语义,runFullCompact 内换算成 ms。
// 实测(i467 real-LLM smoke,docs/handoff/i467-full-compact/,2026-08-19):27KB
// dropped 在 stream=on + thinking=adaptive + maxOutputTokens=8192 下 ~17s 完成,
// 占旧 25s 默认的 67%。Claude Code 的压缩体感是"等模型自然完成",不设紧凑
// client-side timeout;25→90 给 ~3.6× headroom 覆盖更长的常见上下文,不再为
// 单一数字(线性外推到某一容量)的精确上限背书——更长上下文用户可经 run 级
// signal(Esc/Ctrl+C)中止并保持 messages 原样(runFullCompact → signal_aborted
// → applyCompactAttachment 返回 state unchanged)。常量上限不复用 SDK 默认 10
// 分钟,避免 turn 长时阻塞。
export const COMPACT_TIMEOUT_SECONDS = 90;
const _DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE = 3_072; // 留 L3b 门后
const MAX_COMPACT_STREAMING_RETRIES = 2; // 留 L3b 门后
// L3b 门后常量尚无 read use:noUnusedLocals 下 underscore 前缀不豁免模块级 const,
// 用 void 引用标记为已读(零运行时逻辑,不暴露公共 API)。
void _DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE;
void MAX_COMPACT_STREAMING_RETRIES;
