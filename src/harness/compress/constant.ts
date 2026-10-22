// Constant inventory: 7 copied verbatim, 3 wired into logic, 4 reserved for a
// later phase.
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
// An image's real cost is pixel-driven (`width * height / 750`). `image-tokens.ts`
// reads header dimensions from a bounded base64 prefix and clamps the result
// here: one image cannot read as a multi-megabyte text block and trip
// compaction. The largest admitted clipboard or stored image is the wire raw
// budget (base64 form 5 MiB); this reserve stays 3072. Used for both top-level
// `image` blocks and images nested in `tool_result.content`.
export const VISION_IMAGE_TOKEN_CEILING = 3_072;
const _MAX_COMPACT_STREAMING_RETRIES = 2; // Reserved for a later phase.
// The reserved constant has no read site yet: under noUnusedLocals an
// underscore prefix does not exempt module-level consts, so a void reference
// marks it as read (zero runtime logic, no public API exposure).
void _MAX_COMPACT_STREAMING_RETRIES;
