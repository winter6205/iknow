// Q6b-D4 决议:7 个常量从 OpenHarness 照搬,2 个接逻辑,5 个留 L3b 门后
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const TOKEN_ESTIMATION_PADDING = 4 / 3;
export const DEFAULT_KEEP_RECENT = 6; // A4
export const COMPACTION_BOUNDARY_PLACEHOLDER =
  "[compaction boundary — earlier messages cleared]"; // A5
// #467 step 2:full-compact 超时默认值。SECONDS 语义(25s),runFullCompact 内
// 换算成 ms(`COMPACT_TIMEOUT_SECONDS * 1000`)。仍按 issue 决议保持 25 不变。
export const COMPACT_TIMEOUT_SECONDS = 25;
const _DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE = 3_072; // 留 L3b 门后
const MAX_COMPACT_STREAMING_RETRIES = 2; // 留 L3b 门后
// L3b 门后常量尚无 read use:noUnusedLocals 下 underscore 前缀不豁免模块级 const,
// 用 void 引用标记为已读(零运行时逻辑,不暴露公共 API)。
void _DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE;
void MAX_COMPACT_STREAMING_RETRIES;
