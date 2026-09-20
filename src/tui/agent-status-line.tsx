/** @jsxImportSource @opentui/react */
/**
 * TUI projection of the ADR-0028 status bar: show only unchecked todos to
 * the human (above the mode line, compressed to one row). `last_tool` still
 * goes into the model's `<agent_status>` bar and the tool_call trace, but is
 * not mapped to chrome.
 *
 * Data contract: the single source is the `agent_status` stream event from
 * the same computation point that injects the harness bar; this module never
 * reads the todo ledger file. replace-on-event: each event yields a complete
 * independent snapshot.
 *
 * Display: unchecked items → one row `□ a · b · c` (truncated by visual
 * width); no unchecked items / null → 0 rows.
 */
import type { ReactNode } from "react";
import type { AgentStatusSnapshot } from "../harness/agent-status.js";
import { pickPresentAgentStatusSlots } from "../harness/agent-status.js";
import { parseLedger } from "../harness/aci/tools/todo-ledger.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

const ITEM_PREFIX = "□ ";

export interface AgentStatusLine {
  readonly fg: string;
  readonly text: string;
}

export function agentStatusFromEvent(
  event: HarnessStreamEvent
): AgentStatusSnapshot | null {
  if (event.type !== "agent_status") return null;
  // instruction / reconcile slots pass through with the event (same source as
  // the injected bar); projection rule = pickPresentAgentStatusSlots SSOT
  // (same source as snapshot assembly and event emission; absent slot → key
  // omitted, falling back to the old field-set shape). Display surface
  // unchanged — agentStatusLines still projects openTodoLines only.
  return Object.freeze({
    lastTool: event.lastTool,
    openTodoLines: Object.freeze([...event.openTodoLines]),
    ...pickPresentAgentStatusSlots(event),
  });
}

/** Row display text = the subject parsed by the ledger-syntax SSOT; non-syntax lines pass through verbatim. */
function todoBody(raw: string): string {
  return parseLedger(raw)[0]?.subject ?? raw;
}

export function agentStatusLines(
  snapshot: AgentStatusSnapshot | null,
  cols: number
): ReadonlyArray<AgentStatusLine> {
  if (snapshot === null) return [];
  const items = snapshot.openTodoLines;
  if (items.length === 0) return [];
  const joined = items.map(todoBody).join(" · ");
  const budget = Math.max(0, cols - visualWidth(ITEM_PREFIX));
  return [
    {
      fg: tuiPalette.dim,
      text: `${ITEM_PREFIX}${clipOneLineVisual(joined, budget)}`,
    },
  ];
}

export interface AgentStatusPanelProps {
  readonly snapshot: AgentStatusSnapshot | null;
  readonly cols: number;
}

export function AgentStatusPanel(props: AgentStatusPanelProps): ReactNode {
  const lines = agentStatusLines(props.snapshot, props.cols);
  if (lines.length === 0) return null;
  return (
    <box flexDirection="column">
      {lines.map((line, idx) => (
        <text key={idx} fg={line.fg} wrapMode="none">
          {line.text}
        </text>
      ))}
    </box>
  );
}
