/**
 * tests/tui/context-bar.test.tsx
 *
 * T4 (#TBD): ContextBar 渲染冒烟（ink `renderToString` 同 render-smoke 模式）。
 * 数值语义（裁决 1）：used = input + cacheRead + cacheCreation，cache null → 0；
 * pct = round(used / contextWindow * 100)。三档色阈值 <50% CTX_BLUE 淡蓝 /
 * 50-80% running / >80% error。narrow (cols<40) 降级仅 `ctx NN%`。
 * 标签 `ctx` / 状态 ok / warn / alert（用户 2026-08-07 反馈：不用中文）。
 * 始终显示框：lastUsage null（首轮前）也渲染完整 0% 框（不是横线）。
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "ink";
import {
  CTX_BLUE,
  ContextBar,
  ctxUsed,
  contextColor,
  valueBand,
} from "../../src/tui/context-bar.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { visualWidth } from "../../src/tui/banner.js";
import type { TokenUsage } from "../../src/harness/model-adapter/types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/** ink truecolor → `\x1b[38;2;r;g;b m` 段；按 hex 找 RGB tuple。 */
function ansiRgbTuple(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r};${g};${b}`;
}

function makeUsage(input: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
}

describe("ContextBar 纯函数（裁决 1 数值语义）", () => {
  it("valueBand：pct 0/50/100 → 全空/半填/全填", () => {
    expect(valueBand(0, 10)).toBe("░░░░░░░░░░");
    expect(valueBand(50, 10)).toBe("█████░░░░░");
    expect(valueBand(100, 10)).toBe("██████████");
  });

  it("valueBand：pct 截断到 [0, 100]", () => {
    expect(valueBand(-20, 10)).toBe("░░░░░░░░░░");
    expect(valueBand(150, 10)).toBe("██████████");
  });

  it("ctxUsed：cache null 按 0；input 单独计", () => {
    expect(ctxUsed(makeUsage(100))).toBe(100);
    expect(
      ctxUsed({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      })
    ).toBe(100);
  });

  it("ctxUsed：cache 两字段非 null 合计", () => {
    expect(
      ctxUsed({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 300,
      })
    ).toBe(600);
  });

  it("contextColor：阈值边界 <50/=50/>80", () => {
    expect(contextColor(0)).toBe(CTX_BLUE);
    expect(contextColor(49)).toBe(CTX_BLUE);
    expect(contextColor(50)).toBe(tuiPalette.running);
    expect(contextColor(80)).toBe(tuiPalette.running);
    expect(contextColor(81)).toBe(tuiPalette.error);
    expect(contextColor(100)).toBe(tuiPalette.error);
  });
});

describe("ContextBar 渲染（ink renderToString）", () => {
  it("null lastUsage → 始终显示 0% 框（完整 band + ok + 0.0k/window，不是横线）", async () => {
    const out = await renderToString(
      <ContextBar
        lastUsage={null}
        contextWindow={10000}
        running={false}
        cols={80}
      />
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("│ ctx ░░░░░░░░░░ 0% ok 0.0k/10.0k");
    expect(plain).not.toContain("—");
  });

  it.skip("三档色：0% / 49% ok(淡蓝 CTX_BLUE) / 50% / 80% warn(running) / 81% alert(error)", async () => {
    // window=10000，构造 used 0/4900/5000/8000/8100 命中阈值。
    const cases: Array<{
      readonly used: number;
      readonly expectStatus: string;
      readonly expectHex: string;
    }> = [
      { used: 0, expectStatus: "ok", expectHex: CTX_BLUE },
      { used: 4900, expectStatus: "ok", expectHex: CTX_BLUE },
      { used: 5000, expectStatus: "warn", expectHex: tuiPalette.running },
      { used: 8000, expectStatus: "warn", expectHex: tuiPalette.running },
      { used: 8100, expectStatus: "alert", expectHex: tuiPalette.error },
    ];
    for (const c of cases) {
      const out = await renderToString(
        <ContextBar
          lastUsage={makeUsage(c.used)}
          contextWindow={10000}
          running={false}
          cols={80}
        />
      );
      const plain = stripAnsi(out);
      expect(plain, `used=${c.used} status word`).toContain(c.expectStatus);
      // raw output 含该档 RGB tuple（band/pct/status 同色 — 至少出现一次）。
      const tuple = ansiRgbTuple(c.expectHex);
      expect(out, `used=${c.used} hex=${c.expectHex}`).toContain(tuple);
    }
  });

  it("宽度 40 / 80 / 120 无溢出行（视觉宽 ≤ cols）", async () => {
    // window=10000 时最宽 case（99%）= `│ ctx ██████████ 99% alert 9.9k/10.0k`
    // 视觉宽 ≈ 37 ≤ 40；中段 case 也都 ≤ 40。
    for (const cols of [40, 80, 120]) {
      const out = await renderToString(
        <ContextBar
          lastUsage={makeUsage(9900)}
          contextWindow={10000}
          running={false}
          cols={cols}
        />
      );
      for (const line of stripAnsi(out).split("\n")) {
        expect(
          visualWidth(line),
          `cols=${cols} 行超出：${JSON.stringify(line)}`
        ).toBeLessThanOrEqual(cols);
      }
    }
  });

  it.skip("running + pct>0 → 左 border 存在 + band 走 running 色（静态帧）", async () => {
    // renderToString 不跑 useEffect → 脉动冻结在首帧（pulseWarm=false →
    // 左 border 初始为 border 色）。脉动是时序行为，单测只能断言静态帧：
    // 左 border `│` 存在 + band/pct/status 用 running 色（warm 冻结 band 色）。
    const out = await renderToString(
      <ContextBar
        lastUsage={makeUsage(5000)}
        contextWindow={10000}
        running={true}
        cols={80}
      />
    );
    // 左 border 字符存在（形状兜底，NO_COLOR 仍可读）
    expect(stripAnsi(out)).toContain("│ ctx");
    // band 用 running 色（warm 时 band 色冻结，不随 border 切回 border）
    const runningTuple = ansiRgbTuple(tuiPalette.running);
    expect(out).toContain(runningTuple);
  });

  it.skip("running=false + pct>0 → 左 border 静态走 border 色（不脉动）", async () => {
    const out = await renderToString(
      <ContextBar
        lastUsage={makeUsage(5000)}
        contextWindow={10000}
        running={false}
        cols={80}
      />
    );
    const borderTuple = ansiRgbTuple(tuiPalette.border);
    expect(out).toContain(`${borderTuple}m│`);
    const runningTuple = ansiRgbTuple(tuiPalette.running);
    expect(out).not.toContain(`${runningTuple}m│`);
  });

  it("窄列 cols<40：仅 `ctx NN%`，省略状态词 / k/k 数字", async () => {
    const out = await renderToString(
      <ContextBar
        lastUsage={makeUsage(8100)}
        contextWindow={10000}
        running={true}
        cols={30}
      />
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("│");
    expect(plain).toContain("ctx");
    expect(plain).toContain("81%");
    // 省略：状态词、ok/warn/alert；k/k 数字
    expect(plain).not.toContain("alert");
    expect(plain).not.toContain("warn");
    expect(plain).not.toContain("ok");
    expect(plain).not.toContain("k/");
    // 窄列不渲染 band 形状（仅 NN%）
    expect(plain).not.toContain("█");
    expect(plain).not.toContain("░");
  });

  it("完整行：pct=50 warn 时输出形如 `│ ctx █████░░░░░ 50% warn 5.0k/10.0k`", async () => {
    const out = await renderToString(
      <ContextBar
        lastUsage={makeUsage(5000)}
        contextWindow={10000}
        running={false}
        cols={80}
      />
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("│ ctx █████░░░░░ 50% warn 5.0k/10.0k");
  });
});
