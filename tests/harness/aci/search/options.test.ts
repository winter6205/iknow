/**
 * grep flag parsing layer unit tests.
 *
 * Invariants locked:
 *   - pattern only → output=paths / offset=0 / head_limit=50 / context=0 /
 *     ignoreCase=false; the alias `files_with_matches` normalizes to paths at
 *     the parsing layer, never creating a fourth output mode.
 *   - `head_limit` is hard-capped at 2000; `limit` is a **retired name** —
 *     its presence is a typed reject (chosen to avoid colliding with
 *     read_file's line-window param).
 *   - Empty / negative / illegal-integer boundaries are typed rejects.
 *   - `within_lines` is only parsed when `also` is present, default 5.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  parseQuerySpec,
  rejectRetiredLimitField,
  DEFAULT_HEAD_LIMIT,
  DEFAULT_WITHIN_LINES,
  MAX_HEAD_LIMIT,
} from "../../../../src/harness/aci/search/options.ts";

function rejects(input: unknown, re: RegExp): void {
  assert.throws(
    () => parseQuerySpec(input),
    (error: unknown) =>
      error instanceof ToolExecutionError && re.test(error.message),
    `expected typed reject matching ${String(re)} for ${JSON.stringify(input)}`
  );
}

describe("parseQuerySpec — 默认面", () => {
  it("只传 pattern → paths / offset 0 / head_limit 50 / context 0 / 大小写敏感", () => {
    const spec = parseQuerySpec({ pattern: "hit" });

    assert.equal(spec.output, "paths");
    assert.equal(spec.offset, 0);
    assert.equal(spec.headLimit, DEFAULT_HEAD_LIMIT);
    assert.equal(spec.headLimit, 50);
    assert.equal(spec.context, 0);
    assert.equal(spec.ignoreCase, false);
    assert.equal(spec.also, undefined);
    assert.equal(spec.glob, undefined);
    assert.equal(spec.type, undefined);
    // withinLines only matters when `also` is present; without it the default
    // constant stays inert.
    assert.equal(spec.withinLines, DEFAULT_WITHIN_LINES);
  });

  it("显式 output=content / count 被接受", () => {
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "content" }).output,
      "content"
    );
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "count" }).output,
      "count"
    );
  });

  it("`files_with_matches` 是 paths 的入参别名，在解析层归一（D2）", () => {
    // The alias only relabels; no fourth output mode: parse result is
    // field-for-field identical to paths.
    assert.deepEqual(
      parseQuerySpec({ pattern: "a", output: "files_with_matches" }),
      parseQuerySpec({ pattern: "a", output: "paths" })
    );
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "files_with_matches" }).output,
      "paths"
    );
    // paths' context-zeroing rule applies to the alias too (not content).
    assert.equal(
      parseQuerySpec({
        pattern: "a",
        output: "files_with_matches",
        context: 3,
      }).context,
      0
    );
  });

  it("content 才保留 context；paths / count 下 context 被归零", () => {
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "content", context: 3 }).context,
      3
    );
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "paths", context: 3 }).context,
      0
    );
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "count", context: 3 }).context,
      0
    );
  });

  it("also 在场 → within_lines 默认 5，显式值被采用", () => {
    assert.equal(
      parseQuerySpec({ pattern: "a", also: "b" }).withinLines,
      DEFAULT_WITHIN_LINES
    );
    assert.equal(
      parseQuerySpec({ pattern: "a", also: "b", within_lines: 0 }).withinLines,
      0
    );
    assert.equal(
      parseQuerySpec({ pattern: "a", also: "b", within_lines: 12 }).withinLines,
      12
    );
  });
});

describe("parseQuerySpec — head_limit 语义（D3）", () => {
  it("head_limit 被接受并保留", () => {
    assert.equal(parseQuerySpec({ pattern: "a", head_limit: 7 }).headLimit, 7);
  });

  it("head_limit 硬顶 2000（超顶夹紧不报错）", () => {
    assert.equal(
      parseQuerySpec({ pattern: "a", head_limit: 9999 }).headLimit,
      MAX_HEAD_LIMIT
    );
    assert.equal(MAX_HEAD_LIMIT, 2000);
  });

  it("head_limit 不得为 0 或负数（结果名单空页无意义，typed 拒绝）", () => {
    rejects({ pattern: "a", head_limit: 0 }, /head_limit/);
    rejects({ pattern: "a", head_limit: -1 }, /head_limit/);
    rejects({ pattern: "a", head_limit: 1.5 }, /head_limit/);
  });

  it("`limit` 是退役名：出现即 typed 拒绝且文案点名 head_limit", () => {
    assert.throws(
      () => rejectRetiredLimitField({ pattern: "a", limit: 200 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /head_limit/.test(error.message) &&
        /limit/.test(error.message)
    );
    // Absent = fine (no false positives).
    assert.doesNotThrow(() => rejectRetiredLimitField({ pattern: "a" }));
    assert.doesNotThrow(() =>
      rejectRetiredLimitField({ pattern: "a", head_limit: 5 })
    );
  });

  it("`grep_limit` 同样是退役名：typed 拒绝且文案点名 head_limit", () => {
    // The contract says explicitly: "not `limit`, not `grep_limit`".
    // Schema `additionalProperties: false` only guards fresh assembly; direct
    // tool calls / stale assemblies can still bring them in — rejecting only
    // `limit` would let `grep_limit` fail silently (the model thinks it capped
    // rows while actually getting the default 50).
    assert.throws(
      () => rejectRetiredLimitField({ pattern: "a", grep_limit: 200 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /head_limit/.test(error.message) &&
        /grep_limit/.test(error.message)
    );
  });
});

describe("parseQuerySpec — 空 / 非法输入", () => {
  it("pattern 缺失 / 空串 / 非串一律 typed 拒绝", () => {
    rejects({}, /pattern/);
    rejects({ pattern: "" }, /pattern/);
    rejects({ pattern: 42 }, /pattern/);
    rejects(null, /input must be an object/);
    rejects("nope", /input must be an object/);
  });

  it("offset 负 / 小数 / 非数一律 typed 拒绝", () => {
    rejects({ pattern: "a", offset: -1 }, /offset/);
    rejects({ pattern: "a", offset: 0.5 }, /offset/);
    rejects({ pattern: "a", offset: "1" }, /offset/);
  });

  it("output 未知值被 typed 拒绝，文案列出全部合法值（别名也算合法）", () => {
    for (const output of ["lines", 3]) {
      assert.throws(
        () => parseQuerySpec({ pattern: "a", output }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /output/.test(error.message) &&
          ["paths", "content", "count", "files_with_matches"].every((legal) =>
            error.message.includes(legal)
          )
      );
    }
  });

  it("context 负 / 超顶处理：负拒绝、超顶夹到 MAX_CONTEXT", () => {
    rejects({ pattern: "a", output: "content", context: -1 }, /context/);
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "content", context: 500 }).context,
      50
    );
  });

  it("also / glob / type 空串被 typed 拒绝（空模式无意义，不做『匹配全部』退化）", () => {
    rejects({ pattern: "a", also: "" }, /also/);
    rejects({ pattern: "a", glob: "" }, /glob/);
    rejects({ pattern: "a", type: "" }, /type/);
  });

  it("语法坏的 glob 在解析层被拒（两条引擎同成败，不取决于谁在跑）", () => {
    // rg fails the whole run with rc=2 on an unclosed `[`; if only the Node
    // engine treated it as a literal, the same glob would "error when rg is
    // present, silently return empty when it isn't".
    rejects({ pattern: "a", glob: "[.ts" }, /glob/);
    rejects({ pattern: "a", glob: "a[b" }, /unclosed/);
    // `[]]` is legal (a `]` right after `[` is a literal member); no false rejects.
    assert.equal(parseQuerySpec({ pattern: "a", glob: "[]]" }).glob, "[]]");
  });
});
