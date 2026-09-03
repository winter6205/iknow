// @vitest-environment happy-dom
/**
 * tests/web/thinking-block-seconds.test.tsx
 *
 * D2 (tui-display-consistency) wire surface — ThinkingBlock 渲染落盘
 * 秒数 (spec SC8 / D6):
 *
 *  - `thinkingMs > 0` → meta 行末尾挂「 · 思考了 N 秒」(Math.ceil(ms/1000),
 *    与 src/tui/think-fold.ts formatThinkingFold / turn-activity.ts
 *    thinkingMsToSeconds 同 posture);
 *  - `thinkingMs` 缺席 (旧会话 / Postel) → 只显示条目计数 + 已加密计数,
 *    与 spec SC8 「旧数据只显示工具计数」一致 (web 侧 thinking 块挂条
 *    目计数;工具计数在 toolCalls 区;此处 thinking 块按现有 meta 形态渲染);
 *  - AgentCard 把 `answer.thinkingMs` 透传到 ThinkingBlock;
 *  - 250ms 边界 → 1 秒 (与 TUI 同 posture)。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingBlock } from "../../web/src/components/ThinkingBlock.tsx";
import { AgentCard } from "../../web/src/components/AgentCard.tsx";
import type { ThinkingView, TurnAnswerDto } from "../../web/src/api/types.ts";

const thinking: ThinkingView = {
  entries: [{ text: "first" }, { text: "second" }],
  redactedCount: 0,
};

function answer(overrides: Partial<TurnAnswerDto> = {}): TurnAnswerDto {
  return {
    finalText: "ignored body",
    stopReason: "completed",
    turnCount: 1,
    ...overrides,
  };
}

describe("ThinkingBlock — D2 wire surface 落盘秒数 (SC8)", () => {
  it("thinkingMs=1500 → 「 · 思考了 2 秒」 出现在 meta 行", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={1500} />
    );
    assert.ok(html.includes("思考了 2 秒"), "must show '思考了 2 秒'");
  });

  it("thinkingMs=250 → 「思考了 1 秒」(Math.ceil, 与 TUI 同 posture)", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={250} />
    );
    assert.ok(html.includes("思考了 1 秒"));
  });

  it("thinkingMs=999 → 「思考了 1 秒」 (999 < 1000, ceil)", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={999} />
    );
    assert.ok(html.includes("思考了 1 秒"));
  });

  it("thinkingMs=1000 → 「思考了 1 秒」 (整秒不上溢)", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={1000} />
    );
    assert.ok(html.includes("思考了 1 秒"));
  });

  it("thinkingMs=1001 → 「思考了 2 秒」 (整秒上溢 ceil)", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={1001} />
    );
    assert.ok(html.includes("思考了 2 秒"));
  });

  it("thinkingMs=0 → 不挂「思考了 N 秒」(与 TUI 同 posture)", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={0} />
    );
    assert.equal(/思考了\s+\d+\s*秒/.test(html), false);
    // meta 行只显示条目数
    assert.ok(html.includes("2"));
  });

  it("thinkingMs 缺席 (旧会话 / Postel) → 只显示条目计数,无「思考了 N 秒」", () => {
    const html = renderToStaticMarkup(<ThinkingBlock thinking={thinking} />);
    assert.equal(/思考了\s+\d+\s*秒/.test(html), false);
    // meta 行仍存在,显示条目数
    assert.ok(html.includes("2"));
  });

  it("thinkingMs=-100 → 当 0 处理 (防御, 不挂「思考了 -X 秒」)", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={-100} />
    );
    assert.equal(/思考了/.test(html), false);
  });

  it("thinkingMs=NaN → 当 0 处理 (防御, 不挂「思考了 NaN 秒」)", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock thinking={thinking} thinkingMs={NaN} />
    );
    assert.equal(/思考了/.test(html), false);
  });

  it("meta 顺序: 条目数 + 已加密 ×N + 思考了 N 秒", () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock
        thinking={{ entries: [{ text: "x" }], redactedCount: 2 }}
        thinkingMs={3500}
      />
    );
    const idxEntries = html.indexOf("1");
    const idxRedacted = html.indexOf("已加密 ×2");
    const idxSeconds = html.indexOf("思考了 4 秒");
    assert.ok(idxEntries >= 0);
    assert.ok(idxRedacted > idxEntries, "redacted count after entries");
    assert.ok(idxSeconds > idxRedacted, "seconds after redacted count");
  });
});

describe("AgentCard — answer.thinkingMs 透传到 ThinkingBlock (SC8)", () => {
  function render(turnAnswer: TurnAnswerDto): string {
    return renderToStaticMarkup(
      <AgentCard text="legacy body" answer={turnAnswer} />
    );
  }

  it("answer.thinkingMs=2000 → 「思考了 2 秒」 渲染", () => {
    const html = render(
      answer({
        thinking,
        thinkingMs: 2000,
      })
    );
    assert.ok(html.includes("思考了 2 秒"));
  });

  it("answer.thinkingMs undefined (旧会话 Postel) → 不渲染「思考了 N 秒」", () => {
    const html = render(answer({ thinking }));
    assert.equal(/思考了\s+\d+\s*秒/.test(html), false);
  });

  it("answer.thinkingMs=0 → 不渲染「思考了 N 秒」", () => {
    const html = render(answer({ thinking, thinkingMs: 0 }));
    assert.equal(/思考了\s+\d+\s*秒/.test(html), false);
  });
});
