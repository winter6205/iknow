/**
 * tests/web/context-usage-strip.test.tsx
 *
 * T6 (#TBD): ContextUsageStrip 渲染断言 — 三档色阈值 × null 兜底 × cache null。
 * 标签 `ctx` / 状态 ok / warn / alert（用户 2026-08-07 反馈：不用中文）。
 *
 * 复刻 TUI context-bar.test.tsx 的 renderToString 模式：使用
 * react-dom/server 的 renderToStaticMarkup（tests/web/markdown-copy.test.ts 同款，
 * H1 acceptance 显式允许；web 包不带测试框架，root vitest 跑 node env）。
 *
 * 三档色阈值（本计划裁决 7）：<50% #7d8a82 安全 / 50-80% #d9a343 注意 /
 * >80% #c95d47 告警，与 TUI theme.ts:61-62 同值。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextUsageStrip } from "../../web/src/components/ContextUsageStrip.tsx";
import type { TokenUsage } from "../../web/src/api/types.ts";

/** 构造一个 TokenUsage，cache 字段默认 0。 */
function usage(
  inputTokens: number,
  caches: { read?: number | null; creation?: number | null } = {}
): TokenUsage {
  return {
    inputTokens,
    outputTokens: 0,
    cacheCreationInputTokens: caches.creation ?? 0,
    cacheReadInputTokens: caches.read ?? 0,
  };
}

function render(opts: {
  usage: TokenUsage | null;
  contextWindow: number | null;
  sending?: boolean;
}): string {
  return renderToStaticMarkup(
    <ContextUsageStrip
      usage={opts.usage}
      contextWindow={opts.contextWindow}
      sending={opts.sending ?? false}
    />
  );
}

describe("ContextUsageStrip — 三档色阈值", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly pct: number;
    readonly status: string;
    readonly color: string;
  }> = [
    { name: "pct 0 — ok", pct: 0, status: "ok", color: "#7d8a82" },
    { name: "pct 49 — ok", pct: 49, status: "ok", color: "#7d8a82" },
    { name: "pct 50 — warn", pct: 50, status: "warn", color: "#d9a343" },
    { name: "pct 80 — warn", pct: 80, status: "warn", color: "#d9a343" },
    { name: "pct 81 — alert", pct: 81, status: "alert", color: "#c95d47" },
  ];
  for (const { name, pct, status, color } of cases) {
    it(`${name} 渲染状态词与档色 hex`, () => {
      const html = render({ usage: usage(pct), contextWindow: 100 });
      assert.ok(html.includes(status), `must include status word "${status}"`);
      assert.ok(
        html.includes(color),
        `must include tier color hex "${color}" in style attr`
      );
      assert.ok(html.includes(`${pct}%`), `must include percent "${pct}%"`);
      // band 字符存在（10 格，filled = round(pct/100*10)）。
      const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * 10);
      const empty = 10 - filled;
      assert.ok(html.includes("█".repeat(filled)));
      assert.ok(html.includes("░".repeat(empty)));
    });
  }
});

describe("ContextUsageStrip — null 兜底", () => {
  it("usage === null → `ctx —`", () => {
    const html = render({ usage: null, contextWindow: 200000 });
    assert.ok(html.includes("ctx —"));
    assert.ok(!html.includes("ok"));
    assert.ok(!html.includes("warn"));
    assert.ok(!html.includes("alert"));
  });

  it("contextWindow === null → `ctx —`", () => {
    const html = render({
      usage: usage(1234),
      contextWindow: null,
    });
    assert.ok(html.includes("ctx —"));
    assert.ok(!html.includes("ok"));
  });
});

describe("ContextUsageStrip — cache nulls 当 0", () => {
  it("cacheReadInputTokens=null + cacheCreationInputTokens=null → used = input only", () => {
    // input=30, cache null → used=30 / 100 → pct=30；k/k 显示 0.0k/0.1k。
    const html = render({
      usage: {
        inputTokens: 30,
        outputTokens: 0,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      contextWindow: 100,
    });
    assert.ok(html.includes("30%"));
    assert.ok(html.includes("ok"));
    assert.ok(html.includes("0.0k/0.1k"));
  });

  it("cache 部分字段 null：另一个非 null 仍计入", () => {
    // input=20, cacheRead=30, cacheCreation=null → used=50 / 200 → pct=25。
    const html = render({
      usage: {
        inputTokens: 20,
        outputTokens: 0,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: 30,
      },
      contextWindow: 200,
    });
    assert.ok(html.includes("25%"));
    assert.ok(html.includes("ok"));
  });
});

describe("ContextUsageStrip — sending prop", () => {
  it("sending=true 仍渲染三档色（不要求脉冲，但 prop 须接受）", () => {
    const html = render({
      usage: usage(49),
      contextWindow: 100,
      sending: true,
    });
    assert.ok(html.includes("ok"));
    assert.ok(html.includes("#7d8a82"));
  });
});
