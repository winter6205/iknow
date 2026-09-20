/**
 * src/tui/tool-settled.ts
 *
 * Settled-appearance policy core. Pure TS, no React / Ink dependencies; the
 * renderer only consumes slots from `deriveSlot` and never recombines title
 * hiding and preview decisions itself.
 *
 * Derivation order: running calls all stay visible individually → success
 * dispatches by class → failure cuts across at the last step and overrides
 * everything (error color beats accent).
 *
 * The class table is declared here as the single source: the registry in
 * `tool-summary.ts` reuses it per tool name via
 * `settledClass: TOOL_SETTLED_CLASS[name] ?? "retract"`, so the two places
 * cannot drift. Unregistered names default to retract — the policy core must
 * not import the registry, or it would pull in the React chain in reverse.
 */
/**
 * Success-state classification: keep / retract / accent.
 * "subagent" is outside those three — used only by spawn_subagent /
 * subagent_result; the core special-cases it before class dispatch into
 * keep-title-only (title shown, no preview, not in the fold count, default
 * color), leaving glyph differences to the renderer. Declared as an explicit
 * literal rather than an omitted key + `!` assertion, so a missing or
 * misreported entry fails at compile time or in the cross-core gate
 * (tool-settled.test single-sources the subagent set) instead of silently
 * resolving to retract at runtime.
 */
export type SettledClass = "keep" | "retract" | "accent" | "subagent";

/** Slot color token (maps to tuiPalette; the core never decides dim — dim belongs only to the successful bash tail). */
export type SettledColor = "default" | "accent" | "error";

/** Slot color token → palette foreground color.
 *  default falls to dim (the existing secondary form of tool title lines);
 *  dim itself is not decided by the core and the mapping belongs to the
 *  renderer, but both rendering sites (message-blocks / live-tool-preview)
 *  share this function so the color→palette table cannot drift. theme.ts is
 *  pure TS with no React dependency, so the core can reference its types. */
export function settledColorToFg(
  color: SettledColor,
  palette: {
    readonly default: string;
    readonly accent: string;
    readonly error: string;
  }
): string {
  switch (color) {
    case "error":
      return palette.error;
    case "accent":
      return palette.accent;
    case "default":
      return palette.default;
  }
}

/** The only form the renderer consumes: title / preview / fold count / color. */
export interface SettledSlot {
  readonly showTitle: boolean;
  readonly showPreview: boolean;
  /** The fold-count line aggregates only items whose flag is true (success and retract). */
  readonly inFoldCount: boolean;
  readonly color: SettledColor;
}

export interface SettledState {
  readonly running: boolean;
  readonly failed: boolean;
}

/**
 * Success-state class table. SSOT: the tool-summary.ts registry reuses this
 * table per name; spawn_subagent / subagent_result are listed explicitly with
 * the "subagent" class (outside the three classes; the core gives them a
 * keep-title-only slot — title shown, no preview, not in the fold count,
 * default color), glyph differences left to the renderer.
 */
export const TOOL_SETTLED_CLASS: Readonly<Record<string, SettledClass>> = {
  // keep: footprints that stay visible
  bash: "keep",
  write_file: "keep",
  edit_file: "keep",
  bash_stop: "keep",
  todo_write: "keep",
  memory_save: "keep",
  // retract: folded away, title and preview hidden together, counted only in the fold line
  read_file: "retract",
  // Per the read-image-vision spec, same class as read_file. Unregistered
  // names already default to retract, but register it explicitly — summary
  // consumers read TOOL_SETTLED_CLASS[name] directly, so a missing key is a hole.
  read_image: "retract",
  grep: "retract",
  glob: "retract",
  web_search: "retract",
  web_fetch: "retract",
  memory_recall: "retract",
  tool_search: "retract",
  // skill_search was removed (ADR-0046). Historical transcripts still carry
  // the name (its tool_result is already in the message), so the unregistered
  // default of retract covers it — no explicit entry needed.
  bash_output: "retract",
  list_mcp_resources: "retract",
  read_mcp_resource: "retract",
  query_trace: "retract",
  "list-worktrees": "retract",
  lsp_definition: "retract",
  lsp_references: "retract",
  lsp_hover: "retract",
  lsp_go_to_implementation: "retract",
  lsp_prepare_call_hierarchy: "retract",
  lsp_incoming_calls: "retract",
  lsp_outgoing_calls: "retract",
  lsp_diagnostics: "retract",
  lsp_document_symbol: "retract",
  lsp_workspace_symbol: "retract",
  // accent: named tools get the accent color
  skill: "accent",
  "create-worktree": "accent",
  "enter-worktree": "accent",
  "exit-worktree": "accent",
  "remove-worktree": "accent",
  // Outside the three classes (standalone glyph is kept): declared explicitly,
  // and the core special-cases keep-title-only before class dispatch — the
  // registry and the core share one subagent list, pinned by the cross-core gate.
  spawn_subagent: "subagent",
  subagent_result: "subagent",
};

/** Class lookup: unregistered names default to retract (unknown tools: retract, no preview). */
export function settledClassOf(name: string): SettledClass {
  return TOOL_SETTLED_CLASS[name] ?? "retract";
}

/** Live-noise test: true = the tool's running phase belongs in the process
 *  block's `calling`/`called` lines / slot preview — i.e. the retract tools
 *  minus web_search / web_fetch (those are live signals and render as real
 *  cards). The settled counting rule is unchanged: TOOL_SETTLED_CLASS still
 *  records web_* as retract; this predicate only gates live-block entry, and
 *  no consumer should count live web_* into `calling`/`called` or unanchored
 *  blocks. */
export function isLiveNoise(name: string): boolean {
  if (isLiveSignal(name)) return false;
  return settledClassOf(name) === "retract";
}

/** The web subset of live signals: web_search / web_fetch keep one real card
 *  line both live and settled (the query / URL is already in the title).
 *  This predicate is the single source of the carve-out list — both
 *  isLiveNoise's exclusion and the renderer's "title stays when settled"
 *  fallback reference it, so tool names are not hardcoded in each place. */
export function isLiveSignal(name: string): boolean {
  return name === "web_search" || name === "web_fetch";
}

/** Slot for the success state, dispatched by class. */
function slotForClass(cls: SettledClass): SettledSlot {
  switch (cls) {
    case "keep":
      // keep: title stays; showPreview is further filtered by the caller's
      // preview channel. Per docs/CONTEXT.md, the keep class: successful bash
      // keeps the command + a collapsed result preview; write / edit keep the
      // completion preview; the other keeps (bash_stop / todo_write /
      // memory_save) have no preview content anyway. Who really keeps a
      // preview is decided by KEEP_WITH_PREVIEW (bash / write_file / edit_file).
      return {
        showTitle: true,
        showPreview: true,
        inFoldCount: false,
        color: "default",
      };
    case "retract":
      // retract: title and preview must be false together.
      return {
        showTitle: false,
        showPreview: false,
        inFoldCount: true,
        color: "default",
      };
    case "accent":
      // accent: color only, never a body preview.
      return {
        showTitle: true,
        showPreview: false,
        inFoldCount: false,
        color: "accent",
      };
    case "subagent":
      // Outside the three classes: keep-title-only (glyph differences left to the renderer).
      return KEEP_TITLE_ONLY_SLOT;
  }
}

const RETRACT_SLOT = slotForClass("retract");
const ACCENT_SLOT = slotForClass("accent");
/** keep-title-only: session-action tools (bash_stop / todo_write / memory_save)
 *  and the subagent tools outside the three classes. */
const KEEP_TITLE_ONLY_SLOT: SettledSlot = {
  showTitle: true,
  showPreview: false,
  inFoldCount: false,
  color: "default",
};
const KEEP_WITH_PREVIEW_SLOT = slotForClass("keep");
const FAILED_SLOT: SettledSlot = {
  showTitle: true,
  showPreview: false,
  inFoldCount: false,
  color: "error",
};
/** Running state: everything stays individually visible, nothing enters the fold count early. */
const RUNNING_SLOT: SettledSlot = {
  showTitle: true,
  showPreview: false,
  inFoldCount: false,
  color: "default",
};

/** keep tools that carry a preview footprint: bash's collapsed tail window; write/edit completion preview. */
const KEEP_WITH_PREVIEW: ReadonlySet<string> = new Set([
  "bash",
  "write_file",
  "edit_file",
]);

/**
 * The single settled-state derivation. Input: tool name and { running, failed };
 * output: the render slot. Failure cuts across at the last step: any class
 * failing → title stays, error color, no fold count, no preview.
 * Pure function, no shared mutable state.
 */
export function deriveSlot(name: string, state: SettledState): SettledSlot {
  // Failure is the last crosscut: error beats accent / keep.
  if (state.failed) return FAILED_SLOT;
  if (state.running) return RUNNING_SLOT;
  const cls = settledClassOf(name);
  // Subagents never join the three classes (standalone glyph is kept): the
  // class table declares "subagent" explicitly, separated from the unregistered
  // retract default (they are not collapsed as a fallback).
  if (cls === "subagent") return KEEP_TITLE_ONLY_SLOT;
  if (cls === "retract") return RETRACT_SLOT;
  if (cls === "accent") return ACCENT_SLOT;
  // Within keep: bash / write / edit carry a preview footprint, the rest are title-only.
  return KEEP_WITH_PREVIEW.has(name)
    ? KEEP_WITH_PREVIEW_SLOT
    : KEEP_TITLE_ONLY_SLOT;
}
