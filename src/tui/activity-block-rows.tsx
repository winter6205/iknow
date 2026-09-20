/** @jsxImportSource @opentui/react */
/**
 * src/tui/activity-block-rows.tsx
 *
 * Single-source assembly of activity block rows (specs/tui-activity-block.md):
 * a block title row + an optional dim preview row (only when the block slot is
 * `tool-preview`).
 *
 * All consumers share this template: historical message rows (`MessageBlocks`,
 * inserted at the contentBlockIndex anchor) and the tail's unanchored block
 * shells (`TranscriptTail`). The template lives in its own module because
 * `message-blocks` also needs it —— keeping it in `message-row` would form a
 * circular import (message-row already imports MessageBlocks).
 */
import type { ReactNode } from "react";
import * as React from "react";
import { tuiPalette } from "./theme.js";

/** Shared assembly for block title / preview rows. Keys come from the caller
 *  (each consumer uses a different React key prefix; the template itself is identical). */
export function renderActivityBlockRows(
  blockTitles: ReadonlyArray<string>,
  slotPreviews: ReadonlyArray<string | null>,
  contentWidth: number,
  keyOf: (blockIdx: number) => string
): ReactNode {
  return blockTitles.map((title, blockIdx) => {
    const preview = slotPreviews[blockIdx] ?? null;
    return (
      <React.Fragment key={keyOf(blockIdx)}>
        <text
          fg={tuiPalette.dim}
          wrapMode="none"
          width={Math.max(1, contentWidth - 2)}
        >
          {title}
        </text>
        {preview !== null ? (
          <text
            fg={tuiPalette.dim}
            wrapMode="none"
            width={Math.max(1, contentWidth - 2)}
          >
            {preview}
          </text>
        ) : null}
      </React.Fragment>
    );
  });
}
