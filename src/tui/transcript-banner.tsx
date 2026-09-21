/** @jsxImportSource @opentui/react */
/**
 * src/tui/transcript-banner.tsx
 *
 * Banner segment split out of ChatView as a sibling component. The banner is
 * the first segment of the scroll area and shares the scroll space with
 * messages, so scrolling up can reach it again (collapse is not reset). The
 * eye art is coloured cell-by-cell via eyeGradientCells (dusk "magic stone"
 * gradient); the info bar (Version/Cwd/Data dir) takes the tail of each
 * bannerLines row; on narrow terminals (renderBannerLines returns a single
 * short line) the one-line degradation is kept.
 *
 * Content width = full `cols` (same source as the `<scrollbox>` width). The
 * eye + gap + info-bar layout constants (EYE_W / BANNER_GAP) are exclusive to
 * this file; the info part of a bannerLines row is sliced from
 * `EYE_W + BANNER_GAP` (aligned with renderBannerLines' layout in banner.ts).
 */
import type { ReactNode } from "react";
import { EYE_LINES, eyeGradientCells } from "./banner.js";
import { tuiPalette } from "./theme.js";

/** Eye matrix width (first row's width; same glyph data as EYE_LINES in banner.ts). */
const EYE_W = [...(EYE_LINES[0] ?? "")].length;
/** Gap between the eye art and the info bar (same value as GAP in banner.ts). */
const BANNER_GAP = 3;

export function TranscriptBanner(props: {
  readonly bannerLines: ReadonlyArray<string>;
}): ReactNode {
  const pal = tuiPalette;
  const lines = props.bannerLines;
  if (lines.length === 0) return null;
  // Narrow terminal → renderBannerLines returns 1 short line; keep the single-line degradation.
  if (lines.length === 1) {
    return (
      <box
        id="transcript-banner"
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
  // Dusk "magic stone" gradient (matches scripts/banner-gradient-preview/exotic-e2.ts):
  // 13×32 cells coloured individually, diagonal t = cWeight·(c/31) + rWeight·(r/12).
  const eyeGradient = eyeGradientCells({
    from: pal.logoInk,
    to: pal.logoGold,
    cWeight: 0.6,
    rWeight: 0.4,
  });
  return (
    <box
      id="transcript-banner"
      flexDirection="column"
      borderStyle="rounded"
      borderColor={pal.border}
      title="◆ iknow"
      titleAlignment="left"
      paddingX={1}
    >
      {eyeGradient.map((row, r) => {
        // Line tail = the info bar after the GAP (banner.ts renderBannerLines layout).
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
