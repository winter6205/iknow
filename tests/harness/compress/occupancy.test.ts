/**
 * Unit tests for `occupancyFromUsage` — the pure usage→context-occupancy
 * derivation (ADR-0118).
 *
 * Pinned shapes:
 *   - pre_call (both cache fields null/absent) -> inputTokens only;
 *   - post_call (>=1 cache field non-null) -> inputTokens + cacheRead + cacheCreation
 *     (three disjoint Anthropic categories, null treated as 0);
 *   - outputTokens never participates.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { occupancyFromUsage } from "../../../src/harness/compress/index.ts";
import type { TokenUsage } from "../../../src/harness/model-adapter/types.ts";

describe("occupancyFromUsage — usage→occupancy (ADR-0118)", () => {
  it("pre_call 形态(两 cache 字段均 null)→ occupancy = inputTokens", () => {
    const usage: TokenUsage = {
      inputTokens: 1234,
      outputTokens: 5678,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    assert.equal(occupancyFromUsage(usage), 1234);
  });

  it("pre_call 形态(cache 字段运行期缺席 undefined)→ occupancy = inputTokens", () => {
    const usage = {
      inputTokens: 4321,
      outputTokens: 10,
    } as unknown as TokenUsage;
    assert.equal(occupancyFromUsage(usage), 4321);
  });

  it("post_call 形态(两 cache 字段均非 null)→ 三类相加，null 当 0 不适用", () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 9999,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 200,
    };
    assert.equal(occupancyFromUsage(usage), 600);
  });

  it("post_call 形态(仅一个 cache 字段非 null)→ 另一字段按 0 相加", () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 7,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: null,
    };
    assert.equal(occupancyFromUsage(usage), 150);
  });

  it("outputTokens 不进 occupancy 分子", () => {
    const pre: TokenUsage = {
      inputTokens: 10,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    assert.equal(occupancyFromUsage(pre), 10);
  });
});
