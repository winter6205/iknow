import type { IknowAnswer } from "../shared/schema.js";

/** Short display for long snapshot hashes (full id still in JSON view). */
const SNAPSHOT_SHORT_LEN = 12;

/**
 * Human projection of G2 IknowAnswer (design §7).
 * Always includes governance_status and snapshot_id (short form).
 * Never drops required envelope fields from the conceptual display set.
 */
export function formatAnswerHuman(answer: IknowAnswer): string {
  const lines: string[] = [];

  lines.push(answer.text);
  lines.push("");
  lines.push("—— 依据 ——");

  if (answer.source_spans.length === 0) {
    lines.push("(无 source_spans)");
  } else {
    answer.source_spans.forEach((span, i) => {
      const n = i + 1;
      const quotePart =
        span.quote !== undefined && span.quote.length > 0
          ? `  ${span.quote}`
          : "";
      lines.push(`[${n}] ${span.chunk_id}${quotePart}`);
    });
  }

  lines.push("");
  const snapshotShort = shortSnapshot(answer.snapshot_id);
  lines.push(
    `治理: ${answer.governance_status}  ·  snapshot: ${snapshotShort}`,
  );
  const tools =
    answer.tool_trace.length > 0 ? answer.tool_trace.join(",") : "-";
  lines.push(` hops: ${answer.hops_used}  ·  tools: ${tools}`);

  if (answer.notes && answer.notes.length > 0) {
    for (const note of answer.notes) {
      lines.push(note);
    }
  }

  return lines.join("\n");
}

/**
 * Machine projection: full pretty-printed IknowAnswer (incl. tool_calls).
 */
export function formatAnswerJson(answer: IknowAnswer): string {
  return JSON.stringify(answer, null, 2);
}

function shortSnapshot(snapshotId: string): string {
  if (snapshotId.length <= SNAPSHOT_SHORT_LEN) {
    return snapshotId;
  }
  return snapshotId.slice(0, SNAPSHOT_SHORT_LEN);
}
