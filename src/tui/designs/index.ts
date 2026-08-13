/**
 * src/tui/designs/index.ts
 *
 * 思考面板 15 版设计注册中心（demo gallery 数据源）。
 *
 * 5 版初稿 + 10 版炫酷变体；纯预览用，不影响 app.tsx / slash.ts / theme.ts /
 * contract.ts 既有行为。每个 design 实现 ThinkingDesign 契约（_contract.ts），
 * 聚合导出供 scripts/tui-designs-preview.tsx 统一装配展示。
 */
import type { ThinkingDesign } from "./_contract.js";
import { design1 } from "./design-1-restrained.js";
import { design2 } from "./design-2-neon.js";
import { design3 } from "./design-3-crt.js";
import { design4 } from "./design-4-minimal.js";
import { design5 } from "./design-5-gradient.js";
import { design6 } from "./design-6-track-bar.js";
import { design7 } from "./design-7-fill-slot.js";
import { design12 } from "./design-12-flow-slot.js";
import { design14 } from "./design-14-scan.js";
import { design16 } from "./design-16-bg-flow.js";
import { design17 } from "./design-17-pulse.js";
import { design18 } from "./design-18-rising.js";
import { design19 } from "./design-19-capsule.js";
import { design20 } from "./design-20-ripple.js";
import { design21 } from "./design-21-aurora.js";
import { design22 } from "./design-22-fused.js";
import { design23 } from "./design-23-static-gray.js";
import { design24 } from "./design-24-breathing.js";
import { design25 } from "./design-25-flow-edge.js";

/** 全部 19 版设计（顺序 = gallery 展示顺序；按数字键 1-9 + +/- 翻页）。 */
export const THINKING_DESIGNS: readonly ThinkingDesign[] = Object.freeze([
  design1,
  design2,
  design3,
  design4,
  design5,
  design6,
  design7,
  design12,
  design14,
  design16,
  design17,
  design18,
  design19,
  design20,
  design21,
  design22,
  design23,
  design24,
  design25,
]);

export type { ThinkingDesign } from "./_contract.js";
export {
  EFFORT_LEVELS,
  type EffortLevel,
  type PickerModel,
  type PickerEvent,
  reducePickerModel,
  DEFAULT_PICKER_MODEL,
} from "./_contract.js";
