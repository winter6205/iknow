/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-3-crt.tsx
 *
 * 思考面板 · 5 版设计之 3：复古终端 / CRT 磷光风（demo gallery 候选）。
 *
 * 设计要点：
 *  - 主色 `pal.add`（绿 #2ea043）模拟磷光；当前档强调叠加 `pal.bgRunning` / `pal.running`。
 *  - single 边框（细单线，复古终端感），边框色 `pal.add`；
 *    整面板 fg 在 `pal.add` ↔ `pal.bgRunning` 间缓慢微调（1500ms alternate
 *    inOutSine），模拟 CRT 噪点呼吸——本实现走 timeline + 数值插值
 *    （`mixHex`）而非 fg 字符串比较。
 *  - 标题 `[ THINKING ]` 中括号包裹，字符从左到右逐字打字机显现
 *    （60ms / 字符），由 `useTimeline` + `call` 延迟链驱动；
 *    useTimeline 在 unmount 时自动 `pause + unregister`，实现
 *    cancel-on-close。
 *  - 5 档 `#` 密度阶梯（`#` / `##` / `###` / `####` / `#####`，低→高），
 *    当前档 `#` 挂 `TextAttributes.INVERSE` 模拟"光标选中"。
 *  - Auto 圆点 `●`（开）/ `○`（关）：开时整字符用 `TextAttributes.BLINK`，
 *    通过 80ms alternate linear 时间轴持续 toggle（实测在不支持
 *    BLINK 的终端里至少能拿到 fg 闪烁的视觉反馈；支持的终端由终端
 *    自身按原生速率闪烁——两路并行，下文"闪烁 vs BLINK"取舍详述）。
 *  - 入场：外层 `box` `marginTop -3 → 0` 滑落 280ms outQuad，无弹跳。
 *  - 键位提示行：`*` 分隔（终端风格）。
 *
 * 取舍笔记（闪烁 vs BLINK）：
 *  - "CRT 噪点"与"Auto 圆点"是两种效果：
 *      · CRT 噪点 = 颜色微调（fg 数值插值），timeline 驱动 →
 *        所有终端都看得到，因为 fg 是必渲染属性；
 *      · Auto 圆点 = 原生终端 BLINK 属性 + timeline 持续 toggle →
 *        支持 BLINK 的终端由终端自身闪烁（视觉最准），不支持
 *        BLINK 的终端（多数现代 GUI 终端默认关）timeline 仍按
 *        80ms alternate 翻 `TextAttributes.BLINK` 位——视觉降级为
 *        "不可见"，但 fg 仍为 `pal.add`，对没看到闪烁的用户不破坏
 *        可读性。如果后续要兜底，可以在 BLINK 关闭的检测下换成
 *        fg 颜色插值——本设计先保留原生路径。
 */
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

/** 打字机标题（中括号包裹，等宽终端风）。 */
const CRT_TITLE = "[ THINKING ]";
const TYPE_STEP_MS = 60;

/** 5 档 `#` 密度阶梯（低→高），由档位数派生避免与 EFFORT_LEVELS 漂移。 */
const LEVEL_HASHES: ReadonlyArray<string> = EFFORT_LEVELS.map((_, i) =>
  "#".repeat(i + 1)
);

/** 键位提示行（`*` 分隔，终端风格）。 */
const CRT_HINT_TOKENS: ReadonlyArray<string> = [
  " tab/space toggle auto ",
  " arrows change level ",
  " enter confirm ",
  " esc cancel ",
];

/** "足够长"timeline duration（1h），绕开 `loop: true` 的 resetItems 重捕获初值陷阱：
 *  - 用 item 层的 `loop: true, alternate: true` 做无限循环；
 *  - timeline 层 duration 给够大并保持非 loop，update 不会触发
 *    `resetItems`，item 的 initialValues 不会被重新捕获（动画值不会
 *    卡在循环末态）。 */
const INFINITE_MS = 3_600_000;

/** 面板入场滑动时长（outQuad，无弹跳）。 */
const ENTER_MS = 280;

/** CRT 噪点单程时长（alternate → 一上一下 = 2×该值）。 */
const CRT_FLICKER_MS = 1500;

/** Auto 圆点 BLINK toggle 单程时长（alternate → 完整闪烁周期 2×该值）。 */
const DOT_BLINK_MS = 80;

/** 6 位 hex (`#rrggbb`) → 整数 RGB（忽略 alpha）。 */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** 线性插值两支 `pal.*` hex 色，t∈[0,1]；返回值始终 6 位 `#rrggbb`。 */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * k);
  const g = Math.round(pa.g + (pb.g - pa.g) * k);
  const bl = Math.round(pa.b + (pb.b - pa.b) * k);
  const hex = ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
  return `#${hex}`;
}

/**
 * Auto 开时挂载的 BLINK 圆点。Auto 关时整个组件不渲染——利用
 * React unmount + `useTimeline` 的 effect cleanup 实现 cancel-on-close：
 * timeline 自动 `pause + engine.unregister`，不会泄漏 driver tick。
 */
function CrtBlinkDot(): ReactNode {
  const pal = tuiPalette;
  const tl = useTimeline({ duration: INFINITE_MS });
  const [blinkOn, setBlinkOn] = useState(false);
  useEffect(() => {
    tl.add(
      { b: 0 },
      {
        b: 1,
        duration: DOT_BLINK_MS,
        ease: "linear",
        alternate: true,
        loop: true,
        onUpdate: (a) => setBlinkOn(a.targets[0].b > 0.5),
      }
    );
  }, []);
  return (
    <span
      fg={pal.add}
      attributes={blinkOn ? TextAttributes.BLINK : TextAttributes.NONE}
    >
      ●
    </span>
  );
}

/** 复古终端 / CRT 磷光风主面板。组件内部用 hooks（timeline 驱动
 *  入场、打字机、CRT 噪点），再由 `design3.render` 装配导出。 */
function CrtPanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex } = model;

  // 入场：marginTop -3 → 0 滑落 280ms outQuad。
  const enterTl = useTimeline({ duration: ENTER_MS });
  const [enterY, setEnterY] = useState(-3);
  useEffect(() => {
    enterTl.add(
      { y: -3 },
      {
        y: 0,
        duration: ENTER_MS,
        ease: "outQuad",
        onUpdate: (a) => setEnterY(Math.round(a.targets[0].y)),
      }
    );
  }, []);

  // 打字机：每 TYPE_STEP_MS 追加一个字符，timeline call 延迟链。
  const typeTl = useTimeline({
    duration: CRT_TITLE.length * TYPE_STEP_MS + 120,
  });
  const [chars, setChars] = useState(0);
  useEffect(() => {
    for (let i = 1; i <= CRT_TITLE.length; i++) {
      typeTl.call(() => setChars(i), i * TYPE_STEP_MS);
    }
  }, []);

  // CRT 噪点：整面板 fg 在 pal.add ↔ pal.bgRunning 间微调。
  // 量化到 1/32 阶以减少 onUpdate 每帧 setState 的重渲染频率。
  const flickerTl = useTimeline({ duration: INFINITE_MS });
  const [flicker, setFlicker] = useState(0);
  useEffect(() => {
    flickerTl.add(
      { t: 0 },
      {
        t: 1,
        duration: CRT_FLICKER_MS,
        ease: "inOutSine",
        alternate: true,
        loop: true,
        onUpdate: (a) => {
          const v = Math.round(a.targets[0].t * 32) / 32;
          setFlicker(v);
        },
      }
    );
  }, []);

  const crtFg = mixHex(pal.add, pal.bgRunning, flicker);

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={pal.add}
      paddingX={1}
      marginTop={enterY}
      width={Math.max(1, cols)}
    >
      <text fg={pal.add} attributes={TextAttributes.BOLD}>
        {CRT_TITLE.slice(0, chars)}
      </text>
      <text fg={pal.add}>
        {autoOn ? <CrtBlinkDot /> : <span>○</span>}
        {"  AUTO"}
      </text>
      {LEVEL_HASHES.map((hash, i) => {
        const current = i === currentIndex;
        return (
          <text key={i} fg={current ? pal.add : crtFg}>
            <span
              fg={current ? pal.add : crtFg}
              attributes={
                current ? TextAttributes.INVERSE : TextAttributes.NONE
              }
            >
              {hash}
            </span>
            <span> {EFFORT_LEVELS[i]}</span>
          </text>
        );
      })}
      <text fg={pal.dim}>
        <span fg={pal.add}>*</span>
        {CRT_HINT_TOKENS.map((seg, i) => (
          <span key={i}>
            <span>{seg}</span>
            <span fg={pal.add}>*</span>
          </span>
        ))}
      </text>
    </box>
  );
}

export const design3: ThinkingDesign = {
  meta: {
    id: "design-3-crt",
    name: "复古终端风",
    tag: "Retro CRT",
    summary: "单线边框 + 磷光绿 + 打字机标题 + #密度阶梯 + 字符闪烁模拟 CRT。",
  },
  render: ({ model, cols }) =>
    (<CrtPanel model={model} cols={cols} />) as ReactElement,
};
