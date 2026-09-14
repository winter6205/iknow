/**
 * tests/tui/running-unit-fold.test.ts
 *
 * 不变式:折叠按**已完成单元**收,不等整 turn idle。
 *
 *  - thinkingMs > 0 时,即使 running 也应冻结出「思考了 N 秒」行
 *    （plan/plans/tui-chrome-interaction.md T1 — live thinking 结束立即变
 *    结束态行,不等整 turn 收尾）;
 *  - 已完成 retract 工具的计数行同样不受 running 闸门影响 —— retract
 *    一旦落定就归入折叠（不能从 live tail 消失后无处安放）;
 *  - tail 折叠不再有 turn 级闸门（plans/tui-live-activity-fold.md T3 删除
 *    `shouldCollapseTurnToolRows` / `shouldShowTurnActivityFold`）—— 落点
 *    由 per-segment fold 行与 **live activity group** 承担。
 *
 * 5 类边界:empty / negative / overflow / concurrent / exception。SSOT:
 * src/tui/turn-activity.ts 的 `shouldShowThinkingFold` / `shouldShowRetractFold`
 * 两个 per-segment 纯函数（turn 级闸门已删,导出面测试见文末）。
 */
import { describe, expect, test } from "bun:test";
import {
  shouldShowRetractFold,
  shouldShowThinkingFold,
} from "../../src/tui/turn-activity.js";
import * as turnActivityModule from "../../src/tui/turn-activity.js";

describe("shouldShowThinkingFold（思考秒数折叠行）", () => {
  test("empty:thinkingMs=0 / 无 → false（无秒数就不画）", () => {
    expect(
      shouldShowThinkingFold({ running: false, hasThinkingMs: false })
    ).toBe(false);
    expect(
      shouldShowThinkingFold({ running: true, hasThinkingMs: false })
    ).toBe(false);
  });

  test("negative:running=true + thinkingMs>0 → 仍为 true（frozen 数据胜出）", () => {
    // 不变式 = thinkingMs 已 frozen 到盘上,running 不再阻止「思考了 N 秒」渲染。
    expect(shouldShowThinkingFold({ running: true, hasThinkingMs: true })).toBe(
      true
    );
  });

  test("overflow:大值 / 极端值仍按 boolean 决策（与值大小无关）", () => {
    expect(
      shouldShowThinkingFold({ running: false, hasThinkingMs: true })
    ).toBe(true);
  });

  test("concurrent:同输入多次调用结果一致（纯函数稳定）", () => {
    const a = shouldShowThinkingFold({ running: true, hasThinkingMs: true });
    const b = shouldShowThinkingFold({ running: true, hasThinkingMs: true });
    expect(a).toBe(b);
  });

  test("exception:idle + thinkingMs>0 → true（向后兼容 idle 路径）", () => {
    expect(
      shouldShowThinkingFold({ running: false, hasThinkingMs: true })
    ).toBe(true);
  });
});

describe("shouldShowRetractFold（retract 计数行）", () => {
  test("empty:无 retract → false（不画空计数行）", () => {
    expect(
      shouldShowRetractFold({ running: false, segmentRetractTotal: 0 })
    ).toBe(false);
    expect(
      shouldShowRetractFold({ running: true, segmentRetractTotal: 0 })
    ).toBe(false);
  });

  test("negative:负数 retract 视为 0 → false（防御）", () => {
    expect(
      shouldShowRetractFold({ running: true, segmentRetractTotal: -1 })
    ).toBe(false);
  });

  test("overflow:多 retract → true,running 不阻止", () => {
    expect(
      shouldShowRetractFold({ running: true, segmentRetractTotal: 12 })
    ).toBe(true);
  });

  test("concurrent:同输入多次稳定", () => {
    const a = shouldShowRetractFold({ running: true, segmentRetractTotal: 3 });
    const b = shouldShowRetractFold({ running: true, segmentRetractTotal: 3 });
    expect(a).toBe(b);
  });

  test("exception:running + 有 retract → true（plan T1:retract 收成计数行,不从 live 消失）", () => {
    // 不变式 = retract 完成即入折叠,与 turn 是否 running 解耦。
    expect(
      shouldShowRetractFold({ running: true, segmentRetractTotal: 1 })
    ).toBe(true);
  });
});

describe("shouldCollapseTurnToolRows / shouldShowTurnActivityFold（T3 已删除）", () => {
  test("两个 turn 级折叠闸不再导出（被 open-unit 派生取代）", () => {
    // plans/tui-live-activity-fold.md T3：删除把 `foldDisplayLines.length`
    // 当 collapse 信号、删除整轮 `currentTurnHasFold` 关 panel。这两个
    // 函数是那条整轮派生链的入口 —— 留着就会有人再接回去。
    // 判定对象 = 模块导出面（编译期合同），不是运行时行为。
    const exports = Object.keys(turnActivityModule);
    expect(exports).not.toContain("shouldCollapseTurnToolRows");
    expect(exports).not.toContain("shouldShowTurnActivityFold");
  });
});
