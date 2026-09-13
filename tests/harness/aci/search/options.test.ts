/**
 * grep flag 解析层单测（SC12 职责 1；契约 D2–D5）。
 *
 * 锁的不变式：
 *   - 只传 pattern → output=paths / offset=0 / head_limit=50 / context=0 /
 *     ignoreCase=false（D2 默认 + D3 默认 50）；别名 `files_with_matches`
 *     在解析层归一为 paths，不产生第四种出法。
 *   - `head_limit` 硬顶 2000；`limit` 是**退役名**，出现即 typed 拒绝
 *     （D3「不叫 limit」；避免与 read_file 行窗撞名）。
 *   - 空 / 负 / 非法整数的边界一律 typed 拒绝（defensive 五类之空与非法）。
 *   - `also` 在场才解析 `within_lines`，默认 5（D5）。
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
    // withinLines 只在 also 在场时有意义；无 also 时保持默认常量不参与行为。
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
    // 别名只换标签、不产生第四种出法：解析产物与 paths 逐字段相同。
    assert.deepEqual(
      parseQuerySpec({ pattern: "a", output: "files_with_matches" }),
      parseQuerySpec({ pattern: "a", output: "paths" })
    );
    assert.equal(
      parseQuerySpec({ pattern: "a", output: "files_with_matches" }).output,
      "paths"
    );
    // paths 的 context 归零规则同样适用于别名（不是 content）。
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
    // 缺席 = 正常（不误伤）。
    assert.doesNotThrow(() => rejectRetiredLimitField({ pattern: "a" }));
    assert.doesNotThrow(() =>
      rejectRetiredLimitField({ pattern: "a", head_limit: 5 })
    );
  });

  it("`grep_limit` 同样是退役名：typed 拒绝且文案点名 head_limit", () => {
    // 契约 D3 明说「不叫 `limit`，不叫 `grep_limit`」。schema 的
    // `additionalProperties: false` 只拦新装配，直呼工具 / 旧装配仍可能带
    // 进来 —— 只拦 `limit` 会让 `grep_limit` 静默失效（模型以为限了条数，
    // 实际拿默认 50 条）。
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
    // rg 对未闭合 `[` 是 rc=2 整次失败；若只在 Node 引擎里当字面量处理，
    // 同一个 glob 就会「自带引擎在场时报错、起不来时静默回空」（SC9）。
    rejects({ pattern: "a", glob: "[.ts" }, /glob/);
    rejects({ pattern: "a", glob: "a[b" }, /unclosed/);
    // `[]]` 合法（紧跟 `[` 的 `]` 是字面成员），不得误伤。
    assert.equal(parseQuerySpec({ pattern: "a", glob: "[]]" }).glob, "[]]");
  });
});
