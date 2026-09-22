/** @jsxImportSource @opentui/react */
/**
 * src/tui/subagent-card-view.tsx
 *
 * The single rendering surface for the subagent card's two lines
 * (specs/subagent-card-title.md): shared by the live tail
 * (`live-tool-preview.tsx`) and history cards (`message-blocks.tsx`). Same
 * split as `CompletedToolPreviewView`: projection lives in the pure module
 * (`subagent-message-lines.ts`), rendering lives only here — the two hosts
 * must not each write their own JSX, or dim/green colours and the empty-slot
 * placeholder would drift between the two paths.
 *
 * Colour discipline: line 1 (the title) always uses the default text colour —
 * completion does not recolour it; line 2 is the activity slot, dim while the
 * worker runs and `tuiPalette.add` (green) once it completed, because green
 * belongs solely to the `✓ Done` marker. The slot renders an empty string as a
 * single-space placeholder so the row count stays at two and the card never
 * collapses.
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
        {card.titleLine}
      </text>
      <text fg={card.done ? tuiPalette.add : tuiPalette.dim} wrapMode="none">
        {card.detailLine === "" ? " " : card.detailLine}
      </text>
    </box>
  );
}
