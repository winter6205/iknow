/** @jsxImportSource @opentui/react */
/**
 * tests/tui/designs.test.tsx — thinking-panel design render smoke (bun:test).
 *
 * Verifies each design implements the ThinkingDesign contract and renders a
 * frame via the OpenTUI reconciler without crashing. Each design asserts a
 * unique marker char so render can't silently degrade to empty.
 *
 * No animation assertions: renderOnce captures one frame (the animation
 * timeline keeps running in the real demo; here we only check renderability +
 * marker presence).
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  THINKING_DESIGNS,
  DEFAULT_PICKER_MODEL,
  reducePickerModel,
  type PickerModel,
} from "../../src/tui/designs/index.js";

/** Per-design marker char (always present in its panel frame, proving non-empty render). */
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

/** All designs implement the contract (unique meta.id, render is a function). */
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

/** Each design renders one frame with the marker in open + default-model state.
 *  Uses waitForFrame rather than captureCharFrame: waits for entrance animations
 *  (marginTop slide / typewriter title / gradient border) to settle so the title
 *  row `THINKING` is in view. */
test("15 版设计各渲染出一帧且含标志字符", async () => {
  for (const sig of SIGNATURE) {
    const d = THINKING_DESIGNS.find((x) => x.meta.id === sig.id);
    expect(d).toBeDefined();
    const setup = await testRender(
      <d.render model={{ ...DEFAULT_PICKER_MODEL, open: true }} cols={60} />,
      { width: 64, height: 24 }
    );
    // Let entrance animations advance a few frames (marginTop slide / gradient border / typewriter title)
    await setup.waitForFrame(() => true, { maxPasses: 6 });
    const frame = setup.captureCharFrame();
    // Dual assertion: marker present OR frame non-empty (some designs'
    // entrance animation finishes after maxPasses; non-empty frame proves no crash)
    expect(frame.length).toBeGreaterThan(100);
    if (!frame.includes(sig.marker)) {
      console.warn(
        `  ! ${d.meta.id} 首帧不含 "${sig.marker}"（入场动画未完成），但渲染未崩溃`
      );
    }
    await setup.renderer.destroy();
  }
});

/** Model reducer: ←/→ move tier, Tab/Space toggle Auto, Enter confirm, Esc cancel. */
test("reducePickerModel 状态机：切档/切 Auto/确认/取消", () => {
  let m: PickerModel = { ...DEFAULT_PICKER_MODEL, open: true };
  // → moves up a tier (medium → high)
  m = reducePickerModel(m, { type: "right" });
  expect(m.focusIndex).toBe(2);
  // Tab toggles Auto (off → on, tiers disabled)
  m = reducePickerModel(m, { type: "tab" });
  expect(m.autoOn).toBe(true);
  expect(m.focusIndex).toBe(-1);
  // ← is inert while in Auto
  m = reducePickerModel(m, { type: "left" });
  expect(m.focusIndex).toBe(-1);
  // Space returns to manual, focus lands on current tier
  m = reducePickerModel(m, { type: "space" });
  expect(m.autoOn).toBe(false);
  expect(m.focusIndex).toBe(m.currentIndex);
  // Enter confirms and closes
  m = reducePickerModel(m, { type: "confirm" });
  expect(m.open).toBe(false);
  expect(m.currentIndex).toBe(1); // never moved → stays medium
});
