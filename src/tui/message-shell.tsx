/** @jsxImportSource @opentui/react */
/**
 * src/tui/message-shell.tsx
 *
 * Shared assistant shell SSOT. The assistant no longer carries a panel fill —
 * the shell is transparent (no backgroundColor, no paddingX), a marginTop
 * rhythm container only. Assistant text uses the terminal's default
 * background with Markdown formatting kept (subtrees bring their own width /
 * wrap). User messages still use the userBg fill (an internal box in
 * message-blocks.tsx); the input box shares the user fill family (an internal
 * box in prompt-input.tsx). Fold rows follow the assistant — ChatView's
 * renderFoldLines reuses this shell, and with no panel injected the folded
 * rows stay transparent too.
 *
 * Three consumers share the one shell (eliminating "shell jump" inconsistency):
 *  (a) the MessageBlocks assistant branch (history message rendering);
 *  (b) ChatView's streaming draft slot (in-flight assistant draft);
 *  (c) ChatView's renderFoldLines fold-row container (thought for Ns / tool counts).
 *
 * `memo` wrapper: cols / marginTop come from parent props (stable shallow
 * compare). If children is freshly created JSX each time, the shell's memo is
 * defeated — deliberately: memo's goal is keeping the shell itself from
 * re-rendering on unrelated parent state (e.g. scrollbox scrollTop / high-rate
 * streaming draft updates); children are still rebuilt by the parent on
 * demand, same boundary as the existing MessageBlocks memo.
 */
import { memo, type ReactNode } from "react";

/**
 * Shared assistant shell component (memo-wrapped).
 *
 * props:
 *  - `cols`: available shell width (pass-through convention; the shell itself
 *    renders no text — children bring their own width, no need to forward again).
 *  - `marginTop`: top margin of the root node (the 1-row rhythm between
 *    messages is passed by the parent as `visibleIndex===0?0:1`).
 *  - `children`: shell content (text / Markdown / tool summary rows / fold rows).
 */
export const MessageShell = memo(function MessageShell(props: {
  readonly cols?: number;
  readonly marginTop?: number;
  readonly children: ReactNode;
}): ReactNode {
  // cols exists only for the parent pass-through contract (consumers pass it
  // by convention; the shell does no width math — children bring width={cols}).
  // A missing value is not an error.
  void props.cols;
  // Transparent shell: no backgroundColor injected, no paddingX indentation.
  // Inner blocks (user messages / fenced code / input box) each carry their
  // own fill; message-shell only owns the inter-message marginTop rhythm.
  return (
    <box flexDirection="column" marginTop={props.marginTop ?? 0}>
      <box flexDirection="column">{props.children}</box>
    </box>
  );
});
