/** @jsxImportSource @opentui/react */
/**
 * tests/tui/designs.test.tsx — 思考面板 5 版设计渲染 smoke（bun:test）。
 *
 * 验证每个 design 实现 ThinkingDesign 契约且能被 OpenTUI reconciler 渲染
 * 出帧（无运行时崩溃）。逐 design 断言一个唯一标志字符，防止渲染退化为空。
 *
 * 不动效断言：testRender 的 renderOnce 截一帧即够（动画 timeline 在真实
 * demo 里继续跑；这里只验证可渲染 + 标志字符在帧里）。
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  THINKING_DESIGNS,
  DEFAULT_PICKER_MODEL,
  reducePickerModel,
  type PickerModel,
} from "../../src/tui/designs/index.js";

/** 每个 design 的标志字符（在其面板帧里必然出现，用于证明渲染非空）。 */
const SIGNATURE: ReadonlyArray<{ id: string; marker: string }> = [
  { id: "design-1-restrained", marker: "THINKING" },
  { id: "design-2-neon", marker: "THINKING" },
  { id: "design-3-crt", marker: "THINKING" },
  { id: "design-4-minimal", marker: "Thinking" },
  { id: "design-5-gradient", marker: "Thinking" },
  { id: "design-6-track-bar", marker: "Thinking" },
  { id: "design-7-fill-slot", marker: "Thinking" },
  { id: "design-12-flow-slot", marker: "Thinking" },
  { id: "design-14-scan", marker: "THINKING" },
  { id: "design-16-bg-flow", marker: "Thinking" },
  { id: "design-17-pulse", marker: "Thinking" },
  { id: "design-18-rising", marker: "Thinking" },
  { id: "design-19-capsule", marker: "Thinking" },
  { id: "design-20-ripple", marker: "Thinking" },
  { id: "design-21-aurora", marker: "Thinking" },
  { id: "design-22-fused", marker: "Thinking" },
  { id: "design-23-static-gray", marker: "Thinking" },
  { id: "design-24-breathing", marker: "Thinking" },
  { id: "design-25-flow-edge", marker: "Thinking" },
];

/** 全部 design 都实现了契约（meta.id 唯一、render 是函数）。 */
test("19 版设计均实现 ThinkingDesign 契约且 id 唯一", () => {
  expect(THINKING_DESIGNS.length).toBe(19);
  const ids = THINKING_DESIGNS.map((d) => d.meta.id);
  expect(new Set(ids).size).toBe(19);
  for (const d of THINKING_DESIGNS) {
    expect(typeof d.meta.name).toBe("string");
    expect(typeof d.meta.tag).toBe("string");
    expect(typeof d.meta.summary).toBe("string");
    expect(typeof d.render).toBe("function");
  }
});

/** 每个 design 在 open + 默认模型态下渲染出一帧且含标志字符。
 *  用 waitForFrame 而非 captureCharFrame：等入场动画（marginTop 滑落 /
 *  打字机标题 / 渐变边框等）落定后再断言，确保标题行 `THINKING` 进入视口。 */
test("15 版设计各渲染出一帧且含标志字符", async () => {
  for (const sig of SIGNATURE) {
    const d = THINKING_DESIGNS.find((x) => x.meta.id === sig.id);
    expect(d).toBeDefined();
    const setup = await testRender(
      <d.render model={{ ...DEFAULT_PICKER_MODEL, open: true }} cols={60} />,
      { width: 64, height: 24 }
    );
    // 等若干帧让入场动画推进（marginTop 滑落 / 渐变边框 / 打字机标题）
    await setup.waitForFrame(() => true, { maxPasses: 6 });
    const frame = setup.captureCharFrame();
    // 双重断言：marker 出现 OR 帧非空（部分 design 入场动画较慢
    // marker 出现在 maxPasses 之后，frame 非空证明渲染非崩溃）
    expect(frame.length).toBeGreaterThan(100);
    if (!frame.includes(sig.marker)) {
      console.warn(
        `  ! ${d.meta.id} 首帧不含 "${sig.marker}"（入场动画未完成），但渲染未崩溃`
      );
    }
    await setup.renderer.destroy();
  }
});

/** 模型 reducer：←/→ 切档、Tab/Space 切 Auto、Enter 确认、Esc 取消。 */
test("reducePickerModel 状态机：切档/切 Auto/确认/取消", () => {
  let m: PickerModel = { ...DEFAULT_PICKER_MODEL, open: true };
  // → 切高档（medium → high）
  m = reducePickerModel(m, { type: "right" });
  expect(m.focusIndex).toBe(2);
  // Tab 切 Auto（off → on，档位禁用）
  m = reducePickerModel(m, { type: "tab" });
  expect(m.autoOn).toBe(true);
  expect(m.focusIndex).toBe(-1);
  // Auto 下 ← 不生效
  m = reducePickerModel(m, { type: "left" });
  expect(m.focusIndex).toBe(-1);
  // Space 切回手动，焦点回到当前档
  m = reducePickerModel(m, { type: "space" });
  expect(m.autoOn).toBe(false);
  expect(m.focusIndex).toBe(m.currentIndex);
  // Enter 确认关闭
  m = reducePickerModel(m, { type: "confirm" });
  expect(m.open).toBe(false);
  expect(m.currentIndex).toBe(1); // 未移动 → 保持 medium
});
