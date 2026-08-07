import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  TOKEN_ESTIMATION_PADDING,
  DEFAULT_KEEP_RECENT,
  COMPACTION_BOUNDARY_PLACEHOLDER,
} from "../../../src/harness/compress/constant.ts";

describe("compress constants", () => {
  it("AUTOCOMPACT_BUFFER_TOKENS = 13_000", () =>
    assert.equal(AUTOCOMPACT_BUFFER_TOKENS, 13_000));
  it("MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000", () =>
    assert.equal(MAX_OUTPUT_TOKENS_FOR_SUMMARY, 20_000));
  it("MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3", () =>
    assert.equal(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, 3));
  it("TOKEN_ESTIMATION_PADDING = 4/3", () =>
    assert.equal(TOKEN_ESTIMATION_PADDING, 4 / 3));
  it("DEFAULT_KEEP_RECENT = 6", () => assert.equal(DEFAULT_KEEP_RECENT, 6));
  it("COMPACTION_BOUNDARY_PLACEHOLDER 字节级", () =>
    assert.equal(
      COMPACTION_BOUNDARY_PLACEHOLDER,
      "[compaction boundary — earlier messages cleared]"
    ));
});
