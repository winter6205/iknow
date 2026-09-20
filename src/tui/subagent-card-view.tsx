/** @jsxImportSource @opentui/react */
/**
 * src/tui/subagent-card-view.tsx
 *
 * The single rendering surface for the subagent card's two live lines
 * (specs/tui-subagent-transcript-live.md): shared by the live tail
 * (`live-tool-preview.tsx`) and history cards (`message-blocks.tsx`). Same
 * split as `CompletedToolPreviewView`: projection lives in the pure module
 * (`subagent-message-lines.ts`), rendering lives only here — the two hosts
 * must not each write their own JSX, or dim/green colours and empty-line
 * placeholders would drift between the two paths.
 *
 * Colour discipline: line 1 always uses the default text colour (live shows
 * `{role} running...`; once completed it is identity only); the detail line
 * is always dim (completion does not recolour it — green belongs solely to
 * the done marker); when `doneLine` is present it renders as the 3rd line in
 * green `tuiPalette.add` with the literal `✓ Done`. An empty preview renders
 * a single-space placeholder so the row count stays constant and the card
 * never collapses.
 */
import type { ReactNode } from "react";
import type { SubagentCardLines } from "./subagent-message-lines.js";
import { tuiPalette } from "./theme.js";

export function SubagentCardView(props: {
  readonly card: SubagentCardLines;
}): ReactNode {
  const { card } = props;
  return (
    <box flexDirection="column">
      <text fg={tuiPalette.text} wrapMode="none">
        {card.roleLine}
      </text>
      <text fg={tuiPalette.dim} wrapMode="none">
        {card.detailLine === "" ? " " : card.detailLine}
      </text>
      {card.doneLine === undefined ? null : (
        <text fg={tuiPalette.add} wrapMode="none">
          {card.doneLine}
        </text>
      )}
    </box>
  );
}
