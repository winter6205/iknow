/**
 * src/tui/scrollbar-style.ts
 *
 * OpenTUI `<scrollbox>` 竖向滚动条的观感策略：常态极淡、指针移入才显色。
 *
 * 背景：滚动条完全由 OpenTUI 内建（应用层只经 `verticalScrollbarOptions`
 * 覆盖颜色）。默认 thumb `#9a9ea3` 全程不透明、track `#252527` 与聊天背景
 * 近乎同色 —— 视觉上是一根常亮的白条。本模块把它压到「平时几乎看不见、
 * hover 才明显」，track 始终保持隐形，让显色变化集中在 thumb 上。
 *
 * 颜色走 8 位 hex（`#RRGGBBAA`）：OpenTUI 的滑块渲染经
 * `setCellWithAlphaBlending`，alpha 真正参与混合（已实测帧内取色验证），
 * 不是靠调深色调冒充透明。
 *
 * hover 由 scrollbar renderable 基类的 `onMouseOver` / `onMouseOut` 驱动
 * （`Slider` 自己只接 down/drag/up，不含 hover；见 `attachScrollbarHover`）。
 */

/** 常态 thumb：极淡，仅留一丝位置暗示。 */
export const SCROLLBAR_THUMB_IDLE_ALPHA = 60;
/** hover 态 thumb：显色（不透明，对比度拉满）。 */
export const SCROLLBAR_THUMB_HOVER_ALPHA = 255;

/** thumb 基色（中性亮灰，暗色终端下作前景穿透出来）。 */
const THUMB_RGB = [154, 158, 163] as const;
/** track 基色：与聊天背景同色调，alpha 归零 = 完全隐形。 */
const TRACK_RGB = [37, 37, 39] as const;

function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 0; // EXIT: NaN|Infinity → 全透明，不误吞可见度
  return Math.max(0, Math.min(255, Math.trunc(alpha)));
}

/** 小写 hex（与 theme.ts 调色板同款；OpenTUI 两种大小写都收）。 */
function toHex(alpha: number): string {
  return clampAlpha(alpha).toString(16).padStart(2, "0");
}

/** `#rrggbbaa` —— RGB 取自基色三元组，alpha 由入参决定。 */
function rgbaHex(
  rgb: readonly [number, number, number],
  alpha: number
): string {
  const body = rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.trunc(c)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
  return `#${body}${toHex(alpha)}`;
}

/**
 * 竖向滚动条 track（轨道）颜色：恒定全透明。
 *
 * track 与聊天背景同色调，显形只会加噪音；「显色」语义全部交给 thumb。
 * 返回全 0 alpha 而非省略 —— 省略会回落 OpenTUI 默认 `#252527`（可见）。
 */
export function scrollbarTrackColor(): string {
  return rgbaHex(TRACK_RGB, 0);
}

/**
 * 竖向滚动条 thumb（滑块）颜色：`idle` 极淡 / `hover` 显色。
 *
 * @param hovered 指针当前是否停在滚动条上
 */
export function scrollbarThumbColor(hovered: boolean): string {
  return rgbaHex(
    THUMB_RGB,
    hovered ? SCROLLBAR_THUMB_HOVER_ALPHA : SCROLLBAR_THUMB_IDLE_ALPHA
  );
}

/**
 * hover 挂载面：只需 `onMouseOver` / `onMouseOut` 两个可写槽。
 *
 * 方法简写（而非属性式函数类型）是有意的：OpenTUI 把槽声明为
 * `(event: MouseEvent) => void`，属性式写法在逆变下拒收，方法简写按双变
 * 接受 —— 本模块只写零参 handler，不需要也不该 import OpenTUI 的事件类型。
 */
export interface ScrollbarHoverTarget {
  onMouseOver?(event: never): void;
  onMouseOut?(event: never): void;
}

/**
 * 把指针进出映射到 `setHovered`，返回卸载函数。
 *
 * `setHovered` 只在状态真正翻转时被调用 —— 终端把 `over` 事件按移动逐帧
 * 派发，不去重会让每次都触发无谓的 resize/redraw。
 *
 * EXIT：target 缺 `onMouseOver`/`onMouseOut` 槽（非 OpenTUI 对象 / 桩）
 * 时返回 no-op 卸载函数，不抛错 —— 观感降级不该拖垮会话视图。
 */
export function attachScrollbarHover(
  target: ScrollbarHoverTarget | null | undefined,
  setHovered: (hovered: boolean) => void
): () => void {
  if (target == null || typeof target !== "object") return () => {}; // EXIT
  let hovered = false;
  const update = (next: boolean): void => {
    if (next === hovered) return; // dedupe: 逐帧 move 不重放同一状态
    hovered = next;
    setHovered(next);
  };
  target.onMouseOver = () => update(true);
  target.onMouseOut = () => update(false);
  return () => {
    update(false);
    target.onMouseOver = undefined;
    target.onMouseOut = undefined;
  };
}
