/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-card-history-host.test.tsx
 *
 * Regression wiring for lock clauses 1/2/5/6 of
 * specs/tui-subagent-transcript-live.md on the **history-card host**: the
 * `subagentCards` chain (`subagentCardLinesMap` → `ChatView` memo →
 * `MessageRow` → `MessageBlocks.renderToolUseBlock`) was previously covered
 * only by projection unit tests — deleting the prop at any hop kept every
 * test green. This file pins "the chain is actually wired and the host really
 * branches on it": matched card → two lines; unmatched / failed → byte-identical
 * to pre-change.
 *
 * Why render-level assertions are required: the live-tail host and the history
 * host share `SubagentCardView`, but their **branch points differ**
 * (`liveToolPreviewBox` branches on `run.status`; `MessageBlocks` branches on
 * `statusMap`). Testing only projection functions would miss any branch point
 * being short-circuited (e.g. an early card return placed after
 * `resolveToolUseView` returns null).
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { MessageBlocks } from "../../src/tui/message-blocks.js";
import type { SubagentCardLines } from "../../src/tui/subagent-message-lines.js";
import { tuiPalette } from "../../src/tui/theme.js";

const COLS = 60;
const SPAWN_ID = "toolu_history";

/** The `spawn_subagent` call in a history turn (the card host keys on the tool_use block id). */
function spawnMessage(): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: SPAWN_ID,
        name: "spawn_subagent",
        input: { task: "查一下", subagent_type: "explore" },
      },
    ],
  };
}

async function renderWithCards(
  cards: ReadonlyMap<string, SubagentCardLines> | undefined,
  statusMap: ReadonlyMap<string, boolean> = new Map()
): Promise<Awaited<ReturnType<typeof testRender>>> {
  const setup = await testRender(
    <MessageBlocks
      message={spawnMessage()}
      cols={COLS}
      statusMap={statusMap}
      subagentCards={cards}
      thinkingExpanded={false}
    />,
    { width: COLS, height: 20, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  return setup;
}

function frameLines(setup: { captureCharFrame(): string }): string[] {
  return setup
    .captureCharFrame()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function spanFg(
  setup: Awaited<ReturnType<typeof testRender>>,
  text: string
): RGBA | undefined {
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return span.fg;
    }
  }
  return undefined;
}

function rgbaEq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

describe("MessageBlocks 历史卡宿主 — subagentCards 链接通（锁句 1/2）", () => {
  test("命中 live 卡 → 两行：`{role} running...` + dim 预览，不画单行标题", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [
        SPAWN_ID,
        { roleLine: "explore running...", detailLine: "查找文档", done: false },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    expect(lines).toContain("explore running...");
    expect(lines).toContain("查找文档");
    expect(lines.indexOf("查找文档")).toBe(
      lines.indexOf("explore running...") + 1
    );
    // The single-line title form (dotless `explore running`) must not appear
    // alongside — dual render is the failure mode shared by both hosts.
    expect(lines.some((l) => l === "explore running")).toBe(false);
    const detailFg = spanFg(setup, "查找文档");
    expect(detailFg).toBeDefined();
    expect(rgbaEq(detailFg!, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    await setup.renderer.destroy();
  });

  test("命中 completed 卡 → 概述留下 + 其下绿 `✓ Done`（锁句 2 reopen：turn 落定后概述不丢）", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [
        SPAWN_ID,
        {
          roleLine: "explore",
          detailLine: "查找文档",
          doneLine: "✓ Done",
          done: true,
        },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    // The summary being pushed out by the completion marker is what triggered
    // the reopen — both lines must be present and in order.
    expect(lines).toContain("explore");
    expect(lines).toContain("查找文档");
    expect(lines).toContain("✓ Done");
    expect(lines.indexOf("✓ Done")).toBe(lines.indexOf("查找文档") + 1);
    expect(lines.some((l) => l.includes("running..."))).toBe(false);
    const doneFg = spanFg(setup, "✓ Done");
    expect(doneFg).toBeDefined();
    expect(rgbaEq(doneFg!, RGBA.fromHex(tuiPalette.add))).toBe(true);
    // Green belongs only to the completion marker: the summary stays dim.
    const detailFg = spanFg(setup, "查找文档");
    expect(detailFg).toBeDefined();
    expect(rgbaEq(detailFg!, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    await setup.renderer.destroy();
  });
});

describe("MessageBlocks 历史卡宿主 — 回落面（锁句 5/6/7）", () => {
  test("subagentCards 缺省（旧调用）→ 与改前逐字节一致的单行标题", async () => {
    const setup = await renderWithCards(
      undefined,
      new Map([[SPAWN_ID, false]])
    );
    const lines = frameLines(setup);
    // Settled (turn finished) pre-change form = the subagent branch of
    // `formatToolStatusLine` → settled summary `explore` (detail-only, no
    // `running`, no ellipsis).
    expect(lines).toContain("explore");
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    await setup.renderer.destroy();
  });

  test("未落定（statusMap 无该 id）→ 既有 live 单行 `explore running`", async () => {
    // Pre-change live branch: detail-only `{role} running` (no ellipsis). The
    // ellipsis is unique to card-level projection, so it doubles as the tell
    // that "the card was not consumed".
    const setup = await renderWithCards(undefined, new Map());
    const lines = frameLines(setup);
    expect(lines.some((l) => l.includes("explore running"))).toBe(true);
    expect(lines.some((l) => l.includes("running..."))).toBe(false);
    await setup.renderer.destroy();
  });

  test("map 在场但不含该卡 id（未 join）→ 回落单行标题，不借别的卡", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [
        "toolu_someone_else",
        {
          roleLine: "explore running...",
          detailLine: "别人的预览",
          done: false,
        },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    expect(lines.some((l) => l.includes("别人的预览"))).toBe(false);
    expect(lines.some((l) => l.includes("running..."))).toBe(false);
    await setup.renderer.destroy();
  });

  test("failed 卡不吃 card 投影：既有 failure overlay 优先（锁句 5 的宿主分流）", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [
        SPAWN_ID,
        {
          roleLine: "explore",
          detailLine: "查找文档",
          doneLine: "✓ Done",
          done: true,
        },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, true]]));
    const lines = frameLines(setup);
    // Failure overlay takes precedence: the card form (summary + green `✓ Done`)
    // yields entirely to the existing failure form `explore` (error color,
    // detail-only). Both success and failure of subagent tools render
    // detail-only; the `[失败]` ("failed") prefix belongs only to ordinary
    // tools — so assert "summary and completion marker absent + color is not
    // green" rather than some failure literal.
    expect(lines.some((l) => l.includes("running..."))).toBe(false);
    expect(lines).not.toContain("✓ Done");
    expect(lines).not.toContain("查找文档");
    const fg = spanFg(setup, "explore");
    expect(fg).toBeDefined();
    expect(rgbaEq(fg!, RGBA.fromHex(tuiPalette.add))).toBe(false);
    await setup.renderer.destroy();
  });
});

describe("MessageBlocks 历史卡宿主 — 空预览不塌陷", () => {
  test("detailLine 空串 → 仍占两行（role 行 + 占位行），块不压成一行", async () => {
    // Weakest form of "two lines": with an empty taskPreview, handing the empty
    // string straight to <text> lets Yoga collapse the line to 0 height → card
    // squashes to one line (same fingerprint as the old prompt-side strip).
    // `SubagentCardView` guards against this with a single-space placeholder.
    const cards = new Map<string, SubagentCardLines>([
      [
        SPAWN_ID,
        { roleLine: "explore running...", detailLine: "", done: false },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    expect(lines).toContain("explore running...");
    // The placeholder line still occupies a row right below the identity line
    // (blank in charFrame, hence asserting via spans line order).
    const spansLines = setup.captureSpans().lines;
    const roleIdx = spansLines.findIndex((l) =>
      l.spans.some((s) => s.text.includes("explore running..."))
    );
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(spansLines.length).toBeGreaterThanOrEqual(roleIdx + 2);
    await setup.renderer.destroy();
  });
});
