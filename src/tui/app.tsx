/** @jsxImportSource @opentui/react */
/**
 * src/tui/app.tsx
 *
 * TUI root component (OpenTUI backend): state machine, slash routing,
 * hub-bridge streaming, permission modal, quit semantics. Interaction
 * semantics match archive/tui-ink/src/app.tsx; only the rendering backend
 * and key-event model differ (ink useInput → OpenTUI useKeyboard
 * KeyEvent.name projection).
 *
 * State-machine discipline (specs/146-tui.md):
 *  - Session tri-state idle / running-fg / running-bg, driven by pure
 *    functions in session-state.ts; switching away mid-turn → running-bg;
 *    Esc interrupts running-fg only (key migration 2026-09-18: interrupt
 *    moved from Ctrl+C to Esc; Ctrl+C is now selection copy only).
 *  - View bi-state chat / list.
 *  - Messages are ReadonlyArray + Object.freeze, replaced wholesale.
 *
 * Streaming concurrency: `useDeferredValue` lives in ChatView; the app
 * layer wraps draft subscribe callbacks in `startTransition` — dual defense.
 *
 * Quit semantics: /quit with running-bg sessions requires second
 * confirmation; after confirming, wait for all in-flight turns to persist
 * before destroying the renderer (background turns are not interrupted).
 *
 * Multi-line input: input-row accounting is dynamic (chromeReserveRows
 * `inputRows` capped at MAX_INPUT_LINES=8 logical lines of inputValue);
 * more content rows → fewer viewportRows → ChatView height shrinks,
 * history messages are never lost, only the viewport gets shorter.
 *
 * Deliberately absent (OpenTUI built-ins take over):
 *  - row-level scrolling / row-window math (`<scrollbox stickyScroll>`);
 *  - markdown-lines / message-rows / row-window / chat-flow / selection
 *    / mouse / text modules (built-in selection + renderer coordinates).
 */
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { decodePasteBytes, MouseButton } from "@opentui/core";
import type { KeyEvent, MouseEvent, Selection } from "@opentui/core";
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import stringWidth from "string-width";
import type { HarnessStreamEvent } from "../harness/stream.js";
import { summarizeTransportCause } from "../harness/errors.js";
import {
  BACKGROUND_OPERATION_NOTICE,
  BLOCK_OPERATION_NOTICE,
} from "../harness/aci/aci-executor.js";
import type { CompactReason } from "../harness/compress/index.js";
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../harness/model-adapter/types.js";
import type { TuiToolEvent, TuiMcpViewExt } from "./deps.js";
import type { McpServerStatus } from "../harness/mcp/manager.js";
import { isDoubleEsc, type TuiBridge } from "./hub-bridge.js";
import type { TuiAskUserBridge, TuiPendingAsk } from "./ask-user.js";
import type {
  RemoteInputBindings,
  RemoteInputPort,
  RemoteSendResult,
} from "./remote/input-port.js";
import type { ProjectionActiveState } from "./remote/projector.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type {
  PermissionMode,
  PermissionModeContext,
} from "../harness/permission/modes.js";
import {
  modalKeyEventOf,
  ModalHost,
  PERMISSION_ANSWERS,
  permissionModalRows,
  reduceModalKey,
  shortToolUseId,
  wrapModalLines,
  type ModalKeyEvent,
  type PermissionAnswer,
} from "./modal.js";
import {
  abortOwnedWorkOnQuit,
  removeOwnedTurnController,
  trackOwnedTurnController,
} from "./quit-abort.js";
import {
  planQuitBusy,
  quitConfirmationRefreshLines,
  quitBusyFingerprint,
  quitBusyNoticeLines,
} from "./quit-busy.js";
import {
  DRAFT_SESSION_ID,
  appendInputHistory,
  attachSession,
  canInterrupt,
  createDraftSession,
  recoveryNoticeLines,
  seedInputHistory,
  sessionCompacted,
  sessionRewound,
  switchedAwayFrom,
  switchedTo,
  turnFinished,
  turnStarted,
  withSessionRoute,
  userMessageEchoed,
  withContextUsageBeat,
  type TuiSessionState,
  type TuiView,
} from "./session-state.js";
import {
  INITIAL_TOKEN_SPEED_STATE,
  TOKEN_SPEED_WINDOW_MS,
  ZERO_TOKEN_SPEED_READING,
  beginTokenSpeedTurn,
  finishTokenSpeedTurn,
  readTokenSpeed,
  refreshTokenSpeed,
  transitionTokenSpeed,
  type TokenSpeedReading,
  type TokenSpeedState,
} from "./token-speed.js";
import {
  codeRestoreNoticeLines,
  reduceRewindKey,
  rewindModalRows,
  rewindPickerContent,
  type RewindTarget,
} from "./rewind-picker.js";
// ADR-0119 / specs/yolo-mode.md: /yolo confirm-modal content + row accounting
// + key routing (pure module; the state host is this component — see
// yoloConfirming / yoloOn state).
import {
  reduceYoloConfirmKey,
  yoloEnterConfirmContent,
  yoloModalRows,
  type YoloKeyAction,
} from "./yolo-picker.js";
import {
  helpLines,
  parseSkillLoad,
  parseTuiInput,
  slashComplete,
  slashCompleteFromCandidates,
  slashHasArg,
  slashPrefix,
  slashRemainder,
  slashSuggestions,
  type SkillEntryLike,
  type SlashCandidate,
  type TuiSlashCommand,
} from "./slash.js";
import { liveToolReduce } from "./live-tool-state.js";
import type { LiveToolRun } from "./live-tool-state.js";
import {
  ADJUSTABLE_EFFORT_LEVELS,
  effortHasArg,
  parseEffortLevel,
} from "./slash.js";
import {
  ThinkingPicker,
  committedThinkingPatch,
  effortToDisplayIndex,
  indexToEffort,
  reduceThinkingSwitchKey,
  reduceThinkingEffortKey,
  thinkingPickerRows,
  type CommittedThinkingPatch,
  type ThinkingPickerState,
} from "./thinking-picker.js";
import {
  COMPACT_HOLD_MS,
  CompactProgress,
  compactProgressRows,
  reduceCompactionEvent,
  settleCompactPanel,
  startCompactPanel,
  type CompactProgressState,
  type CompactProgressSource,
  type CompactTerminalKind,
} from "./compact-progress.js";
import {
  MemoryPicker,
  applyMemoryPreviewToggle,
  committedMemoryPatch,
  memoryPickerRows,
  reduceMemoryPickerKey,
  seedMemoryPreview,
  type CommittedMemoryPatch,
} from "./memory-picker.js";
import {
  ModelPicker,
  findEntryByRouteId,
  modelPickerEntries,
  modelPickerRows,
  modelRouteId,
  reduceModelPickerKey,
  type ModelPickerEntry,
  type ModelPickerState,
} from "./model-picker.js";
import {
  ConfigPicker,
  configRowKindFor,
  configPickerRows,
  nextSubagentCap,
  reduceConfigPickerKey,
  toggleFsMode,
  toggleWorktreeOnMutate,
  type ConfigPickerState,
  type SubagentCapDisplay,
} from "./config-panel.js";
import { computeThinkingOverride, formatEffortLabel } from "./thinking-gate.js";
import {
  continueExitFromError,
  continueNoticeFor,
  isContinueValidationError,
  pendingFromLoadedSession,
  tuiContinueBusy,
} from "./continue-notice.js";
import { shouldTriggerContinueFromNl } from "../session-api/continue-pending.js";
import type {
  ThinkingEffortWire,
  UserContentBlock,
  WireThinkingOverride,
} from "../session-api/contract.js";
import { ChatView } from "./chat-view.js";
import type { StreamDraft } from "../cli/stream-draft.js";
import { createStreamDraft } from "../cli/stream-draft.js";
import { ListView, relativeTime, type TuiListEntry } from "./list-view.js";
import { McpView, type McpToolEntry } from "./mcp-view.js";
import { ContextBar, displayedModelRoute } from "./context-bar.js";
import {
  EMPTY_ENV_DISPLAY_STORE,
  type EnvDisplayStore,
} from "./env-display-store.js";
// Chrome-focus reducer wiring: `reduceChromeFocus` owns the input /
// subagent(row) / graph focus rings (src/tui/chrome-focus.ts) as a pure
// function; this file only composes it — the wiring must not grow into a
// god-handler. `graphChromeFocus` (graph-chrome.ts legacy two-state
// reducer) keeps only the openView layer (full-screen GraphGroupView
// Open/Close is still its job; not mixed with the three-ring focus switch).
import { type ChromeFocus, reduceChromeFocus } from "./chrome-focus.js";
// Ctrl+X hard-kill of the focused subagent — pure dispatch module (row
// order shares the same source as the panel).
import { dispatchKillFocusedSubagent } from "./subagent-kill.js";
// Live subagent predicate (single source for Ctrl+X dispatch / panel / focus count).
import {
  countLiveBackgroundSubagents,
  isLiveSubagent,
} from "./subagent-message-lines.js";
// Agent current-status display (ADR-0028) — distinct from ContextBar's
// context usage by design: read-only latest snapshot of the agent_status event stream.
import {
  AgentStatusPanel,
  agentStatusFromEvent,
  agentStatusLines,
} from "./agent-status-line.js";
import type { GraphProgressSnapshot } from "../harness/graph/progress.js";
import {
  GraphChromePanel,
  graphChromeRows,
  graphProgressFromEvent,
  reduceGraphChromeFocus,
  type GraphChromeFocus,
} from "./graph-chrome.js";
import { GraphGroupView } from "./graph-group-view.js";
import {
  applyGraphViewKey,
  graphGroupRows,
  selectableNodeIds,
} from "./graph-group.js";
import {
  agentStatusFromMessages,
  type AgentStatusSnapshot,
} from "../harness/agent-status.js";
// Environment current-status as an independent slot — same chrome area as
// the ADR-0028 status bar but a parallel, separate stream. EnvironmentPane
// must not read the ADR-0028 status bar's events / snapshots / ledger
// readers (pinned by a grep guard in tests/tui/environment-pane.test.tsx).
import {
  envSnapshotFromEvent,
  resolveWorktreeChromeRoot,
  sessionLocationLines,
} from "./environment-pane.js";
import type { EnvSnapshot } from "../harness/env-snapshot.js";
// TUI verify closed-loop terminal-state human banner (HITL + auto modes:
// passed / failed / unstable / escalated). The wire already reaches
// bridge.TuiPostResult.verify; projection + render shell live in
// verify-banner.tsx (pure functions, unit-testable).
import {
  projectVerifyBanner,
  VerifyBannerStrip,
  verifyFromWire,
  type VerifySlot,
} from "./verify-banner.js";
import {
  HINT_MAX_ROWS,
  INPUT_MAX_LINES as MAX_INPUT_LINES,
  inputVisibleLineCount,
  inputWrapLineCount,
  PromptInput,
  type PromptInputHandle,
} from "./prompt-input.js";
// chromeReserveRows line-account cap is unified through INPUT_MAX_LINES
// (prompt-input SSOT) so app.tsx and prompt-input.tsx don't each hold an
// "8" constant that can drift. Local alias MAX_INPUT_LINES keeps the
// original reference semantics + re-export to stabilize the external
// import surface (tests/tui/*).
import { renderBannerLines, VERSION } from "./banner.js";
import { copyToClipboard, type CopyResult } from "./clipboard.js";
import {
  PASTE_IMAGE_PROBE_TIMEOUT_MS,
  readClipboardImage,
  type ClipboardImageResult,
  type ReadClipboardImageOptions,
} from "./clipboard-image.js";
import {
  createComposerDraft,
  draftText,
  pasteHasLineBreak,
  skillImageContent,
  toUserContentBlocks,
  transcriptEchoText,
  type ComposerDraft,
  type DraftPayload,
} from "./composer-draft.js";
import {
  emptyGapQueue,
  enqueueGap,
  gapCount,
  gapQueueLine,
  recallNewestGap,
  resolveGapKey,
  restoreGapHead,
  takeOldestGap,
  type GapDraft,
  type GapQueue,
} from "./turn-gap-queue.js";
import { ValidationError } from "../shared/errors.js";
import { summarizeToolCall, formatLiveToolEvent } from "./tool-summary.js";
import {
  SubagentPanel,
  projectSubagentLines,
  visibleLiveRowCount,
  SUBAGENT_PANEL_MAX_ROWS,
  FAILED_VISIBLE_WINDOW_S,
  DONE_FADE_WINDOW_S,
} from "./subagent-panel.js";
import type { SubagentInfo } from "../harness/subagent/manager.js";
import type { BackgroundLiveTask } from "../harness/background/manager.js";
import type {
  SubagentCapacityHolder,
  SubagentCapacityValue,
} from "../harness/subagent/manager.js";
import type { SubagentCapPersistPatch } from "../config/persist-settings.js";
import type { WorktreeOnMutateHolder } from "../harness/isolation/worktree-gate.js";
import { formatRunDuration } from "./run-stats.js";
import { tuiPalette } from "./theme.js";
import { createPermissionModeContext } from "../harness/permission/index.js";
// Imported from the seam's own module, not the index: one getter, one owner.
import { parseFoundationState } from "../harness/permission/shell-parse.js";
import {
  agentModeLabel,
  applyGraphCommand,
  applyShiftTabAgentModeFlip,
  splitGraphArgs,
  type GraphModeContext,
} from "../harness/graph/mode.js";
import {
  applyFsModeCommand,
  parseConfigCommand,
  splitConfigArgs,
  type FsIsolationMode,
  type FsModeContext,
} from "../harness/sandbox/fs-mode.js";
// Shared with the REPL's `/permissions`: one parse / status / usage
// implementation, imported from its own module rather than the barrel so the
// command surface has a single visible owner (same discipline as graph/mode.ts).
import {
  applyPermissionsCommand,
  splitPermissionArgs,
} from "../harness/permission/permissions-command.js";
// ADR-0119 / specs/yolo-mode.md: yolo-axis types (holder + enter/exit action
// single point). Type-only import — the flip semantics live in
// harness/sandbox/yolo.ts (fsMode→global + snapshot for exit + symmetric
// bwrap probe on enter and exit); the permission axis is deliberately not
// among them (ADR-0139); this component never rebuilds them and never
// writes the holder directly.
import type { YoloContext, YoloController } from "../harness/sandbox/yolo.js";
import {
  clearOverlayForUserChange,
  type PresetId,
  type PresetOverlay,
} from "../harness/sandbox/no-sandbox-marker.js";
import { buildSkillLoadText, createSkillBody } from "../harness/skill/body.js";
import type { SkillRescanner } from "../harness/skill/rescan.js";
import {
  formatSkillRescanFailure,
  useLiveSkillCatalog,
} from "./skill-catalog-live.js";
import { projectSlashEntries } from "../harness/skill/catalog.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { IknowSettingsLlmProvider } from "../config/settings.js";
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
} from "../config/env.js";
import { persistModelFailNotice } from "./persist-model-failure.js";
import type { LiveTaskRoot } from "../harness/session-roots.js";
import {
  createSubagentWake,
  toSubagentWakeError,
  type SubagentWake,
} from "../harness/subagent/host-wake.js";
import { extractTitle } from "../session-api/store/schema.js";
import { RECOVERY_IN_PROGRESS_LABEL } from "../session-api/store/recovery-status.js";

/** Local re-export of the chromeReserveRows line-account cap and the
 *  visible-line-count helpers (actual SSOT is prompt-input.tsx, so two
 *  modules don't each hold an "8" constant). Also re-exports
 *  inputWrapLineCount (wrap-aware visual line count) — fixes the regression
 *  where long text without `\n` kept the input box at one line. */
export { inputVisibleLineCount, inputWrapLineCount, MAX_INPUT_LINES };

/** What one turn carries: the text the command parser, the text cap and the
 *  memory query read, plus the ordered payload when the draft holds folded
 *  attachments. `content` absent keeps the hub's single-text-block path. */
type TurnInput = {
  readonly text: string;
  readonly content?: readonly UserContentBlock[];
  /** Who submitted the message (specs/remote-sync.md §4.1); absent → local. */
  readonly origin?: "local" | "remote";
};

/** The Ctrl+V clipboard-image seam: `readClipboardImage` in the product path, a
 *  cue-resolved stub in tests. Takes the reader's own options so the chord's
 *  AbortSignal is the caller's, not a private one. */
export type ClipboardImageReader = (
  options?: ReadClipboardImageOptions
) => Promise<ClipboardImageResult>;

/**
 * Every reader outcome except a payload, in the operator's words. A cancelled
 * read is the discard path itself (the draft already moved on), so it says
 * nothing; a failure says why nothing was added — never a text fallback.
 */
function clipboardImageFailureLines(
  result: Exclude<ClipboardImageResult, { kind: "ok" }>
): ReadonlyArray<string> {
  switch (result.kind) {
    case "empty":
      return ["剪贴板里没有图片。"];
    case "too-large":
      return [`剪贴板图片 ${result.bytes} 字节，超过大小上限，未添加。`];
    case "unsupported":
      return ["剪贴板图片格式不支持（jpeg / png / gif / webp），未添加。"];
    case "error":
      // The reader already flattened this message: no payload, no raw stderr.
      return [`剪贴板读取失败：${result.message}`];
    case "cancelled":
      return [];
  }
}

/**
 * Which buffer span this paste owns, or -1 for none. The first arm is the bytes
 * this insert just wrote. The second matches on content, not position, so after
 * an earlier substitution shifted the recorded span it lands on the pasted
 * string wherever it sits at the end of the buffer — which cannot tell a
 * byte-identical retype, or a tail that predates the paste, from bytes this
 * paste wrote. A span that matches nowhere is left alone.
 */
function locatePastedSpan(buffer: string, start: number, text: string): number {
  return buffer.slice(start, start + text.length) === text
    ? start
    : buffer.endsWith(text)
      ? buffer.length - text.length
      : -1;
}

/**
 * The caret rides along a label substitution: a caret before the span does not
 * move, one after it shifts by the length difference, one inside it lands on the
 * label. The replaced length travels as `to - at`, the span's own bounds.
 */
function caretAfterLabel(
  cursor: number,
  at: number,
  to: number,
  labelLength: number
): number {
  return cursor <= at
    ? cursor
    : cursor >= to
      ? cursor - (to - at) + labelLength
      : at + labelLength;
}

/** One submit awaiting its turn outcome, together with what it took from the
 *  draft: this is what a rejection hands back. */
type SubmittedDraft = TurnInput & {
  readonly displayText: string;
  readonly payloads: readonly DraftPayload[];
};

/**
 * The draft resolves exactly once, at submit: static slash commands keep
 * reading the label form the user saw (`displayText`), while the model gets
 * the real payload. A `/skill` prompt is built from the restored paste
 * instead, with image labels left in place. The transcript echo expands
 * paste labels from those payloads; `displayText` itself stays the input
 * buffer so a rejection can put the fold back. Ordered blocks travel only
 * when a genuine attachment is
 * present, so a text-only draft stays on the hub's single-text-block path.
 * Taking the payloads out of the draft rather than clearing it is what lets a
 * rejection that happened before the turn was accepted hand them back — a pasted
 * clipboard image cannot be re-obtained. Extracted because every branch of it
 * counts against `handleSubmit`'s standing complexity budget.
 */
function resolveSubmittedDraft(
  draft: ComposerDraft,
  text: string
): SubmittedDraft {
  const blocks = toUserContentBlocks(draft.expand(text));
  const messageText = draftText(blocks);
  const hasAttachment = blocks.some((block) => block.type === "image");
  return {
    text: messageText,
    displayText: text,
    payloads: draft.takeSubmission(text),
    ...(hasAttachment ? { content: blocks } : {}),
  };
}

/**
 * The rejection classes split at the hub's accepted-input commit: every throw
 * site reached before it (input validation, the `## GOAL:` directive plus the
 * block refusal, the adapter that cannot carry a block, deps and workspace-root
 * guards) is a ValidationError, and after it the classes are
 * RuntimeStatePersistenceError, a provider API error or a SessionStoreError —
 * never a ValidationError. Restoring on anything else would hand the composer a
 * second copy of a message that IS in history.
 */
function isPreAcceptanceRejection(err: unknown): boolean {
  return err instanceof ValidationError;
}

/**
 * Row count after wrapping notice text by visual width (line-account SSOT,
 * pure function, unit-testable).
 *
 * OpenTUI has no equivalent of the archive's `wrapTextVisual` — reuse
 * `wrapModalLines` from modal.tsx (wrap-ansi + {trim:false, hard:true}).
 * Empty array / no elements → 0 rows.
 */
/**
 * SSOT for /compact entry-guard notice text (pure functions). The five
 * guards cover manual-path preconditions:
 *  - busy: a turn is running, compaction must queue (runState gate);
 *  - in_flight: only one /compact at a time (compactingControllerRef sync gate);
 *  - draft: session not yet persisted, nothing to compact;
 *  - cancelled: promise resolved cancelled (pre-abort early return / event flag);
 *  - failed: compactSession threw (rendered via describeError).
 */
export type CompactGuard = "busy" | "in_flight" | "draft";

export function compactGuardNoticeFor(guard: CompactGuard): string {
  switch (guard) {
    case "busy":
      return "Session is running; compact after this turn ends.";
    case "in_flight":
      return "Compaction already in progress; press Esc to cancel.";
    case "draft":
      return "Empty session — nothing to compact yet.";
    default: {
      const _exhaustive: never = guard;
      throw new Error(`unknown compact guard: ${String(_exhaustive)}`);
    }
  }
}

/** Notice text when compaction was cancelled (promise result cancelled). */
export function compactCancelledNotice(): string {
  return "Compaction cancelled — session unchanged.";
}

/** Notice prefix when compaction throws (error body filled by describeError). */
export function compactFailedNoticePrefix(): string {
  return "Compaction failed: ";
}

/**
 * Decide /compact notice text as a module-level pure function so unit tests
 * can cover all 4 reason branches without mounting the whole TUI render
 * chain + frozen bridge mock. Functional style + exhaustiveness check over
 * the sealed CompactReason union: adding a future reason fails TS compile.
 */
export function compactNoticeFor(
  reason: CompactReason,
  compacted: boolean
): readonly string[] {
  if (compacted) {
    // compacted=true path: windowed → keep tail + trim early; full_summary → summary prefix + kept tail.
    switch (reason) {
      case "windowed":
        return ["Context compacted (kept tail, trimmed early messages)."];
      case "full_summary":
        return ["Context compacted (structured summary + kept tail)."];
      case "below_token_threshold":
      case "messages_too_few":
        // Logically compacted=true never sees these reasons; listed for exhaustiveness.
        throw new Error(
          `unexpected no-op reason in compacted branch: ${reason}`
        );
      default: {
        const _exhaustive: never = reason;
        throw new Error(`unknown compact reason: ${String(_exhaustive)}`);
      }
    }
  }
  // compacted=false path: manual compactSession never returns
  // below_token_threshold (the auto token gate belongs to the proactive
  // path only); empty-session idempotency and overall compaction failure
  // share messages_too_few, meaning "no compactable context" rather than
  // "too few messages". Any below_token_threshold or success reason showing
  // up here is a contract violation → throw instead of rendering auto-gate text.
  switch (reason) {
    case "messages_too_few":
      return ["Nothing to compact — session unchanged."];
    case "below_token_threshold":
    case "windowed":
    case "full_summary":
      throw new Error(`unexpected reason in manual noop branch: ${reason}`);
    default: {
      const _exhaustive: never = reason;
      throw new Error(`unknown compact reason: ${String(_exhaustive)}`);
    }
  }
}

/**
 * True when a row painted with `wrapMode="none"` would fill the terminal's last
 * column with the right half of a double-width glyph. That is the shape the
 * renderer mishandles: the following row is spilled onto the same frame row
 * (measured with two stacked texts in a 56-column box — 28 `中` = string-width
 * 56 merges with the next row, while 56 latin characters, or 55 columns of `中`,
 * keep their rows). A row narrower than the box never reaches that cell, and a
 * row the box fits exactly but closed by a single-width glyph does not either.
 */
export function endsOnWideGlyphInLastCell(row: string, cols: number): boolean {
  if (stringWidth(row) !== cols) return false;
  const codePoints = Array.from(row);
  return stringWidth(codePoints[codePoints.length - 1] ?? "") === 2;
}

/**
 * Fold one logical notice line into painted rows. Copy whose full-width fold
 * keeps the last cell free folds at `cols`; a line that would land a wide glyph
 * there re-folds one cell narrower, which is enough for every row of that line
 * because a row of at most `cols - 1` cells cannot close on a wide glyph. Below
 * 3 columns no width both folds and keeps that cell free (one wide glyph alone
 * equals the box), so those widths pass the line through untouched.
 */
function foldNoticeLine(line: string, cols: number): ReadonlyArray<string> {
  // EXIT: cols < 3 — no width both folds and keeps the last cell free.
  if (cols < 3) return wrapModalLines(line, 0);
  const rows = wrapModalLines(line, cols);
  // EXIT: a row would close on a wide glyph — refold one cell narrower.
  return rows.some((row) => endsOnWideGlyphInLastCell(row, cols))
    ? wrapModalLines(line, cols - 1)
    : rows;
}

/**
 * Fold notice copy into the physical rows the lane paints (one entry = one
 * row). The lane box has no border and no horizontal padding, so this fold is
 * also the width the lane paints at: the row account and the painted lane read
 * one array instead of two different wrap rules.
 */
export function noticePhysicalLines(
  lines: ReadonlyArray<string> | undefined,
  cols: number
): ReadonlyArray<string> {
  if (lines === undefined || lines.length === 0) return [];
  const folded: string[] = [];
  for (const line of lines) folded.push(...foldNoticeLine(line, cols));
  return folded;
}

/**
 * Transcript minimum height. The chat box is a fixed-height scroll viewport;
 * the notice lane is clipped against this floor so the column never asks the
 * terminal for more rows than it has (unclaimed overflow makes Yoga shrink the
 * bottom chrome, which paints the notice over the prompt).
 */
const CHAT_MIN_VIEWPORT_ROWS = 5;

/**
 * Panel-slot marginBottom (SSOT): `panelSlotRows` books `rows + this` for every
 * panel-type slot (notice / modal / picker / compact), so lane geometry that
 * needs that row subtracts this constant instead of a second literal.
 */
const PANEL_SLOT_MARGIN_ROWS = 1;

/**
 * Rows the notice lane can paint: what the terminal has left once the rest of
 * the bottom chrome (chromeReserveRows with `noticeRows: 0`) and the lane's own
 * marginBottom row are taken, and the transcript floor is kept.
 */
export function noticeLaneBodyRows(
  chromeRowsWithoutNotice: number,
  terminalRows: number
): number {
  return Math.max(
    0,
    terminalRows -
      chromeRowsWithoutNotice -
      CHAT_MIN_VIEWPORT_ROWS -
      PANEL_SLOT_MARGIN_ROWS
  );
}

/**
 * Clip folded notice lines to the lane's body rows: keep the head and replace
 * the tail with `… +N` (the subagent panel's form), so the painted row count
 * still equals the booked row count after clipping.
 */
export function noticeClippedLines(
  folded: ReadonlyArray<string>,
  bodyRows: number
): ReadonlyArray<string> {
  if (folded.length <= bodyRows) return folded;
  // EXIT: bodyRows ≤ 0 — chrome + transcript floor already fill the terminal,
  // so the lane paints nothing and books nothing.
  if (bodyRows <= 0) return [];
  return [
    ...folded.slice(0, bodyRows - 1),
    `… +${folded.length - (bodyRows - 1)}`,
  ];
}

/**
 * Bottom chrome line account (SSOT, unit-testable). Itemized; any new bottom
 * row must update this function:
 *
 *   - bottom breathing-room margin (BOTTOM_MARGIN_ROWS; the trailing spacer
 *     under the last chrome row renders the same constant the ledger books,
 *     which keeps the prompt off the screen edge without an unclaimed row)
 *   - permission mode indicator row, 1 row
 *   - input box rounded frame (inputRows content rows + 2 border rows;
 *     dynamic — more input rows shrink the view budget instead of pushing
 *     history messages out)
 *   - ContextBar usage bar, 1 row
 *   - agent current-status (single unfinished-todo line, agentStatusRows; above mode row)
 *   - the ask line takes no row: TranscriptTail renders it inside the ChatView
 *     scrollbox, which scrolls on its own — reserving a chrome row for it
 *     would shrink the viewport without buying a bottom row
 *   - slash candidate rows (inputValue.trim().startsWith("/") ? … : 0)
 *   - notice body + its own marginBottom=1 (`noticeRows` is the clipped count
 *     from `noticeClippedLines`, never the raw fold count: an unclipped lane
 *     overflows the terminal and Yoga shrinks the chrome below it)
 *   - modal body + its own marginBottom=1
 *   - thinking-picker panel + its own marginBottom=1 (pickerRows follows the modalRows convention)
 *   - compact progress panel + its own marginBottom=1 (compactRows same convention)
 *   - subagent panel below the location row: `panelRows` books its folded
 *     rows (SSOT cap SUBAGENT_PANEL_MAX_ROWS); only the retired identity
 *     strip slot `subagentRows` stays 0 — specs/tui-subagent-transcript-live.md
 *   - shell-parser degrade notice (degradeRows, 0/1; above the input, shares
 *     its predicate with the render slot via shellParseDegradeNoticeShown)
 *   - background-run marker row (present when running-bg sessions exist)
 */
/**
 * Uniform accounting for panel-type slots: default 0; rows > 0 → rows + 1
 * (own marginBottom=1), else 0. notice / modal / picker / compact share this
 * convention — writing `?? 0` + a ternary four times inevitably drifts and
 * pushes chromeReserveRows' complexity past the hard gate.
 */
function panelSlotRows(rows: number | undefined): number {
  const n = rows ?? 0;
  return n > 0 ? n + PANEL_SLOT_MARGIN_ROWS : 0;
}

/**
 * Sum of zero-default slots (missing / explicit 0 both count as 0).
 * `chromeReserveRows` already has 6 tail slots; writing `(x ?? 0)` per item
 * would push this combinator past the S5 complexity hard gate. Folding them
 * into this helper keeps each new slot at one added call line.
 */
function zeroDefaultRows(rows: ReadonlyArray<number | undefined>): number {
  let total = 0;
  for (const n of rows) total += n ?? 0;
  return total;
}

/**
 * /model picker entry projection: implementation lives in model-picker.tsx
 * and is re-exported here. Both app and context-bar consume this
 * "registry → entries" projection; whichever one owned it would force the
 * other into a circular reverse import — so the whole projection family
 * (flatten / route matching / display name) sits in their shared leaf
 * module. Re-export keeps existing call sites (inside app +
 * tests/tui/model-command.test.tsx) importing from the same path.
 */
export { modelPickerEntries } from "./model-picker.js";

/** Index of the current model string in the entry list (not found / empty list → 0). */
export function modelFocusIndexFor(
  entries: ReadonlyArray<ModelPickerEntry>,
  model: string | undefined
): number {
  if (model === undefined) return 0;
  const entry = findEntryByRouteId(entries, model);
  return entry === undefined ? 0 : entries.indexOf(entry);
}

/**
 * Picker row account (chrome budget slot): non-chat view / panel closed →
 * 0; open → `modelPickerRows` by current registry entry count. The ternary
 * was folded from TuiApp inline code into a helper, so a new panel adds one
 * call line instead of a component branch (same motivation as
 * `modelPickerEntries`). **Excludes marginBottom=1** (accounted by the +1
 * in chromeReserveRows, see modelPickerRows).
 */
export function modelPickerRowsFor(
  open: boolean,
  view: TuiView,
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined
): number {
  if (!open || view !== "chat") return 0;
  return modelPickerRows(modelPickerEntries(providers).length);
}

/**
 * Panel render state (`ModelPickerState | null`): non-chat / not open →
 * null (component not rendered). Construction + discrimination folded into a
 * helper so the JSX doesn't spend one branch each on an inline ternary and object literal.
 */
export function modelPickerStateFor(
  open: boolean,
  view: TuiView,
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined,
  focusedIndex: number
): ModelPickerState | null {
  if (!open || view !== "chat") return null;
  return { entries: modelPickerEntries(providers), focusedIndex };
}

/**
 * Panel render state (`ConfigPickerState | null`): non-chat / not open →
 * null (component not rendered). Same folding as `modelPickerStateFor`.
 */
function configPickerStateFor(
  open: boolean,
  view: TuiView,
  focusedIndex: 0 | 1 | 2
): ConfigPickerState | null {
  if (!open || view !== "chat") return null;
  return { focusedIndex };
}

/**
 * picker-family row budget entry point (chrome slot; the config panel
 * (ADR-0096) joins it too): checks config → thinking → memory → model in
 * order and returns the first hit's row count (mutual exclusion is
 * guaranteed by the open-panel paths; here we only read the flags). Ternary
 * folded from TuiApp inline code — a new panel adds one discriminator line,
 * not a component branch (complexity hard gate, same motivation as
 * `subagentRowBudget`). **Excludes marginBottom=1** (accounted by the +1 in chromeReserveRows).
 */
function pickerRowsForBudget(opts: {
  readonly view: TuiView;
  readonly configPickerOpen: boolean;
  readonly thinkingPickerOpen: null | "thinking" | "effort";
  readonly memoryPickerOpen: boolean;
  readonly modelPickerOpen: boolean;
  readonly providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined;
}): number {
  if (opts.view !== "chat") return 0;
  if (opts.configPickerOpen) return configPickerRows();
  if (opts.thinkingPickerOpen !== null)
    return thinkingPickerRows(opts.thinkingPickerOpen);
  if (opts.memoryPickerOpen) return memoryPickerRows();
  return modelPickerRowsFor(opts.modelPickerOpen, opts.view, opts.providers);
}

/**
 * mode-row base label (no yolo marker; the existing wide / narrow
 * projections, folded out of the mode-row JSX). Folding motivation: the yolo
 * red marker (specs/yolo-mode.md) requires the narrow-column (`cols < 40`) and
 * wide-column forms both be visible and each is tested, yet TuiApp clamps cols
 * at a floor of 40 (`Math.max(width ?? 80, 40)`) — the narrow branch is
 * unreachable in a real mount, so it can only be asserted through this pure
 * function.
 *
 * The narrow form carries `plan` as its own token: `plan` became reachable in
 * the TUI via `/permissions`, and a narrow row reading `[def]` while the
 * session denies every write is a false label in the one spot the mode is
 * always on screen.
 */
export function modeRowBaseLabel(opts: {
  readonly graphOn: boolean;
  readonly permMode: PermissionMode;
  readonly cols: number;
}): string {
  return opts.cols < 40
    ? `[${opts.graphOn ? "graph" : opts.permMode === "full_auto" ? "auto" : opts.permMode === "plan" ? "plan" : "def"}]`
    : `mode: ${agentModeLabel({ permission: opts.permMode, graph: opts.graphOn })}`;
}

/**
 * ADR-0119 / specs/yolo-mode.md: the yolo red-marker token — the red
 * (pal.error) text appended to the mode row's tail when yolo is ON,
 * persistent and visible at a glance. The narrow column uses the bracket form
 * (same family as the existing [graph|auto|def]); the wide column uses the
 * ` · ` separator (same separator as the running-seconds suffix). Never
 * empty: the caller renders this node conditionally on yoloOn, so when yolo
 * is OFF the whole node is absent (the mode row is byte-identical to before).
 */
export function modeRowYoloMarker(cols: number): string {
  return cols < 40 ? "[YOLO]" : " · YOLO";
}

/**
 * ADR-0141: the YOLO badge — shown only while the yolo preset is unmodified.
 * One word states all three axes, which is why the row suppresses the axis
 * labels it already names (ADR-0141 ruling 5).
 */
export function yoloBadge(cols: number): string {
  return modeRowYoloMarker(cols);
}

/**
 * ADR-0141: the 无沙箱 marker — shown whenever the fence is retired, from the
 * effective configuration or a live bare descendant. Independent of the badge:
 * `--no-sandbox` has no badge and still shows it.
 */
export function noSandboxMarker(cols: number): string {
  return cols < 40 ? "[无沙箱]" : " · 无沙箱";
}

/**
 * The full mode-row pure projection (specs/yolo-mode.md assertion surface):
 * the base axis labels, then the two DERIVED indicators.
 *
 * Suppression rule (ADR-0141 ruling 5): a per-axis label is dropped only for an
 * axis a VISIBLE indicator already states. The badge states all three axes, so
 * under the yolo preset the row is just the badge plus 无沙箱; a bare fence with
 * no preset has no badge, so every axis label stays.
 */
export function modeRowText(opts: {
  /** The preset in force, or undefined. Drives the badge, never the marker. */
  readonly preset?: PresetId;
  /** Whether the fence is retired — from effective config or a live descendant. */
  readonly fenceRetired: boolean;
  readonly graphOn: boolean;
  readonly permMode: PermissionMode;
  readonly cols: number;
}): string {
  const badge = opts.preset === "yolo" ? yoloBadge(opts.cols) : "";
  const marker = opts.fenceRetired ? noSandboxMarker(opts.cols) : "";
  // The badge names all three axes, so the axis labels drop out only under it.
  const base = badge === "" ? modeRowBaseLabel(opts) : "";
  return base + badge + marker;
}

/**
 * ADR-0141: the two derived indicators, read in one place. The 无沙箱 marker
 * follows the fence posture; the YOLO badge follows the declared preset —
 * neither is entry-sourced. An absent overlay (test entries that build no
 * session) falls back to the `yoloOn` mirror, which is exactly the pre-ADR
 * display.
 */
function readPresetIndicators(
  overlay: PresetOverlay | undefined,
  yoloOn: boolean
): { readonly fenceRetired: boolean; readonly preset: PresetId | undefined } {
  return {
    fenceRetired: overlay?.fenceRetired() ?? yoloOn,
    preset: overlay?.preset(),
  };
}

/**
 * The same projection as `modeRowText`, as renderable nodes. The base labels
 * and the two indicators stay in SEPARATE nodes because they are colored
 * differently (`pal.dim` / `pal.running` for labels, `pal.error` for both
 * indicators) — a single concatenated string cannot carry two colors, so this
 * returns the same three strings the projection concatenates, in the same order.
 *
 * A component rather than inline JSX so the suppression branches do not sit
 * inside `TuiApp` (S5: that function is already over the complexity limit at
 * master and must not get worse).
 */
function ModeRowIndicators(props: {
  readonly preset: PresetId | undefined;
  readonly fenceRetired: boolean;
  readonly graphOn: boolean;
  readonly permMode: PermissionMode;
  readonly cols: number;
}): ReactNode {
  const { preset, fenceRetired, graphOn, permMode, cols } = props;
  const pal = tuiPalette;
  return (
    <>
      <text fg={graphOn || permMode === "full_auto" ? pal.running : pal.dim}>
        {preset === "yolo" ? "" : modeRowBaseLabel({ graphOn, permMode, cols })}
      </text>
      {preset === "yolo" && <text fg={pal.error}>{yoloBadge(cols)}</text>}
      {fenceRetired && <text fg={pal.error}>{noSandboxMarker(cols)}</text>}
    </>
  );
}

/**
 * modal-row budget entry (chrome budget slot): the yolo-confirm > rewind >
 * ask order, returning the matched row count. Folded out of the TuiApp inline
 * ternary into a helper (S5 hard gate, same motivation as
 * `pickerRowsForBudget`): with yolo-confirm closed this function is
 * byte-identical to the old inline form (zero modal row-budget regression).
 */
function modalRowsForBudget(opts: {
  readonly yoloConfirmOpen: boolean;
  readonly rewind:
    | {
        readonly targets: ReadonlyArray<RewindTarget>;
        readonly index: number;
        readonly confirming: boolean;
        readonly rowIndex: number;
      }
    | undefined;
  readonly ask:
    | {
        readonly tool: string;
        readonly summaryHint: string;
        readonly toolUseId?: string;
      }
    | undefined;
  readonly cols: number;
}): number {
  if (opts.yoloConfirmOpen) return yoloModalRows(opts.cols);
  if (opts.rewind !== undefined) {
    return rewindModalRows(
      opts.rewind.targets,
      opts.cols,
      opts.rewind.index,
      opts.rewind.confirming,
      opts.rewind.rowIndex
    );
  }
  if (opts.ask !== undefined) return permissionModalRows(opts.ask, opts.cols);
  return 0;
}

/**
 * Input placeholder text while a picker is open (check order = panel
 * priority: yolo-confirm > rewind > config > model > memory > thinking). Any
 * picker open → its key hint, else undefined (caller falls back to the
 * default text / ask branch). The chain lives in this helper so the component
 * only reads a value (complexity gate: branch bodies in helpers; the text SSOT
 * is here, so the strings asserted by tests don't scatter across JSX).
 */
export function pickerPlaceholderFor(opts: {
  readonly yoloConfirmOpen: boolean;
  readonly rewindOpen: boolean;
  readonly configPickerOpen: boolean;
  readonly modelPickerOpen: boolean;
  readonly memoryPickerOpen: boolean;
  readonly thinkingPickerOpen: null | "thinking" | "effort";
}): string | undefined {
  if (opts.yoloConfirmOpen) {
    return "yolo 确认中（Enter 确认 · Esc 取消）";
  }
  if (opts.rewindOpen) {
    return "回退选择器中（↑↓ 选择 · Enter 确认 · Esc 关闭）";
  }
  if (opts.configPickerOpen) {
    return "设置面板中（↑↓ 选择 · Enter 切换 · Esc 关闭）";
  }
  if (opts.modelPickerOpen) {
    return "模型选择中（↑↓ 选择 · Enter 切换 · Esc 关闭）";
  }
  if (opts.memoryPickerOpen) {
    return "记忆开关中（↑↓ 选择 · Space 切换 · Enter 固定 · Esc 保存退出）";
  }
  if (opts.thinkingPickerOpen === "thinking") {
    return "思考开关中（Space 切换 · Enter 固定 · Esc 保存退出）";
  }
  if (opts.thinkingPickerOpen === "effort") {
    return "思考强度中（←/→ 选档 · Tab 自动 · Enter 固定 · Esc 保存退出）";
  }
  return undefined;
}

/**
 * Skill-name argument for /help: with skills → name list, without →
 * undefined (`helpLines` then drops the whole skills section instead of
 * rendering an empty one). Emptiness check folded into a helper so
 * `case "help"` stays one line.
 */
export function skillNamesForHelp(
  skillList: ReadonlyArray<{ readonly name: string }>
): ReadonlyArray<string> | undefined {
  if (skillList.length === 0) return undefined;
  return skillList.map((entry) => entry.name);
}

/** Typed notice when the /model registry is empty (SSOT string asserted by tests). */
export const MODEL_PICKER_EMPTY_NOTICE =
  "未配置 providers —— 在 ~/.iknow/settings.json 的 llm.providers 里登记（含 id / baseUrl / apiKeyEnv / models）。";

/**
 * /model command landing: empty / absent registry → onEmpty (typed notice,
 * **panel stays closed**); non-empty → onOpen(focus = entry for current
 * model, not found → 0); the caller completes panel mutual exclusion (close
 * thinking / memory) inside onOpen. Case body folded out of handleSubmit,
 * leaving one dispatch line per case.
 */
export function openModelPickerCommand(opts: {
  readonly providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined;
  readonly model: string | undefined;
  readonly onEmpty: (lines: ReadonlyArray<string>) => void;
  readonly onOpen: (focusIndex: number) => void;
}): void {
  const entries = modelPickerEntries(opts.providers);
  if (entries.length === 0) {
    opts.onEmpty([MODEL_PICKER_EMPTY_NOTICE]);
    return;
  }
  opts.onOpen(modelFocusIndexFor(entries, opts.model));
}

/**
 * /config panel key handling (body of the host useKeyboard's
 * `if (configPickerOpen)` branch). Pure routing lives in
 * `reduceConfigPickerKey`; this function only wires actions to callbacks,
 * preserving panel interaction semantics (ADR-0096):
 *  - move → onMove (panel stays open);
 *  - fix (Enter) → dispatch by row: FS row → onToggleFsMode (flip fs holder + persist),
 *    cap row → onToggleSubagentCap (cycle cap holder + persist), worktree
 *    row → onToggleWorktreeOnMutate; when a holder is absent the host
 *    callback itself no-ops. Panel stays open (continuous switching).
 *  - commit (Esc) → onClose only (no staged state to save — Enter persists immediately);
 *  - ignore → no-op.
 * Module-level for the same reason as `applyModelPickerKey`: the host
 * useKeyboard branch body lives in a helper (complexity gate: handler only
 * checks the key + dispatches).
 */
export function applyConfigPickerKey(
  event: ModalKeyEvent,
  opts: {
    readonly focusedIndex: 0 | 1 | 2;
    readonly onMove: (index: 0 | 1 | 2) => void;
    readonly onToggleFsMode: () => void;
    readonly onToggleWorktreeOnMutate: () => void;
    readonly onToggleSubagentCap: () => void;
    /**
     * Forced re-render after fix (observed defect: the holder is a plain
     * object and `get()` doesn't subscribe — without an explicit trigger the
     * on-screen value only updates on the next focus move, so Enter shows no
     * feedback). The host just needs a state counter.
     */
    readonly onRerender: () => void;
    readonly onClose: () => void;
  }
): void {
  const action = reduceConfigPickerKey(event, {
    focusedIndex: opts.focusedIndex,
  });
  switch (action.kind) {
    case "move":
      opts.onMove(action.index);
      break;
    case "fix":
      // Dispatch by focusedIndex: FS row → flip fsMode; worktree row → flip the gate holder;
      // cap row → cycle cap (all three rows active; callbacks no-op when their holder is absent).
      {
        const row = configRowKindFor(opts.focusedIndex);
        if (row === "fsMode") opts.onToggleFsMode();
        else if (row === "worktreeOnMutate") opts.onToggleWorktreeOnMutate();
        else if (row === "subagentCap") opts.onToggleSubagentCap();
      }
      opts.onRerender();
      break;
    case "commit":
      opts.onClose();
      break;
    case "ignore":
      break;
  }
}

/**
 * ADR-0141: the clear hook both permission-flip surfaces pass down — `/permissions
 * set` and the Shift+Tab wheel. Built once here so both call sites read the same
 * closure, and so the branch does not sit inside `TuiApp` (S5).
 */
function permissionClearHook(overlay: PresetOverlay | undefined): () => void {
  return (): void => {
    clearOverlayForUserChange(overlay, "permission");
  };
}

/**
 * Ctrl+O key check (toggle thinking fold): folded out of host useKeyboard
 * inline to keep the branch budget intact for the config-panel guard.
 */
function isThinkingFoldKey(e: KeyEvent): boolean {
  return e.ctrl && e.name === "o";
}

/**
 * Behavior body for Enter on the FS row (fix action → actual holder flip +
 * fire-and-forget persist). Module-level helper: holder absent → no-op
 * (panel still opens/closes; same source-of-truth as argless /config opening
 * without a holder). Failure contract matches `runConfigSlashCommand`'s
 * arg path: UI never throws, notice renders, holder value is not rolled back
 * (it already took effect at runtime; the file state follows the next read).
 */
function toggleFsModeAndPersist(
  props: Pick<TuiAppProps, "fsMode" | "onPersistFsMode" | "presetOverlay">,
  setNotice: (notice: Notice) => void
): void {
  const fsCtx = props.fsMode;
  if (fsCtx === undefined) return;
  // ADR-0141: clear the overlay SYNCHRONOUSLY, before the holder write and
  // before the write-back is issued — not inside the persist callback. A
  // rejected write-back leaves the user's choice effective and never re-seeds
  // the overlay (spec §1).
  clearOverlayForUserChange(props.presetOverlay, "fsMode");
  const next = toggleFsMode(fsCtx.get());
  fsCtx.set(next);
  void props.onPersistFsMode?.(next).catch((err: unknown) => {
    setNotice({ lines: [`文件系统隔离档保存失败：${describeError(err)}`] });
  });
}

/**
 * Behavior body for Enter on the cap row (fix action → cycle cap holder +
 * fire-and-forget persist). Module-level helper: holder absent → no-op
 * (same shape as the FS row's missing `fsMode`). Persist-failure fallback
 * matches `toggleFsModeAndPersist` (UI never throws, notice renders, holder
 * stays applied). `nextSubagentCap` is a closed cycle (3→5→9→15→unlimited→3);
 * holder.set internally rejects invalid literals via `isValidSubagentCapacityValue`.
 */
function toggleSubagentCapAndPersist(
  props: Pick<
    TuiAppProps,
    "subagentCapHolder" | "subagentCapDisplay" | "onPersistSubagentCap"
  >,
  setNotice: (notice: Notice) => void
): void {
  const holder = props.subagentCapHolder;
  if (holder === undefined) return;
  // Start from the holder's live value (same source as display: avoids a
  // visual jump when the panel's subagentCapDisplay lags). Even when display
  // and holder.get() diverge (e.g. another process rewrote settings.json and
  // reloaded), the holder wins — display is just a panel snapshot; runtime
  // truth lives in the holder.
  const current: SubagentCapacityValue = holder.get();
  const next = nextSubagentCap(current);
  holder.set(next);
  // fire-and-forget: the holder already applies (manager honors the new gate
  // on next spawn); persist failure falls back to a host notice and does
  // **not** roll back the holder (same as the FS row). Failure has two
  // channels: ① persist resolves with structured `{ok:false, reason}` (the
  // persist impl catches and returns, no rethrow) → sync notice; ② promise
  // rejection → .catch. Hooking only .catch silently swallows ① (the resolved
  // value is dropped by `void`), leaving the user unable to tell "saved"
  // from "save failed".
  void props
    .onPersistSubagentCap?.({ maxConcurrentWorkers: next })
    .then((res) => {
      if (res.ok === false) {
        setNotice({
          lines: [`子代理并发上限保存失败：${res.reason}`],
        });
      }
    })
    .catch((err: unknown) => {
      setNotice({
        lines: [`子代理并发上限保存失败：${describeError(err)}`],
      });
    });
}

/**
 * Behavior body for Enter on the worktree gate row (fix action → flip
 * worktree holder + fire-and-forget persist). Module-level helper: holder
 * absent → no-op (same shape as the FS / cap rows). Persist-failure fallback
 * is the same: UI never throws, notice renders, the flipped holder is not
 * reverted — whether the gate intercepts already takes effect on the next
 * wave; file state follows the next read. **Never auto-provisions**: flipping
 * ON only restores the "block unbound-tree mutations" behavior (ADR-0037).
 */
function toggleWorktreeOnMutateAndPersist(
  props: Pick<
    TuiAppProps,
    "worktreeOnMutateHolder" | "onPersistWorktreeOnMutate"
  >,
  setNotice: (notice: Notice) => void
): void {
  const holder = props.worktreeOnMutateHolder;
  if (holder === undefined) return;
  const next = toggleWorktreeOnMutate(holder.get());
  holder.set(next);
  void props.onPersistWorktreeOnMutate?.(next).catch((err: unknown) => {
    setNotice({ lines: [`worktree 门禁保存失败：${describeError(err)}`] });
  });
}

/**
 * /model panel key handling (body of the host useKeyboard's
 * `if (modelPickerOpen)` branch). Pure routing lives in
 * `reduceModelPickerKey`; this function only wires actions to callbacks,
 * preserving panel interaction semantics:
 *  - move → onMove (panel stays open);
 *  - fix (Enter) → onSelect(route ID) + onClose (select + persist + close);
 *  - commit (Esc) → onClose only (**no persistence**); focus moves stage no
 *    state, so there is nothing to roll back — see the cancel-semantics note
 *    in model-picker.tsx;
 *  - ignore → no-op.
 * Still closes when the focused entry is missing (registry reloaded to
 * empty), same semantics as the inline version.
 */
export function applyModelPickerKey(
  event: ModalKeyEvent,
  opts: {
    readonly entries: ReadonlyArray<ModelPickerEntry>;
    readonly focusedIndex: number;
    readonly onMove: (index: number) => void;
    readonly onSelect: (routeId: string) => void;
    readonly onClose: () => void;
  }
): void {
  const action = reduceModelPickerKey(event, {
    focusedIndex: opts.focusedIndex,
    entryCount: opts.entries.length,
  });
  switch (action.kind) {
    case "move":
      opts.onMove(action.index);
      break;
    case "fix": {
      const chosen = opts.entries[opts.focusedIndex];
      if (chosen !== undefined) opts.onSelect(modelRouteId(chosen));
      opts.onClose();
      break;
    }
    case "commit":
      opts.onClose();
      break;
    case "ignore":
      break;
  }
}

/**
 * specs/tui-subagent-transcript-live.md: the two subagent lines moved into
 * the in-transcript spawn card (scroll area), so there is no identity strip
 * above the prompt anymore — chrome row account goes to zero. The function
 * name and signature stay so that "no longer accounted" is an explicit
 * declaration rather than an implicit default after deleting the call site
 * (`chromeReserveRows.subagentRows` defaults to 0).
 *
 * The two parameters are **deliberately unused**: the signature archives the
 * shape "this budget used to be a function of view/subagents", and callers
 * still pass real values so a future re-accounting change stays inside this
 * function. The constant 0 return is the contract itself (pinned per view /
 * per live count in tests), not a stub to be filled.
 */
export function subagentRowBudget(
  _view: TuiView,
  _subagents: ReadonlyArray<SubagentInfo>
): number {
  return 0;
}

/**
 * SubagentPanel's chrome row account (replaces the constant 0 in
 * subagentRowBudget). Count the projected lines after maxRows folding — the
 * panel books exactly the rows it occupies, so Yoga negative space no longer
 * spills into the input box; the cap (SUBAGENT_PANEL_MAX_ROWS, same source
 * as the component) keeps the account bounded (decoupled from terminal
 * height / live count). Non-chat view → 0 (panel renders null).
 */
function subagentPanelRowBudget(
  view: TuiView,
  subagents: ReadonlyArray<SubagentInfo>,
  cols: number
): number {
  if (view !== "chat") return 0;
  return projectSubagentLines(
    subagents,
    Date.now(),
    cols,
    undefined,
    SUBAGENT_PANEL_MAX_ROWS
  ).length;
}

/**
 * `/graph` case body: flip the graph holder (same source as Shift+Tab) and
 * sync chrome state. Module-level because an `if (!holder)` branch left
 * inside handleSubmit would push it past the complexity ratchet's HEAD
 * baseline (existing over-threshold functions may only stay flat).
 */
function runGraphSlashCommand(
  props: Pick<TuiAppProps, "graphMode">,
  text: string,
  setGraphOn: (enabled: boolean) => void,
  setNotice: (notice: Notice) => void
): void {
  // `/graph` is the non-TTY peer of Shift+Tab — flips the same holder;
  // parsing and text have a single point in harness/graph/mode.ts (shared by all three entry points).
  const graphCtx = props.graphMode;
  if (!graphCtx) {
    setNotice({ lines: ["图模式未接线（本入口未注入 graph holder）。"] });
    return;
  }
  const res = applyGraphCommand(graphCtx, splitGraphArgs(slashRemainder(text)));
  setGraphOn(graphCtx.get().enabled);
  setNotice({ lines: [res.text] });
}

/**
 * `/config` case body (ADR-0096):
 *  - argless (empty args) → open the panel (mutually exclusive with thinking / memory / model pickers);
 *  - with args → existing `applyFsModeCommand` path; status / set / usage behavior unchanged.
 *
 * Module-level for the same reason as `runGraphSlashCommand` (case-body branches live in a helper).
 */
function runConfigSlashCommand(
  props: Pick<TuiAppProps, "fsMode" | "onPersistFsMode" | "presetOverlay">,
  text: string,
  setNotice: (notice: Notice) => void,
  setConfigPickerOpen: (open: boolean) => void,
  setConfigFocusIndex: (index: 0 | 1 | 2) => void,
  setThinkingPickerOpen: (open: null | "thinking" | "effort") => void,
  setMemoryPickerOpen: (open: boolean) => void,
  setModelPickerOpen: (open: boolean) => void
): void {
  const args = splitConfigArgs(slashRemainder(text));
  // Empty args → open the panel (same design as openModelPickerCommand in
  // model-picker — no holder required to open; with the holder absent the
  // panel still shows but Enter on the FS row flips nothing).
  if (args.length === 0) {
    // Panel mutual exclusion: opening config closes the other pickers (same pattern as model / memory pickers).
    setThinkingPickerOpen(null);
    setMemoryPickerOpen(false);
    setModelPickerOpen(false);
    setConfigPickerOpen(true);
    setConfigFocusIndex(0);
    return;
  }
  // ADR-0092: the args path flips the fs isolation holder (orthogonal to
  // PermissionMode — Shift+Tab never touches it); persist only on a
  // successful switch. Parsing and text have a single point in
  // harness/sandbox/fs-mode.ts (shared by all three entry points).
  const fsCtx = props.fsMode;
  if (!fsCtx) {
    setNotice({ lines: ["文件系统隔离档未接线（本入口未注入 fs holder）。"] });
    return;
  }
  // The app side parses once and the same result drives both the notice and the persist decision.
  // `applyFsModeCommand` internally parses again for the "modify holder" path — that is part of the command SSOT; merging it would require fs-mode.ts to expose `kind` in its return value (out of scope for this entry point).
  const cmd = parseConfigCommand(args);
  // ADR-0141: the same hook, same ordering, on the args path.
  if (cmd.kind === "set") {
    clearOverlayForUserChange(props.presetOverlay, "fsMode");
  }
  const res = applyFsModeCommand(fsCtx, args);
  setNotice({ lines: [res.text] });
  // Persist only on a successful switch (usage / status must not write the file). fire-and-forget: failure never throws (UI fallback), success never blocks input.
  if (res.ok && cmd.kind === "set") {
    void props.onPersistFsMode?.(fsCtx.get()).catch((err: unknown) => {
      setNotice({ lines: [`文件系统隔离档保存失败：${describeError(err)}`] });
    });
  }
}

/** The session-holder slash commands, resolved before handleSubmit's switch. */
type HolderSlashCommand = "graph" | "config" | "permissions";

function isHolderSlashCommand(
  command: TuiSlashCommand
): command is HolderSlashCommand {
  return (
    command === "graph" || command === "config" || command === "permissions"
  );
}

/**
 * The session-holder slash commands share one dispatch entry.
 *
 * `/graph`, `/config` and `/permissions` have the same shape — resolve a
 * holder, run its harness command SSOT, re-read any mirror, show the result as
 * a notice — so they are one guard + one call instead of three switch arms.
 * Bodies stay in the per-command helpers below; this only routes.
 */
function runHolderSlashCommand(
  command: HolderSlashCommand,
  props: TuiAppProps,
  text: string,
  setters: HolderSlashSetters
): void {
  switch (command) {
    case "graph":
      runGraphSlashCommand(props, text, setters.setGraphOn, setters.setNotice);
      return;
    case "config":
      runConfigSlashCommand(
        props,
        text,
        setters.setNotice,
        setters.setConfigPickerOpen,
        setters.setConfigFocusIndex,
        setters.setThinkingPickerOpen,
        setters.setMemoryPickerOpen,
        setters.setModelPickerOpen
      );
      return;
    case "permissions":
      runPermissionsSlashCommand(
        setters.permissionMode,
        text,
        setters.setPermMode,
        setters.setNotice,
        // ADR-0141: the overlay clears a declared permission axis; the persist
        // closure carries the user's choice to the user layer.
        {
          presetOverlay: props.presetOverlay,
          onPersistPermissionMode: props.onPersistPermissionMode,
        }
      );
      return;
  }
}

/**
 * `/permissions` case body: the permission-mode switch, shared with the REPL's
 * `/permissions` (parse / status / usage live once in
 * harness/permission/permissions-command.ts — a second copy of that parse is
 * how the TUI ended up with no entry at all).
 *
 * `plan` is deliberately not a Shift+Tab wheel station (harness/permission/
 * modes.ts), so this command is how a TUI session enters and leaves it; the
 * holder it flips is the same one Shift+Tab and yolo touch.
 *
 * Module-level for the same reason as `runGraphSlashCommand` /
 * `runConfigSlashCommand` (every case in handleSubmit's switch counts toward
 * the S5 gate).
 */
function runPermissionsSlashCommand(
  permissionMode: PermissionModeContext,
  text: string,
  setPermMode: (mode: PermissionMode) => void,
  setNotice: (notice: Notice) => void,
  opts?: {
    /**
     * ADR-0141: the session overlay — passed through so `/permissions set`
     * clears a declared permission axis, and the persist closure below carries
     * the user's choice to the user layer.
     */
    readonly presetOverlay?: PresetOverlay;
    readonly onPersistPermissionMode?: (mode: PermissionMode) => Promise<void>;
  }
): void {
  const res = applyPermissionsCommand(
    permissionMode,
    splitPermissionArgs(slashRemainder(text)),
    {
      onUserPermissionChange: permissionClearHook(opts?.presetOverlay),
    }
  );
  // The permMode mirror has no subscription to the holder, so every writer
  // re-reads it after the flip (same discipline as the yolo and Shift+Tab arms).
  setPermMode(permissionMode.get());
  setNotice({ lines: [res.text] });
  // ADR-0141 §5: user-layer write-back only, and only for a posture settings
  // may hold. `full_auto` is a per-session operator choice (ADR-0090), so it is
  // applied in memory and never persisted.
  if (res.ok && permissionMode.get() !== "full_auto") {
    const next = permissionMode.get();
    void opts?.onPersistPermissionMode?.(next).catch((err: unknown) => {
      setNotice({ lines: [`权限模式保存失败：${describeError(err)}`] });
    });
  }
}

/**
 * Bottom breathing-room margin (SSOT, shared by both sides of the ledger):
 * chromeReserveRows books this many rows and the chat render tree emits a
 * trailing spacer of exactly this height, so the prompt never sits flush
 * against the screen edge while reserve and rendered rows stay equal.
 * Pinned by tests/tui/chrome-footer-order.test.tsx (frame row indices).
 */
export const BOTTOM_MARGIN_ROWS = 1;

interface QuitConfirmationSnapshot {
  readonly fingerprint: string;
  readonly waitSet: ReadonlyArray<Promise<unknown>>;
}

function quitConfirmationChanged(
  previous: QuitConfirmationSnapshot | undefined,
  current: QuitConfirmationSnapshot
): boolean {
  return (
    previous === undefined ||
    previous.fingerprint !== current.fingerprint ||
    previous.waitSet.length !== current.waitSet.length ||
    previous.waitSet.some((turn, index) => turn !== current.waitSet[index])
  );
}

function clearQuitConfirmationOnOtherInput(
  pending: boolean,
  text: string,
  clear: () => void
): void {
  if (!pending || text === "/quit" || text === "/exit") return;
  clear();
}

function shouldIgnoreSubmit(text: string, quitting: boolean): boolean {
  return text.length === 0 || quitting;
}

function continueKeyRoutingAfterQuitConfirmation(
  eventType: string,
  key: string,
  pending: boolean,
  cancel: () => void
): boolean {
  if (eventType !== "press") return false;
  if (!pending || key !== "escape") return true;
  cancel();
  return false;
}

function backgroundTaskChromeLines(
  tasks: ReadonlyArray<BackgroundLiveTask>
): ReadonlyArray<string> {
  const visible = tasks
    .slice(0, 3)
    .map(
      (task) => `本 TUI 后台任务 ${task.task_id} · 会话 ${task.conversation_id}`
    );
  if (tasks.length > visible.length) {
    return [
      ...visible,
      `… 本 TUI 还有 ${tasks.length - visible.length} 个后台任务`,
    ];
  }
  return visible;
}

function backgroundTaskLinesForView(
  view: TuiView,
  tasks: ReadonlyArray<BackgroundLiveTask>
): ReadonlyArray<string> {
  return view === "chat" ? backgroundTaskChromeLines(tasks) : [];
}

function acceptedTurnTarget(
  targetId: string | undefined,
  quitting: boolean
): string | undefined {
  if (targetId === undefined || quitting) return undefined;
  return targetId;
}

async function ensureSessionForOpenTurn(
  isQuitting: () => boolean,
  ensureSession: () => Promise<string | undefined>
): Promise<string | undefined> {
  if (isQuitting()) return undefined;
  const conversationId = await ensureSession();
  return isQuitting() ? undefined : conversationId;
}

function createQuitConfirmationSnapshot(input: {
  readonly plan: ReturnType<typeof planQuitBusy>;
  readonly sessions: Readonly<Record<string, TuiSessionState>>;
  readonly inflightTurns: ReadonlyMap<string, ReadonlySet<Promise<unknown>>>;
  readonly liveBackgroundTasks: ReadonlyArray<BackgroundLiveTask>;
  readonly liveSubagents: ReturnType<TuiAppProps["bridge"]["listSubagents"]>;
}): QuitConfirmationSnapshot {
  return {
    fingerprint: quitBusyFingerprint({
      sessions: input.sessions,
      inflightTurns: input.inflightTurns,
      liveBackgroundTasks: input.liveBackgroundTasks,
      subagents: input.liveSubagents,
    }),
    waitSet: input.plan.waitSet,
  };
}

function confirmQuitIfNeeded(input: {
  readonly plan: ReturnType<typeof planQuitBusy>;
  readonly pending: boolean;
  readonly previous: QuitConfirmationSnapshot | undefined;
  readonly snapshot: QuitConfirmationSnapshot;
  readonly save: (snapshot: QuitConfirmationSnapshot) => void;
  readonly show: (lines: ReadonlyArray<string>) => void;
}): boolean {
  const changed =
    input.pending && quitConfirmationChanged(input.previous, input.snapshot);
  if (!(input.plan.needsSecondConfirm && !input.pending) && !changed) {
    return false;
  }
  input.save(input.snapshot);
  input.show(
    changed
      ? quitConfirmationRefreshLines()
      : quitBusyNoticeLines(input.plan.hasStoppableWork)
  );
  return true;
}

function backgroundTaskFingerprint(
  tasks: ReadonlyArray<BackgroundLiveTask>
): string {
  return JSON.stringify(
    tasks
      .map((task) => JSON.stringify([task.task_id, task.conversation_id]))
      .sort()
  );
}

/**
 * 1Hz subagent poll signature. It must cover the union of the fields the two
 * hosts render: the card projection (`subagent-message-lines.ts` — toolUseId,
 * state, role, title, activity) and the bottom panel (taskPreview, startedAt,
 * endedAt, summary / reason, conversationId / foreground). The wall-clock
 * values (`elapsedSec` / `ageSec` / retention windows) are derived at render
 * time, not stored on `SubagentInfo`; `subagentPollSignature` adds the current
 * second while any row renders them. Per-item strings are sorted so a shuffled
 * list still matches.
 *
 * The ref compare in `refreshLiveProjections` uses this to skip
 * `setSubagents` when nothing visible changed, avoiding a whole-tree repaint
 * every tick. `subagentCardsKey` is the card host's narrower signature; this
 * one intentionally adds the panel-only fields.
 */
export function subagentFingerprint(list: ReadonlyArray<SubagentInfo>): string {
  return JSON.stringify(
    list
      .map((s) =>
        JSON.stringify([
          s.taskId,
          s.state,
          s.startedAt,
          s.endedAt ?? null,
          s.summary ?? null,
          s.reason ?? null,
          s.role ?? null,
          s.title ?? null,
          s.activity ?? null,
          s.toolUseId ?? null,
          s.conversationId ?? null,
          s.foreground === true,
          s.taskPreview,
        ])
      )
      .sort()
  );
}

/**
 * Whether the subagent projection's rendered text depends on the wall clock
 * at `nowMs`. A live row prints elapsed seconds; a terminal row stays visible
 * (failed, 30 s window) or counted (`✓ N 完成`, 5 s window) only until its
 * retention window elapses. The 1Hz poll must repaint while this holds even
 * when every content field is unchanged, or the elapsed time freezes and an
 * expired row lingers. Once no row depends on the clock (or the list is
 * empty), the content fingerprint alone can gate the poll.
 */
function subagentsNeedClockTick(
  list: ReadonlyArray<SubagentInfo>,
  nowMs: number
): boolean {
  return list.some((s) => {
    if (isLiveSubagent(s)) return true;
    if (s.endedAt === undefined) return false;
    const ageMs = nowMs - Date.parse(s.endedAt);
    if (!Number.isFinite(ageMs)) return false;
    return s.state === "failed"
      ? ageMs <= FAILED_VISIBLE_WINDOW_S * 1000
      : ageMs <= DONE_FADE_WINDOW_S * 1000;
  });
}

/**
 * Poll signature = content fingerprint + (when the projection is clock-
 * sensitive) the current second. Two lists with identical content but a live
 * (or still-retained) row therefore differ between consecutive seconds, so
 * the elapsed timer and the retention windows keep advancing; a fully static
 * projection keeps one signature. Exported for tests.
 */
export function subagentPollSignature(
  list: ReadonlyArray<SubagentInfo>,
  nowMs: number
): string {
  const content = subagentFingerprint(list);
  return subagentsNeedClockTick(list, nowMs)
    ? `${content}|t${Math.floor(nowMs / 1000)}`
    : content;
}

/**
 * Gate for the 1Hz poll: returns the new signature when `setSubagents` must
 * run, or `null` when repainting would be a no-op (same content AND no
 * clock-sensitive row). Exported so the skip behavior is pinned by a unit
 * test without rendering the whole TuiApp.
 */
export function subagentPollSignatureIfChanged(
  previousSignature: string,
  list: ReadonlyArray<SubagentInfo>,
  nowMs: number
): string | null {
  const signature = subagentPollSignature(list, nowMs);
  return signature === previousSignature ? null : signature;
}

export function chromeReserveRows(opts: {
  readonly noticeRows: number;
  readonly inputHintRows: number;
  readonly bgLine: boolean;
  /** Visible content lines of the input box (textarea logical rows). Default 1 → budget 3 (equals the old fixed value); internally capped at MAX_INPUT_LINES (line-account SSOT, guards against oversized values squeezing the view). */
  readonly inputRows?: number;
  readonly modalRows?: number;
  readonly pickerRows?: number;
  /** Subagent status panel rows: folded actual row count (cap SUBAGENT_PANEL_MAX_ROWS; always equal to the panel's rendered height). The function still accepts explicit values (unit tests / legacy callers). */
  readonly panelRows?: number;
  /**
   * specs/tui-subagent-transcript-live.md: the identity strip above the
   * prompt is removed — the two lines now render on the spawn card inside
   * the session transcript (scroll area, no chrome reservation). Product
   * path is always 0 (return of `subagentRowBudget`); explicit values are
   * only for unit tests / legacy callers. Default 0 → no rows. (The
   * `panelRows` slot books the folded panel rows, so the two slots no
   * longer share the convention.)
   */
  readonly subagentRows?: number;
  /** Agent current-status rows (actual output of agentStatusLines, 0-1). Default 0 → no rows (no snapshot / component renders null / legacy behavior). */
  readonly agentStatusRows?: number;
  /** Environment pane independent slot rows (actual output of envSnapshotLines, 0-2). Default 0 → no rows (no events / component renders null / legacy behavior). */
  readonly envPaneRows?: number;
  /** Verify closed-loop terminal banner rows (actual output of projectVerifyBanner, 0 or 1). Default 0 → no rows (no verify / slot=none → component renders null). */
  readonly verifyRows?: number;
  /** run_graph chrome single row (0 or 1). Default 0 → no rows without a snapshot. */
  readonly graphRows?: number;
  /**
   * shell-parser degrade notice row (0 or 1): shellParseDegradeNotice renders
   * it above the input whenever the parse foundation reports UNAVAILABLE.
   * Default 0 → no rows while the parser answers normally.
   */
  readonly degradeRows?: number;
  /** Compact progress panel rows (compactProgressRows(), 6). Default 0 → no rows when the panel is closed (legacy callers / non-compaction paths unaffected). */
  readonly compactRows?: number;
  /** One row for the unread turn-gap line above the composer. Default 0. */
  readonly queueRows?: number;
  /** Visible owner-labelled live background task rows. Default 0. */
  readonly backgroundTaskRows?: number;
}): number {
  const inputContentRows = Math.max(
    1,
    Math.min(opts.inputRows ?? 1, MAX_INPUT_LINES)
  );
  // Pure additive tail slots (items whose marginBottom is already expressed by their own +1), summed per item.
  const tailRows =
    panelSlotRows(opts.noticeRows) + // notice + marginBottom
    panelSlotRows(opts.modalRows) +
    panelSlotRows(opts.pickerRows) +
    panelSlotRows(opts.compactRows) + // compact progress panel + marginBottom
    // Sum of zero-default slots (missing 0 = no rows): per-item `?? 0` would
    // push this function past the complexity hard gate, so they share one folding
    // helper (same motivation as panelSlotRows).
    zeroDefaultRows([
      opts.panelRows,
      opts.subagentRows,
      opts.agentStatusRows,
      opts.envPaneRows,
      opts.verifyRows,
      opts.graphRows,
      opts.degradeRows,
      opts.queueRows,
      opts.backgroundTaskRows,
    ]) +
    (opts.bgLine ? 1 : 0); // background-run marker row
  return (
    BOTTOM_MARGIN_ROWS + // bottom breathing-room margin — the trailing spacer
    // below renders exactly this many rows; an unclaimed reserve is the
    // double-count class this function's old `ask slot` term belonged to
    1 + // mode indicator row
    inputContentRows + // input box content rows
    2 + // input box rounded border (top/bottom lines)
    opts.inputHintRows +
    1 + // ContextBar
    tailRows
  );
}

/** TUI tool-event sink (migrated from archive): postToolUse projection subscription. */
export interface TuiToolEventSink {
  readonly emit: (event: TuiToolEvent) => void;
  readonly subscribe: (cb: (event: TuiToolEvent) => void) => () => void;
}

export function createToolEventSink(): TuiToolEventSink {
  const subs = new Set<(event: TuiToolEvent) => void>();
  const sink: TuiToolEventSink = {
    emit: (event) => {
      for (const cb of subs) cb(event);
    },
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
  return Object.freeze(sink);
}

/** Fallback when TuiAppProps.permissionMode is missing (test compat; the
 *  product path passes it explicitly from run.tsx). Module-private, avoiding
 *  a mutable singleton shared across mounts. */
const defaultPermissionModeContext: PermissionModeContext =
  createPermissionModeContext("default");

/** skillCatalog default fallback (empty catalog — fixture / test compat; the
 *  product path injects it from run.tsx via TuiExtensions.skillCatalog). Module-private. */
const emptySkillCatalog: SkillCatalog = Object.freeze({
  search: () => [],
  get: () => undefined,
  all: () => [],
  available: () => [],
  getBodyPath: () => undefined,
});

export interface TuiAppProps {
  readonly bridge: TuiBridge;
  readonly askBridge: TuiAskUserBridge;
  readonly toolEventSink: TuiToolEventSink;
  /**
   * Specs/remote-sync.md §4.3: the seat's input port. Bound once on mount to
   * the latest-render handlers and unbound on unmount. Absent (remote
   * disabled / fixture entries) → nothing is bound.
   */
  readonly remoteInputPort?: RemoteInputPort;
  /**
   * Active-projection publisher (specs/remote-sync.md §4.4): one state per
   * change of active conversation / run state / gap-queue count, and
   * undefined on unmount.
   */
  readonly onProjectionActive?: (
    state: ProjectionActiveState | undefined
  ) => void;
  /**
   * Seat notice sink: the seat registers a `show` callback whose lines enter
   * the existing notice lane; the returned cleanup runs on unmount.
   */
  readonly onRemoteNoticeSink?: (show: (line: string) => void) => () => void;
  /** Session already persisted, passed in by the `iknow tui <session-id>` resume entry; absent = draft. */
  readonly initialSession?: TuiSessionState;
  readonly cwd: string;
  readonly dataDir: string;
  readonly permissionMode?: PermissionModeContext;
  /**
   * ADR-0030: session holder for the graph orchestration overlay. The third
   * stop of the Shift+Tab tri-state cycle and `/graph on|off` flip this same
   * holder (all three entry points share it). Absent → Shift+Tab degrades to
   * the existing two-state permission cycle and `/graph` reports unwired
   * (test / fixture compat; the product path injects it via run.tsx).
   */
  readonly graphMode?: GraphModeContext;
  /**
   * ADR-0092: session holder for the filesystem isolation mode. `/config`
   * flips it in place; the engine (build-engine → bash factory) reads the
   * same holder per call. Absent → `/config` reports unwired (test / fixture
   * compat; the product path injects it via run.tsx).
   *
   * **Orthogonal to PermissionMode**: the Shift+Tab tri-state cycle never
   * touches this holder (authorization axis ≠ FS-mode axis).
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0119 / specs/yolo-mode.md: the yolo-axis holder (same shape as
   * fsMode). `/yolo` reads it to decide the confirm direction; the holder is
   * always the authority (this component never writes it directly — a flip
   * only goes through yoloController's enter / exit action; the snapshot +
   * symmetric bwrap-probe semantics live in harness/sandbox/yolo.ts). Absent
   * → `/yolo` warns not-wired (test / fixture compat; the product path
   * injects it via run.tsx).
   */
  readonly yolo?: YoloContext;
  /**
   * ADR-0141: the session overlay — the single carrier both derived indicators
   * read. Absent (test / fixture entries) → both markers fall back to the yolo
   * mirror, which is the pre-overlay behaviour.
   */
  readonly presetOverlay?: PresetOverlay;
  /**
   * ADR-0141 §5: the user-layer permission write-back. Same shape as
   * `onPersistFsMode` — fire-and-forget, failure renders a notice and never
   * rolls the holder back. Product path injects a closure over
   * `persistPermissionModeChanges` from run.tsx.
   */
  readonly onPersistPermissionMode?: (mode: PermissionMode) => Promise<void>;
  /**
   * ADR-0119 / specs/yolo-mode.md: the yolo enter / exit action single point
   * (fsMode snapshot + global, exit restores the snapshot, symmetric bwrap
   * probe on both the enter and exit sides). The permission axis is not part
   * of it — ADR-0139 made the two axes independent, so entering yolo leaves
   * the permission posture exactly as it was and exiting changes nothing.
   * `/yolo` calls enter() / exit() after confirmation, and
   * YoloActionResult.text goes to the notice. Absent → `/yolo` warns
   * not-wired and does not open the confirm modal (fail-closed: never give
   * the user a panel whose confirmation has no action behind it).
   */
  readonly yoloController?: YoloController;
  /**
   * ADR-0092: persist callback after a `/config` switch (fire-and-forget).
   * Product path injects a closure over `persistFsModeChanges(resolveThinkingSettingsPath(), …)`
   * from run.tsx; tests may inject a spy. Failure never throws (UI fallback
   * via setNotice); success never blocks input.
   */
  readonly onPersistFsMode?: (mode: FsIsolationMode) => Promise<void>;
  /** Persistence target for the permission modal "always allow" — session-level grants registry. */
  readonly sessionGrants?: SessionGrants;
  /**
   * Clipboard-image reader behind the Ctrl+V chord. Absent → the real
   * `readClipboardImage` (host interop + temp file); tests inject a stub that
   * resolves on cue, because a test process cannot reach the host clipboard.
   * The chord owns no other configuration surface: no setting, no timeout knob.
   */
  readonly clipboardImageReader?: ClipboardImageReader;
  /** Test injection: optional initial view (default chat). */
  readonly initialView?: TuiView;
  /** Test / mock injection: callback triggered on renderer.destroy; default = no-op.
   *  Argument = conversationId of the sessions active at quit time (undefined for an
   *  unpersisted draft), so the host can print a resume hint after terminal restore. */
  readonly onQuit?: (
    conversationId?: string,
    inflightTurns?: ReadonlyArray<Promise<unknown>>
  ) => void;
  /** Skill catalog (mixed into slash candidates + /skill-name load-and-send).
   *  Optional: default = empty catalog (fixture / test compat; the product path
   *  injects via run.tsx through TuiExtensions.skillCatalog). This value is an
   *  **assembly-time cache**, refreshed on slash-panel open via `skillRescanner`. */
  readonly skillCatalog?: SkillCatalog;
  /**
   * Rescan seam (`specs/skill-index-increment.md`) — the same holder as the
   * engine's `deps.skillIndexDelta` (once at assembly, shared across
   * sessions). Rescanning the loadable surface when the slash panel opens
   * lets SKILL.md files written mid-session enter candidates immediately.
   * Absent (fixture / test) → candidates stay the `skillCatalog` snapshot
   * (byte-identical to the old behavior).
   */
  readonly skillRescanner?: SkillRescanner;
  /** Live taskRoot cell (specs/skill-load-write-root.md): read for a snapshot
   *  when slash assembles a skill body — the same assembly point as ACI skill()
   *  / hub loadSkillBody. Default = undefined → no trailer (fixture / test compat). */
  readonly liveTaskRoot?: LiveTaskRoot;
  /** Worktree isolation flag (single read point in build-engine
   *  `isolationEnabled`, surfaced here). Since ADR-0079 slash-assembled skill
   *  bodies no longer consume `isolationOn` (no write-root trailer on bodies);
   *  the field stays to keep the TuiAppProps assembly surface compatible with
   *  build-engine passthrough, in case another render surface needs the isolation flag.
   *
   *  The config panel (ADR-0096) reuses this field to show the worktree gate row
   *  (display-only; the flip is driven by the isolation holder sibling of props.fsMode). */
  readonly isolationOn?: boolean;
  /**
   * ADR-0096: display-only projection of the current subagent concurrency cap
   *  (one-time read at startup). undefined → the panel shows a "—" placeholder.
   *  This ticket wires no holder, persists nothing, and triggers no manager
   *  behavior; after the cap holder landed, the runtime cap snapshot replaces it.
   *  This field must never call `SubAgentCapacityError` or mutate
   *  `SubagentManager` — out of the display-only boundary.
   */
  readonly subagentCapDisplay?: SubagentCapDisplay;
  /**
   * ADR-0096: runtime holder for the subagent concurrency cap (same shape as
   * fsMode / graphMode). When present, Enter on the panel cap row cycles
   * holder.set(...) (3→5→9→15→unlimited→3) and persists fire-and-forget via
   * `onPersistSubagentCap` (same failure-fallback contract as the FS row's
   * onPersistFsMode); when absent the cap row stays display-only (legacy behavior).
   *
   * Holding the holder does not make the panel visible — `subagentCapDisplay`
   * (fed from holder.get() by the caller) still controls the row's display
   * text; this prop only decides whether the cap row is editable.
   */
  readonly subagentCapHolder?: SubagentCapacityHolder;
  /**
   * ADR-0096: persist channel for the subagent concurrency cap. Failure is
   * **dual-channel**: the persist impl may resolve with a structured
   * `{ ok: false; reason }` (persistSubagentCapImpl catches internally without
   * rethrowing) or reject outright — both render as an app-side notice.
   * Absent → in-session flip only (holder already applied), no file write
   * (test / legacy host compat).
   */
  readonly onPersistSubagentCap?: (
    patch: SubagentCapPersistPatch
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * ADR-0096: runtime holder for the worktree gate (same shape as fsMode /
   * subagentCapHolder). When present, Enter on the panel worktree row flips
   * holder.set(...) and persists fire-and-forget via
   * `onPersistWorktreeOnMutate`; when absent the row falls back to the
   * static `isolationOn` snapshot and stays display-only.
   *
   * The gate itself never auto-provisions (ADR-0037): flipping ON only makes
   * unbound-tree mutations get intercepted on the next wave, pointing at the create-worktree ACI tool.
   */
  readonly worktreeOnMutateHolder?: WorktreeOnMutateHolder;
  /**
   * ADR-0096: persist channel for the worktree gate (isolation.worktreeOnMutate, user layer).
   * Same as onPersistFsMode: returns a promise; failure is caught and shown as a
   * notice, and the applied holder is not reverted. Absent → in-session flip
   * only, no file write (test / legacy host compat).
   */
  readonly onPersistWorktreeOnMutate?: (on: boolean) => Promise<void>;
  /** MCP dashboard extension surface (TuiMcpViewExt minimal dependency). Default =
   *  undefined → /mcp view switch shows "MCP not wired". Product path injects via
   *  run.tsx through TuiExtensions; fixture / tests may stub. */
  readonly mcp?: TuiMcpViewExt;
  /**
   * Subscription point for the env-derived display snapshot (current model
   * route string + thinking baseline). The product path assembles and passes it
   * from run.tsx (single publication point of the `env.llm` projection).
   *
   * Unwired (fixture / the many TuiApp-mounting tests) → a module-level lazy
   * empty store: reads are always undefined (/info omits the `Model:` line,
   * ContextBar omits the model segment), and subscriptions never fire —
   * equivalent to "env never changed", matching the old default prop.
   */
  readonly envDisplay?: EnvDisplayStore;
  /**
   * Reverse persistence (bidirectional settings channel): when a /thinking or
   * /effort panel exits via Esc-save, the commit result is projected into a
   * persistable payload handed to the host to write back to settings.json
   * (fire-and-forget, never blocking panel state updates). A
   * `{ ok: false; reason }` return or a throw → the app renders a notice; the
   * in-memory override has already applied (this session). No notice on
   * success (writeback is a background act; panel Esc is itself the feedback).
   * Optional: default undefined → panel behaves exactly like a pure in-memory
   * override (test / fixture compat).
   */
  readonly onPersistThinking?: (
    patch: CommittedThinkingPatch
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * /memory panel Esc writeback to settings.memory. Optional: default →
   * in-session preview only (test compat). Live flags are injected by the
   * host and updated in sync on Esc.
   */
  readonly onPersistMemory?: (
    patch: CommittedMemoryPatch
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly defaultMemory?: {
    readonly autoExtract?: boolean;
    readonly dream?: boolean;
  };
  readonly memoryFlags?: {
    autoExtract: boolean;
    dream: boolean;
  };
  /**
   * memory-toggle-live: invalidation handle for the memory_layer system
   * snapshot (build-engine invalidateMemorySystem passed through deps).
   * Called on /memory commit; the flip takes effect on the next turn.
   * Default (tests / legacy hosts) → not called.
   */
  readonly invalidateMemorySystem?: () => void;
  /**
   * ADR-0093 / specs/tui-model-command.md: provider registry (startup snapshot
   * of settings `llm.providers`). Data source of the `/model` panel — expanded
   * into flat provider × models entries. Default / empty array → `/model`
   * shows the MODEL_PICKER_EMPTY_NOTICE without opening the panel (test /
   * fixture compat, unchanged behavior).
   */
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  /**
   * ADR-0093 / ADR-0145: persist channel after Enter-selection in the `/model`
   * panel. The host must **explicitly refresh env and rebuild the adapter** after
   * writing settings.json (the self-write sentinel swallows the watcher event
   * caused by its own writeback, so reloadFromEnv is not triggered
   * automatically). A `{ ok: false; reason }` return or a throw → the app
   * renders a notice; no notice on success (writeback is a background act).
   * Default undefined → selection only closes the panel (pure UI, test compat).
   *
   * `conversationId` is the ACTIVE conversation (undefined for a draft — a
   * draft has no conversation yet). ADR-0145: the host sets THIS conversation's
   * route first (the conversation owns it) and then writes the default for
   * conversations started later. `stage: "route"` = the route did not resolve:
   * nothing changed (the conversation kept its old route, the default was not
   * written either).
   */
  readonly onPersistModel?: (
    patch: { readonly model: string },
    conversationId: string | undefined
  ) => Promise<
    | { ok: true }
    | {
        ok: false;
        reason: string;
        stage?: "route" | "write" | "reload";
      }
  >;
  /**
   * On the streaming arm: how long without an onStream event before the
   * notice is rewritten to "still waiting" (ms). Default = 60_000: silence
   * past the threshold only updates the sticky notice copy, it does
   * **not** auto-dismiss. Tests may inject a small value to avoid a real
   * sleep. Note: this is UI-feedback throttling, **not** the harness-side
   * idle / hardCap decision (the harness still decides fault class via
   * settings.llm.idleTimeoutMs, default 300_000 ≈ 5 min).
   */
  readonly streamingSilenceNoticeMs?: number;
}

interface Notice {
  readonly lines: ReadonlyArray<string>;
}

/** Remote-input notices (specs/remote-sync.md §4.3): the seat's message gets
 *  one line in the same lane as every other TUI notice. */
const REMOTE_SENT_NOTICE = "远程输入：消息已发送";
const REMOTE_QUEUED_NOTICE = "远程输入：消息已排队，将在当前回合结束后发送";

/**
 * UI-feedback throttle: how long the streaming arm may go without onStream
 * events before the notice copy changes to "waiting for model output". The
 * 60s default is UI feedback only and **does not**
 * affect harness-side idle / hardCap decisions — those follow
 * settings.llm.idleTimeoutMs (env > settings > default 300_000, see env.ts).
 * The copy is rewritten in place rather than adding a new notice; the notice
 * box stays sticky (no TTL auto-dismiss) until a stream event resumes.
 * The copy carries no duration: the threshold is host-injectable, and long
 * silence inside a buffered tool input is normal on this model route.
 *
 * Phase gate: by design the harness emits no stream events during tool
 * execution (incl. permission / ask waits), so "no stream bytes" does not
 * imply a stuck model — that phase is gated by `toolPhaseActive` (see
 * nextToolPhaseActive / armSilenceTimer) and must not land in the notice.
 */
const DEFAULT_STREAMING_SILENCE_NOTICE_MS = 60_000;

/**
 * Plan A T6: repaint cadence of the live token-speed suffix. The 800 ms
 * cadence keeps every repaint strictly inside the one-second sample window
 * (a 1 s cadence races the window edge and can miss a short burst), so the
 * rate refreshes ~1.25 times per second instead of per fragment. The timer
 * only runs while a call is generating (cleared on post_call / tool phase /
 * turn end).
 *
 * Exported so the repaint cadence is pinned by the TUI tests instead of a
 * duplicated literal.
 */
export const TOKEN_SPEED_REPAINT_MS = 800;

/**
 * Silence-threshold resolution, pushed down to this leaf function so the
 * `??` doesn't add cyclomatic complexity to the already at-limit `runTurnOnce`.
 * Exported so the spec-pinned default value has an assertion: the threshold
 * is a tuned constant, nothing else would catch a revert.
 */
export function resolveStreamingSilenceNoticeMs(
  override: number | undefined
): number {
  return override ?? DEFAULT_STREAMING_SILENCE_NOTICE_MS;
}

/**
 * Tool-phase tracking (leaf function so its branches don't add to onStream's cyclomatic complexity).
 *
 * "No stream bytes" is an anomaly signal only in the **model phase**: during
 * tool execution (incl. permission / ask waits) the harness emits no stream
 * events by design, and counting that as silence would falsely report
 * "waiting for model" on long tools.
 *
 * The phase discriminator uses event semantics, not the display state
 * `liveToolRuns`: the latter shrinks only on postToolUse, while calls blocked
 * by permissions (denied / hook blocked) **don't** emit postToolUse (the
 * permission-executor blocked branch returns directly), so the display state
 * would stay "running" for the whole turn and a phase gate reading it would
 * under-report until turn end. Event-based criteria have no such hole:
 *   - `tool_call_start` = the model stream already handed over tool_use, tool
 *     execution follows → enter tool phase;
 *   - `agent_status` / `env_snapshot` = boundary events before each model call
 *     (tool batch closed, next model call starting) → leave tool phase; silence
 *     after them is model silence.
 * The only event that arrives during tool execution is graph_progress
 * (run_graph internal progress), which matches neither side, so the phase holds.
 */
export function nextToolPhaseActive(
  active: boolean,
  event: HarnessStreamEvent
): boolean {
  if (event.type === "agent_status" || event.type === "env_snapshot") {
    return false;
  }
  if (event.type === "tool_call_start") return true;
  return active;
}

/**
 * Apply stream events to the pure per-turn speed reducer. The reducer owns
 * call boundaries and rate math; the host supplies time and owns its timer.
 * `tool_call_start` stays in generation because tool-input deltas follow it.
 * `agent_status` / `env_snapshot` mark the next model call when a pre-call
 * usage beat is unavailable. Projected usage never changes speed.
 */
export function tokenSpeedTransition(
  state: TokenSpeedState,
  event: HarnessStreamEvent,
  now: number
): TokenSpeedState {
  return transitionTokenSpeed(state, event, now);
}

/**
 * The active conversation always renders a speed, including zero while a
 * draft has no conversation id or a model call has not emitted output.
 */
function tokenSpeedReadingFor(
  readings: Record<string, TokenSpeedReading>,
  conversationId: string | undefined
): TokenSpeedReading {
  if (conversationId === undefined) return ZERO_TOKEN_SPEED_READING;
  return readings[conversationId] ?? ZERO_TOKEN_SPEED_READING;
}

/**
 * On streaming silence, rewrite the current notice to the "waiting for
 * model" copy. English is the existing convention for sticky notices
 * (docs/CONTEXT.md "sticky notice": English boxes for abnormal stops /
 * transport hangs), consistent with init / interrupt / API-error surfaces.
 * Both lines stay shorter than the notice box inner width, so no wrapping.
 */
const STREAMING_SILENCE_NOTICE_LINES: ReadonlyArray<string> = [
  "⠿ Waiting for model output — no new stream bytes.",
  "Still in the model phase — no new stream bytes yet.",
];

/**
 * Whether the current notice is exactly the streaming-silence copy. A
 * successful finish clears only this procedural hint; more definite sources
 * (stop_summary / abnormal-stop notices) are preserved as-is by identity.
 */
function isStreamingSilenceNotice(notice: Notice | undefined): boolean {
  const lines = notice?.lines;
  return (
    lines !== undefined &&
    lines.length === STREAMING_SILENCE_NOTICE_LINES.length &&
    lines.every((line, i) => line === STREAMING_SILENCE_NOTICE_LINES[i])
  );
}

// specs/tui-skill-slash-catalog.md (skill bare alias): slash matching accepts
// the catalog's unique bare-name aliases; display/loading still use canonical
// names. Aliasing adds no catalog interface — it derives only from the public
// `available()` / `get()` (never re-implement the `:` name-split rule here).
// The surface / projection algorithms live in harness (`loadableOf` /
// `projectSlashEntries`); this file keeps no local copy.

/**
 * **Submit-time** skill-load resolution for slash (discriminated union).
 *
 * `error` and `miss` must stay separate: when the scan fails, "not a skill"
 * is **unknown**, and lying with miss would show the operator "unknown
 * command" (implying the skill doesn't exist) when the real cause is a
 * momentarily unreadable root (`SkillRescanError`).
 */
export type SkillLoadResolution =
  | {
      readonly kind: "hit";
      /** The catalog this hit came from — same instance used for `get(name)`, avoiding split-brain. */
      readonly catalog: SkillCatalog;
      readonly name: string;
      readonly remainder: string;
    }
  | { readonly kind: "miss" }
  | { readonly kind: "error"; readonly error: unknown };

/**
 * Submit-time skill-load resolution for `/name` (miss → rescan once inline).
 *
 * The rescan triggered by opening the slash panel is **async**: typing /
 * pasting `/zz-live` and hitting Enter quickly can submit before it lands,
 * and consulting only the cached list would report a freshly installed skill
 * as "unknown command" (confirmed in a real TUI run). So the submit path
 * rescans as a fallback — hit uses it directly, only a miss triggers a
 * rescan (zero extra IO in the common case).
 *
 * Static vocabulary lines and plain messages short-circuit **before** the
 * scan: `/help` / `/quit` shouldn't pay a full-root scan for a skill-load decision.
 */
export async function resolveSkillLoadAtSubmit(input: {
  readonly text: string;
  /** The current catalog, possibly already refreshed. */
  readonly catalog: SkillCatalog;
  readonly rescanner: SkillRescanner | undefined;
}): Promise<SkillLoadResolution> {
  // Only lines that start with "/" and miss the static vocabulary can be a
  // skill-load (same discipline as parseSkillLoad: static commands win).
  // message / command are an immediate miss with no disk scan.
  if (parseTuiInput(input.text).kind !== "unknown") return { kind: "miss" };
  const attempt = (catalog: SkillCatalog): SkillLoadResolution | undefined => {
    const load = parseSkillLoad(input.text, toSlashEntries(catalog));
    if (load === undefined) return undefined;
    // hit ⟹ `get` must return a value (toSlashEntries derives from the same
    // catalog), but under a partial catalog degrading to miss is more honest
    // than handing the caller an undefined crash.
    if (catalog.get(load.name) === undefined) return undefined;
    return { kind: "hit", catalog, name: load.name, remainder: load.remainder };
  };
  const cached = attempt(input.catalog);
  if (cached !== undefined || input.rescanner === undefined) {
    return cached ?? { kind: "miss" };
  }
  let fresh: SkillCatalog;
  try {
    fresh = await input.rescanner.rescan();
  } catch (error) {
    return { kind: "error", error };
  }
  return attempt(fresh) ?? { kind: "miss" };
}

/**
 * Submit-time skill-load **disposition** (the caller contract of
 * `resolveSkillLoadAtSubmit`).
 *
 *   - `not-skill`: not a skill-load (plain message / static command / miss) →
 *     caller falls back to existing routing;
 *   - `notice`: show the operator one notice (missing / scan failure / body
 *     assembly failure), don't send;
 *   - `send`: hit and body assembled → caller `sendTurn`s.
 *
 * Module-level pure function so these branches stay out of the god
 * component's `handleSubmit` (complexity ratchet).
 */
export type SkillLoadOutcome =
  | { readonly kind: "not-skill" }
  | { readonly kind: "notice"; readonly lines: readonly string[] }
  | {
      readonly kind: "send";
      readonly sendText: string;
      readonly displayText: string;
    };

/**
 * Decide and assemble one submit-time skill-load (see `SkillLoadOutcome`).
 *
 * The three "not a skill" paths converge here so `handleSubmit` needs only
 * two branches: static-command / plain-message short-circuit, parse miss,
 * and `get` coming up empty.
 */
export async function resolveSkillLoadSubmit(input: {
  readonly text: string;
  readonly catalog: SkillCatalog;
  readonly rescanner: SkillRescanner | undefined;
}): Promise<SkillLoadOutcome> {
  const resolved = await resolveSkillLoadAtSubmit(input);
  if (resolved.kind === "error") {
    return {
      kind: "notice",
      lines: [formatSkillRescanFailure(resolved.error)],
    };
  }
  if (resolved.kind === "miss") return { kind: "not-skill" };
  const entry = resolved.catalog.get(resolved.name);
  // specs/skill-index-increment.md: `disable-model-invocation` gates only the
  // model index and `skill()`, **not** the human-side slash — a disabled entry
  // is still loadable via `/` (same tier as a missing description). The only
  // gate left here is "not in the catalog".
  if (entry === undefined) {
    return {
      kind: "notice",
      lines: [`技能 ${resolved.name} 不可用（不存在）。`],
    };
  }
  try {
    // ADR-0079 — skill bodies carry no write-root trailer anymore.
    // Write-situation disclosure is handled by the worker prior + chat-session
    // rebind one-time notice. Slash assembly uses the entry + dir single form;
    // liveTaskRoot / isolationOn are still held by this component for chrome
    // rendering (sessionLocationLines via resolveWorktreeChromeRoot) but not
    // consumed on this path.
    const body = await createSkillBody({ entry, dir: entry.dir });
    // displayText uses the same closed-envelope form (empty body + same
    // remainder) so the render layer's `projectSkillLoadUserText` extracts the
    // same `{name, remainder}` — the in-flight echo and the persisted
    // transcript render identically (chip-only or chip+remainder); the old
    // Chinese "[load skill X]" placeholder is gone. After the turn finishes,
    // the persisted authoritative message is atomically replaced.
    return {
      kind: "send",
      sendText: buildSkillLoadText(resolved.name, body, resolved.remainder),
      displayText: buildSkillLoadText(
        resolved.name,
        "",
        resolved.remainder.length > 0 ? resolved.remainder : undefined
      ),
    };
  } catch (err) {
    return { kind: "notice", lines: [`加载技能失败：${describeError(err)}`] };
  }
}

/**
 * Whether the slash panel is open (the rising-edge signal for
 * `useLiveSkillCatalog`).
 *
 * Module-level pure function (one more inline criterion in the god component
 * means one more complexity notch), and it **single-sources** the "panel
 * open" predicate: `inputHintSuggestions` and `hintRows` each inlined it, and
 * this hook is the third consumer — three hand-rolled copies would drift the
 * moment "open" semantics change (e.g. allowing a space after `/`).
 */
function slashPaletteOpen(inputValue: string): boolean {
  return inputValue.trim().startsWith("/");
}

/**
 * Slash candidate projection (specs/skill-index-increment.md: the human-side
 * slash uses the **loadable-skills surface** — including description-less
 * entries and `disable-model-invocation` ones — not the model index surface).
 *
 * The algorithm itself lives in harness (`projectSlashEntries`) so TUI / CLI
 * / hub share one implementation instead of mirrors. This function only keeps
 * the TUI host's name and shape (existing tests / slash.ts consumers unchanged).
 */
export function toSlashEntries(
  catalog: SkillCatalog
): ReadonlyArray<SkillEntryLike> {
  return projectSlashEntries(catalog);
}

/**
 * ADR-0119: initial-value seeding for the yolo ON mirror — S5 extraction
 * (inlining three `??` in TuiApp's useState seed would push the god component
 * past the complexity gate).
 *
 * Precedence: the controller's holder is the authority (when present, its
 * reading wins) → the bare holder → false (not-wired = non-yolo, fail-closed).
 */
function seedYoloOn(props: TuiAppProps): boolean {
  const fromController = props.yoloController?.context.get();
  if (fromController !== undefined) return fromController;
  return props.yolo?.get() ?? false;
}

/**
 * The setter surface of the holder-slash family (`/graph`, `/config`,
 * `/permissions`) — a narrowed pass-through of host state, same shape as
 * `YoloSetters`. Grouped so the three commands share one dispatch arm and one
 * call site instead of three copies of the same setter list.
 */
interface HolderSlashSetters {
  /** Permission-mode holder (the resolved one, so `/permissions` flips exactly
   *  the holder Shift+Tab flips). */
  readonly permissionMode: PermissionModeContext;
  readonly setGraphOn: (v: boolean) => void;
  /** The permMode mirror (mode-row label); unsubscribed, so every holder writer
   *  re-reads it after the flip. */
  readonly setPermMode: (mode: PermissionMode) => void;
  readonly setNotice: (v: Notice) => void;
  readonly setConfigPickerOpen: (open: boolean) => void;
  readonly setConfigFocusIndex: (index: 0 | 1 | 2) => void;
  readonly setThinkingPickerOpen: (open: null | "thinking" | "effort") => void;
  readonly setMemoryPickerOpen: (open: boolean) => void;
  readonly setModelPickerOpen: (open: boolean) => void;
}

/** The three setter surface of the yolo confirm modal (a narrowed pass-through of host state). */
interface YoloSetters {
  readonly setYoloConfirming: (v: boolean | undefined) => void;
  readonly setYoloOn: (v: boolean) => void;
  readonly setNotice: (v: { lines: readonly string[] } | undefined) => void;
  /** The permMode mirror (mode-row label). Enter/exit move the permission
   *  holder inside the controller; the mirror has no subscription, so these
   *  branches must re-read it after the flip lands. */
  readonly setPermMode: (mode: PermissionMode) => void;
  readonly permissionMode: PermissionModeContext;
}

/**
 * ADR-0119: the directional asymmetric routing of `/yolo` — S5 extraction
 * (adding this case to handleSubmit's switch would push the god function past
 * the complexity gate).
 *
 *   - not-yolo → open the **enter** confirm modal (dangerous-operation copy,
 *     shaped like /rewind);
 *   - already-yolo → **exit immediately**, no modal (exit is always safe; the
 *     enter/exit asymmetry is pinned by specs/yolo-mode.md), but still through
 *     the bwrap probe — the probe lives inside `controller.exit()`, and on
 *     refusal the state is unchanged and only a notice is shown;
 *   - controller absent = not-wired → typed notice, no panel opened (same
 *     fail-closed as /graph).
 *
 * No idle guard: enter/exit are synchronous holder flips, orthogonal by
 * construction to the in-flight turn's per-call snapshot semantics.
 */
function handleYoloSlash(
  controller: YoloController | undefined,
  setters: YoloSetters
): void {
  if (controller === undefined) {
    setters.setNotice({
      lines: ["yolo 未接线（本入口未注入 yolo controller）。"],
    });
    return;
  }
  if (controller.context.get()) {
    // Exit immediately: no confirmation. Probe refusal → ok:false, holder untouched.
    const result = controller.exit();
    setters.setYoloOn(controller.context.get());
    setters.setPermMode(setters.permissionMode.get());
    setters.setNotice({ lines: [result.text] });
    return;
  }
  setters.setYoloConfirming(true);
}

/** rewind picker's key-action landing surface (a narrowed pass-through of host state). */
interface RewindKeySetters {
  readonly setIndex: (index: number) => void;
  readonly setConfirming: (confirming: boolean) => void;
  readonly setConfirmIndex: (index: number) => void;
  /** cancel: clears targets + index + confirming + notice (Esc collapses). */
  readonly cancel: () => void;
  readonly execute: (target: RewindTarget, restoreCode: boolean) => void;
}

/**
 * Key routing landing while the rewind picker is active — folded out of the
 * host `useKeyboard` closure inline (S5 hard gate; that god closure is already
 * on the ratchet baseline).
 *
 * The reducer is a pure function (rewind-picker); this function only dispatches
 * actions: move/confirm are taken up by host state; execute is produced on
 * confirm-state Enter (at which point the reducer emits no move, so reading the
 * target by the current index is safe); cancel collapses and clears the notice.
 */
function applyRewindModalKey(opts: {
  readonly targets: ReadonlyArray<RewindTarget>;
  readonly index: number;
  readonly confirming: boolean;
  readonly confirmIndex: number;
  readonly keyEvent: KeyEvent;
  readonly setters: RewindKeySetters;
}): void {
  const action = reduceRewindKey(modalKeyEventOf(opts.keyEvent), {
    targets: opts.targets,
    selectedIndex: opts.index,
    confirming: opts.confirming,
    confirmIndex: opts.confirmIndex,
  });
  switch (action.type) {
    case "move":
      // While confirming, move walks the action rows; otherwise the anchors.
      if (opts.confirming) opts.setters.setConfirmIndex(action.index);
      else opts.setters.setIndex(action.index);
      break;
    case "confirm":
      opts.setters.setConfirming(true);
      opts.setters.setConfirmIndex(0);
      break;
    case "execute": {
      const target = opts.targets[opts.index];
      if (target !== undefined)
        opts.setters.execute(target, action.restoreCode);
      break;
    }
    case "cancel":
      opts.setters.cancel();
      break;
    case "ignore":
      break;
  }
}

/**
 * Exclusive key dispatch for the active modal (ADR-0119): priority
 * yolo-confirm > rewind. Folded out of the host `useKeyboard` closure (S5 hard
 * gate: the closure sits on the ratchet baseline, and merging the arms into one
 * call **nets down** its branch count — the switch cases move out too).
 *
 * yolo-confirm is placed before rewind / double-Esc: a dangerous-operation
 * confirmation is the most explicit pending intent, so Enter/Esc must reach it
 * directly, not be hijacked by double-Esc / ask keys. yolo and rewind never
 * actually coexist (both disable the input box and cannot open past each other);
 * the only stackable case is the engine-side ask (tool-authorization wait) —
 * both the render slot and the row accounting are yolo-first, and the ask
 * blocks until the confirmation ends (consistent with the ask's own blocking
 * semantics).
 *
 * @returns true → the key was consumed by the active modal; the caller must
 *   return immediately. false → no active modal; the caller continues the
 *   remaining key routing (the modal-discrimination SSOT is this function —
 *   callers must not re-derive it).
 */
function dispatchActiveModalKey(opts: {
  readonly yolo: {
    readonly confirming: boolean | undefined;
    readonly controller: YoloController | undefined;
    readonly setters: YoloSetters;
  };
  readonly rewind: {
    readonly targets: ReadonlyArray<RewindTarget> | undefined;
    readonly index: number;
    readonly confirming: boolean;
    readonly confirmIndex: number;
    readonly setters: RewindKeySetters;
  };
  readonly keyEvent: KeyEvent;
}): boolean {
  if (opts.yolo.confirming !== undefined) {
    applyYoloConfirmKey(
      reduceYoloConfirmKey(modalKeyEventOf(opts.keyEvent)),
      opts.yolo.controller,
      opts.yolo.setters
    );
    return true;
  }
  if (opts.rewind.targets === undefined) return false;
  applyRewindModalKey({
    targets: opts.rewind.targets,
    index: opts.rewind.index,
    confirming: opts.rewind.confirming,
    confirmIndex: opts.rewind.confirmIndex,
    keyEvent: opts.keyEvent,
    setters: opts.rewind.setters,
  });
  return true;
}

function applyYoloConfirmKey(
  action: YoloKeyAction,
  controller: YoloController | undefined,
  setters: YoloSetters
): void {
  if (action === "ignore") return;
  setters.setYoloConfirming(undefined);
  if (action === "cancel") {
    setters.setNotice(undefined);
    return;
  }
  if (controller === undefined) {
    // The open path is already guarded (no wiring → no panel); the defensive
    // branch keeps the same typed notice.
    setters.setNotice({
      lines: ["yolo 未接线（本入口未注入 yolo controller）。"],
    });
    return;
  }
  const result = controller.enter();
  setters.setYoloOn(controller.context.get());
  setters.setPermMode(setters.permissionMode.get());
  setters.setNotice({ lines: [result.text] });
}

/**
 * With askPending, an input y/n/a answers directly (the modal has yielded the
 * keys → the input box is the fallback).
 *
 * Folding motivation for the module-level helper: every extra `case` in
 * handleSubmit's switch counts toward the S5 complexity gate
 * (SwitchCase[test]), so the branch is extracted per the repo's standing remedy
 * (semantics byte-unchanged: y/yes → once, a/always → always, n/no → reject).
 *
 * Returns true when answered (the caller returns immediately); no pending /
 * not an answer word → false, and the caller continues the slash / message
 * routing below.
 */
function applyAskShortcut(
  pending: TuiPendingAsk | undefined,
  text: string,
  resolve: (ask: TuiPendingAsk, answer: PermissionAnswer) => void
): boolean {
  if (pending === undefined) return false;
  const lower = text.toLowerCase();
  if (lower === "y" || lower === "yes") {
    resolve(pending, "once");
    return true;
  }
  if (lower === "a" || lower === "always") {
    resolve(pending, "always");
    return true;
  }
  if (lower === "n" || lower === "no") {
    resolve(pending, "reject");
    return true;
  }
  return false;
}

/**
 * ADR-0124 §6 「降级不许静默」: the one red row while the parse foundation
 * answers degraded, read from the same getter that chooses the seam's arms. A
 * plain function so the arm mounts at the input box, never in a wrapper that
 * could stay unmounted.
 */
/**
 * One predicate for two consumers: the render slot below and the
 * chromeReserveRows `degradeRows` ledger. They must agree, or the row
 * overflows the budget and Yoga crushes the mode row into the input border.
 */
export function shellParseDegradeNoticeShown(view: TuiView): boolean {
  return view === "chat" && parseFoundationState() === "UNAVAILABLE";
}

function shellParseDegradeNotice(view: TuiView): ReactNode {
  if (!shellParseDegradeNoticeShown(view)) {
    return null;
  }
  return (
    <text fg={tuiPalette.error}>
      {`shell 解析器不可用，已降级到旧扫描：判定仍生效（详见日志）`}
    </text>
  );
}

function GapQueueLine(props: {
  readonly line: string | undefined;
  readonly color: string;
}): ReactNode {
  if (props.line === undefined) return null;
  return <text fg={props.color}>{props.line}</text>;
}

function gapChromeRows(line: string | undefined): number {
  return line === undefined ? 0 : 1;
}

function viewGapLine(
  view: string,
  queue: GapQueue,
  sessionKey: string,
  cols: number
): string | undefined {
  if (view !== "chat") return undefined;
  return gapQueueLine(queue, sessionKey, cols);
}

/** Interrupt copy, unless a queued draft will take the next gap. */
function cancelledTurnNotice(
  queuedDraftWaiting: boolean,
  uncancellable: string | undefined,
  interrupted: boolean | undefined
): { lines: string[] } | undefined {
  if (queuedDraftWaiting) return undefined;
  if (uncancellable !== undefined) return { lines: [uncancellable] };
  if (interrupted === true) return { lines: ["已打断，checkpoint 已保存"] };
  if (interrupted === false) {
    return { lines: ["已打断（无新内容，未落 checkpoint）"] };
  }
  return { lines: ["已打断当前 turn"] };
}

/** Inline ask line for the transcript tail (single source for the host's
 *  non-modal permission hint). The modal owns the question while it is up, so
 *  the inline line exists only when a question is pending and no modal shows
 *  it. Empty hint / empty call id drop their segment; spacing stays fixed. */
export function askLineFor(
  pending: TuiPendingAsk | undefined,
  modalActive: boolean
): string | undefined {
  if (pending === undefined || modalActive) return undefined;
  const hint = pending.summaryHint ? ` ${pending.summaryHint}` : "";
  const call =
    pending.toolUseId.length > 0
      ? ` · call ${shortToolUseId(pending.toolUseId)}`
      : "";
  return `[ask] 允许 ${pending.tool}？${hint}${call} 输入 y/a/n（a=总是允许）`;
}

export function TuiApp(props: TuiAppProps): ReactNode {
  const pal = tuiPalette;
  const permissionMode = props.permissionMode ?? defaultPermissionModeContext;
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const cols = Math.max(width ?? 80, 40);
  const rows = Math.max(height ?? 24, 10);

  // ── State-machine core ─────────────────────────────────────────
  const initial = props.initialSession ?? createDraftSession();
  const initialKey = initial.conversationId ?? DRAFT_SESSION_ID;
  const [sessions, setSessions] = useState<Record<string, TuiSessionState>>(
    () => ({ [initialKey]: initial })
  );
  const [activeKey, setActiveKey] = useState(initialKey);
  const [backgroundTasks, setBackgroundTasks] = useState<
    ReadonlyArray<BackgroundLiveTask>
  >(() => props.bridge.listLiveBackgroundTasks());
  const backgroundTasksSignatureRef = useRef(
    backgroundTaskFingerprint(backgroundTasks)
  );
  const [view, setView] = useState<TuiView>(props.initialView ?? "chat");
  const [inputValue, setInputValue] = useState("");
  // Input history (in-memory, never persisted) keyed per session
  // (conversationId / DRAFT_SESSION_ID). On resume, seedInputHistory projects
  // the persisted transcript's query-user messages as the seed (↑ recall works
  // immediately); afterwards submits append via appendInputHistory (blank
  // skipped + adjacent dedup, same-reference short-circuit). openSessionAt
  // seeds on first attach the same way; switching back to an already-loaded
  // session keeps its history (an existing map key is never reseeded, so
  // in-process appends survive).
  const [inputHistories, setInputHistories] = useState<
    Record<string, ReadonlyArray<string>>
  >(() => ({ [initialKey]: seedInputHistory(initial.messages) }));
  const inputHistory = inputHistories[activeKey] ?? [];
  const [notice, setNotice] = useState<Notice | undefined>(() =>
    turnLaneNoticeFor(initial)
  );
  const [liveToolLines, setLiveToolLines] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  // Structured live tool-call state.
  const [liveToolRuns, setLiveToolRuns] = useState<
    Record<string, ReadonlyArray<LiveToolRun>>
  >({});
  // ADR-0028: TUI reads only the latest status snapshot — per-session-key
  // (conversationId → snapshot, same keyed shape as liveToolRuns).
  // replace-on-event: each event wholesale replaces the slot of its turn's
  // conversationId; no history and no second todo ledger (the single data
  // source is the same snapshot emitted from the same computation point that
  // feeds the harness `<agent_status>` block). Rendering takes only the
  // active session's slot → switching away leaves no stale status behind and
  // switching back still has it. Kept separate from liveToolRuns (in-flight
  // display): never mixed, never fed back into any model-facing field.
  const [agentStatuses, setAgentStatuses] = useState<
    Record<string, AgentStatusSnapshot>
  >(() => {
    const id = initial.conversationId;
    if (id === undefined) return {};
    const snapshot = agentStatusFromMessages(initial.messages);
    return snapshot === null ? {} : { [id]: snapshot };
  });
  // Environment-status single state slot — an independent stream parallel to
  // the ADR-0028 status bar. env is not session-scoped (globally shared): no
  // conversationId keying, replace-on-event with the full projected snapshot;
  // no events yet → null → pane not rendered. Data flows into this UI only,
  // never back into any model-facing field.
  const [envSnapshot, setEnvSnapshot] = useState<EnvSnapshot | null>(
    () => null
  );
  const [graphProgresses, setGraphProgresses] = useState<
    Record<string, GraphProgressSnapshot>
  >({});
  // chrome-focus three-state (input / subagent(row) / graph); reducer SSOT =
  // reduceChromeFocus. `graphViewOpen` remains independent state (full-screen
  // GraphGroupView open/close, triggered by graph-chrome's legacy reducer
  // openView; orthogonal to the three-ring focus switching).
  const [chromeFocus, setChromeFocus] = useState<ChromeFocus>({
    kind: "input",
  });
  // Legacy two-state `graphChromeFocus` kept only for the graph full-screen
  // view's openView decision (graph chrome's own onTabComplete legacy path
  // still exists, see onLeaveToChrome below now using reduceChromeFocus);
  // remove during later cleanup.
  const [graphChromeFocus, setGraphChromeFocus] =
    useState<GraphChromeFocus>("input");
  const [graphViewOpen, setGraphViewOpen] = useState(false);
  const [graphSelectedId, setGraphSelectedId] = useState<string | null>(null);
  const [graphNodeDetail, setGraphNodeDetail] = useState(false);
  // verify terminal slot (conversationId → VerifySlot discriminated union).
  // none = no verify (legal state → banner silent); ok = 4 terminal states;
  // unavailable = illegal wire shape (degraded). sendTurn clears the slot on
  // entry (so the previous turn's verdict can't leak into the next turn's
  // running phase); runTurnOnce writes it after resp via verifyFromWire
  // runtime validation. On resume the transcript has no VerifyAnswerView →
  // slot stays empty; no second ledger is cloned from the transcript (same
  // discipline as agent-status).
  const [verifySlots, setVerifySlots] = useState<Record<string, VerifySlot>>(
    {}
  );
  // Thinking fold-panel expanded state; Ctrl+O folds/unfolds, /thinking toggles (thinking enabled).
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  // Read surface for the env-derived display snapshot: unwired → module-level
  // lazy empty store (reads always empty).
  const envDisplay = props.envDisplay ?? EMPTY_ENV_DISPLAY_STORE;
  // Thinking control-arm toggle (switched by /thinking, decoupled from the
  // fold state). Initial baseline = env defaultThinking.mode === "adaptive";
  // user /effort also calls setEnabled(true).
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(
    () => envDisplay.get().defaultThinking?.mode === "adaptive"
  );
  // Thinking effort level (set by /effort; "" = unspecified → no effort
  // attached). Initial = env defaultThinking.effort.
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffortWire>(
    () => envDisplay.get().defaultThinking?.effort ?? ""
  );
  // Whether the user **personally** changed thinking / effort (ref not state:
  // it only feeds the "should a new env baseline override" decision and never
  // drives rendering itself). Once set, it is never reset for the session —
  // /model switches do **not** reset it either, which is exactly the fixed
  // behavior (the old implementation dragged both states back to the new
  // baseline on every env change, silently discarding the user's manual override).
  const thinkingTouchedRef = useRef(false);
  const effortTouchedRef = useRef(false);
  // New env baseline arrives → backfill only fields the user **never touched**.
  // Writing an identical value to an untouched field is a React bailout (no
  // re-render) — so a "model-only" publish is a zero-render event, and only an
  // override left by /thinking /effort renders when it must explicitly yield
  // to the new baseline. Deliberate trade-off: once the user has touched a
  // field, later env baseline changes never rewrite it this session — the
  // display layer and the per-turn override therefore stay consistent
  // (override is computed relative to the baseline, which comes from the
  // store; if this dragged back to a new baseline, the user's manual edit would
  // be silently swallowed).
  useEffect(() => {
    const unsubscribe = envDisplay.subscribe(() => {
      const snap = envDisplay.get();
      if (!thinkingTouchedRef.current) {
        setThinkingEnabled(snap.defaultThinking?.mode === "adaptive");
      }
      if (!effortTouchedRef.current) {
        setThinkingEffort(snap.defaultThinking?.effort ?? "");
      }
    });
    return unsubscribe;
  }, [envDisplay]);
  // ── thinking-picker panel state (opened by /thinking /effort; null = closed) ──
  // Dual-panel picker (user-decided design): /thinking /effort no longer take
  // effect immediately with a notice; they open an overlay panel. Enter fixes
  // (panel stays open), Esc saves and exits (writes the real thinkingEnabled /
  // thinkingEffort; there is no cancel path). Inside the panel everything is
  // uncommitted staged state (switchPreview / effortFocusIndex /
  // effortFixedIndex); only Esc writes real state.
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState<
    null | "thinking" | "effort"
  >(null);
  // Switch-panel preview state (/thinking): the uncommitted switch value in
  // the panel (Enter/Space/Tab toggle; only Esc-save writes thinkingEnabled).
  const [switchPreview, setSwitchPreview] = useState<boolean>(
    () => thinkingEnabled
  );
  // Effort-panel focused level (/effort): cursor moved by ←/→ (0..4, uncommitted).
  const [effortFocusIndex, setEffortFocusIndex] = useState<number>(
    effortToDisplayIndex(thinkingEffort)
  );
  // Effort-panel fixed level (/effort): in-panel committed pick fixed by Enter
  // (0..4; only Esc-save writes thinkingEffort).
  const [effortFixedIndex, setEffortFixedIndex] = useState<number>(
    effortToDisplayIndex(thinkingEffort)
  );
  const [memoryPickerOpen, setMemoryPickerOpen] = useState(false);
  const [memoryFocusIndex, setMemoryFocusIndex] = useState<0 | 1>(0);
  // /model panel: open = panel visible; focusIndex = focused entry index (the
  // only staged state in the panel). **Focus moves stage no state** — there is
  // no such thing as an "uncommitted model selection" (Enter is the only write),
  // so Esc is neither save-exit nor discard; see the cancel-semantics note in model-picker.tsx.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelFocusIndex, setModelFocusIndex] = useState(0);
  // /config panel (ADR-0096): opened by argless `/config`. FS row Enter persists
  // immediately; the worktree / cap rows were display-only at first and became
  // editable once their holders were wired in.
  const [configPickerOpen, setConfigPickerOpen] = useState(false);
  const [configFocusIndex, setConfigFocusIndex] = useState<0 | 1 | 2>(0);
  // The three rows' holders (FS / worktree / cap) are plain objects — `get()`
  // doesn't subscribe, so a flip triggers no re-render and on-screen values
  // stall until the next focus move (observed defect). This counter only
  // re-renders after a fix; it feeds no decision (values are still read from
  // the holders).
  const [configRenderTick, setConfigRenderTick] = useState(0);
  const [memoryCommitted, setMemoryCommitted] = useState(() =>
    seedMemoryPreview(props.defaultMemory)
  );
  const [memoryPreview, setMemoryPreview] = useState(() =>
    seedMemoryPreview(props.defaultMemory)
  );
  // Effort-panel auto mode (/effort): toggled by Space/Tab; on Esc-save, autoOn
  // takes priority and writes ""=adaptive (keeps auto, no downgrade to a
  // concrete level). Seed = current thinkingEffort==="" → adaptive (fixes the
  // bug where argless /effort on the current auto silently dropped to medium
  // on Esc).
  const [effortAutoOn, setEffortAutoOn] = useState<boolean>(
    () => thinkingEffort === ""
  );
  // Permission-mode mirror (only drives mode-indicator-row re-render).
  const [permMode, setPermMode] = useState(() => permissionMode.get());
  // Graph overlay mirror (same: drives the mode indicator row only; the holder is authoritative).
  const [graphOn, setGraphOn] = useState(
    () => props.graphMode?.get().enabled ?? false
  );
  // Permission modal slot state (dismissed = after Esc collapse, fall back to the input-box y/n prompt).
  const [askModalDismissed, setAskModalDismissed] = useState(false);
  const [permissionIndex, setPermissionIndex] = useState(0);
  const [pendingQuit, setPendingQuit] = useState(false);
  // L3 rewind picker state (checkpoint-rewind; shared by /rewind and double Esc).
  // The active state directly holds the anchor targets projected from the
  // session file (one-time load at selection, reducing closures and async
  // races); selectedIndex / confirming are host-held (pure render, no internal
  // state, same discipline as the permission modal). Switching away from the
  // active session closes the picker (newSession / openSessionAt clear state)
  // so it never hovers over the wrong session.
  const [rewindTargets, setRewindTargets] = useState<
    ReadonlyArray<RewindTarget> | undefined
  >(undefined);
  const [rewindIndex, setRewindIndex] = useState(0);
  const [rewindConfirming, setRewindConfirming] = useState(false);
  // ADR-0119 / specs/yolo-mode.md: the /yolo **enter**-confirmation modal slot
  // (only entry is confirmed; exit is immediate and bypasses the modal — see
  // case "yolo"). undefined = closed; true = enter-confirmation (currently
  // non-yolo). Same discipline as rewind: pure rendering, no internal state,
  // selected index pinned to 0 (the reducer ignores ↑↓). Session switching does
  // not clear this state: yolo is a harness-level axis (not persisted, never
  // enters session files), not session-level UI; and while the confirmation is
  // open the input box is disabled and keys are exclusive, so session switching
  // is unreachable — no cross-session residue path.
  const [yoloConfirming, setYoloConfirming] = useState<boolean | undefined>(
    undefined
  );
  // ADR-0119: the yolo ON mirror (only drives the mode-row red marker
  // re-render; the holder is the authority). The holder's get() does not
  // subscribe (same constraint as the permMode / graphOn mirrors) — flips only
  // happen in this component's confirmation execute branch (mirrored
  // synchronously after enter() returns, together with the permMode mirror the
  // controller's permission flip needs) and case "yolo"'s immediate-exit
  // branch (mirrored after exit() returns); startup `--yolo` is read once by
  // the useState seed.
  const [yoloOn, setYoloOn] = useState(() => seedYoloOn(props));
  // ADR-0141: the 无沙箱 marker reads the fence posture and the YOLO badge
  // reads the declared preset — both off the overlay, so neither is
  // entry-sourced. Absent overlay (test entries) falls back to the yolo mirror.
  const { fenceRetired, preset } = readPresetIndicators(
    props.presetOverlay,
    yoloOn
  );
  // Highlighted row of the three confirm actions. Only read while confirming,
  // and armed to the first action on every entry into the confirm state, so it
  // never carries a stale choice across pickers.
  const [rewindConfirmIndex, setRewindConfirmIndex] = useState(0);
  const lastEscAtRef = useRef<number | undefined>(undefined);

  // Terminals (iTerm2 / WezTerm / kitty etc.) **automatically** paste "the
  // current system clipboard content" into stdin on mouse right-up — a
  // terminal-level feature, not an OpenTUI event. Our right-up copy (OSC52
  // write to clipboard) fires almost simultaneously with the terminal-initiated
  // paste, so chronologically the pasted bytes carry the **pre-OSC52** system
  // clipboard content (not the current selection), which usePaste then writes
  // into the input box — showing up as "right-click copy + right-click paste
  // trigger together, pasting something copied elsewhere earlier". The app
  // cannot stop the terminal from sending bytes, but it can arm a
  // paste-swallow window after the right-up copy (default 250ms, covering the
  // stdin→paste-event parse delay); when usePaste receives a PasteEvent inside
  // the arm window → event.preventDefault() swallows it, never reaching
  // setInputValue. Outside the window (user-initiated Cmd+V) behavior is unchanged.
  const pasteArmedUntilRef = useRef<number>(0);
  // Paste buffer-first single source of truth: app-level usePaste writes the
  // native textarea buffer directly through this handle (same origin as
  // keypress), bypassing React state queuing (for the race, see the header
  // note in tests/tui/input-interleave-race.test.tsx).
  const promptInputRef = useRef<PromptInputHandle | null>(null);
  // A clipboard read is async, so the draft a payload belongs to is the one that
  // was current when Ctrl+V was pressed. This counter names that draft: every
  // change that invalidates it bumps the counter and aborts what is in flight,
  // so a result that arrives late is discarded instead of labelling a composer
  // the user has already replaced. Bumped when the draft discards a payload
  // (submit / Ctrl+C clear / unit deletion, through the draft's own observer)
  // and by the session-switch effect below.
  const clipboardImageGenRef = useRef(0);
  const clipboardImageAbortRef = useRef<AbortController | null>(null);
  // One read at a time, in press order: the host round trip has no fixed
  // duration, so serializing is what makes `[image#N]` numbering — and the
  // submitted block order — follow the gestures.
  const clipboardImageQueueRef = useRef<Promise<void>>(Promise.resolve());

  function invalidateClipboardImageReads(): void {
    clipboardImageGenRef.current += 1;
    clipboardImageAbortRef.current?.abort();
    clipboardImageAbortRef.current = null;
  }

  // Folded-unit table for the composer: the buffer shows `[paste#N …]` /
  // `[image#N]`, this holds the real payload until submit. PromptInput deletes
  // a label as one unit and toggles it with Ctrl+G through the same instance.
  const composerDraftRef = useRef(
    createComposerDraft({
      onPayloadsDiscarded: invalidateClipboardImageReads,
    })
  );
  // The submit whose turn outcome is still unknown, with the payloads it took
  // out of the draft. One slot: a new submit replaces the previous, and every
  // route that consumed the draft settles it — accepted turns drop it, a
  // pre-acceptance rejection hands it back. It is not dropped when `activeKey`
  // changes: the first message of a draft session remaps that key mid-send, and
  // that turn's rejection is exactly the case that must be restorable.
  const pendingSubmissionRef = useRef<SubmittedDraft | null>(null);
  const gapQueueRef = useRef<GapQueue>(emptyGapQueue());
  const [gapQueue, setGapQueue] = useState<GapQueue>(emptyGapQueue());
  const liveTurnsRef = useRef(new Set<string>());
  const drainLockRef = useRef(false);
  // Composer text as it is *now*, for the restore gate: a rejection
  // continuation runs inside the render the submit closure was created in, where
  // `inputValue` still holds the text that was just submitted.
  const composerValueRef = useRef(inputValue);
  useEffect(() => {
    composerValueRef.current = inputValue;
  }, [inputValue]);

  /** The composer's own report, buffer-first: a keystroke counts as touching the
   *  composer before the render that carries it lands. */
  function reportComposerValue(value: string): void {
    composerValueRef.current = value;
    setInputValue(value);
  }

  function claimPendingSubmission(): SubmittedDraft | null {
    const claimed = pendingSubmissionRef.current;
    pendingSubmissionRef.current = null;
    return claimed;
  }

  /** A turn nobody submitted (a background wake, a slash command) must not hand
   *  back the draft an earlier route spent: drop that claim with it. */
  function dropPendingSubmission(): void {
    pendingSubmissionRef.current = null;
  }

  /**
   * Put a rejected submit back, but only while the composer is still untouched:
   * text the user typed since the submit is the worse loss, and pasting the
   * failed draft over it would destroy that. A visibly non-empty composer is
   * its own notice, so no extra message here. The refill sets the controlled
   * value and, when the composer can take it, the buffer: Enter may already
   * have emptied the buffer, and a setState back to the string React had
   * committed does not re-run the sync effect. A disabled composer skips that
   * imperative write, which would be dropped and would leave the adopted
   * payloads with no label to show for them.
   */
  function restoreClaimedSubmission(submitted: SubmittedDraft): void {
    if (promptInputRef.current === null) return;
    if (composerValueRef.current.length > 0) return;
    if (composerDraftRef.current.heldPayloadCount() > 0) return;
    composerDraftRef.current.adoptSubmission(submitted.payloads);
    setInputValue(submitted.displayText);
    // Enter may already have emptied the native buffer. If this restore
    // returns the same string React had committed, setState bails out and
    // the sync effect never runs, so the buffer would stay empty. Write it
    // when the composer can take the write; a disabled one still follows
    // the state-first path above (the imperative write would be dropped).
    if (promptInputRef.current.isEditable()) {
      promptInputRef.current.replaceBuffer(
        submitted.displayText,
        submitted.displayText.length
      );
    }
  }

  /** A submit that never started a turn: its draft was never spent. */
  function restoreRejectedDraft(): void {
    const claimed = claimPendingSubmission();
    if (claimed !== null) restoreClaimedSubmission(claimed);
  }

  /** A turn that threw: only a rejection from before the accepted user message
   *  gives the draft back, anything else may already be in history. A remote
   *  draft never writes the composer (spec §4.3), so it is dropped instead. */
  function settleRejectedDraftTurn(err: unknown): void {
    const claimed = claimPendingSubmission();
    if (
      claimed === null ||
      claimed.origin === "remote" ||
      !isPreAcceptanceRejection(err)
    ) {
      return;
    }
    restoreClaimedSubmission(claimed);
  }

  /** One Ctrl+V press: queue a single clipboard-image read for the live draft. */
  function pasteClipboardImage(): void {
    const generation = clipboardImageGenRef.current;
    clipboardImageQueueRef.current = clipboardImageQueueRef.current.then(() =>
      receiveClipboardImage(generation)
    );
  }

  /** A single-line paste may be an image copy's text flavor, so it queues a
   *  clipboard probe behind the chord: one serialized gesture stream keeps
   *  `[image#N]` numbering in press order whether the user pressed Ctrl+V or let
   *  the terminal paste. Numbering is what the queue guarantees; buffer position
   *  and submitted block order are not, because a chord writes its label at the
   *  live caret and can therefore land after a paste that was pressed later (see
   *  the `order（已知倒置）` case in `tests/tui/composer-clipboard-image.test.tsx`).
   *  The paste's own text is already in the buffer by the time this runs — a
   *  probe must never hold, reorder, or swallow what the user pasted. */
  function probePastedImage(start: number, text: string): void {
    const generation = clipboardImageGenRef.current;
    clipboardImageQueueRef.current = clipboardImageQueueRef.current.then(() =>
      receivePastedImageProbe(generation, start, text)
    );
  }

  /** One clipboard read for a queued gesture, handed the caller's generation
   *  token. `timeoutMs` is the paste probe's bounded budget; the chord omits it
   *  so the reader's own default applies. Null means the gesture went stale: the
   *  caller has no payload to deliver and nothing to say about it. */
  async function readClipboardSnapshot(
    generation: number,
    timeoutMs?: number
  ): Promise<ClipboardImageResult | null> {
    // A paste or press queued behind an invalidation never starts its read.
    if (clipboardImageGenRef.current !== generation) return null;
    const controller = new AbortController();
    clipboardImageAbortRef.current = controller;
    const read = props.clipboardImageReader ?? readClipboardImage;
    let result: ClipboardImageResult;
    try {
      result = await read({
        signal: controller.signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch {
      // A throwing reader breaks its own never-rejects contract, and a rejected
      // link would strand every later press: answer the failure arm instead.
      result = { kind: "error", message: "读取未给出结果" };
    }
    if (clipboardImageAbortRef.current === controller) {
      clipboardImageAbortRef.current = null;
    }
    // The draft moved on while the bytes were in flight — drop the payload and
    // stay silent, since what it was meant for is already gone by the user's
    // own hand. `{kind:"cancelled"}` alone is not enough here: a reader that
    // had already resolved is not aborted by the signal, only stale.
    if (clipboardImageGenRef.current !== generation) return null;
    return result;
  }

  /** The clipboard half of a single-line paste. When the snapshot turns out to
   *  hold a supported bitmap, the text the terminal forwarded was a byproduct of
   *  that same copy, so those exact bytes in the buffer are replaced in place by
   *  `[image#N]`. */
  async function receivePastedImageProbe(
    generation: number,
    start: number,
    text: string
  ): Promise<void> {
    const result = await readClipboardSnapshot(
      generation,
      PASTE_IMAGE_PROBE_TIMEOUT_MS
    );
    // A gesture too stale to deliver is the same outcome as one that found no
    // bitmap: the paste stays exactly as it is.
    if (result === null) return;
    // Anything but a real bitmap leaves the paste exactly as the terminal put it
    // there. Silence is the point: an ordinary text copy is the common answer,
    // and a probe that finds nothing is not a failure the user caused — a read
    // that threw is answered as nothing found, since the paste is already in the
    // buffer either way.
    if (result.kind !== "ok") {
      // A bitmap that is there but refused for size is the one case where the
      // user really did copy an image, so the refusal is reported the way the
      // chord reports it and the pasted link stays put.
      if (result.kind === "too-large") {
        const lines = clipboardImageFailureLines(result);
        if (lines.length > 0) setNotice({ lines });
      }
      return;
    }
    // No composer mounted (list / mcp view), or one that went disabled while the
    // bytes were in flight (focus moved to the chrome, a picker opened) → nothing
    // to substitute into, and the draft stays untouched so no label number is
    // spent on a payload the buffer can never name.
    const input = promptInputRef.current;
    if (input === null || !input.isEditable()) return;
    const buffer = composerValueRef.current;
    const at = locatePastedSpan(buffer, start, text);
    if (at < 0) return;
    const to = at + text.length;
    const label = composerDraftRef.current.addImage({
      mediaType: result.mediaType,
      data: result.data,
    });
    const next = buffer.slice(0, at) + label + buffer.slice(to);
    // replaceBuffer is the deliberate-caret buffer write the fold and label
    // paths already use: it reports the new buffer through onChange, so display
    // and payload table move together in one write.
    input.replaceBuffer(
      next,
      caretAfterLabel(input.getCursorOffset(), at, to, label.length)
    );
  }

  async function receiveClipboardImage(generation: number): Promise<void> {
    const result = await readClipboardSnapshot(generation);
    if (result === null) return;
    if (result.kind === "ok") {
      // No composer mounted (list / mcp view), or one that went disabled while
      // the bytes were in flight → nothing to attach to, and the draft stays
      // untouched so no label number is spent on a payload no buffer names.
      const input = promptInputRef.current;
      if (input === null || !input.isEditable()) return;
      const label = composerDraftRef.current.addImage({
        mediaType: result.mediaType,
        data: result.data,
      });
      // insertText lands the label at the caret as it is *now*; a caret position
      // captured at press time would drop it mid-word after typing during the
      // read. The buffer is display truth: nothing is ever inserted on failure.
      input.insertText(label);
      return;
    }
    const lines = clipboardImageFailureLines(result);
    if (lines.length > 0) setNotice({ lines });
  }

  // The composer buffer and the draft are app-global, so switching the active
  // session is the point where a read in flight stops targeting what the user is
  // looking at. Mounted on the key, not on `[activeKey, active.runState]`: a
  // turn starting or finishing leaves the draft exactly as it was.
  useEffect(() => {
    invalidateClipboardImageReads();
  }, [activeKey]);

  // Ctrl+V: fold one clipboard image into the composer. Its own listener, not an
  // arm in the big global key handler, because this chord has no modal or
  // focus precedence to negotiate — PromptInput yields every ctrl/meta chord
  // except its own Ctrl+G. A bracketed paste does probe the clipboard now, but
  // only when the terminal emitted one: a `Win+Shift+S` screenshot puts a bitmap
  // on the clipboard with no text flavor, so nothing is pasteable and this chord
  // stays the only gesture that can read it. The paste probe covers the image
  // copies that *do* carry a text flavor.
  useKeyboard((e) => {
    if (e.eventType !== "press") return;
    if (!e.ctrl || e.name !== "v") return;
    e.preventDefault();
    pasteClipboardImage();
  });

  // ── Streaming draft (mounted while the single session is in flight; bg sessions
  //    get their final text through the persistence refresh) ───────────────────
  const [streamDraft, setStreamDraft] = useState<StreamDraft | null>(null);
  const [draftSegments, setDraftSegments] = useState<ReadonlyArray<string>>([]);
  const [thinkingDraftMasked, setThinkingDraftMasked] = useState<string>("");
  // Thinking final seconds of the latest turn (snapshot at turn end). Kept
  // for the last history assistant's fold line to show "thought for N
  // seconds". **Not keyed per session**: only the last assistant's retention
  // is displayed, written in the same turn as the mode-row Crunched (same
  // runTurnOnce finally), so a non-current turn never reads it; after
  // switching sessions the last assistant still carries the old turn's
  // thinking seconds (known limitation, no ownership check, same as the
  // original implementation).
  // D3 (tui-display-consistency): the whole in-memory thinking-seconds side
  // channel was removed — no more pin / freeze / ref / store-thunk set of
  // in-memory second variables. The fold line now reads `session.thinkingMs`
  // (persisted data carried by `attachSession` / `turnFinished`;
  // `streamDraft.thinkingSeconds()` remains only as the live "thinking…" read
  // during streaming, no longer frozen or handed back).
  // Run-duration stats (live seconds at the mode row's right edge): stamped
  // at turn start, ticking at 1Hz while running, frozen at turn end.
  // runStartedAt non-null = running (mode row shows `· Xs`); null = finished
  // (mode row clears, stats move to the trailing Crunched line in the message flow).
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsed, setRunElapsed] = useState(0);
  // Plan A T6 token speed. The reducer state lives in a ref: a per-fragment
  // update must not re-render the whole tree on every token. The reading the
  // bar renders lives in React state, keyed by conversation (the same key
  // discipline as liveToolRuns) so a background turn never overwrites the
  // foreground session's suffix.
  const tokenSpeedRef = useRef<Record<string, TokenSpeedState>>({});
  const [tokenSpeedReadings, setTokenSpeedReadings] = useState<
    Record<string, TokenSpeedReading>
  >({});

  /**
   * Plan A T6: store the speed state of one conversation. The reducer state
   * lives in the ref; the bar renders the published reading. Storing does not
   * publish: the live path stores the reducer state on every fragment and
   * publishes only on the repaint tick, so this is the single writer of the
   * ref slot.
   */
  function storeTokenSpeed(
    conversationId: string,
    state: TokenSpeedState
  ): TokenSpeedReading {
    tokenSpeedRef.current[conversationId] = state;
    return readTokenSpeed(state);
  }

  /**
   * Plan A T6: publish one reading of a conversation to the bar. The
   * published value is rounded to whole tok/s, so the tree re-renders only
   * when the number the user sees actually changes (a per-fragment
   * re-render of the whole TUI would be wasteful).
   */
  function publishTokenSpeedReading(
    conversationId: string,
    reading: TokenSpeedReading
  ): void {
    setTokenSpeedReadings((prev) => {
      const current = prev[conversationId];
      if (
        current !== undefined &&
        current.estimated === reading.estimated &&
        Math.round(current.value) === Math.round(reading.value)
      ) {
        return prev; // EXIT: same rounded reading → keep the published one, no re-render
      }
      return { ...prev, [conversationId]: reading };
    });
  }

  /**
   * Plan A T6: store the speed state of one conversation and publish its
   * reading. Used by the boundaries and call ends, which show a zero or an
   * average right away; the live path stores without publishing (the repaint
   * tick publishes).
   */
  function publishTokenSpeed(
    conversationId: string,
    state: TokenSpeedState
  ): void {
    publishTokenSpeedReading(
      conversationId,
      storeTokenSpeed(conversationId, state)
    );
  }
  // Subagent read-only projection (host = bridge.listSubagents). Starts as an
  // empty array — bridge is not called before the first frame, and watch
  // derived false so no timer starts.
  const [subagents, setSubagents] = useState<ReadonlyArray<SubagentInfo>>([]);
  // 1Hz poll signature (mirrors backgroundTasksSignatureRef): the mount effect
  // seeds it so the first poll tick does not repeat the mount set. The poll
  // only calls setSubagents when the signature changes, so an unchanged static
  // set no longer drives a whole-tree repaint every second. A live row or one
  // inside a terminal retention window still ticks each second — its elapsed /
  // expiry text is wall-clock derived (subagentPollSignature appends the
  // current second while that holds).
  const subagentsSignatureRef = useRef("");
  // Session ownership + snapshot seconds of the last finished turn. Cleared
  // at runTurnOnce entry (no stale summary while running), written in finally;
  // ChatView only accepts crunchedSeconds when `crunchedOf === activeKey`,
  // avoiding cross-session mismatch (same ownership check as the old runStatsOf).
  const [crunchedOf, setCrunchedOf] = useState<string | null>(null);
  const [crunchedSeconds, setCrunchedSeconds] = useState(0);
  useEffect(() => {
    if (streamDraft === null) {
      setDraftSegments([]);
      setThinkingDraftMasked("");
      return undefined;
    }
    const unsubscribe = streamDraft.subscribe(() => {
      // Dual defense for streaming: mark high-frequency stream updates as low-priority transitions.
      startTransition(() => {
        setDraftSegments(streamDraft.maskedSegments());
        setThinkingDraftMasked(streamDraft.thinkingMasked());
      });
    });
    setDraftSegments(streamDraft.maskedSegments());
    setThinkingDraftMasked(streamDraft.thinkingMasked());
    // D3: removed the `setInterval` freeze tick — no more frozen seconds handed
    // back to the app layer; the fold line's "thought for N seconds" is taken
    // over by the persisted thinkingMs (`MessageBlocks` reads
    // `session.thinkingMs[messageIndex]`).
    return () => {
      unsubscribe();
    };
  }, [streamDraft]);

  // ── Quit / interrupt / inflight bookkeeping ─────────────────────────────────
  const aborters = useRef(new Map<string, AbortController>());
  const ownedTurnControllers = useRef(new Set<AbortController>());
  const quittingRef = useRef(false);
  const pendingQuitSnapshotRef = useRef<QuitConfirmationSnapshot | undefined>(
    undefined
  );
  // Turn promises attributed per conversation: /quit's wait set has to be able
  // to say which session it is waiting on.
  const inflightTurns = useRef(new Map<string, Set<Promise<unknown>>>());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const subagentWakeRef = useRef<SubagentWake | undefined>(undefined);
  // Dedicated AbortController for manual compaction — decoupled from the
  // turn `aborters` map (turn-interrupt ↔ compaction-interrupt are two
  // independent channels). Only one /compact path can be in flight at a time
  // (a single active session), so one ref slot suffices. The Esc interrupt
  // handler checks this ref before falling back to `canInterrupt(active)`:
  // non-null → compaction cancel. The re-entry guard (prevents duplicate
  // /compact triggers) reads the same ref (synchronous source, no React
  // commit race).
  const compactingControllerRef = useRef<AbortController | null>(null);
  // Compact progress panel (per-conversation keyed, same ownership discipline
  // as liveToolRuns / agentStatuses: events key by the session active at
  // arrival, rendering takes only the active session's entry). Manual /compact
  // and in-turn auto-compact share one reducer — the auto path was previously
  // fully silent to the user, and this panel is its first visualization.
  const [compactPanels, setCompactPanels] = useState<
    Record<string, CompactProgressState>
  >({});
  // Terminal-state dwell timer (conversationId → handle): after a terminal
  // state the panel unmounts HOLD_MS later so 100% / failure colors stay
  // visible. A new compaction start or unmount clears pending timers so a
  // late timer never hits a fresh panel.
  const compactTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );
  /** Clear a pending timer (ref bookkeeping and clearTimeout paired, avoiding leaks). */
  function clearCompactTimer(conversationId: string): void {
    const timer = compactTimersRef.current.get(conversationId);
    if (timer !== undefined) {
      clearTimeout(timer);
      compactTimersRef.current.delete(conversationId);
    }
  }
  /** Immediately remove the panel + clear pending timer (for no-op / turn-finally sweep). */
  function clearCompactPanel(conversationId: string): void {
    clearCompactTimer(conversationId);
    setCompactPanels((prev) => {
      if (!(conversationId in prev)) return prev;
      const { [conversationId]: _dropped, ...rest } = prev;
      return rest;
    });
  }
  /**
   * Arm the HOLD_MS unmount timer (idempotent: already armed → don't reset —
   * timing starts at the first terminal signal, repeated settles never extend
   * the dwell window).
   *
   * Both paths must arm it, entering from different places (the turn path has
   * no promise result to rely on — compaction happens inside the run, so its
   * terminal signal can only come from events): missing either one leaves the
   * panel pinned on screen with `✓ done` forever, still holding its chrome row account.
   */
  function armCompactHoldTimer(conversationId: string): void {
    if (compactTimersRef.current.has(conversationId)) return;
    const timer = setTimeout(() => {
      compactTimersRef.current.delete(conversationId);
      setCompactPanels((prev) => {
        if (!(conversationId in prev)) return prev;
        const { [conversationId]: _dropped, ...rest } = prev;
        return rest;
      });
    }, COMPACT_HOLD_MS);
    compactTimersRef.current.set(conversationId, timer);
  }
  /**
   * Unified terminal-state entry (the promise result is the terminal-state
   * authority): set terminal state + arm the HOLD_MS unmount timer. Panel
   * already gone (cleared / never established) → setState no-op; the timer is
   * still armed but its callback no-ops, no side effects.
   */
  function settleCompactPanelFor(
    conversationId: string,
    kind: CompactTerminalKind
  ): void {
    setCompactPanels((prev) => {
      const current = prev[conversationId];
      if (current === undefined) return prev;
      const next = settleCompactPanel(current, kind, Date.now());
      if (next === current) return prev;
      return { ...prev, [conversationId]: next };
    });
    armCompactHoldTimer(conversationId);
  }
  /**
   * Unified delivery entry for compaction events (shared by the turn and
   * manual paths).
   *
   * Three duties (order-sensitive):
   *  1. `compaction_started` → first clear this conversation's pending hold
   *     timer: a new run has begun, and an in-flight unmount timer from the
   *     previous run would delete **this** run's fresh panel (discipline in
   *     the compactTimersRef comment);
   *  2. reduce into state (identity guard: non-compaction event / unchanged → no re-render);
   *  3. terminal event → arm the HOLD_MS unmount timer.
   *
   * Item 3 is the critical fix: the turn path's terminal state can come
   * **only** from events (compaction runs inside the run, no promise result to
   * rely on); missing the arm leaves a `✓ done` panel on screen forever, still
   * holding its chrome row account. Re-arming on the manual path is an idempotent no-op.
   */
  function applyCompactEvent(
    conversationId: string,
    event: HarnessStreamEvent,
    source: CompactProgressSource
  ): void {
    if (event.type === "compaction_started") {
      clearCompactTimer(conversationId);
    }
    setCompactPanels((prev) => {
      const next = reduceCompactionEvent(prev[conversationId], event, {
        source,
        nowMs: Date.now(),
      });
      if (next === prev[conversationId]) return prev;
      if (next === undefined) {
        const { [conversationId]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [conversationId]: next };
    });
    if (
      event.type === "compaction_completed" ||
      event.type === "compaction_failed" ||
      event.type === "compaction_cancelled"
    ) {
      armCompactHoldTimer(conversationId);
    }
  }
  /**
   * Non-terminal fallback sweep (the "finally hard-sweep" semantics, shared by
   * the turn and manual paths): panel still non-terminal → remove immediately,
   * never leave a fake 95% in-flight state.
   *
   * Why both paths must sweep: the promise result is the terminal-state
   * authority, but only if every path settled something. Both the turn path's
   * terminus (finally) and manual's (catch/finally) could gain future changes
   * that "reach no settle branch" — and the hold timer only starts on settle,
   * so a missed settle means **permanent residue**. Sweeping at both termini
   * downgrades "missed settle" from "permanent residue" to "panel disappears
   * immediately".
   */
  function sweepCompactPanel(conversationId: string): void {
    setCompactPanels((prev) => {
      const current = prev[conversationId];
      if (current === undefined || current.terminal !== null) return prev;
      const { [conversationId]: _dropped, ...rest } = prev;
      return rest;
    });
  }
  // On unmount clear pending timers (guards setState-after-unmount).
  useEffect(() => {
    const timers = compactTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const viewRef = useRef<TuiView>(view);
  viewRef.current = view;
  // Root cause of an intermittent regression (v2 fix): on mouse-down OpenTUI
  // auto-calls clearSelection() when defaultPrevented is false. When
  // right-down lands (a) in a hitTest-miss region or (b) inside a child's
  // stopPropagation chain, preventDefault is missed — clearSelection first
  // resets each touchedRenderable's local selection, then sets
  // currentSelection to null. handleMouseUp then reads getSelection() → null →
  // "no selection". v1 (ref<Selection|null>) held the Selection object
  // reference to dodge the null branch, but still hit "empty selection": the
  // Selection's internal _selectedRenderables pointed at already-reset
  // renderables, so getSelectedText returned "".
  // v2 switches to a value-type cache: listen to OpenTUI's "selection" event
  // (emitted on left-drag-RELEASE, right after finishSelection ran
  // notifySelectablesOfSelectionChange while every touchedRenderable's local
  // selection is still alive) and extract the text string into a ref at that
  // moment. Strings are value types — clearSelection can't touch them;
  // right-up reads the string copy directly.
  const cachedSelectionTextRef = useRef<string>("");
  useSelectionHandler((selection: Selection) => {
    // OpenTUI emits "selection" on left-drag-RELEASE, right after
    // finishSelection has run notifySelectablesOfSelectionChange while every
    // touchedRenderable's local selection is still alive. Extract the text
    // string into the ref immediately — strings are value types, no later
    // clearSelection can alter them.
    cachedSelectionTextRef.current = selection.getSelectedText();
  });

  // ── askPending subscription (mount/unmount of the permission modal) ─────
  const [askPending, setAskPending] = useState<TuiPendingAsk | undefined>(
    props.askBridge.pending()
  );
  useEffect(() => {
    setAskPending(props.askBridge.pending());
    return props.askBridge.subscribe(() =>
      setAskPending(props.askBridge.pending())
    );
  }, [props.askBridge]);

  // ── session-state mirror refs (read from mouse / streaming stale closures) ──
  const dataDirRef = useRef(props.dataDir);
  useEffect(() => {
    dataDirRef.current = props.dataDir;
  }, [props.dataDir]);
  // Copy channel: prefer OSC52, fall back to the native fallback chain on failure.
  // Must ask renderer.isOsc52Supported() before calling OSC52 — some terminals
  // (security policy) silently ignore OSC52 bytes while
  // copyToClipboardOSC52 still returns true, producing a "copied" notice with
  // an empty clipboard. Gate first instead of blindly trusting the native return.
  const doCopy = useCallback(
    async (text: string): Promise<CopyResult> => {
      if (text.length === 0) return { kind: "empty" };
      if (renderer.isOsc52Supported()) {
        let oscOk = false;
        try {
          oscOk = renderer.copyToClipboardOSC52(text);
        } catch {
          oscOk = false;
        }
        if (oscOk) return { kind: "ok", method: "pbcopy" };
      }
      return copyToClipboard(text, { dataDir: dataDirRef.current });
    },
    [renderer]
  );

  /** Set the notice from a copy result (shared by right-click copy). */
  function setNoticeFromCopyResult(text: string, result: CopyResult): void {
    if (result.kind === "ok") {
      setNotice({ lines: [`已复制（${result.method}，${text.length} 字）。`] });
    } else if (result.kind === "fallback") {
      setNotice({
        lines: [
          `剪贴板命令不可用，文本已写入 ${result.path}（${result.bytes} bytes）。`,
        ],
      });
    } else if (result.kind === "error") {
      setNotice({ lines: [`复制失败：${result.message}`] });
    }
  }

  /** Right-button down: extra cache pass + block OpenTUI's auto clearSelection() on down. */
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button === MouseButton.RIGHT) {
        // Belt-and-braces path:
        //   1. cache: useSelectionHandler already stored the text string in
        //      cachedSelectionTextRef at left-drag-RELEASE; here we read
        //      currentSelection once more and rewrite the text — covering "the
        //      selection event never emitted" or "currentSelection not
        //      cleared yet" (e.g. tests that assign currentSelection directly).
        //   2. preventDefault: blocks OpenTUI's default
        //      (!defaultPrevented && down && currentSelection → clearSelection()).
        const live = renderer.getSelection();
        if (live) {
          const text = live.getSelectedText();
          if (text.length > 0) cachedSelectionTextRef.current = text;
        }
        e.preventDefault();
      }
    },
    [renderer]
  );

  /** Right-button up: copy the cached selection text (extracted earlier by useSelectionHandler). */
  const handleMouseUp = useCallback(
    (e: MouseEvent) => {
      if (e.button !== MouseButton.RIGHT) return;
      const text = cachedSelectionTextRef.current;
      cachedSelectionTextRef.current = "";
      if (text.length === 0) {
        // Empty cache: either nothing was ever drag-selected, or the last
        // emit's Selection.getSelectedText() itself returned "" (e.g. the user
        // clicked without dragging). Distinct notices tell the two apart.
        if (renderer.getSelection() === null) {
          setNotice({ lines: ["无选区：先按住鼠标左键拖选文本。"] });
        } else {
          setNotice({ lines: ["选中区域为空。"] });
        }
        return;
      }
      void doCopy(text).then((result) => setNoticeFromCopyResult(text, result));
      // Arm the paste-swallow window: the copy triggered by right-up reaches
      // stdin almost together with the terminal's paste bytes; the app cannot
      // stop the terminal from sending them but can swallow the event when
      // usePaste receives it. 250ms covers stdin parse → _internalKeyInput
      // dispatch → usePaste handler; user-initiated Cmd+V beyond 250ms is unaffected.
      pasteArmedUntilRef.current = Date.now() + 250;
      renderer.clearSelection();
    },
    [renderer, doCopy]
  );

  usePaste((event) => {
    // paste-swallow: the copy triggered by right-up is followed within 250ms
    // by the terminal's paste bytes (the pasted content is the pre-OSC52
    // system clipboard, not the current selection). Any paste arriving inside
    // the arm window is swallowed and never reaches setInputValue. Outside the
    // window (user-initiated Cmd+V / Shift+Insert) behavior is unchanged.
    if (Date.now() < pasteArmedUntilRef.current) {
      // Explicit preventDefault also feeds downstream (even with no renderable
      // listener, keeping semantics clear: this is a paste we actively rejected).
      event.preventDefault();
      pasteArmedUntilRef.current = 0;
      return;
    }
    // preventDefault + buffer-first single source of truth. preventDefault
    // blocks the textarea's native handlePaste (InternalKeyHandler.emitWithPriority
    // skips renderable listeners when defaultPrevented). If one paste event
    // drove inputValue through both path A and path B (external dictation
    // emitting multiple segments at once):
    //  - path A functional updater (prev+text) and path B direct setInputValue
    //    (ta.plainText) misalign across React 18 commit cycles → middle segments lost;
    //  - useEffect[props.value] repeatedly resets the buffer via setText
    //    (prompt-input.tsx) → mid-commit buffer state gets overwritten → misaligned overwrite.
    // The original fix used path A alone (setInputValue(prev+text) queued into
    // commit); but the keypress path is buffer-first (native buffer written
    // synchronously + absolute-value onChange(ta.plainText)), so a keypress
    // absolute setState landing before the paste's functional update commits
    // still overwrote the queued paste segment — middle segments lost when
    // dictation paste interleaves with manual keypress (input-interleave-race test).
    // Now it calls PromptInput.insertText: buffer-first like keypress, same
    // single source (write native buffer → synchronous content-changed emit →
    // handleContentChange reports the absolute value), so the two paths no
    // longer interleave into a race.
    event.preventDefault();
    const text = decodePasteBytes(event.bytes) ?? "";
    if (text.length === 0) return;
    // A composer that cannot take the write has not received a paste. Both
    // imperative writes drop silently while it is disabled (picker, ask modal,
    // chrome focus elsewhere), so folding or probing from that state would spend
    // a draft label and a host round trip on bytes that never reached the buffer
    // — an orphan payload the buffer no longer names, which is also what blocks a
    // later rejected draft from being handed back.
    const input = promptInputRef.current;
    if (input === null || !input.isEditable()) return;
    // A multiline paste is never an image copy, so it needs no clipboard probe
    // and stays on the immediate path it always had. It folds into a summary
    // label; the payload stays in the draft table and is restored verbatim at
    // submit. The break may be LF or CR: Windows Terminal delivers clipboard
    // CRLF as CR, and the editor then paints that CR as a real line — a gate
    // that only looks for LF leaves the paste expanded. Manually typed newlines
    // never reach here, so hand-edited multiline text stays expanded.
    if (pasteHasLineBreak(text)) {
      input.insertText(composerDraftRef.current.foldPaste(text).label);
      return;
    }
    // A single-line paste cannot tell an image copy's byproduct text (a URL, a
    // file path) from the text the user meant, because the discriminator is the
    // clipboard snapshot rather than the text's shape — so it is the snapshot
    // that gets asked, through the same queue as the chord. The text goes in
    // first: that round trip must never delay the paste, reorder it against a
    // keystroke that follows it, or swallow it when Enter comes right after.
    const start = input.getCursorOffset();
    input.insertText(text);
    probePastedImage(start, text);
  });

  // ── Tool-event subscription (structured state + legacy string-line fallback) ──
  useEffect(
    () =>
      props.toolEventSink.subscribe((event) => {
        if (event.toolUseId !== undefined) {
          const { detail } = summarizeToolCall(
            event.toolName,
            event.input,
            cols
          );
          const toolUseId = event.toolUseId;
          setLiveToolRuns((prev) => ({
            ...prev,
            [event.conversationId]: liveToolReduce(
              prev[event.conversationId] ?? [],
              {
                kind: "post_tool_use",
                id: toolUseId,
                name: event.toolName,
                input: event.input,
                ok: event.kind === "ok",
                detail,
                message: event.message,
                oldContent: event.payload?.oldContent,
                newContent: event.payload?.newContent,
                stdout: event.payload?.stdout,
                stderr: event.payload?.stderr,
              }
            ),
          }));
          return;
        }
        // Legacy path (string events without toolUseId) uniformly goes through
        // the formatLiveToolEvent SSOT — spawn_subagent / subagent_result hit
        // the subagent-specific glyph branches (▣/✓/✗ + subagent label)
        // through it; an empty detail renders `${name} · ok`, replacing the
        // old truncated `name  [ok]` template (matches tool-summary.ts byte
        // rules). Pass cols so detail caps by visual width.
        setLiveToolLines((prev) => ({
          ...prev,
          [event.conversationId]: [
            ...(prev[event.conversationId] ?? []),
            formatLiveToolEvent({
              toolName: event.toolName,
              input: event.input,
              kind: event.kind,
              cols,
            }),
          ],
        }));
      }),
    [props.toolEventSink, cols]
  );

  // ── Derived: active session + input candidates + permissionIndex/active ──
  const active = sessions[activeKey] ?? initial;
  /**
   * ADR-0145: the model the CURRENT conversation uses. A conversation owns
   * its route; the env store carries only the DEFAULT (for conversations
   * started later). A conversation without a route yet (a draft, or a session
   * file written before the route existed) falls back to that default.
   *
   * The precedence rule lives in `displayedModelRoute` — the one rule the
   * ContextBar uses too: the conversation's route first, the snapshot's
   * default second. The route is render-time state; the default is read at
   * call time (the store publishes outside the React tree, so this closure
   * never re-renders with it).
   */
  function activeModel(): string | undefined {
    return displayedModelRoute(active.model, envDisplay.get().model);
  }
  // 1Hz runtime tick: running-fg and stamped → increment runElapsed (same
  // discipline as the thinking-seconds tick — read-only refs/state, no extra
  // setState storms).
  useEffect(() => {
    if (active.runState !== "running-fg" || runStartedAt === null) return;
    const tick = setInterval(() => {
      setRunElapsed(Math.floor((Date.now() - runStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [active.runState, runStartedAt]);
  // Subagent watch derivation — polling window = running-fg OR live subagent
  // OR inside a terminal retention window (failed uses
  // FAILED_VISIBLE_WINDOW_S×1000, completed uses DONE_FADE_WINDOW_S×1000 —
  // both imported from SubagentPanel's source to avoid double encoding). After
  // the window the subagents array may still hold the entry but
  // Date.parse age > window → hasRecentEndedSubagent=false → subagentWatch=false →
  // effect cleanup stops the timer instead of wasting 1Hz polling.
  const hasLiveSubagent = subagents.some(isLiveSubagent);
  const hasRecentEndedSubagent = subagents.some((s) => {
    if (s.endedAt === undefined) return false;
    const ageMs = Date.now() - Date.parse(s.endedAt);
    return s.state === "failed"
      ? ageMs < FAILED_VISIBLE_WINDOW_S * 1000
      : ageMs < DONE_FADE_WINDOW_S * 1000;
  });
  const subagentWatch = hasLiveSubagent || hasRecentEndedSubagent;
  // 1Hz subagent polling: running-fg or watch=true → pull bridge.listSubagents().
  // Without a manager (ask surface) listSubagents stays an empty array and
  // watch stays false, so no timer starts; in running-bg, if there are still
  // live / unexpired terminal subagents (watch=true) the timer also runs — the
  // chat view needs the freshest subagents projection (runElapsed/ageSec tick
  // per second), while in list/mcp views the panel doesn't render yet the
  // polling cost is 1Hz and only borne when watch=true.
  // Pull once synchronously at mount: an idle session that already has live
  // subagents (leftover from the previous turn / external spawn) renders the
  // spawn-card lines / panel in the first frame instead of waiting for a tick
  // that watch=false would never start.
  useEffect(() => {
    const initial = props.bridge.listSubagents();
    subagentsSignatureRef.current = subagentPollSignature(initial, Date.now());
    setSubagents(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.bridge]);
  useEffect(() => {
    const refreshLiveProjections = (): void => {
      const nextTasks = props.bridge.listLiveBackgroundTasks();
      const nextSignature = backgroundTaskFingerprint(nextTasks);
      if (nextSignature !== backgroundTasksSignatureRef.current) {
        backgroundTasksSignatureRef.current = nextSignature;
        setBackgroundTasks(nextTasks);
      }
      if (active.runState === "running-fg" || subagentWatch) {
        const nextSubagents = props.bridge.listSubagents();
        const nextSignature = subagentPollSignatureIfChanged(
          subagentsSignatureRef.current,
          nextSubagents,
          Date.now()
        );
        if (nextSignature !== null) {
          subagentsSignatureRef.current = nextSignature;
          setSubagents(nextSubagents);
        }
      }
    };
    refreshLiveProjections();
    const tick = setInterval(refreshLiveProjections, 1000);
    return () => clearInterval(tick);
  }, [active.runState, subagentWatch, props.bridge]);
  // chrome-focus clamp: when subagent row counts change (live subagents exit /
  // join / completion windows expire), the row under chromeFocus.kind ===
  // "subagent" may go out of bounds. The reducer clamps on key press, but this
  // effect covers stale focus with no key press: out-of-range → back to input
  // (same semantics as the reducer: the subagent ring is unreachable). Graph
  // focus is already handled above by the graphProgresses nextGraph === null
  // branch's setGraphChromeFocus("input"), so no duplication here.
  // skillCatalog is optional (default = empty catalog); available() = non-disabled
  // entries with descriptions, name-sorted. Slash candidates mix static commands + skills.
  const cachedSkillCatalog = props.skillCatalog ?? emptySkillCatalog;
  // specs/skill-index-increment.md (slash side): the candidate surface is
  // "hot in place" — opening the slash panel rescans the current loadable
  // surface once through the rescan seam (SKILL.md files written mid-session /
  // plugin directory changes show immediately, no waiting for the next turn).
  // Seam absent (test / fixture) → identity passthrough of the cache; rescan
  // failure → keep the cache + one notice (never blocks input).
  const skillCatalog = useLiveSkillCatalog({
    catalog: cachedSkillCatalog,
    rescanner: props.skillRescanner,
    paletteOpen: slashPaletteOpen(inputValue),
    onRescanError: (err) =>
      setNotice({ lines: [formatSkillRescanFailure(err)] }),
  });
  const skillList = useMemo(() => toSlashEntries(skillCatalog), [skillCatalog]);
  // Live taskRoot cell (specs/skill-load-write-root.md): beyond slash assembly,
  // the chrome render surface (sessionLocationLines via
  // resolveWorktreeChromeRoot) also consumes it. Since ADR-0079 slash assembly
  // no longer reads this cell (bodies carry no write-root trailer), but the
  // cell is still passed through props here for chrome rendering.
  const liveTaskRoot = props.liveTaskRoot;
  const inputHintSuggestions = useMemo<ReadonlyArray<SlashCandidate>>(() => {
    if (!inputValue.trim().startsWith("/")) return [];
    return slashSuggestions(inputValue, skillList);
  }, [inputValue, skillList]);
  // New ask id arrives → reset modal state during render.
  const askId = askPending?.id;
  const lastAskIdRef = useRef<string | undefined>(undefined);
  if (askId !== lastAskIdRef.current) {
    lastAskIdRef.current = askId;
    if (askId !== undefined) {
      setAskModalDismissed(false);
      setPermissionIndex(0);
    }
  }
  const askModalActive =
    view === "chat" && askPending !== undefined && !askModalDismissed;
  // Active session's status snapshot (keyed by conversationId, same derivation
  // shape as other live session state) — draft has no conversationId / the session has no
  // events yet → null, panel not rendered → nothing stale on switch-away, restored on switch-back.
  const agentStatus = active.conversationId
    ? (agentStatuses[active.conversationId] ?? null)
    : null;
  const graphProgress = active.conversationId
    ? (graphProgresses[active.conversationId] ?? null)
    : null;
  // Chrome-focus reducer input — `visibleLiveRowCount` is the "live row count
  // still visible after folding" (starting + running, capped by
  // SUBAGENT_PANEL_MAX_ROWS; same source as the projectSubagentLines
  // projection). Feeds reduceChromeFocus's subagentCount and the out-of-range
  // clamp of SubagentPanel's focusedRow — the raw live count won't do: when
  // the panel folds rows (>maxRows) it would move focus onto hidden rows.
  const liveSubagentCount = visibleLiveRowCount(subagents, Date.now(), cols);
  // chrome-focus clamp: when the visible subagent row count changes (live
  // subagents exit / join / completion windows expire / folding boundaries
  // crossed), the row under chromeFocus.kind === "subagent" may go out of
  // bounds. The reducer clamps on key press; this effect covers stale focus
  // with no key press: out-of-range → back to input (reducer-consistent: the
  // subagent ring is unreachable). Graph focus is already covered above by the
  // graphProgresses nextGraph === null branch's setGraphChromeFocus("input").
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (chromeFocus.kind !== "subagent") return;
    if (chromeFocus.row < liveSubagentCount) return;
    setChromeFocus({ kind: "input" });
  }, [liveSubagentCount]);

  // ── Permission modal answer landing ──────────────────────────────
  function resolvePermissionAsk(
    pending: TuiPendingAsk,
    answer: PermissionAnswer,
    origin: "local" | "remote" = "local"
  ): void {
    const settled = props.askBridge.resolveAsk(
      pending.id,
      answer !== "reject",
      origin,
      answer
    );
    if (!settled) return;
    if (answer === "always") {
      const tool = pending.tool;
      props.sessionGrants?.add({
        id: `tui-always-${tool}`,
        match: ({ tool: t }) => t === tool,
        decision: "allow",
        reason: `TUI 用户在权限确认 modal 选择「总是允许」（${tool}）`,
      });
      setNotice({
        lines: [
          props.sessionGrants !== undefined
            ? `已允许 ${tool}（本会话总是允许）`
            : `已允许 ${tool}`,
        ],
      });
      return;
    }
    if (answer === "reject") {
      setNotice({ lines: [`已拒绝 ${pending.tool}`] });
    }
  }

  // ── View chrome (banner shares scroll space with messages) ───────
  // The banner is the scrollbox's first segment, scrolling with messages (so
  // users can scroll up back to it). Two-color glyph-shaped segmentation is
  // lost in plain text (unified single logoInk color; accepted degradation,
  // see the header note in banner.ts renderBannerLines).
  const bannerLines = useMemo<ReadonlyArray<string>>(
    () =>
      renderBannerLines(
        { version: VERSION, cwd: props.cwd, dataDir: props.dataDir },
        cols
      ),
    [cols, props.cwd, props.dataDir]
  );

  // ── /sessions list loading ───────────────────────────────────────────
  const [listEntries, setListEntries] = useState<ReadonlyArray<TuiListEntry>>(
    []
  );

  // ── /mcp dashboard data (pulled once on first entry, refreshed after reload) ────
  const [mcpStatuses, setMcpStatuses] = useState<readonly McpServerStatus[]>(
    () => props.mcp?.status() ?? []
  );
  const [mcpTools, setMcpTools] = useState<readonly McpToolEntry[]>(
    () => props.mcp?.listMcpTools?.() ?? []
  );
  async function enterMcpView(): Promise<void> {
    if (!props.mcp) {
      setNotice({ lines: ["MCP 未装配（buildTuiDeps 未注入 mcp 扩展）。"] });
      return;
    }
    // Pull the freshest status + full tool list once on first entry; keep the cache to avoid re-pulling.
    setMcpStatuses(props.mcp.status());
    setMcpTools(props.mcp.listMcpTools?.() ?? []);
    setView("mcp");
  }
  async function reloadMcpView(): Promise<void> {
    const ext = props.mcp;
    if (!ext) return;
    try {
      await ext.reload();
    } catch (err) {
      setNotice({ lines: [`MCP 重载失败：${describeError(err)}`] });
    }
    // Reload re-registers tools (unregister + register); refresh status and tool list.
    setMcpStatuses(ext.status());
    setMcpTools(ext.listMcpTools?.() ?? []);
  }
  async function safeList(): Promise<ReadonlyArray<TuiListEntry>> {
    try {
      const raw = await props.bridge.listSessions();
      const entries = raw.map((e) => ({
        ...e,
        runningBg: sessions[e.conversation_id]?.runState === "running-bg",
      }));
      setListEntries(entries);
      return entries;
    } catch (err) {
      setNotice({ lines: [`读取会话列表失败：${describeError(err)}`] });
      return [];
    }
  }

  // ── Session switch / new ────────────────────────────────────────────
  function newSession(): void {
    const draft = createDraftSession();
    setSessions((prev) => ({ ...prev, [DRAFT_SESSION_ID]: draft }));
    // A new draft starts with empty input history: submit remap resets the
    // DRAFT key to [], so /new must not leak the previous draft's history.
    setInputHistories((prev) => ({ ...prev, [DRAFT_SESSION_ID]: [] }));
    setActiveKey(DRAFT_SESSION_ID);
    publishProjectionActive({
      conversationId: null,
      running: false,
      queued: 0,
    });
    setView("chat");
    setNotice(undefined);
    setRewindTargets(undefined);
    setRewindConfirming(false);
    setRewindIndex(0);
    setThinkingPickerOpen(null);
    setMemoryPickerOpen(false);
    setModelPickerOpen(false);
    setConfigPickerOpen(false);
  }
  async function openSessionAt(index: number): Promise<void> {
    if (index === 0) {
      newSession();
      return;
    }
    const entries = await safeList();
    const entry = entries[index - 1];
    if (!entry) return;
    const id = entry.conversation_id;
    const existing = sessions[id];
    let opened: TuiSessionState | undefined = existing;
    if (!existing) {
      try {
        // ADR-0136 §4: session ENTRY. The in-progress label goes up before the
        // entry promise and the classified status replaces it on resolve; it is
        // a host transient, never an outcome recovery can return.
        setNotice({ lines: [RECOVERY_IN_PROGRESS_LABEL] });
        const { file, recovery } = await props.bridge.openSession(id);
        if (file === null) {
          // The log is unreadable: the classification is what the operator
          // needs, and there is no transcript to render or reconstruct.
          setNotice({ lines: recoveryNoticeLines({ messages: [], recovery }) });
          return;
        }
        // ADR-0145: the conversation's OWN route. The hub knows it (its map
        // entry, else the route the file carries, else the current default);
        // the state must carry it, so the model row / `/info` / `/model`
        // cursor show the route this conversation RUNS on, not the default.
        const route = await props.bridge.getSessionModel?.(id);
        const attached = withSessionRoute(attachSession(file, recovery), route);
        opened = attached;
        setSessions((prev) => ({ ...prev, [id]: attached }));
        // First attach seeds input history from the transcript so ↑ recall
        // works at once; already-loaded sessions keep their in-process
        // appends (re-seeding would drop submissions not yet flushed).
        setInputHistories((prev) =>
          prev[id] === undefined
            ? { ...prev, [id]: seedInputHistory(attached.messages) }
            : prev
        );
        const statusSnapshot = agentStatusFromMessages(attached.messages);
        if (statusSnapshot !== null) {
          setAgentStatuses((prev) => ({ ...prev, [id]: statusSnapshot }));
        }
      } catch (err) {
        setNotice({ lines: [`打开会话失败：${describeError(err)}`] });
        return;
      }
    }
    setSessions((prev) => {
      const next = { ...prev };
      const leaving = next[activeKey];
      if (leaving) next[activeKey] = switchedAwayFrom(leaving);
      const entering = next[id];
      if (entering) next[id] = switchedTo(entering);
      return next;
    });
    setActiveKey(id);
    const activated = existing === undefined ? opened : sessionsRef.current[id];
    publishProjectionActive({
      conversationId: id,
      running: (activated?.runState ?? "idle") !== "idle",
      queued: gapCount(gapQueueRef.current, id),
    });
    setView("chat");
    // A reopened session brings its last settled turn's durable notice into
    // the lane the live turn used; any other outcome (unknown included) clears
    // it exactly as before.
    setNotice(turnLaneNoticeFor(opened));
    setRewindTargets(undefined);
    setRewindConfirming(false);
    setRewindIndex(0);
    setThinkingPickerOpen(null);
    setMemoryPickerOpen(false);
    setModelPickerOpen(false);
    setConfigPickerOpen(false);
  }

  // ── Turn send ───────────────────────────────────────────────────
  // Echo and sent text diverge only for skill-load: displayText is the compact
  // chip shown while the turn runs, and text is the envelope the model
  // receives. A folded paste in that prompt is already restored before the
  // envelope is built, so the chip remainder and the model text are the
  // payload; an image stays `[image#N]` in the remainder and travels as a
  // content block. On turn end, turnFinished swaps in the persisted messages.
  function publishGap(next: GapQueue): void {
    gapQueueRef.current = next;
    setGapQueue(next);
  }

  function gapKeyNow(): string {
    const key = activeKeyRef.current;
    return resolveGapKey({
      activeKey: key,
      conversationId: sessionsRef.current[key]?.conversationId,
      draftKey: DRAFT_SESSION_ID,
      liveKeys: [...liveTurnsRef.current],
    });
  }

  function conversationIdForSend(
    key: string,
    gapKey: string
  ): string | undefined {
    const conversationId = sessionsRef.current[key]?.conversationId;
    if (conversationId !== undefined) return conversationId;
    if (key !== DRAFT_SESSION_ID) return key;
    return gapKey === DRAFT_SESSION_ID ? undefined : gapKey;
  }

  function liveKeyHeld(key: string): boolean {
    return liveTurnsRef.current.has(key);
  }

  function turnIsLive(key: string): boolean {
    if (liveKeyHeld(key)) return true;
    const direct = sessionsRef.current[key];
    if (direct !== undefined && direct.runState !== "idle") return true;
    const activeSession = sessionsRef.current[activeKeyRef.current];
    return (
      activeSession !== undefined &&
      activeSession.runState !== "idle" &&
      (activeKeyRef.current === key || activeSession.conversationId === key)
    );
  }

  function toGapDraft(pending: SubmittedDraft): GapDraft {
    return {
      text: pending.text,
      displayText: pending.displayText,
      payloads: pending.payloads,
      ...(pending.content !== undefined ? { content: pending.content } : {}),
      ...(pending.origin !== undefined ? { origin: pending.origin } : {}),
    };
  }

  function holdRunningSubmit(
    gapKey: string,
    text: string,
    displayText: string | undefined,
    content: readonly UserContentBlock[] | undefined,
    origin: "local" | "remote"
  ): void {
    // A remote message never spends the composer's in-flight submission: that
    // slot belongs to the running keyboard submit, and its rejection restore
    // must keep the text it took.
    const pending: SubmittedDraft =
      origin === "remote"
        ? {
            text,
            displayText: displayText ?? text,
            payloads: [],
            ...(content !== undefined ? { content } : {}),
            origin,
          }
        : (pendingSubmissionRef.current ?? {
            text,
            displayText: displayText ?? text,
            payloads: [],
            ...(content !== undefined ? { content } : {}),
          });
    if (origin !== "remote") pendingSubmissionRef.current = null;
    publishGap(enqueueGap(gapQueueRef.current, gapKey, toGapDraft(pending)));
  }

  function putGapBack(gapKey: string): void {
    const pending = claimPendingSubmission();
    if (pending === null) return;
    publishGap(
      restoreGapHead(gapQueueRef.current, gapKey, toGapDraft(pending))
    );
  }

  function settleGapHold(
    fromGap: boolean,
    gapKey: string,
    text: string,
    displayText: string | undefined,
    content: readonly UserContentBlock[] | undefined,
    origin: "local" | "remote"
  ): boolean {
    if (!fromGap && turnIsLive(gapKey)) {
      holdRunningSubmit(gapKey, text, displayText, content, origin);
      return true;
    }
    if (fromGap && liveKeyHeld(gapKey)) {
      putGapBack(gapKey);
      return true;
    }
    return false;
  }

  function armLiveTurn(key: string): void {
    liveTurnsRef.current.add(key);
  }

  function disarmLiveTurn(key: string): void {
    liveTurnsRef.current.delete(key);
  }

  function retargetLiveTurn(holdKey: string, targetId: string): void {
    if (holdKey === targetId) return;
    liveTurnsRef.current.delete(holdKey);
    liveTurnsRef.current.add(targetId);
  }

  function recordGapHistory(fromGap: boolean, key: string, text: string): void {
    if (!fromGap || text.length === 0) return;
    setInputHistories((prev) => ({
      ...prev,
      [key]: appendInputHistory(prev[key] ?? [], text),
    }));
  }

  function noteGapSend(fromGap: boolean): void {
    if (fromGap) setNotice(undefined);
  }

  function recallQueuedDraft(): boolean {
    if (composerValueRef.current.length > 0) return false;
    if (composerDraftRef.current.heldPayloadCount() > 0) return false;
    const taken = recallNewestGap(gapQueueRef.current, gapKeyNow());
    if (taken.draft === undefined) return false;
    publishGap(taken.queue);
    restoreClaimedSubmission(toGapDraft(taken.draft));
    return true;
  }

  function gapDrainAllowed(opts?: {
    readonly skipIdleCheck?: boolean;
  }): boolean {
    if (drainLockRef.current) return false;
    if (compactingControllerRef.current !== null) return false;
    if (opts?.skipIdleCheck !== true) {
      const session = sessionsRef.current[activeKeyRef.current];
      if (session === undefined || session.runState !== "idle") return false;
    }
    return !liveKeyHeld(gapKeyNow());
  }

  function tryDrainGap(opts?: { readonly skipIdleCheck?: boolean }): void {
    if (quittingRef.current) return;
    if (!gapDrainAllowed(opts)) return;
    const key = gapKeyNow();
    const taken = takeOldestGap(gapQueueRef.current, key);
    if (taken.draft === undefined) return;
    drainLockRef.current = true;
    publishGap(taken.queue);
    const draft = taken.draft;
    pendingSubmissionRef.current = toGapDraft(draft);
    // The queue line keeps the folded label; the message that actually sends
    // renders the paste, same as a submit that did not wait.
    void sendTurn(
      draft.text,
      transcriptEchoText(draft.displayText, draft.payloads),
      draft.content,
      true,
      draft.origin ?? "local"
    ).finally(() => {
      drainLockRef.current = false;
    });
  }

  function releaseTurnGap(targetId: string): void {
    const key = activeKeyRef.current;
    const session = sessionsRef.current[key];
    if (targetId !== key && session?.conversationId !== targetId) return;
    tryDrainGap({ skipIdleCheck: true });
  }

  function consumeLeadingEscape(): boolean {
    if (compactingControllerRef.current !== null) {
      compactingControllerRef.current.abort();
      return true;
    }
    if (gapCount(gapQueueRef.current, gapKeyNow()) === 0) return false;
    interruptForegroundTurn();
    tryDrainGap();
    return true;
  }

  async function sendTurn(
    text: string,
    displayText?: string,
    content?: readonly UserContentBlock[],
    fromGap = false,
    origin: "local" | "remote" = "local"
  ): Promise<RemoteSendResult> {
    const gapKey = gapKeyNow();
    if (settleGapHold(fromGap, gapKey, text, displayText, content, origin)) {
      if (origin === "remote") setNotice({ lines: [REMOTE_QUEUED_NOTICE] });
      return "queued";
    }
    const startedKey = activeKeyRef.current;
    armLiveTurn(gapKey);
    let conversationId = conversationIdForSend(startedKey, gapKey);
    try {
      conversationId = await ensureSessionForOpenTurn(
        () => quittingRef.current,
        () => props.bridge.ensureSession(conversationId)
      );
    } catch (err) {
      disarmLiveTurn(gapKey);
      setNotice({ lines: [`建档失败：${describeError(err)}`] });
      if (origin !== "remote") restoreRejectedDraft();
      // No turn started: report the refusal so the seat does not claim one.
      return { failed: true };
    }
    if (
      startedKey === DRAFT_SESSION_ID &&
      !fromGap &&
      conversationId !== undefined
    ) {
      // ADR-0145: the conversation the draft became owns a route — the hub
      // stamped it when it created the session. The TUI state must carry it,
      // so the model row / `/info` / `/model` cursor show THAT route, not the
      // default (which another conversation's `/model` act can move).
      const createdRoute = await props.bridge.getSessionModel?.(conversationId);
      setSessions((prev) => {
        const draft = prev[DRAFT_SESSION_ID];
        if (!draft) return prev;
        const next = {
          ...prev,
          [conversationId as string]: withSessionRoute(
            { ...draft, conversationId },
            createdRoute
          ),
        };
        delete next[DRAFT_SESSION_ID];
        return next;
      });
      // Move input history to the real session key on remap: appends landed
      // under DRAFT_SESSION_ID before the first message created the session.
      // Reset DRAFT to [] so the next /new draft starts with empty history.
      setInputHistories((prev) => {
        const draftHistory = prev[DRAFT_SESSION_ID];
        if (draftHistory === undefined) return prev;
        if (prev[conversationId as string] !== undefined) return prev;
        return {
          ...prev,
          [conversationId as string]: draftHistory,
          [DRAFT_SESSION_ID]: [],
        };
      });
      setActiveKey(conversationId);
      publishProjectionActive({
        conversationId,
        running: true,
        queued: 0,
      });
    }
    const targetId = acceptedTurnTarget(conversationId, quittingRef.current);
    if (targetId === undefined) {
      disarmLiveTurn(gapKey);
      if (origin !== "remote") restoreRejectedDraft();
      // No target conversation: nothing was accepted, so nothing "sent".
      return { failed: true };
    }
    retargetLiveTurn(gapKey, targetId);
    recordGapHistory(fromGap, targetId, text);
    noteGapSend(fromGap);
    if (origin === "remote") setNotice({ lines: [REMOTE_SENT_NOTICE] });
    setSessions((prev) => {
      const current = prev[targetId];
      if (!current) return prev;
      return {
        ...prev,
        [targetId]: userMessageEchoed(
          turnStarted(current),
          displayText ?? text
        ),
      };
    });
    const controller = new AbortController();
    trackOwnedTurnController(
      aborters.current,
      ownedTurnControllers.current,
      targetId,
      controller
    );
    // Drop the previous turn's verify verdict at the turn boundary so the
    // banner never shows a stale judgment (same discipline as crunchedOf).
    setVerifySlots((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    const promise = runTurnOnce(
      targetId,
      {
        text,
        content,
        ...(origin === "remote" ? { origin } : {}),
      },
      controller
    );
    trackInflightTurn(targetId, promise);
    return "sent";
  }

  async function runContinueTurn(): Promise<void> {
    if (
      quittingRef.current ||
      tuiContinueBusy({
        runState: active.runState,
        compacting: compactingControllerRef.current !== null,
      })
    ) {
      setNotice({ lines: continueNoticeFor("busy_stop_first") });
      return;
    }
    const targetId = active.conversationId;
    if (targetId === undefined) {
      setNotice({ lines: continueNoticeFor("nothing_pending") });
      return;
    }
    setNotice(undefined);
    setSessions((prev) => {
      const current = prev[targetId];
      if (!current) return prev;
      return { ...prev, [targetId]: turnStarted(current) };
    });
    const controller = new AbortController();
    trackOwnedTurnController(
      aborters.current,
      ownedTurnControllers.current,
      targetId,
      controller
    );
    setVerifySlots((prev) => {
      if (!(targetId in prev)) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    const promise = runTurnOnce(targetId, { text: "" }, controller, "continue");
    trackInflightTurn(targetId, promise);
  }

  async function sessionPendingFromStore(): Promise<boolean> {
    const id = active.conversationId;
    if (id === undefined) return false;
    const file = await props.bridge.loadSessionFile(id);
    return pendingFromLoadedSession({
      messages: file.messages,
      ...(file.goal !== undefined ? { goal: file.goal } : {}),
    });
  }

  async function runTurnOnce(
    targetId: string,
    input: TurnInput,
    controller: AbortController,
    mode: "append" | "continue" | "wake" = "append"
  ): Promise<void> {
    let stopReason: string | undefined;
    let lastUsage: TokenUsage | null = null;
    let interrupted: boolean | undefined;
    /** ADR-0094: gateway-side summary on transport failure; undefined = not a transport failure. */
    let apiError:
      { readonly status?: number; readonly message: string } | undefined;
    /** The settled turn's output-limit notice (hub-owned copy, verbatim).
     *  Undefined = this turn did not truncate, so the abnormal-stop lane keeps
     *  its generic wording. */
    let outputLimitNotice: string | undefined;
    let uncancellableOperationNotice: string | undefined;
    // Tracks transport_retry notices so completed/maxTurns teardown clears
    // only this turn's retry notice, never stop_summary or other sources.
    let retryNoticeShown = false;
    // Predicate / continue ValidationError is not a turn: keep EXIT notice,
    // restore idle, do not reload (a reload overwrite would fail the refresh).
    let skipTurnRefresh = false;
    // UI-only feedback throttle: once the streaming arm goes quiet past the
    // silence threshold, rewrite the notice to "still waiting". Harness idle
    // decisions are unaffected (they follow settings.llm.idleTimeoutMs).
    // Closure vars, not React state: the timer handle is re-armed on every
    // onStream event.
    const silenceThresholdMs = resolveStreamingSilenceNoticeMs(
      props.streamingSilenceNoticeMs
    );
    let silenceTimerId: ReturnType<typeof setTimeout> | undefined;
    let silenceNoticeShown = false;
    // Live speed repaints while recent output remains in the one-second
    // window. A call can begin without a pre-call usage beat, so its first
    // output delta arms the timer. An expired window clears it until another
    // delta arrives.
    let speedTimerId: ReturnType<typeof setInterval> | undefined;
    let tokenSpeedRunActive = true;
    const clearSpeedTimer = (): void => {
      if (speedTimerId !== undefined) {
        clearInterval(speedTimerId);
        speedTimerId = undefined;
      }
    };
    const armSpeedTimer = (): void => {
      if (speedTimerId !== undefined) return;
      speedTimerId = setInterval(() => {
        if (!tokenSpeedRunActive) return;
        const current = tokenSpeedRef.current[targetId];
        if (current === undefined) return;
        const now = Date.now();
        publishTokenSpeed(targetId, refreshTokenSpeed(current, now));
        if (
          current.lastOutputAt !== null &&
          now - current.lastOutputAt > TOKEN_SPEED_WINDOW_MS
        ) {
          clearSpeedTimer();
        }
      }, TOKEN_SPEED_REPAINT_MS);
    };
    /**
     * Apply one stream event to this conversation's speed state and keep the
     * repaint timer in phase with the reducer: recent generation → armed,
     * waiting/tool/done → cleared. Live publishing is deferred to the repaint
     * tick; boundaries and call ends publish immediately.
     */
    const applyTokenSpeedEvent = (event: HarnessStreamEvent): void => {
      if (!tokenSpeedRunActive) return;
      const current =
        tokenSpeedRef.current[targetId] ?? INITIAL_TOKEN_SPEED_STATE;
      const next = tokenSpeedTransition(current, event, Date.now());
      if (next === current) return;
      // Live rates are published only on the repaint tick: publishing per
      // fragment makes the number flicker and re-renders the tree far too
      // often. Boundaries and call ends publish now (zero / average).
      if (next.phase === "generating" && next.firstOutputAt !== null) {
        storeTokenSpeed(targetId, next); // live branch: store only, the tick publishes
        armSpeedTimer();
      } else {
        clearSpeedTimer();
        publishTokenSpeed(targetId, next); // EXIT: not generating (boundary / call end / tool) → publish the zero or average now
      }
    };
    // Phase tracking (see nextToolPhaseActive): a turn starts in model
    // phase and flips to tool phase when tool_use is emitted.
    let toolPhaseActive = false;
    const clearSilenceTimer = (): void => {
      if (silenceTimerId !== undefined) {
        clearTimeout(silenceTimerId);
        silenceTimerId = undefined;
      }
    };
    const armSilenceTimer = (): void => {
      clearSilenceTimer();
      silenceNoticeShown = false;
      // Resumed stream bytes make the waiting copy false: it asserts "no new
      // stream bytes" while bytes are arriving. Cleared here — the single
      // choke point every onStream event passes, ahead of the per-type
      // branches, so a notice set later in the same call (transport_retry) is
      // not erased. Unconditional rather than gated on this turn's flag: the
      // notice slot is shared across in-flight turns, so a copy another turn
      // raised is just as false. The identity check leaves other-source
      // notices untouched, and returning `prev` makes React bail out, so the
      // per-delta cost is one updater call.
      setNotice((prev) => (isStreamingSilenceNotice(prev) ? undefined : prev));
      if (silenceThresholdMs <= 0) return;
      silenceTimerId = setTimeout(() => {
        silenceTimerId = undefined;
        // Fire once per silence episode; onStream resets silenceNoticeShown
        // when bytes resume, so the next episode can notify again.
        if (silenceNoticeShown) return;
        // Phase gate: no stream events during tool execution (incl.
        // permission/ask waits) is by design, not a stuck model. Re-arm a
        // full window without notifying.
        if (toolPhaseActive) {
          armSilenceTimer();
          return;
        }
        silenceNoticeShown = true;
        setNotice({ lines: [...STREAMING_SILENCE_NOTICE_LINES] });
      }, silenceThresholdMs);
    };
    const draft = createStreamDraft();
    setStreamDraft(draft);
    // Wall-clock timer for the mode line's live "running" counter: turn
    // start → end (waits + tools included). Thinking seconds are separate —
    // see stream-draft.ts (measured from the first thinking_delta).
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setRunElapsed(0);
    publishTokenSpeed(targetId, beginTokenSpeedTurn());
    // The in-memory thinking-seconds channel is gone; folded rows read
    // thinkingMs from the persisted file. Clear the previous "Crunched"
    // summary so a new turn doesn't show the old one at the stream tail.
    setCrunchedOf(null);
    // Draft segmentation: tool_call_start seals the current text segment and
    // exposes the sealed count as draftEpoch, so ChatView interleaves in the
    // same order as persisted content blocks. Closure event order only.
    const onStream = (event: HarnessStreamEvent): void => {
      // Phase advance before timer reset: agent_status / env_snapshot return
      // the turn to model phase, tool_call_start enters tool phase (see
      // nextToolPhaseActive).
      toolPhaseActive = nextToolPhaseActive(toolPhaseActive, event);
      // Plan A T6: feed the pure speed reducer (call boundary, output
      // fragments, tool phase, call end). Display only — nothing here
      // touches usage, messages, or persistence.
      applyTokenSpeedEvent(event);
      // Any onStream event counts as "bytes arrived" → re-arm the silence
      // timer (one notice per episode, see armSilenceTimer).
      armSilenceTimer();
      draft.append(event);
      if (event.type === "tool_call_start") {
        // Seal before reading sealedCount: setState updaters run at render
        // time, so re-reading state inside one is a stale-read trap.
        draft.sealText();
        const draftEpoch = draft.sealedCount();
        setLiveToolRuns((prev) => ({
          ...prev,
          [targetId]: liveToolReduce(prev[targetId] ?? [], {
            kind: "tool_call_start",
            id: event.id,
            name: event.name,
            draftEpoch,
          }),
        }));
        // No in-memory thinking-seconds pinning at tool start; final values
        // come from the persisted thinkingMs.
      }
      if (event.type === "tool_input_delta") {
        setLiveToolRuns((prev) => ({
          ...prev,
          [targetId]: liveToolReduce(prev[targetId] ?? [], {
            kind: "tool_input_delta",
            id: event.id,
            partialJson: event.partialJson,
          }),
        }));
      }
      if (event.type === "stop_summary") {
        if (
          event.text === BACKGROUND_OPERATION_NOTICE ||
          event.text === BLOCK_OPERATION_NOTICE
        ) {
          uncancellableOperationNotice = event.text;
        }
        setNotice({ lines: [event.text] });
      }
      if (event.type === "transport_retry") {
        // Surface 429/network retry progress in the notice lane; a later
        // stopReason/cancel notice overwrites it at turn end.
        retryNoticeShown = true;
        setNotice({
          lines: [
            `⠿ 连接重试 ${event.attempt}/${event.maxAttempts}（${event.detail}），退避中…`,
          ],
        });
      }
      if (event.type === "agent_status") {
        // ADR-0028: replace this conversation's status slot wholesale, keyed
        // by the turn's own targetId (closure capture, like liveToolRuns).
        // agentStatusFromEvent returns a self-contained snapshot, so stale
        // state can't linger. UI-only; never feeds model-facing fields.
        const nextAgentStatus = agentStatusFromEvent(event);
        if (nextAgentStatus !== null) {
          setAgentStatuses((prev) => ({
            ...prev,
            [targetId]: nextAgentStatus,
          }));
        }
      }
      if (event.type === "env_snapshot") {
        // Env snapshot: session-independent single slot, replaced wholesale
        // by envSnapshotFromEvent. UI-only; never feeds model-facing fields.
        const nextEnv = envSnapshotFromEvent(event);
        if (nextEnv !== null) {
          setEnvSnapshot(nextEnv);
        }
      }
      if (event.type === "context_usage") {
        // #1079 call-beat: replace this conversation's usage reading mid-run
        // (pre-call measurement, then post-call correction of the same call).
        // UI-only display input; never feeds model-facing fields.
        //
        // Plan A T4 / 2026-10-22 confirmed-only amendment: the confirmed usage
        // lands in `lastUsage` (the only reading that reaches the session file
        // and `/info`); the bar-facing reading lands in `displayOccupancy`
        // (UI-only). A `projected` beat carries no `usage` at all, so it can
        // never become `lastUsage` (ADR-0008 D6), and it no longer repaints
        // the bar either — it is the image-bearing gate's input only. When the
        // beat is projected or identical to what is already on screen,
        // `withContextUsageBeat` returns the same session object, so we return
        // the unchanged `prev` map instead of a new one (no whole-tree
        // re-render).
        setSessions((prev) => {
          const current = prev[targetId];
          if (!current) return prev;
          const next = withContextUsageBeat(current, event);
          return next === current ? prev : { ...prev, [targetId]: next };
        });
      }
      const nextGraph = graphProgressFromEvent(event);
      if (nextGraph !== undefined) {
        setGraphProgresses((prev) => {
          if (nextGraph === null) {
            const { [targetId]: _dropped, ...rest } = prev;
            return rest;
          }
          return { ...prev, [targetId]: nextGraph };
        });
        if (nextGraph === null) {
          setGraphChromeFocus("input");
          setGraphViewOpen(false);
          setGraphNodeDetail(false);
          setGraphSelectedId(null);
        }
      }
      // Auto-compact (proactive/reactive) was once silent to the user; this
      // panel is its first surfacing. It shares applyCompactEvent with the
      // manual path (same reduce + terminal timer arming); the identity
      // guard keeps non-compaction events on the same reference, no re-render.
      if (event.type.startsWith("compaction_")) {
        applyCompactEvent(targetId, event, "turn");
      }
    };
    try {
      // Arm the silence timer at turn start: even if the first stream byte
      // arrives only past the threshold (stream setup stuck in backpressure
      // / TLS handshake), the UI should reach the "still waiting" path.
      // armSilenceTimer resets silenceNoticeShown, so later events aren't
      // swallowed by the streak.
      armSilenceTimer();
      // Thinking override gate: send a per-turn override only when the user
      // actually changed thinking state (env default → no override). Logic:
      // computeThinkingOverride in thinking-gate.ts (pure fn, unit-tested).
      //
      // Read the baseline from the store at turn start, not from a
      // render-time snapshot: the hub may have rebuilt the adapter with a new
      // env, and a stale baseline would emit an override clobbering the fresh
      // default the adapter just received.
      const thinkingOverride: WireThinkingOverride | undefined =
        computeThinkingOverride(
          envDisplay.get().defaultThinking,
          thinkingEnabled,
          thinkingEffort
        );
      const resp =
        mode === "wake"
          ? await props.bridge.wakeFromSubagent(targetId)
          : mode === "continue"
            ? await props.bridge.continueSession(targetId, {
                signal: controller.signal,
                onStream,
              })
            : await props.bridge.postMessage({
                conversationId: targetId,
                text: input.text,
                content: input.content,
                signal: controller.signal,
                onStream,
                ...(thinkingOverride ? { thinking: thinkingOverride } : {}),
                ...(input.origin !== undefined ? { origin: input.origin } : {}),
              });
      if (resp === undefined) {
        skipTurnRefresh = true;
        return;
      }
      stopReason = resp.stopReason;
      lastUsage = resp.lastUsage;
      // Interrupt feedback: the bridge passes true/false when cancelled;
      // other stop reasons → undefined (the notice branch acts on cancelled).
      interrupted = resp.interrupted;
      // ADR-0094: pass the transport summary to the notice renderer;
      // undefined falls back to the generic text. Feeds "API error (status): message".
      apiError = resp.apiError;
      // The hub's verbatim output-limit notice (present only on a recorded
      // truncation). Carried through the lane and the session snapshot so the
      // live turn and a reopen read one identical line.
      outputLimitNotice = resp.outputLimitNotice;
      // The turn ran to an answer: the accepted message and its attachments are
      // durably in history, so the draft this submit took stays spent.
      pendingSubmissionRef.current = null;
      // Verify verdict into its slot. verifyFromWire validates the wire
      // shape at the runtime boundary; invalid wire → unavailable (degraded
      // render, no throw into React); none → drop the key, banner silent.
      setVerifySlots((prev) => {
        const next = verifyFromWire(resp.verify);
        if (next.kind === "none") {
          if (!(targetId in prev)) return prev;
          const without = { ...prev };
          delete without[targetId];
          return without;
        }
        return { ...prev, [targetId]: next };
      });
    } catch (err) {
      // ADR-0094: non-transient provider failures (e.g. 4xx) reject from
      // run() instead of taking the TransportRetryExhausted normal-return
      // path. Only results carrying an HTTP status render "API error
      // (status): ..."; status-less hub validation errors (ValidationError /
      // NotFoundError) keep the describeError text instead of posing as API errors.
      const thrownApiError = transportApiErrorFromThrow(err);
      if (thrownApiError !== undefined) {
        apiError = thrownApiError;
      }
      const outcome = turnFailureOutcome({ mode, err, thrownApiError });
      if (outcome.stopReason !== undefined) {
        stopReason = outcome.stopReason;
      }
      if (outcome.skipTurnRefresh) {
        skipTurnRefresh = true;
      }
      setNotice({ lines: [...outcome.noticeLines] });
      settleRejectedDraftTurn(err);
    } finally {
      liveTurnsRef.current.delete(targetId);
      removeOwnedTurnController(
        aborters.current,
        ownedTurnControllers.current,
        targetId,
        controller
      );
      // Turn over (success / cancelled / throw): clear the silence timer so a
      // stuck "still waiting" timer can't fire setNotice later. Do NOT clear
      // the notice text — sticky handling belongs to the teardown branches
      // below, not this finally.
      clearSilenceTimer();
      // Plan A T6: the live-speed repaint stops with the turn — no interval
      // may outlive it. Any partial output becomes a whole-call estimate;
      // the final weighted average remains visible until the next turn.
      tokenSpeedRunActive = false;
      clearSpeedTimer();
      publishTokenSpeed(
        targetId,
        finishTokenSpeedTurn(tokenSpeedRef.current[targetId], Date.now())
      );
      // Failsafe compact-panel sweep: still non-terminal at turn end means
      // terminal events were missed → clear it immediately rather than
      // leaving a fake in-flight panel. Already terminal → the HOLD_MS timer
      // unloads it. Shares sweepCompactPanel with the manual path.
      sweepCompactPanel(targetId);
      // Thinking seconds now run entirely through the persisted path:
      // commitMessages writes thinkingMs, loadSessionFile → turnFinished
      // carries it, and the folded "thought for N s" row reads it once the
      // streaming panel disappears.
      draft.reset();
      setStreamDraft(null);
      // Freeze the exact run duration at turn end (tick may miss the tool tail).
      // crunchedOf is the owning session id: ChatView takes crunchedSeconds
      // only for the active session, avoiding cross-session mismatches.
      const finalRunSeconds = Math.max(
        0,
        Math.floor((Date.now() - startedAt) / 1000)
      );
      setRunElapsed(finalRunSeconds);
      setRunStartedAt(null);
      if (!skipTurnRefresh) {
        setCrunchedOf(targetId);
        setCrunchedSeconds(finalRunSeconds);
      }
    }
    if (skipTurnRefresh) {
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: Object.freeze({ ...current, runState: "idle" }),
        };
      });
      releaseTurnGap(targetId);
      return;
    }
    try {
      const file = await props.bridge.loadSessionFile(targetId);
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: turnFinished(current, {
            conversationId: file.conversation_id,
            messages: file.messages,
            turnCount: file.turnCount,
            updatedAt: file.updatedAt,
            jsonMode: file.jsonMode,
            stopReason:
              (stopReason as TuiSessionState["lastStopReason"]) ?? "completed",
            lastUsage,
            // ADR-0037: a rebound turn's persisted file carries the task
            // worktree root, updating the status row within the turn; the
            // field is absent for normal turns → turnFinished keeps the old value.
            workspaceRoot: file.workspaceRoot,
            // The persisted file carries thinkingMs as a parallel array; the
            // folded "thought for N s" row reads it (in-memory channel removed).
            thinkingMs: file.thinkingMs,
            // Turn end owns this line: the settled turn's notice replaces the
            // previous turn's (absent = cleared), so the session snapshot
            // always describes the same turn a reopen would re-read.
            outputLimitNotice,
            // ADR-0145: the persisted file carries the conversation's own
            // route (a backfilled one included), so the display follows the
            // route this conversation RUNS on. Absent (a file written before
            // conversations owned a route) → turnFinished keeps the old value.
            model: file.model,
          }),
        };
      });
      setLiveToolLines((prev) => ({ ...prev, [targetId]: [] }));
      setLiveToolRuns((prev) => ({ ...prev, [targetId]: [] }));
      if (stopReason === "cancelled") {
        setNotice(
          cancelledTurnNotice(
            gapCount(gapQueueRef.current, targetId) > 0,
            uncancellableOperationNotice,
            interrupted
          )
        );
      } else if (
        stopReason === "protocolError" ||
        stopReason === "timeout" ||
        stopReason === "nonSuccessStop" ||
        stopReason === "emptyFinalResponse" ||
        stopReason === "fused"
      ) {
        // 429/network failures are flattened by loop-engine into a normal
        // return (protocolError, empty finalText); without this branch the
        // turn would end silently. Abnormal stopReasons share the notice lane
        // so the user sees the turn did not succeed. maxTurns takes its own arm
        // below — a cap is not a fault, so it must not borrow this wording.
        // ADR-0094: protocolError +
        // apiError render the dedicated "API error (status): message" text
        // (single point = abnormalStopNoticeLines). An output-limit stop
        // replaces only the generic line: the hub's own English notice is what
        // a reopen shows too, so the two views cannot drift.
        setNotice({
          lines: abnormalStopNoticeLines(
            stopReason,
            apiError,
            outputLimitNotice
          ),
        });
      } else {
        setNotice((prev) =>
          turnTeardownNotice(prev, stopReason, retryNoticeShown)
        );
      }
    } catch (err) {
      // Even on refresh failure fall back to idle; otherwise the session sticks in running-fg.
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: turnFinished(current, {
            conversationId: current.conversationId ?? targetId,
            messages: current.messages,
            turnCount: current.turnCount,
            updatedAt: current.updatedAt,
            jsonMode: current.jsonMode,
            stopReason:
              (stopReason as TuiSessionState["lastStopReason"]) ?? "completed",
            lastUsage,
          }),
        };
      });
      setNotice({ lines: [`刷新会话失败：${describeError(err)}`] });
    }
    releaseTurnGap(targetId);
  }

  // Terminal worker notices wake only the active idle session. The
  // injected drain is sent through the bridge's silent path, so this effect
  // never appends a user bubble or input-history entry.
  useEffect(() => {
    const controller = createSubagentWake({
      manager: undefined,
      subscribe: props.bridge.subscribeSubagentTerminal,
      conversationId: () =>
        sessionsRef.current[activeKeyRef.current]?.conversationId,
      isIdle: () => {
        const current = sessionsRef.current[activeKeyRef.current];
        return (
          !quittingRef.current &&
          current?.runState === "idle" &&
          current.conversationId !== undefined &&
          !liveTurnsRef.current.has(current.conversationId)
        );
      },
      wake: async () => {
        if (quittingRef.current) return;
        const current = sessionsRef.current[activeKeyRef.current];
        const targetId = current?.conversationId;
        if (targetId === undefined || current.runState !== "idle") return;
        setSessions((prev) => {
          const latest = prev[activeKeyRef.current];
          if (!latest || latest.runState !== "idle") return prev;
          return {
            ...prev,
            [activeKeyRef.current]: turnStarted(latest),
          };
        });
        const abortController = new AbortController();
        trackOwnedTurnController(
          aborters.current,
          ownedTurnControllers.current,
          targetId,
          abortController
        );
        dropPendingSubmission();
        liveTurnsRef.current.add(targetId);
        const promise = runTurnOnce(
          targetId,
          { text: "" },
          abortController,
          "wake"
        );
        trackInflightTurn(targetId, promise);
        await promise;
      },
      onError: (error) => {
        setNotice({ lines: [`后台唤醒失败：${describeError(error)}`] });
      },
    });
    subagentWakeRef.current = controller;
    controller.flush();
    return () => {
      controller.dispose();
      if (subagentWakeRef.current === controller) {
        subagentWakeRef.current = undefined;
      }
    };
  }, [props.bridge]);

  useEffect(() => {
    tryDrainGap();
  }, [active.runState, activeKey, gapQueue]);

  // A background turn can make the active session idle after a notice was
  // queued. Flush on the state transition rather than waiting for another
  // worker event.
  useEffect(() => {
    subagentWakeRef.current?.flush();
  }, [activeKey, active.runState]);

  /**
   * Register a turn promise under its conversation id and drop it when it
   * settles. A conversation can hold more than one at a time (a gap send lands
   * while the previous turn is still settling), so this is a set, not a slot.
   */
  function trackInflightTurn(
    conversationId: string,
    promise: Promise<unknown>
  ): void {
    const promises =
      inflightTurns.current.get(conversationId) ?? new Set<Promise<unknown>>();
    promises.add(promise);
    inflightTurns.current.set(conversationId, promises);
    void promise.finally(() => {
      const live = inflightTurns.current.get(conversationId);
      if (live === undefined) return;
      live.delete(promise);
      if (live.size === 0) inflightTurns.current.delete(conversationId);
    });
  }

  function quit(): void {
    if (quittingRef.current) return;
    const liveBackgroundTasks = props.bridge.listLiveBackgroundTasks();
    const liveSubagents = props.bridge.listSubagents();
    const plan = planQuitBusy({
      sessions: sessionsRef.current,
      inflightTurns: inflightTurns.current,
      liveBackgroundTasks,
      subagents: liveSubagents,
      interruptibleConversationId: canInterrupt(active)
        ? active.conversationId
        : undefined,
    });
    const snapshot = createQuitConfirmationSnapshot({
      plan,
      sessions: sessionsRef.current,
      inflightTurns: inflightTurns.current,
      liveBackgroundTasks,
      liveSubagents,
    });
    if (
      confirmQuitIfNeeded({
        plan,
        pending: pendingQuit,
        previous: pendingQuitSnapshotRef.current,
        snapshot,
        save: (next) => {
          pendingQuitSnapshotRef.current = next;
          setPendingQuit(true);
        },
        show: (lines) => setNotice({ lines: [...lines] }),
      })
    ) {
      return;
    }
    quittingRef.current = true;
    pendingQuitSnapshotRef.current = undefined;
    setPendingQuit(false);
    abortOwnedWorkOnQuit({
      aborters: ownedTurnControllers.current,
      compaction: compactingControllerRef.current,
    });
    subagentWakeRef.current?.dispose();
    subagentWakeRef.current = undefined;
    props.onQuit?.(active.conversationId, plan.waitSet);
    if (!renderer.isDestroyed) renderer.destroy();
  }

  /** Ctrl+O: toggle the fold state (thinkingExpanded); unrelated to the /thinking switch. */
  function toggleThinkingFold(): void {
    setThinkingExpanded((prev) => !prev);
  }

  /**
   * Foreground interrupt (driven by Esc): aborts "everything in this
   * session's foreground" in one pass.
   *   - Subagents: bridge.abortSessionForegroundWork(id) enumerates and
   *     aborts fresh foreground work hub-side (an in-flight wait:true child
   *     with an idle parent is only visible there; the TUI's 1Hz projection
   *     can be up to 1s stale, so it is not the criterion). No manager
   *     (ask form) → empty array.
   *   - Parent turn: the existing `aborters` registry — the sole abort
   *     channel, shared with /quit and canInterrupt. A missing controller
   *     (turn finally already ran) stays silent; never fabricate an interrupt.
   *
   * Returns whether the foreground really had live work, judged by the action
   * itself rather than stale React state; callers use it to decide whether to
   * fall through to the double-Esc rewind check. Both arms empty → zero side
   * effects, returns `{ interrupted: false }`.
   */
  function interruptForegroundTurn(): { interrupted: boolean } {
    const id = active.conversationId;
    const abortedSubagents =
      id === undefined ? [] : props.bridge.abortSessionForegroundWork(id);
    const controller = id === undefined ? undefined : aborters.current.get(id);
    if (!canInterrupt(active))
      return { interrupted: abortedSubagents.length > 0 };
    controller?.abort();
    return { interrupted: true };
  }

  // ── Remote seat bindings (specs/remote-sync.md §4.3) ────────────
  // The port is bound once per port instance; the bound shims read this ref so
  // every call lands on the latest render's sendTurn / resolvePermissionAsk /
  // interruptForegroundTurn closures (they read render-scoped state).
  const remoteBindingsRef = useRef<RemoteInputBindings>({
    getActiveConversationId: () => null,
    sendMessage: () => "sent",
    answerApproval: () => "not_pending",
    abort: () => ({ interrupted: false }),
  });
  remoteBindingsRef.current = {
    getActiveConversationId: () => {
      const key = activeKeyRef.current;
      return sessionsRef.current[key]?.conversationId ?? null;
    },
    sendMessage: (text) =>
      sendTurn(text, undefined, undefined, false, "remote"),
    answerApproval: (toolUseId, answer) => {
      const pending = props.askBridge
        .pendingAll()
        .find((ask) => ask.toolUseId === toolUseId);
      if (pending === undefined) return "not_pending";
      resolvePermissionAsk(pending, answer, "remote");
      return "ok";
    },
    abort: () => interruptForegroundTurn(),
  };
  useEffect(() => {
    const port = props.remoteInputPort;
    if (port === undefined) return undefined;
    return port.bind({
      getActiveConversationId: () =>
        remoteBindingsRef.current.getActiveConversationId(),
      sendMessage: (text) =>
        remoteBindingsRef.current.sendMessage(text, "remote"),
      answerApproval: (toolUseId, answer) =>
        remoteBindingsRef.current.answerApproval(toolUseId, answer, "remote"),
      abort: () => remoteBindingsRef.current.abort(),
    });
  }, [props.remoteInputPort]);

  const projectionActiveRef = useRef(props.onProjectionActive);
  projectionActiveRef.current = props.onProjectionActive;

  /**
   * Publish an active-conversation identity change synchronously, before any
   * work that can emit bus events for it. The effect below still owns
   * running / queued changes; an identity change must not wait for its pass,
   * or the projector drops the new conversation's first turn events.
   */
  function publishProjectionActive(next: ProjectionActiveState): void {
    projectionActiveRef.current?.(next);
  }

  const projectionQueued = gapCount(gapQueue, gapKeyNow());
  useEffect(() => {
    projectionActiveRef.current?.({
      conversationId: active.conversationId ?? null,
      running: active.runState !== "idle",
      queued: projectionQueued,
    });
  }, [activeKey, active.conversationId, active.runState, projectionQueued]);
  useEffect(
    () => () => {
      projectionActiveRef.current?.(undefined);
    },
    []
  );

  useEffect(() => {
    const register = props.onRemoteNoticeSink;
    if (register === undefined) return undefined;
    return register((line) => setNotice({ lines: [line] }));
  }, [props.onRemoteNoticeSink]);

  /**
   * The copy action shared by rungs 1 and 2: reset the renderer selection cache
   * (the same reset the mouse-up path performs, so a second Ctrl+C cannot repeat
   * a stale copy) and report whatever the clipboard accepted. `text` is already
   * read out of the cache by the caller, so clearing here cannot truncate it.
   */
  function copySelectedText(text: string): void {
    cachedSelectionTextRef.current = "";
    void doCopy(text).then((result) => setNoticeFromCopyResult(text, result));
  }

  /**
   * Ctrl+C priority chain (interrupt lives on Esc, so this arm never interrupts):
   *   1. live composer selection → copy it;
   *   2. renderer (transcript) selection cache → copy it;
   *   3. non-empty draft → clear the whole draft (buffer text + folded
   *      attachments) and stop there;
   *   4. nothing above → the existing copy-usage notice.
   * The editor selection is live buffer state while the renderer selection is a
   * cache only reset on a successful copy or mouse-up, so it survives a focus
   * change and can be stale — the editor therefore wins when both exist.
   */
  function handleCtrlCCopy(): void {
    const editorSelection = promptInputRef.current?.getSelection() ?? "";
    if (editorSelection.length > 0) {
      copySelectedText(editorSelection);
      return;
    }
    const selectedText = cachedSelectionTextRef.current;
    if (selectedText.length > 0) {
      copySelectedText(selectedText);
      return;
    }
    // Whole-draft clear: the label form is what the buffer holds, so forgetting
    // the payload table is what makes the cleared attachments really gone.
    // The gate reads the synchronous mirror, not `inputValue`: a keystroke and
    // this Ctrl+C can arrive in the same task, where the render this closure was
    // created in still holds the pre-keystroke text.
    if (composerValueRef.current.trim().length > 0) {
      promptInputRef.current?.replaceBuffer("", 0);
      composerDraftRef.current.clear();
      return;
    }
    setNotice({
      lines: ["无选区：先按住鼠标左键拖选文本，再按 Ctrl+C 复制。"],
    });
  }

  /**
   * Ctrl+X: force-kill the live subagent focused by chrome-focus. No focus
   * or a stale row (subagent just terminal, clamp not run yet) → the pure
   * dispatch returns kind:"none" → no-op, no throw, no fabricated taskId.
   * Row → taskId mapping follows live row order like SubagentPanel's
   * focusedRow (see the header note in subagent-kill.ts).
   */
  function killFocusedSubagent(): void {
    const kill = dispatchKillFocusedSubagent(chromeFocus, subagents);
    if (kill.kind !== "kill") return;
    const aborted = props.bridge.abortSubagentTask(kill.taskId);
    setNotice({
      lines: [
        aborted
          ? `已强杀子代理 ${kill.role ?? kill.taskId}。`
          : `子代理 ${kill.role ?? kill.taskId} 已不在运行。`,
      ],
    });
  }

  /** Open the L3 rewind-anchor picker (shared by /rewind and double-Esc):
   *  load the session file once → project anchors → activate the picker.
   *  Failures surface only the typed kind via describeError. The caller has
   *  already guaranteed idle + non-draft. */
  async function openRewindPicker(targetId: string): Promise<void> {
    try {
      const targets = await props.bridge.listRewindTargets(targetId);
      if (targets.length === 0) {
        setNotice({
          lines: ["Nothing to rewind to yet."],
        });
        return;
      }
      setRewindTargets(targets);
      setRewindIndex(0);
      setRewindConfirming(false);
    } catch (err) {
      setNotice({ lines: [`读取会话失败：${describeError(err)}`] });
    }
  }

  /** Move head after confirmation; with fillInput, put the anchor text back into
   *  the input. `restoreCode` = the hub also wrote the abandoned segment's files
   *  back, so its report joins the notice (a rewind that refused some paths must
   *  not read as a clean success). */
  async function executeRewind(
    targetId: string,
    target: RewindTarget,
    restoreCode: boolean
  ): Promise<void> {
    setRewindTargets(undefined);
    setRewindConfirming(false);
    try {
      const { codeRestore } = await props.bridge.rewindSession(
        targetId,
        target.head,
        restoreCode
      );
      const fresh = await props.bridge.loadSessionFile(targetId);
      setSessions((prev) => {
        const current = prev[targetId];
        if (!current) return prev;
        return {
          ...prev,
          [targetId]: sessionRewound(current, {
            messages: fresh.messages,
            turnCount: fresh.turnCount,
            updatedAt: fresh.updatedAt,
            jsonMode: fresh.jsonMode,
          }),
        };
      });
      const noticeText = target.userMessageText || "(无文本)";
      setNotice({
        lines: [
          `已回退到 ［${noticeText}］ 之前。`,
          ...(codeRestore !== undefined
            ? codeRestoreNoticeLines(codeRestore)
            : []),
        ],
      });
      if (target.fillInput) setInputValue(target.fullText);
    } catch (err) {
      setNotice({ lines: [`回退失败：${describeError(err)}`] });
    }
  }

  // ── Submit routing ────────────────────────────────────────────────
  async function handleSubmit(raw: string): Promise<void> {
    const text = raw.trim();
    if (shouldIgnoreSubmit(text, quittingRef.current)) return;
    // Through the composer's own report, not just the state setter: the restore
    // gate reads this same tick, when no render has carried the clear yet.
    reportComposerValue("");
    // Whatever the submit becomes, the buffer the composer was showing is gone:
    // a clipboard read still in flight was started for that draft, not for the
    // text the user types next — with no folded unit there is nothing taken for
    // the draft's own observer to report.
    invalidateClipboardImageReads();
    clearQuitConfirmationOnOtherInput(pendingQuit, text, () => {
      pendingQuitSnapshotRef.current = undefined;
      setPendingQuit(false);
    });
    // Folded units resolve exactly once, here: static-command routing keeps
    // reading the label text it was written for, the model receives the
    // payload. A `/skill` prompt is the exception that still needs the
    // restored paste: the skill name stays the typed token, and the
    // remainder is the payload the bubble and the model both read. Image
    // labels stay in that remainder; the bytes travel as content blocks.
    const submitted = resolveSubmittedDraft(composerDraftRef.current, text);
    const messageText = submitted.text;
    pendingSubmissionRef.current = submitted;
    // With askPending, y/n/a answer directly (modal yielded keys → input fallback).
    if (applyAskShortcut(askPending, text, resolvePermissionAsk)) return;
    // Exact /skill-name [prompt] match → deterministic skill-load send
    // (static commands win first: parseSkillLoad returns undefined on a hit,
    // falling through to normal routing). Re-scan once at submit time: the
    // async rescan from panel opening may not land before a fast Enter.
    // The source is the transcript form, not the input label: a folded paste
    // in the prompt must already be the payload before the envelope is built.
    const skillSource = transcriptEchoText(text, submitted.payloads);
    const skillOutcome = await resolveSkillLoadSubmit({
      text: skillSource,
      catalog: skillCatalog,
      rescanner: props.skillRescanner,
    });
    if (skillOutcome.kind === "notice") {
      setNotice({ lines: [...skillOutcome.lines] });
      restoreRejectedDraft();
      return;
    }
    if (skillOutcome.kind === "send") {
      setNotice(undefined);
      await sendTurn(
        skillOutcome.sendText,
        skillOutcome.displayText,
        skillImageContent(skillOutcome.sendText, submitted.payloads)
      );
      return;
    }
    const parsed = parseTuiInput(text);
    if (parsed.kind === "message") {
      // Only real messages enter history (no y/n / slash / busy-guard
      // noise), keyed by activeKey for per-session isolation;
      // appendInputHistory skips blanks, dedupes adjacent, same-ref on no-op.
      // History keeps the resolved text, not the label: recalling a folded
      // paste must give back editable multiline text, not an inert summary.
      if (!askPending && active.runState === "idle" && messageText.length > 0) {
        setInputHistories((prev) => ({
          ...prev,
          [activeKey]: appendInputHistory(prev[activeKey] ?? [], messageText),
        }));
      }
      try {
        const pending = await sessionPendingFromStore();
        if (shouldTriggerContinueFromNl({ line: parsed.text, pending })) {
          await runContinueTurn();
          return;
        }
      } catch (err) {
        setNotice({ lines: [`读取会话失败：${describeError(err)}`] });
        restoreRejectedDraft();
        return;
      }
      setNotice(undefined);
      // Routing already read the label form. The model and the transcript
      // both get the paste payload; the folded label stays on the draft so a
      // rejection can put it back in the input.
      await sendTurn(
        messageText,
        transcriptEchoText(text, submitted.payloads),
        submitted.content
      );
      return;
    }
    if (parsed.kind === "unknown") {
      setNotice({
        lines: [`未知命令：${parsed.raw}（/help 查看词表）`],
      });
      restoreRejectedDraft();
      return;
    }
    // The session-holder commands resolve before the switch: three extra
    // `case` labels there cost three `SwitchCase[test]` points against
    // handleSubmit's S5 baseline, while one guard costs one (same remedy as
    // applyAskShortcut above — route the family, not the branch).
    if (isHolderSlashCommand(parsed.command)) {
      runHolderSlashCommand(parsed.command, props, text, {
        permissionMode,
        setGraphOn,
        setPermMode,
        setNotice,
        setConfigPickerOpen,
        setConfigFocusIndex,
        setThinkingPickerOpen,
        setMemoryPickerOpen,
        setModelPickerOpen,
      });
      return;
    }
    switch (parsed.command) {
      case "sessions": {
        await safeList();
        setView("list");
        return;
      }
      case "mcp": {
        await enterMcpView();
        return;
      }
      case "new":
        newSession();
        return;
      case "quit":
      case "exit":
        quit();
        return;
      case "help":
        setNotice({ lines: helpLines(skillNamesForHelp(skillList)) });
        return;
      case "info": {
        setNotice({
          lines: infoLines(
            active,
            activeKey,
            props.bridge.contextWindow,
            {
              enabled: thinkingEnabled,
              effort: thinkingEffort,
            },
            // ADR-0145: the conversation's own route wins over the default.
            // The default half is read live at call time (not
            // render-captured): env changes publish through the store only
            // and this closure never re-renders with them. The route half is
            // render-captured state — the conversation's own route, as the
            // TUI knows it.
            activeModel()
          ),
        });
        return;
      }
      case "yolo":
        // ADR-0119: the routing body is folded into a helper (S5 complexity
        // gate; see the helper header for the enter/exit asymmetry).
        handleYoloSlash(props.yoloController, {
          setYoloConfirming,
          setYoloOn,
          setNotice,
          setPermMode,
          permissionMode,
        });
        return;
      case "thinking": {
        // /thinking opens a pure ON/OFF toggle panel (the panel itself is
        // the feedback, no notice). Seeded from current thinkingEnabled;
        // Enter/Space/Tab flip the preview, Esc saves. Effort untouched.
        setThinkingPickerOpen("thinking");
        setSwitchPreview(thinkingEnabled);
        setMemoryPickerOpen(false);
        setConfigPickerOpen(false);
        return;
      }
      case "effort": {
        const level = parseEffortLevel(text);
        // /effort opens the effort-level panel. Valid level arg → open with
        // that level fixed; no arg → open seeded with the committed level;
        // only an invalid concrete level (e.g. /effort auto) shows a notice.
        if (level === undefined && effortHasArg(text)) {
          setNotice({
            lines: [
              `当前：${
                thinkingEnabled ? "自适应" : "off"
              }（档位：${formatEffortLabel(
                thinkingEffort
              )}）/ 可用：${ADJUSTABLE_EFFORT_LEVELS.join(
                " "
              )} / 用法：/effort <level>`,
            ],
          });
          return;
        }
        const seed = level ?? thinkingEffort; // no arg → seed the committed level
        setThinkingPickerOpen("effort");
        // auto seed: no arg while adaptive (thinkingEffort="") → autoOn=true
        // (Esc keeps auto writing ""); an explicit level → autoOn=false.
        setEffortAutoOn(seed === "");
        setEffortFocusIndex(effortToDisplayIndex(seed));
        setEffortFixedIndex(effortToDisplayIndex(seed)); // /effort <level> fixes that level directly
        setMemoryPickerOpen(false);
        setConfigPickerOpen(false);
        return;
      }
      case "memory": {
        setThinkingPickerOpen(null);
        setMemoryPickerOpen(true);
        setMemoryFocusIndex(0);
        setMemoryPreview(memoryCommitted);
        setConfigPickerOpen(false);
        return;
      }
      case "model":
        // ADR-0093: empty/absent registry → typed notice (no throw, no
        // picker); otherwise open with focus on the current model's entry
        // (0 if not found). Decision lives inside openModelPickerCommand.
        openModelPickerCommand({
          providers: props.providers,
          // Focus seeds from the conversation's own route, falling back to
          // the live snapshot (the default): the picker shows the model the
          // current conversation actually uses (the closure doesn't subscribe
          // to the store).
          model: activeModel(),
          onEmpty: (lines) => setNotice({ lines }),
          onOpen: (focusIndex) => {
            // Panel exclusivity: opening the model picker closes sibling panels.
            setThinkingPickerOpen(null);
            setMemoryPickerOpen(false);
            setConfigPickerOpen(false);
            setModelFocusIndex(focusIndex);
            setModelPickerOpen(true);
          },
        });
        return;
      case "compact": {
        if (active.runState !== "idle") {
          setNotice({
            lines: [compactGuardNoticeFor("busy")],
          });
          return;
        }
        // Block re-triggering while compaction runs: runState stays idle
        // during compaction so the usual gate misses it; a ref guards
        // synchronously (React state lags one commit).
        if (compactingControllerRef.current !== null) {
          setNotice({
            lines: [compactGuardNoticeFor("in_flight")],
          });
          return;
        }
        const targetId = active.conversationId;
        if (targetId === undefined) {
          setNotice({ lines: [compactGuardNoticeFor("draft")] });
          return;
        }
        // Dedicated AbortController (Esc cancels via compactingControllerRef)
        // + observer relaying compaction_* progress events (text deltas are
        // remapped into the compaction preview). Progress renders through
        // compact-progress.tsx (rows budgeted in
        // chromeReserveRows.compactRows) and reduces via the same
        // reduceCompactionEvent pure functions as in-turn auto-compact.
        const compactController = new AbortController();
        compactingControllerRef.current = compactController;
        // Show the panel before any event arrives — the user should see
        // "compacting" immediately. Clear this session's pending hold timer
        // first: a previous compaction's terminal timer would otherwise fire
        // and delete this new panel (see compactTimersRef).
        clearCompactTimer(targetId);
        setCompactPanels((prev) => ({
          ...prev,
          [targetId]: startCompactPanel("manual", Date.now()),
        }));
        // compaction_cancelled in onStream marks a mid-run cancel (the
        // bridge returns compacted=false, same shape as "nothing to
        // compact"); the closure flag picks the notice text after resolve.
        // Note: with a pre-aborted signal the observer never fires —
        // response.cancelled backstops that, and settling is driven by the
        // promise result (events are only the fast path).
        let cancelledByUser = false;
        try {
          const compactResult = await props.bridge.compactSession(targetId, {
            signal: compactController.signal,
            onStream: (event) => {
              if (event.type === "compaction_cancelled") {
                cancelledByUser = true;
              }
              // Same entry point as the turn path (reduce + identity guard + terminal timer).
              applyCompactEvent(targetId, event, "manual");
            },
          });
          const compacted = compactResult.compacted;
          // Backstop: the pre-aborted signal path never fires the observer → use response.cancelled.
          if (compactResult.cancelled) cancelledByUser = true;
          if (cancelledByUser) {
            // Cancel = no change: the session is left
            // untouched — no sessionCompacted projection (updatedAt /
            // messages unchanged), only the user gets a notice.
            settleCompactPanelFor(targetId, "cancelled");
            setNotice({
              lines: [compactCancelledNotice()],
            });
          } else if (compacted) {
            // Trimming actually done → reload the persisted file + sessionCompacted projection.
            const file = await props.bridge.loadSessionFile(targetId);
            setSessions((prev) => {
              const current = prev[targetId];
              if (!current) return prev;
              return {
                ...prev,
                [targetId]: sessionCompacted(current, {
                  messages: file.messages,
                  turnCount: file.turnCount,
                  updatedAt: file.updatedAt,
                  jsonMode: file.jsonMode,
                }),
              };
            });
            settleCompactPanelFor(targetId, "done");
            // Notice text decided by the compactNoticeFor pure function:
            // the no-op branch means "no compactable context";
            // below_token_threshold throws on the manual path.
            setNotice({
              lines: compactNoticeFor(compactResult.reason, true),
            });
          } else {
            // no-op (compacted:false, not cancelled) = nothing happened —
            // clear the panel immediately instead of a fake "done".
            clearCompactPanel(targetId);
            setNotice({
              lines: compactNoticeFor(compactResult.reason, false),
            });
          }
        } catch (err) {
          settleCompactPanelFor(targetId, "failed");
          setNotice({
            lines: [`${compactFailedNoticePrefix()}${describeError(err)}`],
          });
        } finally {
          // Symmetric failsafe sweep: the four branches above cover
          // cancelled / compacted / no-op / catch, but a future branch that
          // misses settle would strand a pending panel forever (the hold
          // timer only arms on settle). Already terminal → sweep is a no-op.
          sweepCompactPanel(targetId);
          compactingControllerRef.current = null;
          tryDrainGap();
        }
        return;
      }
      case "continue": {
        if (
          tuiContinueBusy({
            runState: active.runState,
            compacting: compactingControllerRef.current !== null,
          })
        ) {
          setNotice({ lines: continueNoticeFor("busy_stop_first") });
          return;
        }
        if (slashHasArg(text)) {
          setNotice({ lines: continueNoticeFor("usage") });
          return;
        }
        dropPendingSubmission();
        await runContinueTurn();
        return;
      }
      case "rewind": {
        if (active.runState !== "idle") {
          setNotice({
            lines: ["当前会话正在运行；回退等本轮结束后再执行。"],
          });
          return;
        }
        const targetId = active.conversationId;
        if (targetId === undefined) {
          setNotice({ lines: ["当前是空会话，还没有可回退的点。"] });
          return;
        }
        await openRewindPicker(targetId);
        return;
      }
    }
  }

  // ── Reverse persistence (two-way settings channel) ────────────────────
  /**
   * Hand the panel's committed payload to props.onPersistThinking for the
   * settings.json write-back. Fire-and-forget: it never blocks the panel
   * state update (Esc-save already took effect). Failure (reject or
   * { ok:false }) → notice, keeping the in-memory override valid for this
   * session; success is silent. Null payload (defensive branch of
   * committedThinkingPatch, unreachable in the current union) → no-op.
   */
  function persistThinkingFromCommit(
    patch: CommittedThinkingPatch | null
  ): void {
    if (patch === null || props.onPersistThinking === undefined) return;
    void props.onPersistThinking(patch).then(
      (res) => {
        if (!res.ok) {
          setNotice({
            lines: [
              `思考设置已生效（本次会话），但写回 settings.json 失败：${res.reason}`,
            ],
          });
        }
      },
      (err) => {
        setNotice({
          lines: [
            `思考设置已生效（本次会话），但写回 settings.json 失败：${
              err instanceof Error ? err.message : String(err)
            }`,
          ],
        });
      }
    );
  }

  function persistMemoryFromCommit(patch: CommittedMemoryPatch): void {
    if (props.memoryFlags !== undefined) {
      props.memoryFlags.autoExtract = patch.autoExtract;
      props.memoryFlags.dream = patch.dream;
    }
    // The same commit invalidates the memory_layer system snapshot so the
    // toggle (incl. off) takes effect next turn — no stale snapshot latch.
    props.invalidateMemorySystem?.();
    if (props.onPersistMemory === undefined) return;
    void props.onPersistMemory(patch).then(
      (res) => {
        if (!res.ok) {
          setNotice({
            lines: [
              `记忆设置已生效（本次会话），但写回 settings.json 失败：${res.reason}`,
            ],
          });
        }
      },
      (err) => {
        setNotice({
          lines: [
            `记忆设置已生效（本次会话），但写回 settings.json 失败：${
              err instanceof Error ? err.message : String(err)
            }`,
          ],
        });
      }
    );
  }

  /**
   * Persistence wiring for the /model picker's Enter selection. Unlike the
   * fire-and-forget thinking/memory paths, this must await the host: the
   * host refreshes env and rebuilds the adapter after the write-back (the
   * self-write sentinel swallows the watcher event its own write triggers,
   * so reloadFromEnv won't fire automatically). Failures surface as a
   * notice; the panel is already closed.
   *
   * ADR-0145: `conversationId` is the ACTIVE conversation (undefined for a
   * draft) — the host sets that conversation's own route. On success the
   * conversation's state carries the new route, so the display follows it
   * immediately instead of waiting for the next env publish.
   *
   * A route failure changed NOTHING, so the conversation keeps its old route
   * and the display keeps showing it. Any other failure happened AFTER the
   * route was set: the conversation KEEPS the new route, so the display must
   * follow it — exactly what the notice says ("Model switched (this
   * session), but failed to write settings.json").
   */
  function persistModelFromCommit(
    model: string,
    conversationId: string | undefined
  ): Promise<void> {
    const cb = props.onPersistModel;
    if (cb === undefined) return Promise.resolve();
    /** The conversation's route changed → the state carries it (ADR-0145). */
    const adoptRoute = (): void => {
      if (conversationId === undefined) return;
      setSessions((prev) => {
        const current = prev[conversationId];
        if (current === undefined) return prev;
        return {
          ...prev,
          [conversationId]: withSessionRoute(current, model),
        };
      });
    };
    return cb({ model }, conversationId).then(
      (res) => {
        if (!res.ok) {
          setNotice({
            lines: [persistModelFailNotice(res.stage, res.reason)],
          });
        }
        if (!res.ok && res.stage === "route") return;
        adoptRoute();
      },
      (err) => {
        // The act reports a route failure as a result, never as a rejection —
        // so a rejection means the DEFAULT write failed, after the route was
        // set. The notice says the session switched; the display agrees.
        setNotice({
          lines: [persistModelFailNotice("write", describeError(err))],
        });
        adoptRoute();
      }
    );
  }

  // ── Global keys (Ctrl+C / Shift+Tab / Ctrl+O / modal) ────
  useKeyboard((e) => {
    if (
      !continueKeyRoutingAfterQuitConfirmation(
        e.eventType,
        e.name,
        pendingQuit,
        () => {
          pendingQuitSnapshotRef.current = undefined;
          setPendingQuit(false);
          setNotice({
            lines: ["已取消退出；当前 TUI 的后台任务继续运行"],
          });
          e.preventDefault();
        }
      )
    ) {
      return;
    }
    const isCtrlC = e.ctrl && e.name === "c";

    if (graphViewOpen && graphProgress !== null) {
      applyGraphViewKey(
        {
          key: e.name,
          selectedId: graphSelectedId,
          detail: graphNodeDetail,
          selectableIds: selectableNodeIds(
            graphGroupRows(graphProgress, graphSelectedId)
          ),
        },
        {
          closeDetail: () => setGraphNodeDetail(false),
          closeView: () => setGraphViewOpen(false),
          select: setGraphSelectedId,
          openDetail: () => setGraphNodeDetail(true),
        }
      );
      if (!isCtrlC) return;
    }

    const graphKey = reduceGraphChromeFocus({
      focus: graphChromeFocus,
      hasSnapshot: graphProgress !== null,
      key: e.name,
    });
    // Graph fullscreen open/close is still driven by the legacy two-state
    // graphChromeFocus reducer's openView. The three-state chromeFocus only
    // replaces Down/Up switching between chrome rings (input ↔
    // subagent(row) ↔ graph) via reduceChromeFocus + PromptInput
    // onLeaveToChrome. Dual-reducer sync: when chromeFocus enters graph,
    // graphChromeFocus must follow, or Enter's openView check reads stale.
    if (chromeFocus.kind === "graph" && graphChromeFocus !== "graph") {
      setGraphChromeFocus("graph");
    }
    if (chromeFocus.kind === "graph") {
      // Inside the graph ring the old reducer keeps only two jobs: Enter →
      // openView, Escape → leave ring. Down/Up are deliberately not handled
      // here (it would reset focus to input and return unconditionally,
      // killing the three-ring reducer's graph→Up transitions); they fall
      // through to the three-ring branch, which syncs graphChromeFocus on exit.
      if (graphKey.openView === true) {
        const ids =
          graphProgress === null
            ? []
            : selectableNodeIds(graphGroupRows(graphProgress, null));
        setGraphSelectedId(ids[0] ?? null);
        setGraphNodeDetail(false);
        setGraphViewOpen(true);
        if (!isCtrlC) return;
      }
      if (e.name === "escape") {
        setChromeFocus({ kind: "input" });
        setGraphChromeFocus("input");
        if (!isCtrlC) return;
      }
      if (e.name !== "down" && e.name !== "up" && !isCtrlC) return;
    }

    // Global Down/Up for the three-state chrome-focus reducer: when focus is
    // not in input (subagent or graph ring), the reducer consumes the keys
    // (PromptInput is disabled then). The input path is handled inside
    // PromptInput via onLeaveToChrome — orthogonal to this branch.
    //   - input → PromptInput itself (hint / multiline / history / yield).
    //   - subagent(row) → move across rows; Down past the last row → graph
    //     (if a snapshot exists); Up at row 0 → input.
    //   - graph → Up → last subagent (if any) / input; Down at the last
    //     ring → stay.
    // The reducer is pure: detect focus changes with !== identity.
    if (
      chromeFocus.kind !== "input" &&
      (e.name === "down" || e.name === "up") &&
      view === "chat"
    ) {
      const next = reduceChromeFocus({
        focus: chromeFocus,
        key: e.name,
        subagentCount: liveSubagentCount,
        hasSnapshot: graphProgress !== null,
      });
      if (next.focus !== chromeFocus) {
        setChromeFocus(next.focus);
        // Dual-reducer sync (leaving): when three-ring focus exits graph,
        // the old reducer's focus must return to input too, or the next
        // Enter reads a stale "graph" and opens fullscreen unexpectedly.
        if (
          chromeFocus.kind === "graph" &&
          next.focus.kind !== "graph" &&
          graphChromeFocus !== "input"
        ) {
          setGraphChromeFocus("input");
        }
      }
      // Graph-fullscreen open never reaches this branch (short-circuited
      // above); closed, fullscreen ignores Down/Up, so the preventDefault
      // here is effectively a no-op.
      return;
    }

    // Shift+Tab cycles agent mode (permission cycle + optional graph
    // overlay state; without a graph holder it degrades to the two-state cycle).
    if (
      applyShiftTabAgentModeFlip({
        key: {
          name: e.name,
          shift: e.shift,
          ctrl: e.ctrl,
          meta: e.meta,
        },
        permission: permissionMode,
        graph: props.graphMode,
        // ADR-0141: a permission step clears a declared axis out of the
        // overlay; the wheel's start point is the effective posture.
        onUserPermissionChange: permissionClearHook(props.presetOverlay),
        ...(props.presetOverlay !== undefined
          ? {
              effectivePermission: props.presetOverlay.effectivePermission(),
            }
          : {}),
        onFlip: (next) => {
          setPermMode(next.permission);
          setGraphOn(next.graph);
        },
      })
    ) {
      return;
    }
    // Ctrl+C: copy selection only. Interrupt moved wholesale to the Esc
    // branch (interruptForegroundTurn incl. foreground-subagent fan-out),
    // so copying can never trigger an interrupt.
    if (isCtrlC) {
      // The copy arm lives in the helper — the handler only dispatches keys.
      handleCtrlCCopy();
      return;
    }
    // Ctrl+X: force-kill the chrome-focus selected live subagent.
    // Key detection stays here; the branch body is in the helper.
    if (e.ctrl && e.name === "x") {
      killFocusedSubagent();
      return;
    }
    if (view !== "chat") return;
    // Ctrl+O: toggle the thinking fold. Purely presentational — decoupled
    // from /thinking (thinkingEnabled). Key test in isThinkingFoldKey.
    if (isThinkingFoldKey(e)) {
      toggleThinkingFold();
      return;
    }
    // /config panel (ADR-0096): exclusive keys while open, checked before
    // model/memory/thinking — the most recently opened sibling panel wins.
    // Key routing + behavior live in applyConfigPickerKey and the
    // toggle*AndPersist helpers.
    if (configPickerOpen) {
      applyConfigPickerKey(modalKeyEventOf(e), {
        focusedIndex: configFocusIndex,
        onMove: setConfigFocusIndex,
        onToggleFsMode: () => toggleFsModeAndPersist(props, setNotice),
        onToggleWorktreeOnMutate: () =>
          toggleWorktreeOnMutateAndPersist(props, setNotice),
        onToggleSubagentCap: () =>
          toggleSubagentCapAndPersist(props, setNotice),
        onRerender: () => setConfigRenderTick((tick) => tick + 1),
        onClose: () => setConfigPickerOpen(false),
      });
      return;
    }
    // /model panel: exclusive keys while open (inserted after the Ctrl
    // branch). Semantics: ↑/↓ move focus, Enter selects + persists + closes,
    // Esc closes without persisting. Routing in applyModelPickerKey.
    if (modelPickerOpen) {
      applyModelPickerKey(modalKeyEventOf(e), {
        entries: modelPickerEntries(props.providers),
        focusedIndex: modelFocusIndex,
        onMove: setModelFocusIndex,
        onSelect: (routeId) =>
          void persistModelFromCommit(routeId, active.conversationId),
        onClose: () => setModelPickerOpen(false),
      });
      return;
    }
    if (memoryPickerOpen) {
      const action = reduceMemoryPickerKey(modalKeyEventOf(e), {
        focusedIndex: memoryFocusIndex,
      });
      switch (action.type) {
        case "move":
          setMemoryFocusIndex(action.index);
          break;
        case "toggle": {
          const row = memoryFocusIndex === 0 ? "autoExtract" : "dream";
          setMemoryPreview((prev) => applyMemoryPreviewToggle(prev, row));
          break;
        }
        case "fix":
          break;
        case "commit": {
          const patch = committedMemoryPatch(memoryPreview);
          setMemoryCommitted(patch);
          setMemoryPreview(patch);
          setMemoryPickerOpen(false);
          persistMemoryFromCommit(patch);
          break;
        }
        case "ignore":
          break;
      }
      return;
    }
    // thinking picker: exclusive keys while open. Priority: Ctrl combos >
    // picker > rewind > double Esc > ask modal (this branch sits after the
    // Ctrl branch; ctrl/meta combos are ignored by the reducer, not
    // swallowed). Enter fixes the preview (panel stays open); Esc saves to
    // real state — there is no cancel path.
    if (thinkingPickerOpen === "thinking") {
      const action = reduceThinkingSwitchKey(modalKeyEventOf(e));
      switch (action.type) {
        case "toggle":
          // Space/Tab: flip the switch preview; panel stays open.
          setSwitchPreview((prev) => !prev);
          break;
        case "fix":
          // Enter fixes the current preview without flipping it; the panel
          // stays open. With only ON/OFF states, fix just confirms the
          // preview — persistence happens on Esc either way.
          break;
        case "commit":
          // Esc: commit the fixed preview into thinkingEnabled, then close.
          setThinkingEnabled(switchPreview);
          // User-touched: later env baselines must not rewrite this field (see the subscription effect).
          thinkingTouchedRef.current = true;
          setThinkingPickerOpen(null);
          // Reverse persistence: fire-and-forget — never blocks the panel
          // update; failures show a notice (the in-memory override stands).
          void persistThinkingFromCommit(
            committedThinkingPatch({
              kind: "thinking",
              enabled: switchPreview,
            })
          );
          break;
        case "ignore":
          break;
      }
      return;
    }
    if (thinkingPickerOpen === "effort") {
      const action = reduceThinkingEffortKey(modalKeyEventOf(e), {
        focusedIndex: effortFocusIndex,
      });
      switch (action.type) {
        case "move":
          // ←/→: move the focus cursor; panel stays open.
          setEffortFocusIndex(action.index);
          break;
        case "fix":
          // Enter: fix the focused level as the committed preview; panel stays open.
          setEffortFixedIndex(effortFocusIndex);
          break;
        case "toggleAuto":
          // Space/Tab: toggle adaptive auto; panel stays open.
          setEffortAutoOn((prev) => !prev);
          break;
        case "commit": {
          // Esc: autoOn → write "" (stay adaptive, no downgrade); otherwise
          // the fixed concrete level. Both implicitly enable thinking; then close.
          setThinkingEffort(
            effortAutoOn ? "" : indexToEffort(effortFixedIndex)
          );
          setThinkingEnabled(true); // Implicitly enable thinking: picking a level turns it on
          // One /effort commit touches two fields — both are user-touched,
          // so later env baseline changes must not pull them back.
          thinkingTouchedRef.current = true;
          effortTouchedRef.current = true;
          setThinkingPickerOpen(null);
          // Reverse persistence: fire-and-forget — never blocks the panel
          // update; failures show a notice (the in-memory override stands).
          void persistThinkingFromCommit(
            committedThinkingPatch({
              kind: "effort",
              focusedIndex: effortFocusIndex,
              currentIndex: effortFixedIndex,
              autoOn: effortAutoOn,
            })
          );
          break;
        }
        case "ignore":
          break;
      }
      return;
    }
    // Active-modal exclusive keys: yolo-confirm > rewind (ADR-0119).
    // The modal discriminator + routing body both live in the helper (S5
    // complexity gate; see the helper header for the priority rationale), so
    // the closure makes one dispatch call.
    const activeConversationId = active.conversationId;
    if (
      dispatchActiveModalKey({
        yolo: {
          confirming: yoloConfirming,
          controller: props.yoloController,
          setters: {
            setYoloConfirming,
            setYoloOn,
            setNotice,
            setPermMode,
            permissionMode,
          },
        },
        rewind: {
          targets: rewindTargets,
          index: rewindIndex,
          confirming: rewindConfirming,
          confirmIndex: rewindConfirmIndex,
          setters: {
            setIndex: setRewindIndex,
            setConfirming: setRewindConfirming,
            setConfirmIndex: setRewindConfirmIndex,
            cancel: () => {
              setRewindTargets(undefined);
              setRewindIndex(0);
              setRewindConfirming(false);
              setRewindConfirmIndex(0);
              setNotice(undefined);
            },
            // Confirm-state Enter: the reducer yields execute without move, so
            // taking the target by the current index is safe (done in helper).
            // Missing session id (draft) → do not execute.
            execute: (target, restoreCode) => {
              if (activeConversationId !== undefined) {
                void executeRewind(activeConversationId, target, restoreCode);
              }
            },
          },
        },
        keyEvent: e,
      })
    ) {
      return;
    }
    // Double Esc (Esc is the sole interrupt entry): if the foreground has
    // work, interruptForegroundTurn (parent turn + this session's foreground
    // subagents, same criterion as /quit's canInterrupt) wins and only
    // records the timestamp; an idle first Esc only records the timestamp; a
    // second Esc within REWIND_DOUBLE_ESC_WINDOW_MS opens the L3 picker.
    // With askModalActive the block below dismisses the modal — no interception.
    if (e.name === "escape" && !askModalActive) {
      // Compaction cancel, or a queued draft's interrupt, consumes this Esc
      // before it can arm rewind. Compaction stays first: runState is idle
      // while compacting, so a bare interrupt would open the rewind picker.
      if (consumeLeadingEscape()) return;
      const nowMs = Date.now();
      const last = lastEscAtRef.current;
      // Interrupt first when the foreground has work: the criterion is
      // interruptForegroundTurn()'s own result (fresh hub-side foreground
      // accounting + aborter registry), not the TUI 1Hz projection, which
      // would miss wait:true children whose parent just went idle.
      if (interruptForegroundTurn().interrupted) {
        lastEscAtRef.current = nowMs;
        return;
      }
      if (last !== undefined && isDoubleEsc(last, nowMs)) {
        lastEscAtRef.current = undefined;
        const targetId = active.conversationId;
        if (targetId !== undefined) {
          void openRewindPicker(targetId);
        } else {
          setNotice({
            lines: ["当前是空会话，还没有可回退的点。"],
          });
        }
      } else {
        lastEscAtRef.current = nowMs;
      }
      return;
    }
    // Ask modal: exclusive keys while active.
    if (askModalActive && askPending !== undefined) {
      const action = reduceModalKey(modalKeyEventOf(e), {
        options: PERMISSION_ANSWERS,
        selectedIndex: permissionIndex,
      });
      switch (action.type) {
        case "move":
          setPermissionIndex(action.index);
          break;
        case "select":
          resolvePermissionAsk(askPending, action.value as PermissionAnswer);
          break;
        case "dismiss":
          setAskModalDismissed(true);
          break;
        case "ignore":
          break;
      }
    }
  });

  // ── Render views ────────────────────────────────────────────────────
  // Viewport height: row-level scrolling is gone (scrollbox has stickyScroll;
  // ChatView sizes itself). Banner and messages share the scrollbox, so the
  // banner is no longer deducted separately.
  // Chrome is budgeted item by item (chromeReserveRows SSOT): input 3 + mode
  // 1 + ContextBar 1 + bottom margin 1 + slash suggestions + notice /
  // modal wrapped rows + bgLine.
  // Budget only what can actually render: PromptInput windows the list to
  // HINT_MAX_ROWS rows, so a bare "/" (16 candidates) reserves 8, not 16 —
  // otherwise the surplus rows squeeze the chrome into overlapping lines on
  // short terminals.
  const hintRows = inputValue.trim().startsWith("/")
    ? Math.min(slashSuggestions(inputValue, skillList).length, HINT_MAX_ROWS)
    : 0;
  const bgSession = Object.values(sessions).find(
    (s) => s.runState === "running-bg"
  );
  const bgLine = bgSession !== undefined;
  const backgroundTaskLines = backgroundTaskLinesForView(view, backgroundTasks);
  const modalAsk =
    view === "chat" && askModalDismissed === false ? askPending : undefined;
  // The picker highlights the anchor row while selecting and an action row
  // while confirming; row accounting and ModalHost must agree on one index.
  const rewindRow = rewindConfirming ? rewindConfirmIndex : rewindIndex;
  // The modal row budget places yolo-confirm first, in the same order as the
  // ModalHost slot (priority rationale in the render-slot comment); the
  // existing ask / rewind order is preserved between them (the two never
  // coexist, so no practical effect). The discrimination is folded into a
  // module-level helper (S5 hard gate; see the helper header).
  const modalRows = modalRowsForBudget({
    yoloConfirmOpen: yoloConfirming !== undefined,
    rewind:
      rewindTargets === undefined
        ? undefined
        : {
            targets: rewindTargets,
            index: rewindIndex,
            confirming: rewindConfirming,
            rowIndex: rewindRow,
          },
    ask: modalAsk,
    cols,
  });
  // Picker row budget (thinking 5 / effort 7 + margins) joins the chrome
  // budget like modalRows, or the viewport would shrink. The
  // config/thinking/memory/model discrimination lives in a module-level helper.
  const pickerRows: number = pickerRowsForBudget({
    view,
    configPickerOpen,
    thinkingPickerOpen,
    memoryPickerOpen,
    modelPickerOpen,
    providers: props.providers,
  });
  // Compact panel: only the active session's entry (same ownership check as
  // crunchedOf / verifySlots — no other session's panel after switching away).
  const activeCompact: CompactProgressState | undefined =
    active.conversationId !== undefined
      ? compactPanels[active.conversationId]
      : undefined;
  // Panel discriminated union (shared by render slot + type annotation).
  const pickerState: ThinkingPickerState | null =
    view === "chat" && thinkingPickerOpen !== null
      ? thinkingPickerOpen === "thinking"
        ? { kind: "thinking", enabled: switchPreview }
        : {
            kind: "effort",
            focusedIndex: effortFocusIndex,
            currentIndex: effortFixedIndex,
            autoOn: effortAutoOn,
          }
      : null;
  // /model render state: built when open, else null (same shape as pickerState).
  const modelState: ModelPickerState | null = modelPickerStateFor(
    modelPickerOpen,
    view,
    props.providers,
    modelFocusIndex
  );
  // /config render state: built when open, else null (helper-folded discrimination).
  const configState: ConfigPickerState | null = configPickerStateFor(
    configPickerOpen,
    view,
    configFocusIndex
  );
  // Wrap-aware input row count: long text without `\n` still folds at cols.
  // The cap lives inside chromeReserveRows (SSOT); overflow scrolls within
  // the textarea.
  const inputContentRows = inputWrapLineCount(inputValue, cols);
  // Subagent panel renders under the input. Its rows must be budgeted
  // (capped at SUBAGENT_PANEL_MAX_ROWS): bottom chrome has no fixed height
  // and flexShrink=1, so an unbudgeted panel makes Yoga squeeze input
  // content into the borders once ≥7 live rows appear.
  // Agent status: 0-1 unchecked-todo line above the mode row; non-chat view
  // or no snapshot → 0 (component renders null).
  const agentStatusRowBudget =
    view === "chat" ? agentStatusLines(agentStatus, cols).length : 0;
  const subagentPanelRows = subagentPanelRowBudget(view, subagents, cols);
  // Env snapshot events are still received (harness informs humans, not
  // the model). envPaneRows renders a permanent session-location row (0/1):
  // the main-repo / non-task path shows it too; binding a task tree only
  // swaps the path for the live taskRoot. Branch comes from
  // env_snapshot.gitBranch; before the first snapshot only the path shows.
  // Read-only projection (sessionLocationLines), zero git operations.
  const envPaneRowBudget =
    view === "chat"
      ? sessionLocationLines({
          projectRoot: props.cwd,
          worktreeRoot:
            resolveWorktreeChromeRoot(
              active.workspaceRoot,
              liveTaskRoot?.read()
            ) ?? null,
          branch: envSnapshot?.gitBranch ?? null,
          cols,
        }).length
      : 0;
  // Location row recomputes with the snapshot (first frame fills the branch).
  void envSnapshot;
  // Verify banner row budget: active session's slot + permission mode
  // (interactive/full_auto); the marker derives from permMode alone, never
  // from goal presence. projectVerifyBanner (pure fn) yields 0/1 rows. Chat
  // view only — no render for switched-away sessions (ownership check like
  // crunchedOf).
  const verifyMode: "interactive" | "full_auto" =
    permMode === "full_auto" ? "full_auto" : "interactive";
  const verifySlot: VerifySlot | null =
    view === "chat" && active.conversationId !== undefined
      ? (verifySlots[active.conversationId] ?? { kind: "none" })
      : { kind: "none" };
  const verifyRowBudget =
    view === "chat"
      ? projectVerifyBanner(verifySlot, verifyMode, cols).length
      : 0;
  // Bottom chrome slots other than the notice lane: the lane's clipped row
  // count must be booked through the same ledger twice (once to learn what the
  // rest of the chrome costs, once for the final reserve), so the slot list is
  // built here and spread into both calls.
  const gapKey = resolveGapKey({
    activeKey,
    conversationId: active.conversationId,
    draftKey: DRAFT_SESSION_ID,
    liveKeys: [...liveTurnsRef.current],
  });
  const gapLine = viewGapLine(view, gapQueue, gapKey, cols);
  const chromeSlots = {
    inputHintRows: hintRows,
    bgLine,
    inputRows: inputContentRows,
    modalRows,
    pickerRows: pickerRows,
    compactRows:
      view === "chat" && activeCompact !== undefined
        ? compactProgressRows()
        : 0,
    // SubagentPanel rows are budgeted (collapsed height = render height);
    // see specs/tui-subagent-transcript-live.md for the superseded record.
    panelRows: subagentPanelRows,
    // Per specs/tui-subagent-transcript-live.md those two lines moved
    // onto the spawn card inside the transcript (scroll area), so this no
    // longer reserves chrome and subagentRowBudget stays 0. The call site
    // is kept so re-budgeting later needs no signature churn.
    subagentRows: subagentRowBudget(view, subagents),
    agentStatusRows: agentStatusRowBudget,
    envPaneRows: envPaneRowBudget,
    verifyRows: verifyRowBudget,
    graphRows: graphChromeRows(graphProgress),
    degradeRows: shellParseDegradeNoticeShown(view) ? 1 : 0,
    queueRows: gapChromeRows(gapLine),
    backgroundTaskRows: backgroundTaskLines.length,
  };
  // The lane's physical rows: folded once, clipped to what the terminal has
  // left, then booked and rendered from that same array.
  const noticeLines = noticeClippedLines(
    noticePhysicalLines(notice?.lines, cols),
    noticeLaneBodyRows(
      chromeReserveRows({ ...chromeSlots, noticeRows: 0 }),
      rows
    )
  );
  const viewportRows = Math.max(
    CHAT_MIN_VIEWPORT_ROWS,
    rows -
      chromeReserveRows({
        ...chromeSlots,
        noticeRows: noticeLines.length,
      })
  );
  // List and MCP views render no input box, mode row or ContextBar, so the only
  // bottom chrome they book is the notice lane plus these 2 headroom rows.
  const noticeLaneOnlyRows = (laneRows: number): number =>
    Math.max(CHAT_MIN_VIEWPORT_ROWS, rows - 2 - laneRows);
  // List view (ListView): only the notice occupies the bottom.
  const listViewRows = noticeLaneOnlyRows(noticeLines.length);
  // MCP dashboard view: same budget as the list.
  const mcpViewRows = noticeLaneOnlyRows(noticeLines.length);

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {view === "list" ? (
        <ListView
          entries={listEntries}
          cols={cols}
          rows={listViewRows}
          onOpen={(i) => void openSessionAt(i)}
          onBack={() => setView("chat")}
        />
      ) : view === "mcp" ? (
        <McpView
          statuses={mcpStatuses}
          tools={mcpTools}
          cols={cols}
          rows={mcpViewRows}
          onReload={reloadMcpView}
          onBack={() => setView("chat")}
        />
      ) : graphViewOpen && graphProgress !== null ? (
        <GraphGroupView
          snapshot={graphProgress}
          selectedId={graphSelectedId}
          detail={graphNodeDetail}
          cols={cols}
          rows={rows}
        />
      ) : (
        <>
          <box height={viewportRows} flexShrink={0} flexGrow={0}>
            <ChatView
              session={active}
              cols={cols}
              rows={viewportRows}
              draftSegments={draftSegments}
              thinkingDraftMasked={thinkingDraftMasked}
              liveToolLines={
                active.conversationId
                  ? (liveToolLines[active.conversationId] ?? [])
                  : []
              }
              liveToolRuns={
                active.conversationId
                  ? (liveToolRuns[active.conversationId] ?? [])
                  : []
              }
              subagents={subagents}
              askLine={askLineFor(askPending, askModalActive)}
              thinkingExpanded={thinkingExpanded}
              bannerLines={bannerLines}
              crunchedSeconds={
                crunchedOf === activeKey ? crunchedSeconds : undefined
              }
              backgroundRunningCount={countLiveBackgroundSubagents(
                subagents,
                active.conversationId
              )}
            />
          </box>
        </>
      )}
      {/* Notice lane: renders exactly the clipped physical rows the ledger
          booked (`noticeLines` is the single array both sides read, folded at
          the lane's own inner width and painted with wrapMode="none"), so a
          booked row is a painted row and an over-tall notice can only fold
          itself away, never crush the chrome below it. */}
      {noticeLines.length > 0 && (
        <box flexDirection="column" marginBottom={1}>
          {noticeLines.map((line, i) => (
            <text key={`notice-${i}`} fg={pal.dim} wrapMode="none">
              {line}
            </text>
          ))}
        </box>
      )}
      {view === "chat" && activeCompact !== undefined && (
        <CompactProgress state={activeCompact} />
      )}
      {pickerState !== null && <ThinkingPicker state={pickerState} />}
      {view === "chat" && memoryPickerOpen && (
        <MemoryPicker
          state={{
            focusedIndex: memoryFocusIndex,
            autoExtract: memoryPreview.autoExtract,
            dream: memoryPreview.dream,
          }}
        />
      )}
      {modelState !== null && <ModelPicker state={modelState} />}
      {/* ADR-0096 /config panel: all three rows are editable (Enter toggles
          each holder and persists). A missing holder (fsMode / subagentCap /
          worktreeOnMutate) makes its row display-only / no-op, but the panel
          still opens — unlike the model picker, which refuses to open
          without a providers registry. */}
      {configState !== null && (
        <ConfigPicker
          // Re-render counter as prop: after Enter toggles a holder, this
          // component re-reads holder.get() (holders are not subscribable;
          // see configRenderTick). Prop, not key — a key change would remount
          // and visibly replay the border animation.
          renderTick={configRenderTick}
          state={configState}
          fsMode={props.fsMode}
          worktreeOnMutateHolder={props.worktreeOnMutateHolder}
          worktreeOn={props.isolationOn}
          subagentCapHolder={props.subagentCapHolder}
          subagentCapDisplay={props.subagentCapDisplay}
          capRowInteractive={props.subagentCapHolder !== undefined}
        />
      )}
      {view === "chat" && (
        <ModalHost
          modal={
            // Modal slot priority: yolo-confirm > rewind > ask (ADR-0119).
            // yolo-confirm first: a dangerous-operation confirmation is the
            // most explicit pending intent, so Enter/Esc must reach it
            // directly; yolo and rewind never actually coexist (both disable
            // the input and cannot open past each other), and when the
            // engine-side ask opens during the confirmation, yolo-first lets
            // the confirmation finish first (the ask blocks — consistent with
            // its own blocking semantics). The row budget (modalRowsForBudget)
            // opens with the same order.
            yoloConfirming !== undefined
              ? {
                  kind: "select",
                  ...yoloEnterConfirmContent(),
                  // Confirmation state carries no selection semantics (the
                  // reducer ignores ↑↓); the highlighted row stays pinned to the
                  // execute option.
                  selectedIndex: 0,
                }
              : rewindTargets !== undefined
                ? {
                    kind: "select",
                    ...rewindPickerContent(
                      rewindTargets,
                      rewindIndex,
                      rewindConfirming
                    ),
                    selectedIndex: rewindRow,
                  }
                : askModalActive && askPending !== undefined
                  ? {
                      kind: "permission",
                      tool: askPending.tool,
                      summaryHint: askPending.summaryHint,
                      toolUseId: askPending.toolUseId,
                      selectedIndex: permissionIndex,
                    }
                  : undefined
          }
          cols={cols}
        />
      )}
      {view === "chat" && (
        <AgentStatusPanel snapshot={agentStatus} cols={cols} />
      )}
      {view === "chat" && (
        <box flexDirection="row">
          {/* ADR-0141: the base labels come from the SAME derived projection as
              the two indicators, so the suppression rule (a label drops out only
              for an axis a visible indicator states) is decided in one place.
              Each indicator keeps its own node because the indicators are red
              while the base labels are not — one projection cannot color them
              as one run. */}
          <ModeRowIndicators
            preset={preset}
            fenceRetired={fenceRetired}
            graphOn={graphOn}
            permMode={permMode}
            cols={cols}
          />
          {/* Live run seconds to the right of mode (`· Xs`, ticks per
              second); cleared at turn end — stats move to the trailing
              `Crunched for X` line. The live generation rate is NOT shown
              here: it is the context-bar suffix (`42 tok/s`, Plan A T6). */}
          {cols >= 40 &&
            active.runState === "running-fg" &&
            runStartedAt !== null && (
              <text fg={pal.dim}>{` · ${formatRunDuration(runElapsed)}`}</text>
            )}
        </box>
      )}
      {/* Verify terminal-state banner: outside the scroll area, between the
          mode row and the input. slot=none renders null (silent, no fake
          hint); HITL shows directly, full_auto prefixes [auto]. Rows
          budgeted via chromeReserveRows.verifyRows. */}
      {view === "chat" && (
        <VerifyBannerStrip slot={verifySlot} mode={verifyMode} cols={cols} />
      )}
      {/* The subagent identity bar above the prompt was removed — those
          two lines now render on the spawn card inside the session
          transcript (see specs/tui-subagent-transcript-live.md), so no
          subagent chrome rows remain here (subagentRowBudget stays 0). */}
      {shellParseDegradeNotice(view)}
      <GapQueueLine line={gapLine} color={pal.dim} />
      {view === "chat" && (
        <PromptInput
          ref={promptInputRef}
          draft={composerDraftRef.current}
          value={inputValue}
          cols={cols}
          maxLines={MAX_INPUT_LINES}
          placeholder={
            // Picker placeholder text (incl. /model) lives in
            // pickerPlaceholderFor; no picker open → ask / default text.
            pickerPlaceholderFor({
              yoloConfirmOpen: yoloConfirming !== undefined,
              rewindOpen: rewindTargets !== undefined,
              configPickerOpen,
              modelPickerOpen,
              memoryPickerOpen,
              thinkingPickerOpen,
            }) ??
            (askPending
              ? askModalActive
                ? "modal 键位接管中（Esc 退回输入）"
                : "y/a/n 确认工具授权（a=总是允许）"
              : "输入消息或 /help")
          }
          active={active.runState === "running-fg"}
          disabled={
            askModalActive ||
            rewindTargets !== undefined ||
            yoloConfirming !== undefined ||
            thinkingPickerOpen !== null ||
            memoryPickerOpen ||
            modelPickerOpen ||
            configPickerOpen ||
            // Input deactivation follows the chrome-focus reducer: disabled
            // while focus is on the subagent or graph ring.
            chromeFocus.kind !== "input" ||
            graphViewOpen
          }
          onChange={reportComposerValue}
          onSubmit={(v) => void handleSubmit(v)}
          onRecallQueued={recallQueuedDraft}
          onSelectHint={(candidate) => {
            // candidate is the SlashCandidate union: static command →
            // handleSubmit(`/${cmd}`) routing; skill → skill-load send. With
            // the hint bar visible Enter hits this callback instead of
            // onSubmit (PromptInput semantics), so preserve the typed
            // remainder: if inputValue's first token exactly matches the
            // candidate, submit the raw line; otherwise send the completion.
            if (candidate.kind === "command") {
              // Keep typed args: if the first token exactly matches the
              // selected command (e.g. /effort high) submit the raw line;
              // otherwise send `/{cmd}`. First token via slash.ts slashPrefix.
              const firstTok = slashPrefix(inputValue);
              if (firstTok === candidate.command) {
                void handleSubmit(inputValue);
              } else {
                void handleSubmit(`/${candidate.command}`);
              }
            } else {
              const load = parseSkillLoad(inputValue, skillList);
              if (load !== undefined && load.name === candidate.name) {
                void handleSubmit(inputValue);
              } else {
                void handleSubmit(`/${candidate.name}`);
              }
            }
          }}
          onTabComplete={(value, cursor) => {
            // A non-first highlighted candidate (cursor > 0) completes to
            // the hint selection; otherwise slashComplete's three-way
            // behavior: unique match, or longest-common-prefix partial.
            if (cursor > 0 && inputHintSuggestions.length > 0) {
              return slashCompleteFromCandidates(inputHintSuggestions, cursor);
            }
            return slashComplete(value, skillList);
          }}
          hintSuggestions={inputHintSuggestions}
          history={inputHistory}
          onLeaveToChrome={() => {
            // The three-state chrome-focus reducer (input/subagent(row)/
            // graph) replaces the old two-state graphChromeFocus.
            // PromptInput has already consumed the key when this fires, so
            // here the reducer only applies "leave input" semantics:
            // input → first reachable ring (subagent or graph).
            const next = reduceChromeFocus({
              focus: chromeFocus,
              key: "down",
              subagentCount: liveSubagentCount,
              hasSnapshot: graphProgress !== null,
            });
            // Pure reducer: detect the focus change with !== identity.
            if (next.focus !== chromeFocus) {
              setChromeFocus(next.focus);
            }
            // true = PromptInput yielded the key (preventDefault consumed),
            // so the app layer must not re-process it. Focus unchanged (no
            // reachable ring) → false, letting PromptInput keep its state.
            return next.focus !== chromeFocus;
          }}
        />
      )}
      {/* Chrome footer order below the prompt — JSX order = visual order.
          New rows go after ContextBar, never between ContextBar and
          PromptInput: ContextBar (model + ctx) → session location
          (path · branch) → subagent task list → graph. */}
      {view === "chat" && (
        <box flexDirection="row" justifyContent="flex-start">
          <ContextBar
            lastUsage={active.lastUsage}
            // Confirmed measured reading only (ADR-0008 2026-10-22);
            // absent → the bar falls back to `lastUsage`.
            displayOccupancy={active.displayOccupancy}
            // Plan A T6: the live / final generation rate (`42 tok/s`).
            tokenSpeed={tokenSpeedReadingFor(
              tokenSpeedReadings,
              active.conversationId
            )}
            contextWindow={props.bridge.contextWindow}
            running={active.runState === "running-fg"}
            cols={cols}
            // ContextBar subscribes to envDisplay itself: env changes never
            // re-render this tree, so the model name needn't be threaded via
            // props. providers is a startup constant and still comes via props.
            envDisplay={envDisplay}
            // ADR-0145: the current conversation's own route wins over the
            // store's default; absent (a draft / no route yet) → the store's.
            model={active.model}
            providers={props.providers}
            effortLabel={
              thinkingEnabled ? formatEffortLabel(thinkingEffort) : "off"
            }
          />
        </box>
      )}
      {/* Session location row (below ContextBar, above the subagent
          panels; envPaneRows budget unchanged): a permanent
          `path · branch` line whose slot shows the task-tree root when
          bound. Not in the focus ring, no dirty/diff. */}
      {view === "chat" &&
        sessionLocationLines({
          projectRoot: props.cwd,
          worktreeRoot:
            resolveWorktreeChromeRoot(
              active.workspaceRoot,
              liveTaskRoot?.read()
            ) ?? null,
          branch: envSnapshot?.gitBranch ?? null,
          cols,
        }).map((line, idx) => (
          <text key={idx} fg={line.fg} wrapMode="none">
            {line.text}
          </text>
        ))}
      {backgroundTaskLines.map((line, idx) => (
        <text key={`background-task-${idx}`} wrapMode="none">
          {line}
        </text>
      ))}
      {/* Subagent panel under the location row; its rows count into the
          chrome budget (collapsed at SUBAGENT_PANEL_MAX_ROWS). focusedRow
          expands that live row's full taskPreview with a `> ` prefix while
          others stay truncated — only reducer-addressable live rows
          (SubagentPanel projects by liveIndex). */}
      {view === "chat" && (
        <SubagentPanel
          subagents={subagents}
          cols={cols}
          maxRows={SUBAGENT_PANEL_MAX_ROWS}
          focusedRow={
            chromeFocus.kind === "subagent" ? chromeFocus.row : undefined
          }
        />
      )}
      {view === "chat" && (
        <GraphChromePanel
          snapshot={graphProgress}
          cols={cols}
          focused={chromeFocus.kind === "graph"}
        />
      )}
      {bgSession !== undefined && (
        <box>
          <text fg={pal.dim}>{bgStatusLine(bgSession.messages)}</text>
        </box>
      )}
      {/* Bottom breathing room: emits exactly the rows chromeReserveRows
          books as BOTTOM_MARGIN_ROWS — the ledger and the render move
          together, so no reserve row is ever unclaimed. */}
      {view === "chat" && <box height={BOTTOM_MARGIN_ROWS} flexShrink={0} />}
    </box>
  );
}

export function infoLines(
  session: TuiSessionState,
  key: string,
  contextWindow: number,
  thinking: { readonly enabled: boolean; readonly effort: ThinkingEffortWire },
  /** Current model string, shown verbatim as `Model: <provider>/<model>`;
   *  without a providers section the same line still shows — no fake prefix. */
  model: string | undefined
): ReadonlyArray<string> {
  const lu = session.lastUsage;
  const tokenLines =
    lu === null
      ? ["tokens: —"]
      : [
          `tokens in/out: ${lu.inputTokens}/${lu.outputTokens}`,
          `cache read: ${lu.cacheReadInputTokens}`,
          `window: ${contextWindow}`,
        ];
  // Thinking row: off / adaptive (auto) / adaptive (high)...
  // formatEffortLabel maps an empty enabled effort to "auto" (single label source).
  const thinkingLine = thinking.enabled
    ? `thinking: adaptive (${formatEffortLabel(thinking.effort)})`
    : "thinking: off";
  // `Model: <provider>/<model>` line: when the envDisplay snapshot has no
  // model route, drop the whole line instead of rendering `Model: undefined`.
  const modelLine = model !== undefined ? [`Model: ${model}`] : [];
  return [
    `conversation_id: ${session.conversationId ?? key}（${
      session.conversationId ? "已建档" : "draft，首条消息后建档"
    }）`,
    `turnCount: ${session.turnCount}`,
    `updatedAt: ${session.updatedAt ? relativeTime(session.updatedAt) : "—"}`,
    `jsonMode: ${session.jsonMode}`,
    `runState: ${session.runState}`,
    ...tokenLines,
    thinkingLine,
    ...modelLine,
  ];
}

/** Background-session status line: "running in background · <title>".
 *  Pure and unit-testable: an empty title falls back to the bare label. */
export function bgStatusLine(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const title = extractTitle(messages);
  return title.length > 0 ? `后台运行中 · ${title}` : "后台运行中";
}

/**
 * ADR-0094: single-point builder for the viewport API-error notice line.
 * Input is summarizeTransportCause output ({ status?, message }): with a
 * status → "⚠ API error (status): ...", otherwise "⚠ API error: ...". All
 * three call sites share this helper — no inlined ternary duplicates.
 */
function apiErrorNoticeLine(summary: {
  readonly status?: number;
  readonly message: string;
}): string {
  return summary.status !== undefined
    ? `⚠ API error (${summary.status}): ${summary.message}`
    : `⚠ API error: ${summary.message}`;
}

/**
 * Throw-path provider-failure test: only summaries carrying an HTTP status
 * (SDK APIError shape) count as provider/transport errors. Hub-side local
 * validation errors (status-less ValidationError / NotFoundError) return
 * undefined so describeError text stands — never posing as an API error.
 */
function transportApiErrorFromThrow(
  err: unknown
): { readonly status: number; readonly message: string } | undefined {
  const summary = summarizeTransportCause(err);
  return summary !== undefined && summary.status !== undefined
    ? { status: summary.status, message: summary.message }
    : undefined;
}

/**
 * Whole throw-path outcome for runTurnOnce's catch (single complexity
 * point): picks notice lines / stop reason / refresh skip per mode. A
 * continue EXIT / validation error sets no stopReason — it projects as
 * completed to keep existing semantics.
 */
function turnFailureOutcome(opts: {
  readonly mode: "append" | "continue" | "wake";
  readonly err: unknown;
  readonly thrownApiError:
    { readonly status?: number; readonly message: string } | undefined;
}): {
  readonly stopReason?: string;
  readonly noticeLines: readonly string[];
  readonly skipTurnRefresh: boolean;
} {
  if (opts.mode === "continue") {
    const exit = continueExitFromError(opts.err);
    if (exit !== undefined) {
      return { noticeLines: continueNoticeFor(exit), skipTurnRefresh: true };
    }
    if (isContinueValidationError(opts.err)) {
      return { noticeLines: [opts.err.message], skipTurnRefresh: true };
    }
    return {
      stopReason: "protocolError",
      noticeLines: [
        opts.thrownApiError !== undefined
          ? apiErrorNoticeLine(opts.thrownApiError)
          : `续跑失败：${describeError(opts.err)}`,
      ],
      skipTurnRefresh: false,
    };
  }
  if (opts.mode === "wake") {
    return {
      stopReason: "protocolError",
      noticeLines: [toSubagentWakeError(opts.err).message],
      skipTurnRefresh: false,
    };
  }
  return {
    stopReason: "protocolError",
    noticeLines: [
      opts.thrownApiError !== undefined
        ? apiErrorNoticeLine(opts.thrownApiError)
        : `turn 失败：${describeError(opts.err)}`,
    ],
    skipTurnRefresh: false,
  };
}

/**
 * The notice lane's durable content for a session just opened: its last
 * settled turn's output-limit notice (carried by session state, which takes it
 * from the persisted outcome on reopen and from the live answer at turn end).
 * Undefined for every other outcome — an unknown one included, which is never
 * labelled either way.
 */
function turnLaneNoticeFor(
  session: TuiSessionState | undefined
): Notice | undefined {
  const notice = session?.outputLimitNotice;
  // ADR-0136: a session open carries its recovery status in the same lane, so
  // the restored state and the truncation notice never hide one another.
  const recovery = recoveryNoticeLines(session);
  if (notice === undefined && recovery.length === 0) return undefined;
  return {
    lines: [...recovery, ...(notice === undefined ? [] : [notice])],
  };
}

/**
 * The notice lane's line for a run that stopped at the turn cap: what ended, and
 * what is still open. English per docs/CONTEXT.md "sticky notice"; one line,
 * shorter than the notice box inner width, so it never re-wraps the chrome.
 */
const TURN_CAP_NOTICE_LINES: ReadonlyArray<string> = [
  "⚠ Turn cap reached (maxTurns) — send a message to continue.",
];

/**
 * Compose the cap line with what this turn's stream already left in the lane. A
 * wrap-up summary stays above it (it says what got done before the cap); a
 * transport_retry or silence heartbeat is dropped, since both describe a run
 * that is no longer running.
 */
function turnCapNotice(
  notice: Notice | undefined,
  transportRetryShown: boolean
): Notice {
  const carried =
    notice === undefined ||
    transportRetryShown ||
    isStreamingSilenceNotice(notice)
      ? []
      : notice.lines;
  return { lines: [...carried, ...TURN_CAP_NOTICE_LINES] };
}

/**
 * End-of-turn notice-lane decision for stops that are neither interrupted nor
 * an abnormal fault. `maxTurns` keeps its own line: the cap stopped this run,
 * not the session, and a cap is not a fault, so it must not borrow the
 * abnormal-stop wording. Otherwise teardown clears only this turn's transient
 * texts — a completed turn must not keep "backing off…" lingering, and the
 * silence-wait text goes too unless a stronger source (stop_summary etc.)
 * replaced it; the identity check returns other notices untouched, no
 * re-render. A turn-cap line clears at the next run's own boundary
 * (handleSubmit).
 */
function turnTeardownNotice(
  notice: Notice | undefined,
  stopReason: string | undefined,
  retryNoticeShown: boolean
): Notice | undefined {
  if (stopReason === "maxTurns") return turnCapNotice(notice, retryNoticeShown);
  if (retryNoticeShown) return undefined;
  return isStreamingSilenceNotice(notice) ? undefined : notice;
}

/**
 * Notice lines for abnormal stopReasons: protocolError + apiError gets the
 * dedicated API-error text; an output-limit stop shows the hub's own durable
 * notice line; other abnormal stops get the generic
 * "turn did not finish" line.
 */
function abnormalStopNoticeLines(
  stopReason: string,
  apiError: { readonly status?: number; readonly message: string } | undefined,
  outputLimitNotice?: string
): string[] {
  // The notice is attached by the hub only for a recorded truncation, so this
  // never rewrites another stop reason's text.
  if (stopReason === "nonSuccessStop" && outputLimitNotice !== undefined) {
    return [outputLimitNotice];
  }
  return stopReason === "protocolError" && apiError !== undefined
    ? [apiErrorNoticeLine(apiError)]
    : [`⚠ turn 未成功结束（${stopReason}）：可能是连接或模型故障，请重试`];
}

function describeError(err: unknown): string {
  // ADR-0093: a provider hit with unset apiKeyEnv is a typed plain object,
  // not an Error. Recognize the discriminated union `kind` first —
  // String(err) would flatten it to [object Object], hiding kind /
  // providerId / apiKeyEnv (typed-error catch contract, code-quality.md).
  if (isLlmProviderConfigError(err)) {
    return formatLlmProviderConfigError(err);
  }
  if (typeof err === "object" && err !== null && "kind" in err) {
    const kind = String((err as { kind: unknown }).kind);
    const detail = typedErrorDetail(
      err as { conversation_id?: unknown; sha?: unknown }
    );
    return `会话存储错误 [${kind}]${detail === "" ? "" : ` ${detail}`}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Which locator a typed store error names: the session it failed on, or —
 *  for the preimage blob store — the content address it could not read. Kind
 *  alone says what went wrong; without this the operator sees no target. */
function typedErrorDetail(err: {
  conversation_id?: unknown;
  sha?: unknown;
}): string {
  if (typeof err.conversation_id === "string") return err.conversation_id;
  if (typeof err.sha === "string") return `blob ${err.sha}`;
  return "";
}
