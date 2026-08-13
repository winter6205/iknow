/**
 * src/tui/designs/_contract.ts
 *
 * 思考面板 5 版设计的共享合同（demo gallery 接口契约）。
 *
 * 每个 design 必须实现 `ThinkingDesign` 接口：纯渲染、纯键路由、可独立测
 * 试；由 demo gallery 入口统一装配，用户按 1-5 切换查看实际渲染效果。
 *
 * 不动既有 app.tsx / slash.ts / theme.ts / contract.ts；本目录纯预览用，
 * 仅作为后续 picker 形态选型的视觉/动效候选池。
 */
import type { ReactElement } from "react";
import type { KeyEvent } from "@opentui/core";

/** 5 档 concrete effort（不含自适应档；自适应档 = 顶部 Auto 圆点开关）。 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Picker 模型态（demo 自管；模拟真实使用时的双向状态）。 */
export interface PickerModel {
  /** Auto 圆点开关：true = effort=""（跟随 env/provider 默认），false = concrete 档位。 */
  readonly autoOn: boolean;
  /** 当前生效档位索引（0..4）。 */
  readonly currentIndex: number;
  /** Picker 内焦点游标位置（0..4，autoOn=true 时为 -1 表示游标在 Auto）。 */
  readonly focusIndex: number;
  /** Picker 是否打开（demo 内 toggle）。 */
  readonly open: boolean;
}

/** Picker 模型事件（demo 模拟交互产生）。 */
export type PickerEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "left" }
  | { type: "right" }
  | { type: "tab" } // 切 Auto
  | { type: "space" }; // 切 Auto（与 Tab 等价）

/** Picker 模型 reducer 纯函数（demo 与 design 解耦）。 */
export function reducePickerModel(
  model: PickerModel,
  event: PickerEvent
): PickerModel {
  if (!model.open) {
    if (event.type === "open") {
      return {
        ...model,
        open: true,
        focusIndex: model.autoOn ? -1 : model.currentIndex,
      };
    }
    return model;
  }
  switch (event.type) {
    case "close":
      return { ...model, open: false };
    case "cancel":
      return { ...model, open: false };
    case "confirm": {
      // Auto on → 维持 effort=""；off → 选 focusIndex
      if (model.autoOn)
        return { ...model, open: false, currentIndex: model.currentIndex };
      return { ...model, open: false, currentIndex: model.focusIndex };
    }
    case "left": {
      if (model.autoOn) return model;
      return { ...model, focusIndex: Math.max(0, model.focusIndex - 1) };
    }
    case "right": {
      if (model.autoOn) return model;
      return {
        ...model,
        focusIndex: Math.min(EFFORT_LEVELS.length - 1, model.focusIndex + 1),
      };
    }
    case "tab":
    case "space": {
      const nextAuto = !model.autoOn;
      return {
        ...model,
        autoOn: nextAuto,
        focusIndex: nextAuto ? -1 : model.currentIndex,
      };
    }
    default:
      return model;
  }
}

/** Picker 默认态：Auto off, 档位 medium (index=1)。 */
export const DEFAULT_PICKER_MODEL: PickerModel = {
  autoOn: false,
  currentIndex: 1, // medium
  focusIndex: 1,
  open: false,
};

/** Design 渲染输出：含面板 + 文档式辅助（标题、说明、键位提示）。
 *  demo gallery 会把它铺到 demo 屏幕：左侧面板，右侧说明 + 控制。 */
export interface ThinkingDesignProps {
  readonly model: PickerModel;
  readonly cols: number;
}

/** Design 元数据（demo gallery 列表展示）。 */
export interface ThinkingDesignMeta {
  readonly id: string;
  readonly name: string;
  readonly tag: string; // 一句话风格标签（中文）
  readonly summary: string; // 设计要点（demo 右侧展示）
}

/** Design 完整契约：元数据 + 渲染组件 + 可选键路由。
 *  键路由可选（demo 可提供全局默认行为）；提供则可定制非标准键位。 */
export interface ThinkingDesign {
  readonly meta: ThinkingDesignMeta;
  readonly render: (props: ThinkingDesignProps) => ReactElement;
  /** 可选：自定义键路由；返回 null 走 demo 默认（←/→ 档位/Tab+Space Auto/Enter 确认/Esc 取消）。 */
  readonly reduceKey?: (
    event: KeyEvent,
    model: PickerModel
  ) => PickerEvent | null;
}
