/** @jsxImportSource @opentui/react */
/**
 * src/tui/transcript-banner.tsx
 *
 * #986：banner 段渲染抽到独立 sibling 组件。spec 方案 B：banner 是滚动区
 * 首段，与消息共享 scroll space；用户上滚能翻回 banner（不复位 collapse，
 * 2026-08-08 裁定）。眼睛段用 eyeGradientCells 逐 cell 上色（e2 黄昏魔法石
 * 渐变）；info 栏（Version/Cwd/Data dir）取 bannerLines 行尾段；窄终端
 * （renderBannerLines 返回单行 short）保持单行降级。
 *
 * 内容宽度 = `cols` 满宽（与 `<scrollbox>` width 同源）。眼形 + GAP + info
 * 栏布局常量（EYE_W / BANNER_GAP）由本文件独享；bannerLines 行尾段从
 * `EYE_W + BANNER_GAP` 起 slice（与 banner.ts renderBannerLines 布局对齐）。
 */
import type { ReactNode } from "react";
import { EYE_LINES, eyeGradientCells } from "./banner.js";
import { tuiPalette } from "./theme.js";

/** 眼睛矩阵宽（首行宽度，banner.ts EYE_LINES 字形数据同源）。 */
const EYE_W = [...(EYE_LINES[0] ?? "")].length;
/** 眼睛与 info 栏之间间距（banner.ts GAP 同值）。 */
const BANNER_GAP = 3;

export function TranscriptBanner(props: {
  readonly bannerLines: ReadonlyArray<string>;
}): ReactNode {
  const pal = tuiPalette;
  const lines = props.bannerLines;
  if (lines.length === 0) return null;
  // 窄终端 → renderBannerLines 返回 1 行短形态；保留单行降级。
  if (lines.length === 1) {
    return (
      <box
        flexDirection="column"
        borderStyle="rounded"
        borderColor={pal.border}
        title="◆ iknow"
        titleAlignment="left"
        paddingX={1}
      >
        <text key="banner-short" fg={pal.logoInk} wrapMode="none">
          {lines[0] === "" ? " " : lines[0]}
        </text>
      </box>
    );
  }
  // e2 黄昏魔法石渐变（与 scripts/banner-gradient-preview/exotic-e2.ts 一致）：
  // 13×32 逐 cell 上色，对角线 t = cWeight·(c/31) + rWeight·(r/12)。
  const eyeGradient = eyeGradientCells({
    from: pal.logoInk,
    to: pal.logoGold,
    cWeight: 0.6,
    rWeight: 0.4,
  });
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={pal.border}
      title="◆ iknow"
      titleAlignment="left"
      paddingX={1}
    >
      {eyeGradient.map((row, r) => {
        // 行尾段 = GAP 之后的 info 栏（banner.ts renderBannerLines 布局）。
        const infoPart = (lines[r] ?? "").slice(EYE_W + BANNER_GAP);
        return (
          <text key={`banner-${r}`} wrapMode="none">
            {row.map((seg, c) => (
              <span key={`b-${r}-${c}`} fg={seg.hex}>
                {seg.text}
              </span>
            ))}
            <span fg={pal.logoInk}>{infoPart === "" ? " " : infoPart}</span>
          </text>
        );
      })}
    </box>
  );
}
