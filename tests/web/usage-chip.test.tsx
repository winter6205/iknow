/**
 * tests/web/usage-chip.test.tsx
 *
 * UsageChip render asserts — three color-tier thresholds × usage null renders as 0
 * (status strip stays resident before the first turn; contextWindow null renders
 * nothing) × cache null treated as 0 × hover title details. The percentage math was
 * migrated semantically from the retired context-usage-strip.test.tsx (component
 * retired whole, not weakened asserts): numerator = context occupancy
 * (ADR-0118: pre_call cache 全 null → inputTokens-only；post_call =
 * inputTokens + cacheReadInputTokens + cacheCreationInputTokens, null cache
 * → 0), denominator = contextWindow, pct = round(used/window×100).
 *
 * renderToStaticMarkup follows the existing tests/web convention (node env, no DOM framework).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  contextOccupancy,
  UsageChip,
} from "../../web/src/components/UsageChip.tsx";
import type { TokenUsage } from "../../web/src/api/types.ts";

/** Build a TokenUsage; cache fields default to 0. */
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

/**
 * Context occupancy numerator contract (ADR-0118) — SHARED TABLE with
 * tests/tui/context-bar.test.tsx: the same TokenUsage input pairs must yield
 * the same occupancy on both mirrors (TUI contextOccupancy / web
 * contextOccupancy). Changing a row here must change the mirrored row there.
 */
const OCCUPANCY_CASES: ReadonlyArray<{
  readonly name: string;
  readonly usage: TokenUsage;
  readonly used: number;
}> = [
  {
    name: "pre_call 形态（cache 全 null）→ inputTokens",
    usage: {
      inputTokens: 12800,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
    used: 12800,
  },
  {
    name: "pre_call 形态非零 input 同样不加 cache",
    usage: {
      inputTokens: 1,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
    used: 1,
  },
  {
    name: "post_call 三类相加（一 cache null 当 0）",
    usage: {
      inputTokens: 20,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 30,
    },
    used: 50,
  },
  {
    name: "post_call 三 cache 齐全",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    },
    used: 600,
  },
  {
    name: "post_call cache 全 0 → inputTokens",
    usage: {
      inputTokens: 42,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    used: 42,
  },
  {
    name: "超预算占用原样返回（clamp 属渲染侧）",
    usage: {
      inputTokens: 15000,
      outputTokens: 0,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
    used: 15000,
  },
];

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
      assert.ok(html.includes(color), `must include tier color hex "${color}"`);
    });
  }
});

describe("UsageChip — null / 缺失", () => {
  it("usage === null → 按 0 渲染（首回合前状态条常驻）", () => {
    const html = render({ usage: null, contextWindow: 200000 });
    assert.ok(html.includes("0.0k / 200.0k"));
    assert.ok(html.includes("0%"));
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
    // input=30, cache null → used=30 / 100 → pct=30
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
    // input=20, cacheRead=30, cacheCreation=null → used=50 / 200 → pct=25
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

describe("UsageChip — contextOccupancy（ADR-0118 共享分子表）", () => {
  it("共享表逐行命中；pre_call 形态恒不加 cache", () => {
    for (const c of OCCUPANCY_CASES) {
      assert.equal(contextOccupancy(c.usage), c.used, c.name);
    }
    // 结构不可能「总量再加 cacheRead 2×」：pre_call 形态（两 cache 字段均
    // null）走 inputTokens-only 分支，cache 字段不参与任何加法。
    for (const input of [0, 1, 12800, 15000]) {
      assert.equal(
        contextOccupancy({
          inputTokens: input,
          outputTokens: 0,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        }),
        input
      );
    }
  });

  it("pre_call 形态读数渲染 = inputTokens 原样上条", () => {
    const html = render({
      usage: {
        inputTokens: 12800,
        outputTokens: 0,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      contextWindow: 256000,
    });
    assert.ok(html.includes("12.8k / 256.0k"));
    assert.ok(html.includes("5%"));
  });
});

describe("UsageChip — 明细与悬停 title", () => {
  it("可见 X.Xk / Y.Yk token 明细", () => {
    const html = render({ usage: usage(42000), contextWindow: 200000 });
    assert.ok(html.includes("42.0k / 200.0k"));
  });

  it("悬停 title 显示精确 token 值", () => {
    const html = render({ usage: usage(42000), contextWindow: 200000 });
    assert.ok(html.includes('title="42,000 / 200,000 tokens"'));
  });

  it("进度条填充宽度 = min(pct,100)%", () => {
    const html = render({ usage: usage(42000), contextWindow: 200000 });
    assert.ok(html.includes("width:21%"));
  });

  it("进度条填充宽度封顶 100%（used 超窗时）", () => {
    const html = render({ usage: usage(150), contextWindow: 100 });
    assert.ok(html.includes("width:100%"));
    assert.ok(html.includes("150%"));
  });
});

describe("UsageChip — sending prop", () => {
  it("sending=true → 轻微透明（对齐 ContextUsageStrip 现有口径）", () => {
    const html = render({
      usage: usage(49),
      contextWindow: 100,
      sending: true,
    });
    assert.ok(html.includes("opacity:0.85"));
  });

  it("sending=false → 无透明样式", () => {
    const html = render({ usage: usage(49), contextWindow: 100 });
    assert.ok(!html.includes("opacity"));
  });
});
