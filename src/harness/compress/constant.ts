// Constant inventory: 7 copied verbatim, 2 wired into logic, 5 reserved for a later phase.
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const TOKEN_ESTIMATION_PADDING = 4 / 3;
export const DEFAULT_KEEP_RECENT = 6; // A4
export const COMPACTION_BOUNDARY_PLACEHOLDER =
  "[compaction boundary — earlier messages cleared]"; // A5
// full-compact installs no default client-side timeout: compaction waits for
// the model to finish naturally, bounded by the SDK default HTTP timeout plus
// user-signal cancellation; a 25s/attempt + retries model proved insufficient
// on long contexts (a smoke test measured a 27KB dropped turn already taking
// ~17s, 67% of 25s). `timeoutMs` is kept as an injection seam on runFullCompact
// for tests / explicit callers; no default = no timer installed.
const _DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE = 3_072; // Reserved for a later phase.
const MAX_COMPACT_STREAMING_RETRIES = 2; // Reserved for a later phase.
// The reserved constants have no read sites yet: under noUnusedLocals an
// underscore prefix does not exempt module-level consts, so a void reference
// marks them as read (zero runtime logic, no public API exposure).
void _DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE;
void MAX_COMPACT_STREAMING_RETRIES;
