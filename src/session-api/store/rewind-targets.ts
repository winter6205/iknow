/**
 * Rewind picker 锚点从当前 head 祖先链投影（Claude Code：回到所选
 * 用户消息之前）。head 指到该句 parent；fillInput 把提示词填回输入框。
 * 跳过分支仍留在 JSONL，但不进默认 picker，所以时间戳不会留在面板里。
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
