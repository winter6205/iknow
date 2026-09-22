/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-card-history-host.test.tsx
 *
 * Regression wiring for specs/subagent-card-title.md SC2/SC3/SC5/SC7 on the
 * **history-card host**: the `subagentCards` chain
 * (`subagentCardLinesMap` → `ChatView` memo → `MessageRow` →
 * `MessageBlocks.renderToolUseBlock`) was previously covered only by
 * projection unit tests — deleting the prop at any hop kept every test green.
 * This file pins "the chain is actually wired and the host really branches on
 * it": matched card → two lines (title + activity slot); unmatched / failed →
 * byte-identical to pre-change.
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
        input: { task: "查一下", subagent_type: "explore", title: "整理报告" },
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

describe("MessageBlocks 历史卡宿主 — subagentCards 链接通（SC2/SC3）", () => {
  test("命中 live 卡 → 两行：title + dim 在飞工具名，不画单行标题", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [SPAWN_ID, { titleLine: "整理报告", detailLine: "Bash", done: false }],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    expect(lines).toContain("整理报告");
    expect(lines).toContain("Bash");
    expect(lines.indexOf("Bash")).toBe(lines.indexOf("整理报告") + 1);
    // The single-line title form (dotless `explore running`) must not appear
    // alongside — dual render is the failure mode shared by both hosts.
    expect(lines.some((l) => l === "explore running")).toBe(false);
    const detailFg = spanFg(setup, "Bash");
    expect(detailFg).toBeDefined();
    expect(rgbaEq(detailFg!, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    const titleFg = spanFg(setup, "整理报告");
    expect(titleFg).toBeDefined();
    expect(rgbaEq(titleFg!, RGBA.fromHex(tuiPalette.dim))).toBe(false);
    await setup.renderer.destroy();
  });

  test("命中 completed 卡 → title 留下 + 其下绿 `✓ Done`（SC3：turn 落定后 title 不变）", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [SPAWN_ID, { titleLine: "整理报告", detailLine: "✓ Done", done: true }],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    // The title being pushed out by the completion marker is what triggered
    // the original reopen — both lines must be present and in order.
    expect(lines).toContain("整理报告");
    expect(lines).toContain("✓ Done");
    expect(lines.indexOf("✓ Done")).toBe(lines.indexOf("整理报告") + 1);
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    const doneFg = spanFg(setup, "✓ Done");
    expect(doneFg).toBeDefined();
    expect(rgbaEq(doneFg!, RGBA.fromHex(tuiPalette.add))).toBe(true);
    // Green belongs only to the completion marker: the title keeps its color.
    const titleFg = spanFg(setup, "整理报告");
    expect(titleFg).toBeDefined();
    expect(rgbaEq(titleFg!, RGBA.fromHex(tuiPalette.add))).toBe(false);
    await setup.renderer.destroy();
  });
});

/** The same spawn call as the parent recorded it, minus the operator title. */
function unlabelledSpawnMessage(): AnthropicNativeMessage {
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

async function renderHost(
  message: AnthropicNativeMessage,
  cards: ReadonlyMap<string, SubagentCardLines> | undefined,
  statusMap: ReadonlyMap<string, boolean> = new Map()
): Promise<Awaited<ReturnType<typeof testRender>>> {
  const setup = await testRender(
    <MessageBlocks
      message={message}
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

describe("MessageBlocks 历史卡宿主 — 重载会话没有 live 列表", () => {
  test("已落定的 spawn + 空 map → 两行卡吃 block 自己 input 的 title", async () => {
    // The list died with the previous process, but `title` is durable in the
    // transcript: the card keeps its title line instead of decaying into the
    // generic tool row (which would drop the operator's label entirely).
    const setup = await renderHost(
      spawnMessage(),
      new Map(),
      new Map([[SPAWN_ID, false]])
    );
    const lines = frameLines(setup);
    expect(lines).toContain("整理报告");
    expect(lines.some((l) => l === "explore")).toBe(false);
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    await setup.renderer.destroy();
  });

  test("该卡没有 title → 第 1 行走 catalog 角色，仍是两行卡", async () => {
    const setup = await renderHost(
      unlabelledSpawnMessage(),
      undefined,
      new Map([[SPAWN_ID, false]])
    );
    const lines = frameLines(setup);
    expect(lines).toContain("explore");
    // A settled spawn never claims completion it cannot support: the slot is
    // the placeholder row, and no green marker is painted.
    expect(lines.some((l) => l.includes("✓ Done"))).toBe(false);
    const spansLines = setup.captureSpans().lines;
    const titleIdx = spansLines.findIndex((l) =>
      l.spans.some((s) => s.text.includes("explore"))
    );
    expect(spansLines.length).toBeGreaterThanOrEqual(titleIdx + 2);
    await setup.renderer.destroy();
  });

  test("failed（无 map）→ failure overlay 依旧优先，不画 fallback 卡", async () => {
    const setup = await renderHost(
      spawnMessage(),
      undefined,
      new Map([[SPAWN_ID, true]])
    );
    const lines = frameLines(setup);
    expect(lines).not.toContain("整理报告");
    expect(lines).not.toContain("✓ Done");
    await setup.renderer.destroy();
  });
});

describe("MessageBlocks 历史卡宿主 — 回落面（SC5 / join 契约）", () => {
  test("未落定（statusMap 无该 id）→ 既有 live 单行 `explore running`", async () => {
    // Pre-change live branch: detail-only `{role} running` (no ellipsis). The
    // card title is the tell that "the card was consumed"; it must not appear
    // on the fallback path — an unsettled spawn belongs to the live host.
    const setup = await renderHost(spawnMessage(), undefined, new Map());
    const lines = frameLines(setup);
    expect(lines.some((l) => l.includes("explore running"))).toBe(true);
    expect(lines.some((l) => l.includes("整理报告"))).toBe(false);
    await setup.renderer.destroy();
  });

  test("map 在场但不含该卡 id → 不借别人的标题 / 工具名", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [
        "toolu_someone_else",
        { titleLine: "别人的标题", detailLine: "Bash", done: false },
      ],
    ]);
    const setup = await renderHost(
      spawnMessage(),
      cards,
      new Map([[SPAWN_ID, false]])
    );
    const lines = frameLines(setup);
    expect(lines.some((l) => l.includes("别人的标题"))).toBe(false);
    expect(lines.some((l) => l.includes("Bash"))).toBe(false);
    // Its own card comes from its own input, never from the missing entry.
    expect(lines).toContain("整理报告");
    await setup.renderer.destroy();
  });

  test("failed 卡不吃 card 投影：既有 failure overlay 优先（SC5 的宿主分流）", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [SPAWN_ID, { titleLine: "整理报告", detailLine: "✓ Done", done: true }],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, true]]));
    const lines = frameLines(setup);
    // Failure overlay takes precedence: the card form (title + green `✓ Done`)
    // yields entirely to the existing failure form `explore` (error color,
    // detail-only). Both success and failure of subagent tools render
    // detail-only; the `[失败]` ("failed") prefix belongs only to ordinary
    // tools — so assert "title and completion marker absent + color is not
    // green" rather than some failure literal.
    expect(lines).not.toContain("✓ Done");
    expect(lines).not.toContain("整理报告");
    const fg = spanFg(setup, "explore");
    expect(fg).toBeDefined();
    expect(rgbaEq(fg!, RGBA.fromHex(tuiPalette.add))).toBe(false);
    await setup.renderer.destroy();
  });
});

describe("MessageBlocks 历史卡宿主 — 空活动槽不塌陷", () => {
  test("detailLine 空串 → 仍占两行（title 行 + 占位行），块不压成一行", async () => {
    // Weakest form of "two lines": with an empty activity slot, handing the
    // empty string straight to <text> lets Yoga collapse the line to 0 height
    // → card squashes to one line (same fingerprint as the old prompt-side
    // strip). `SubagentCardView` guards against this with a space placeholder.
    const cards = new Map<string, SubagentCardLines>([
      [SPAWN_ID, { titleLine: "整理报告", detailLine: "", done: false }],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    expect(lines).toContain("整理报告");
    // The placeholder line still occupies a row right below the title line
    // (blank in charFrame, hence asserting via spans line order).
    const spansLines = setup.captureSpans().lines;
    const titleIdx = spansLines.findIndex((l) =>
      l.spans.some((s) => s.text.includes("整理报告"))
    );
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(spansLines.length).toBeGreaterThanOrEqual(titleIdx + 2);
    await setup.renderer.destroy();
  });
});
