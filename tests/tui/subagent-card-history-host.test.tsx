/** @jsxImportSource @opentui/react */
/**
 * tests/tui/subagent-card-history-host.test.tsx
 *
 * specs/tui-subagent-transcript-live.md 锁句 1/2/5/6 的**历史卡宿主**接线回归：
 * `subagentCards` 这条链（`subagentCardLinesMap` → `ChatView` memo →
 * `MessageRow` → `MessageBlocks.renderToolUseBlock`）此前只被投影单测覆盖 ——
 * 把 prop 从任一跳删掉，所有测试仍然全绿。本文件钉住「链真的接通且宿主真的
 * 按它分流」：命中卡 → 两行；未命中 / failed → 与改前逐字节一致。
 *
 * 为什么必须是渲染级断言：live tail 宿主与历史宿主共用 `SubagentCardView`，
 * 但**分流点各不相同**（`liveToolPreviewBox` 按 `run.status` 分，
 * `MessageBlocks` 按 `statusMap` 分）。只测投影函数不会发现任一分流点被
 * 短路（如 card 早退落在 `resolveToolUseView` 的 null 之后）。
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

/** 历史 turn 里那次 `spawn_subagent` 调用（卡宿主认的是 tool_use block id）。 */
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
    // 单行标题形态（dotless `explore running`）不得同时出现 —— dual render
    // 是两个宿主共用的失败模式。
    expect(lines.some((l) => l === "explore running")).toBe(false);
    const detailFg = spanFg(setup, "查找文档");
    expect(detailFg).toBeDefined();
    expect(rgbaEq(detailFg!, RGBA.fromHex(tuiPalette.dim))).toBe(true);
    await setup.renderer.destroy();
  });

  test("命中 completed 卡 → 第 2 行绿 `done`（锁句 2：turn 落定后仍在卡上）", async () => {
    const cards = new Map<string, SubagentCardLines>([
      [
        SPAWN_ID,
        { roleLine: "explore running...", detailLine: "done", done: true },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    expect(lines).toContain("explore running...");
    expect(lines).toContain("done");
    const doneFg = spanFg(setup, "done");
    expect(doneFg).toBeDefined();
    expect(rgbaEq(doneFg!, RGBA.fromHex(tuiPalette.add))).toBe(true);
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
    // 落定态（turn 已结束）的既有形态 = `formatToolStatusLine` 的 subagent
    // 分支 → 落定摘要 `explore`（detail-only，无 `running`、无三点）。
    expect(lines).toContain("explore");
    expect(lines.some((l) => l.includes("running"))).toBe(false);
    await setup.renderer.destroy();
  });

  test("未落定（statusMap 无该 id）→ 既有 live 单行 `explore running`", async () => {
    // 改前形态的 live 分支：detail-only `{role} running`（无三点）。三点是
    // 卡级投影独有的形态，故它同时是「卡没被消费」的判据。
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
        { roleLine: "explore running...", detailLine: "done", done: true },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, true]]));
    const lines = frameLines(setup);
    // 失败横切优先：两行形态（身份行 + 绿 done）整体让位给既有失败形态
    // `explore`（error 色，detail-only）。子代理工具的成功与失败都走
    // detail-only，`[失败]` 前缀只属于普通工具 —— 故断「两行不在 + 颜色
    // 不是绿」而非断某个失败字面。
    expect(lines.some((l) => l.includes("running..."))).toBe(false);
    expect(lines).not.toContain("done");
    const fg = spanFg(setup, "explore");
    expect(fg).toBeDefined();
    expect(rgbaEq(fg!, RGBA.fromHex(tuiPalette.add))).toBe(false);
    await setup.renderer.destroy();
  });
});

describe("MessageBlocks 历史卡宿主 — 空预览不塌陷", () => {
  test("detailLine 空串 → 仍占两行（role 行 + 占位行），块不压成一行", async () => {
    // 这是「两行」的最弱形态：空 taskPreview 时若渲染层把空串直接交给
    // <text>，Yoga 会把该行收成 0 高 → 卡塌成一行（与 prompt 侧旧 strip
    // 的压行指纹同型）。`SubagentCardView` 用单空格占位防这一手。
    const cards = new Map<string, SubagentCardLines>([
      [
        SPAWN_ID,
        { roleLine: "explore running...", detailLine: "", done: false },
      ],
    ]);
    const setup = await renderWithCards(cards, new Map([[SPAWN_ID, false]]));
    const lines = frameLines(setup);
    expect(lines).toContain("explore running...");
    // 占位行在身份行正下方仍占一行（charFrame 里为空白，故按 spans 行序断）。
    const spansLines = setup.captureSpans().lines;
    const roleIdx = spansLines.findIndex((l) =>
      l.spans.some((s) => s.text.includes("explore running..."))
    );
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(spansLines.length).toBeGreaterThanOrEqual(roleIdx + 2);
    await setup.renderer.destroy();
  });
});
