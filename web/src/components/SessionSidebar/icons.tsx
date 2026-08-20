/**
 * serve-workspace T7a — SessionSidebar 内部图标集合 (T7b: Chevron 合并)。
 *
 * 16×16 / 12×12 描边 SVG，沿用项目既有的 stroke=currentColor / strokeWidth
 * 体系：父级 text-* 决定着色。无状态、无依赖，可被 SessionSidebar /
 * grouped-view / hooks 任意处 import。
 *
 * T7b review fix L3: `ChevronRightIcon` + `ChevronDownIcon` 结构仅 points 旋
 * 转方向不同，合并为 `ChevronIcon({ direction })`；方向切换靠 SVG `<polyline>`
 * points 不同（保持原 polyline 形态，不引入 CSS rotate，避免 strokeWidth /
 * 尺寸在不同方向时形变）。`ChevronLeftIcon` 单独保留 — 形态不重合。
 */
import type { JSX } from "react";

export function PlusIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function RefreshIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1 2.12-9.36L23 10" />
    </svg>
  );
}

export function ChevronLeftIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

/**
 * 通用 chevron 箭头（T7b 合并 Right/Down）。`direction` 决定 polyline 三点
 * 走向：
 *  - "right" → 9,6 → 15,12 → 9,18（左上 → 中右 → 左下，" > " 形）
 *  - "down"  → 6,9 → 12,15 → 18,9（左上 → 中下 → 右上，" v " 形）
 *
 * 默认 12×12 / strokeWidth=2，与原 `ChevronDownIcon` 一致；"right" 沿用相同
 * 尺寸，由调用方决定是否在父容器加 `transition-transform` 做旋转动画
 * （grouped-view 用 `-rotate-90` / `rotate-0` 切换）。
 */
export function ChevronIcon({
  direction,
}: {
  direction: "right" | "down";
}): JSX.Element {
  const points = direction === "down" ? "6 9 12 15 18 9" : "9 6 15 12 9 18";
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={points} />
    </svg>
  );
}
