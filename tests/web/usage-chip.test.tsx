/**
 * tests/web/usage-chip.test.tsx
 *
 * UsageChip 渲染断言 — 三档色阈值 × null → 不渲染 × cache null 当 0 ×
 * title 明细。百分比计算断言语义迁移自已退役的
 * context-usage-strip.test.tsx（组件整体退役，非降断言）：
 * 分子 = inputTokens + cacheReadInputTokens + cacheCreationInputTokens，
 * 分母 = contextWindow，pct = round(used/window×100)。
 *
 * renderToStaticMarkup 模式沿用 tests/web 既有约定（node env，无 DOM 框架）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageChip } from "../../web/src/components/UsageChip.tsx";
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
    <UsageChip
      usage={opts.usage}
      contextWindow={opts.contextWindow}
      sending={opts.sending ?? false}
    />
  );
}

describe("UsageChip — 三档色阈值", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly pct: number;
    readonly color: string;
  }> = [
    { name: "pct 0 — 正常", pct: 0, color: "#7ab8ff" },
    { name: "pct 49 — 正常", pct: 49, color: "#7ab8ff" },
    { name: "pct 50 — warn", pct: 50, color: "#d9a343" },
    { name: "pct 80 — warn", pct: 80, color: "#d9a343" },
    { name: "pct 81 — danger", pct: 81, color: "#c95d47" },
  ];
  for (const { name, pct, color } of cases) {
    it(`${name} 渲染百分比与档色 hex`, () => {
      const html = render({ usage: usage(pct), contextWindow: 100 });
      assert.ok(html.includes(`${pct}%`), `must include percent "${pct}%"`);
      assert.ok(
        html.includes(color),
        `must include tier color hex "${color}"`
      );
    });
  }
});

describe("UsageChip — null / 缺失 → 不渲染", () => {
  it("usage === null → 空字符串", () => {
    const html = render({ usage: null, contextWindow: 200000 });
    assert.equal(html, "");
  });

  it("contextWindow === null → 空字符串", () => {
    const html = render({ usage: usage(1234), contextWindow: null });
    assert.equal(html, "");
  });

  it("contextWindow <= 0 → 空字符串（除零保护）", () => {
    const html = render({ usage: usage(10), contextWindow: 0 });
    assert.equal(html, "");
  });
});

describe("UsageChip — cache nulls 当 0（迁移自 context-usage-strip）", () => {
  it("cacheReadInputTokens=null + cacheCreationInputTokens=null → used = input only", () => {
    // input=30, cache null → used=30 / 100 → pct=30。
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
  });
});

describe("UsageChip — title 明细", () => {
  it("悬停 title 显示 X.Xk / Y.Yk tokens", () => {
    const html = render({ usage: usage(42000), contextWindow: 200000 });
    assert.ok(html.includes('title="42.0k / 200.0k tokens"'));
  });
});

describe("UsageChip — sending prop", () => {
  it("sending=true → 轻微透明（对齐 ContextUsageStrip 现有口径）", () => {
    const html = render({ usage: usage(49), contextWindow: 100, sending: true });
    assert.ok(html.includes("opacity:0.85"));
  });

  it("sending=false → 无透明样式", () => {
    const html = render({ usage: usage(49), contextWindow: 100 });
    assert.ok(!html.includes("opacity"));
  });
});
