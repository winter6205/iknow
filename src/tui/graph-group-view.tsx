/** @jsxImportSource @opentui/react */
/**
 * run_graph 全屏语义分组视图。独立 view，不走 ChatView 行账。
 * 节点 last 输出用快照 summary 文本，不用原型假 transcript。
 */
import type { ReactNode } from "react";
import type { GraphProgressSnapshot } from "../harness/graph/progress.js";
import { tuiPalette } from "./theme.js";
import {
  formatGraphNodeDetail,
  graphGroupRows,
  sliceGraphViewRows,
  type GraphViewRow,
} from "./graph-group.js";

export interface GraphGroupViewProps {
  readonly snapshot: GraphProgressSnapshot;
  readonly selectedId: string | null;
  readonly detail: boolean;
  readonly cols: number;
  readonly rows: number;
}

function rowFg(row: GraphViewRow, selected: boolean): string {
  if (selected) return tuiPalette.text;
  return row.dim ? tuiPalette.dim : tuiPalette.text;
}

export function GraphGroupView(props: GraphGroupViewProps): ReactNode {
  const rows = sliceGraphViewRows(
    graphGroupRows(props.snapshot, props.selectedId),
    props.selectedId,
    Math.max(1, props.rows)
  );
  if (props.detail && props.selectedId !== null) {
    const node = props.snapshot.nodes.find((n) => n.id === props.selectedId);
    return (
      <box flexDirection="column" height={props.rows} width={props.cols}>
        <text fg={tuiPalette.dim}>node {props.selectedId}</text>
        <text wrapMode="word">{formatGraphNodeDetail(node)}</text>
      </box>
    );
  }
  return (
    <box flexDirection="column" height={props.rows} width={props.cols}>
      {rows.map((row) => (
        <text
          key={row.key}
          fg={rowFg(row, row.nodeId === props.selectedId)}
          wrapMode="none"
        >
          {row.nodeId === props.selectedId ? `> ${row.text}` : `  ${row.text}`}
        </text>
      ))}
    </box>
  );
}
