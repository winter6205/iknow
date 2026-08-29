import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentCard } from "../../web/src/components/AgentCard.tsx";
import type { ActivityItem, ToolCallView, TurnAnswerDto } from "../../web/src/api/types.ts";

const tool: ToolCallView = {
  id: "t1",
  name: "bash",
  inputPreview: "{}",
  outputPreview: "ok",
  isError: false,
  truncated: false,
};

function answer(overrides: Partial<TurnAnswerDto> = {}): TurnAnswerDto {
  return {
    finalText: "",
    stopReason: "completed",
    turnCount: 1,
    ...overrides,
  };
}

function render(activity: readonly ActivityItem[]): string {
  return renderToStaticMarkup(
    <AgentCard
      text="ignored legacy body"
      answer={answer({
        activity,
      })}
    />
  );
}

describe("AgentCard — ordered activity", () => {
  it("renders a tool fold after preceding activity text", () => {
    const html = render([
      { type: "text", text: "before text" },
      { type: "tool", tool },
      { type: "text", text: "after text" },
    ]);
    assert.ok(html.indexOf("before text") < html.indexOf("bash"));
    assert.ok(html.indexOf("bash") < html.indexOf("after text"));
  });

  it("renders a tool fold before following activity text", () => {
    const html = render([
      { type: "tool", tool },
      { type: "text", text: "following text" },
    ]);
    assert.ok(html.indexOf("bash") < html.indexOf("following text"));
  });

  it("uses the legacy thinking → body → tools layout when activity is absent or empty", () => {
    const legacy = answer({
      finalText: "legacy body",
      thinking: { entries: [{ text: "legacy thinking" }], redactedCount: 0 },
      toolCalls: [tool],
    });
    for (const activity of [undefined, []] as const) {
      const html = renderToStaticMarkup(
        <AgentCard text="legacy body" answer={{ ...legacy, activity }} />
      );
      assert.ok(html.indexOf("legacy thinking") < html.indexOf("legacy body"));
      assert.ok(html.indexOf("legacy body") < html.indexOf("bash"));
    }
  });
});
