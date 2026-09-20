/**
 * Rewind picker anchors are projected from the current head's ancestor
 * chain: head points at the chosen user message's parent (rewind lands
 * before it); fillInput puts the prompt back into the input box. Skipped
 * branches stay in the JSONL but are not listed in the default picker.
 */
import { isTurnQuery } from "../turn-projection.js";
import type { AnthropicNativeMessage } from "../../harness/index.js";
import type { CheckpointRecord } from "./schema.js";
import {
  headChainEvents,
  type ParsedSessionLog,
  type SessionEventRecord,
} from "./jsonl.js";

export type LedgerRewindTarget = {
  readonly head: string | null;
  readonly userMessageText: string;
  readonly fullText: string;
  readonly anchoredAt: string;
  readonly fillInput: boolean;
  readonly anchorTurnIndex: number;
};

export function buildRewindTargetsFromLog(
  log: ParsedSessionLog
): ReadonlyArray<LedgerRewindTarget> {
  const userEvents = headChainEvents(log).filter((e) => isTurnQuery(e.message));
  if (userEvents.length === 0) return [];

  const checkpoints = log.header.checkpoints ?? [];
  return userEvents.map((userEvent, index) =>
    toTarget({
      head: userEvent.parent,
      userEvent,
      anchorTurnIndex: index,
      checkpoints,
    })
  );
}

function toTarget(opts: {
  readonly head: string | null;
  readonly userEvent: SessionEventRecord;
  readonly anchorTurnIndex: number;
  readonly checkpoints: ReadonlyArray<CheckpointRecord>;
}): LedgerRewindTarget {
  const fullText = firstUserFullText(opts.userEvent.message);
  return {
    head: opts.head,
    userMessageText: fullText.slice(0, 80),
    fullText,
    anchoredAt: anchoredAtFor(
      opts.checkpoints,
      opts.anchorTurnIndex,
      opts.userEvent
    ),
    fillInput: true,
    anchorTurnIndex: opts.anchorTurnIndex,
  };
}

function firstUserFullText(msg: AnthropicNativeMessage): string {
  const block = msg.content.find((b) => b.type === "text");
  return block !== undefined && block.type === "text" ? block.text.trim() : "";
}

function anchoredAtFor(
  checkpoints: ReadonlyArray<CheckpointRecord>,
  turnIndex: number,
  userEvent: SessionEventRecord
): string {
  const record = checkpoints.find((c) => c.turnIndex === turnIndex);
  if (record?.interruptedAt) return record.interruptedAt;
  return userEvent.createdAt ?? "";
}
