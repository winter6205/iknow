/**
 * #624: rewind picker 锚点从 JSONL 全量事件投影。选一条用户消息 = 把
 * 持久化 head 指到那句事件 id；发给模型的是这句往回的祖先链。被跳过
 * 分支上的用户消息仍列出，可再选中撤销回退。另有 head=null「首条之前」。
 */
import { isTurnQuery } from "../turn-projection.js";
import type { AnthropicNativeMessage } from "../../harness/index.js";
import type { CheckpointRecord } from "./schema.js";
import type { ParsedSessionLog, SessionEventRecord } from "./jsonl.js";

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
  const userEvents = log.events.filter((e) => isTurnQuery(e.message));
  if (userEvents.length === 0) return [];

  const checkpoints = log.header.checkpoints ?? [];
  const targets: LedgerRewindTarget[] = [];

  if (log.head !== null) {
    targets.push(
      toTarget({
        head: null,
        userEvent: userEvents[0]!,
        anchorTurnIndex: 0,
        checkpoints,
        fillInput: true,
      })
    );
  }

  userEvents.forEach((userEvent, index) => {
    if (userEvent.id === log.head) return;
    targets.push(
      toTarget({
        head: userEvent.id,
        userEvent,
        anchorTurnIndex: index,
        checkpoints,
        fillInput: false,
      })
    );
  });

  return targets;
}

function toTarget(opts: {
  readonly head: string | null;
  readonly userEvent: SessionEventRecord;
  readonly anchorTurnIndex: number;
  readonly checkpoints: ReadonlyArray<CheckpointRecord>;
  readonly fillInput: boolean;
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
    fillInput: opts.fillInput,
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
