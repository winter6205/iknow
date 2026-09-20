/** @jsxImportSource @opentui/react */
/**
 * One line of run_graph main-session chrome: English `graph` + counts + now,
 * below the usage bar. Data comes only from `graph_progress` snapshot DTOs;
 * no scheduler / topo imports.
 */
import type { ReactNode } from "react";
import type { GraphProgressSnapshot } from "../harness/graph/progress.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

export type GraphChromeFocus = "input" | "graph";

export interface GraphChromeLine {
  readonly fg: string;
  readonly text: string;
}

/**
 * graph_progress → snapshot. A null snapshot clears the slot; any other event
 * keeps the old one (returns undefined).
 */
export function graphProgressFromEvent(
  event: HarnessStreamEvent
): GraphProgressSnapshot | null | undefined {
  if (event.type !== "graph_progress") return undefined;
  return event.snapshot;
}

function doneCount(snapshot: GraphProgressSnapshot): number {
  return snapshot.nodes.filter((n) => n.status === "done").length;
}

function nowNames(snapshot: GraphProgressSnapshot): string {
  return snapshot.nodes
    .filter((n) => n.status === "running")
    .map((n) => n.id)
    .join(",");
}

export function graphChromeLine(
  snapshot: GraphProgressSnapshot | null,
  cols: number,
  focused: boolean
): GraphChromeLine | null {
  if (snapshot === null) return null;
  const prefix = focused ? "> " : "";
  const now = nowNames(snapshot);
  const body =
    now.length > 0
      ? `graph ${doneCount(snapshot)}/${snapshot.nodes.length} now ${now}`
      : `graph ${doneCount(snapshot)}/${snapshot.nodes.length}`;
  const text = clipOneLineVisual(`${prefix}${body}`, Math.max(1, cols));
  return { fg: tuiPalette.dim, text };
}

export function graphChromeRows(
  snapshot: GraphProgressSnapshot | null
): number {
  return snapshot === null ? 0 : 1;
}

export interface ReduceGraphChromeFocusInput {
  readonly focus: GraphChromeFocus;
  readonly hasSnapshot: boolean;
  readonly key: string;
}

export interface ReduceGraphChromeFocusResult {
  readonly focus: GraphChromeFocus;
  readonly openView?: true;
}

export function reduceGraphChromeFocus(
  input: ReduceGraphChromeFocusInput
): ReduceGraphChromeFocusResult {
  if (!input.hasSnapshot) return { focus: "input" };
  if (input.focus === "input") {
    if (input.key === "down" || input.key === "tab") {
      return { focus: "graph" };
    }
    return { focus: "input" };
  }
  if (input.key === "escape" || input.key === "up") {
    return { focus: "input" };
  }
  if (input.key === "return") {
    return { focus: "graph", openView: true };
  }
  return { focus: "graph" };
}

export interface GraphChromePanelProps {
  readonly snapshot: GraphProgressSnapshot | null;
  readonly cols: number;
  readonly focused: boolean;
}

export function GraphChromePanel(props: GraphChromePanelProps): ReactNode {
  const line = graphChromeLine(props.snapshot, props.cols, props.focused);
  if (line === null) return null;
  return (
    <box>
      <text fg={line.fg} wrapMode="none">
        {line.text}
      </text>
    </box>
  );
}
