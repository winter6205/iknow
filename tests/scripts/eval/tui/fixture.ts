/**
 * Fixture builders for the #1219 TUI calibration tooling.
 *
 * WHY this file exists: every acceptance/idle claim in `scripts/eval/tui/` is a
 * claim about the PERSISTED session-store JSONL, so the tests need store files
 * that are byte-shaped exactly like the ones the product writes. Building them
 * by hand would let a test pass against a shape the product never emits.
 *
 * Base records go through the production serializer `sessionFileToJsonl`
 * (`src/session-api/store/jsonl.ts`); the incremental appends (later messages,
 * `native_state` / `outcome` / `head` off-chain records) are hand-written
 * because no serializer emits them one at a time. `storeIsProductionValid()`
 * re-reads a finished fixture with the production `parseSessionJsonl`, so any
 * drift between the hand-written lines and the store contract fails a test
 * rather than passing silently.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { parseSessionJsonl } from "../../../../src/session-api/store/jsonl.ts";
import {
  messageEventId,
  sessionFileToJsonl,
  type SessionEventRecord,
  type SessionHeadRecord,
  type SessionNativeStateRecord,
  type SessionOutcomeRecord,
} from "../../../../src/session-api/store/jsonl.ts";
import type { NativeStateMessage } from "../../../../src/shared/native-state-port.ts";
import { computeProjectSlug } from "../../../../src/shared/project-slug.ts";

/** Where a fixture conversation lives on disk. */
export interface FixtureLocation {
  readonly dataDir: string;
  readonly cwd: string;
  readonly conversationId: string;
}

/** One `<data>/projects/<slug>/<conv>/<conv>.jsonl` path. */
export function storePath(loc: FixtureLocation): string {
  return join(
    loc.dataDir,
    "projects",
    computeProjectSlug(loc.cwd),
    loc.conversationId,
    `${loc.conversationId}.jsonl`
  );
}

/** One sub-agent transcript path — the shape that produced the historical
 *  false positive: real files, wrong conversation, no acceptance. */
export function subagentPath(loc: FixtureLocation, uuid: string): string {
  return join(
    loc.dataDir,
    "projects",
    computeProjectSlug(loc.cwd),
    loc.conversationId,
    "subagents",
    uuid,
    `${uuid}.jsonl`
  );
}

function writeFresh(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, "utf8");
}

function userMessage(text: string, hostInjected?: true): NativeStateMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    ...(hostInjected === true ? { hostInjected } : {}),
  };
}

function assistantMessage(text: string): NativeStateMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/**
 * Create the conversation with an EXISTING baseline: header + one real user
 * message (`e0`) + `head`. No stimulus has been submitted yet — this is the
 * shape a resumed/follow-up run starts from, and the reason "a new session file
 * appeared" cannot be a proof of anything.
 */
export function initStore(loc: FixtureLocation, seedText: string): void {
  const now = "2026-10-06T12:00:54.826Z";
  writeFresh(
    storePath(loc),
    sessionFileToJsonl({
      schemaVersion: 5,
      conversation_id: loc.conversationId,
      messages: [userMessage(seedText)],
      jsonMode: false,
      turnCount: 1,
      updatedAt: now,
      title: "fixture",
      cwd: loc.cwd,
      sanitized_at: now,
      workspaceRoot: loc.cwd,
      nativeStateFormat: 1,
      messageCreatedAt: [now],
    })
  );
}

/** Create an EMPTY conversation (header only, opening `head:null`). */
export function initEmptyStore(loc: FixtureLocation): void {
  const now = "2026-10-06T12:00:54.826Z";
  writeFresh(
    storePath(loc),
    sessionFileToJsonl({
      schemaVersion: 5,
      conversation_id: loc.conversationId,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: loc.cwd,
      sanitized_at: now,
      workspaceRoot: loc.cwd,
      nativeStateFormat: 1,
    })
  );
}

export interface AppendUserArgs {
  readonly loc: FixtureLocation;
  readonly index: number;
  readonly text: string;
  readonly parent: string | null;
  /** The ADR-0112 host-plumbing stamp. Only a REAL user turn omits it. */
  readonly hostInjected?: true;
  readonly createdAt?: string | null;
}

/** Append a `type:"message"` event and the trailing `type:"head"` record. */
export function appendUser(args: AppendUserArgs): SessionEventRecord {
  const record: SessionEventRecord = {
    type: "message",
    id: messageEventId(args.index),
    parent: args.parent,
    message: userMessage(args.text, args.hostInjected),
    createdAt:
      args.createdAt === undefined
        ? "2026-10-06T12:00:56.459Z"
        : (args.createdAt ?? undefined),
  };
  return appendMessage(args.loc, record);
}

export interface AppendAssistantArgs {
  readonly loc: FixtureLocation;
  readonly index: number;
  readonly text: string;
  readonly parent: string | null;
  readonly createdAt?: string;
}

/** Append an assistant event + trailing head (a round's reply). */
export function appendAssistant(args: AppendAssistantArgs): SessionEventRecord {
  const record: SessionEventRecord = {
    type: "message",
    id: messageEventId(args.index),
    parent: args.parent,
    message: assistantMessage(args.text),
    createdAt: args.createdAt ?? "2026-10-06T12:00:58.100Z",
  };
  return appendMessage(args.loc, record);
}

function appendMessage(
  loc: FixtureLocation,
  record: SessionEventRecord
): SessionEventRecord {
  appendLine(storePath(loc), JSON.stringify(record));
  appendHead(loc, record.id);
  return record;
}

/** Append the trailing head record the store writes after every message. */
export function appendHead(loc: FixtureLocation, id: string | null): void {
  const record: SessionHeadRecord = { type: "head", id };
  appendLine(storePath(loc), JSON.stringify(record));
}

/**
 * Append a `native_state` boundary record.
 *
 * `boundary:"input"` is the ACCEPTANCE signal (the host published state at the
 * accepted user turn); `boundary:"terminal"` is the IDLE signal (the round
 * returned control). `tool_batch` is internal per-LLM-turn activity and must
 * never be read as either.
 */
export function appendNativeState(args: {
  readonly loc: FixtureLocation;
  readonly anchorEventId: string;
  readonly boundary: "input" | "terminal" | "tool_batch";
  readonly messageCount: number;
  readonly createdAt: string;
}): SessionNativeStateRecord {
  const record: SessionNativeStateRecord = {
    type: "native_state",
    anchorEventId: args.anchorEventId,
    bodySha: `b${args.messageCount}`.padEnd(64, "0"),
    boundary: args.boundary,
    messageCount: args.messageCount,
    createdAt: args.createdAt,
  };
  appendLine(storePath(args.loc), JSON.stringify(record));
  return record;
}

/** Append an ADR-0126 `outcome` record (corroboration only, never a counter). */
export function appendOutcome(args: {
  readonly loc: FixtureLocation;
  readonly turnId: string;
  readonly stopReason?: string;
}): SessionOutcomeRecord {
  const record: SessionOutcomeRecord = {
    type: "outcome",
    turnId: args.turnId,
    stopReason: (args.stopReason ??
      "completed") as SessionOutcomeRecord["stopReason"],
  };
  appendLine(storePath(args.loc), JSON.stringify(record));
  return record;
}

/** Append one `operation_fact` record (the UUID `turnId` namespace trap). */
export function appendOperationFact(args: {
  readonly loc: FixtureLocation;
  readonly anchorEventId: string;
  readonly turnId: string;
}): void {
  appendLine(
    storePath(args.loc),
    JSON.stringify({
      type: "operation_fact",
      factId: `fact_${args.turnId}`,
      anchorEventId: args.anchorEventId,
      baseBodySha: "c".repeat(64),
      turnId: args.turnId,
      fact: {
        kind: "tool_result",
        toolUseId: "call_01a1",
        batchPosition: 0,
        batchSize: 1,
        resultMessage: {},
      },
      createdAt: "2026-10-06T12:01:00.198Z",
    })
  );
}

/** Append an arbitrary raw line — malformed / compatibility cases only. */
export function appendRaw(loc: FixtureLocation, line: string): void {
  appendLine(storePath(loc), line);
}

/** Write a raw byte blob to the END of the store without a newline (partial append). */
export function appendPartial(loc: FixtureLocation, text: string): void {
  mkdirSync(dirname(storePath(loc)), { recursive: true });
  appendFileSync(storePath(loc), text, "utf8");
}

/** Create a sub-agent transcript under the measured conversation. */
export function initSubagentStore(
  loc: FixtureLocation,
  uuid: string,
  seedText: string
): string {
  const path = subagentPath(loc, uuid);
  writeFresh(
    path,
    sessionFileToJsonl({
      schemaVersion: 5,
      conversation_id: uuid,
      messages: [assistantMessage(seedText)],
      jsonMode: false,
      turnCount: 1,
      updatedAt: "2026-10-06T12:56:56.000Z",
      title: "sub",
      cwd: loc.cwd,
      sanitized_at: "2026-10-06T12:56:56.000Z",
      nativeStateFormat: 1,
    })
  );
  return path;
}

/** Re-read a finished fixture with the PRODUCTION parser. Any shape drift in a
 *  hand-written line surfaces here instead of passing silently. */
export function storeIsProductionValid(path: string): {
  ok: boolean;
  detail: string;
} {
  try {
    parseSessionJsonl(readFileSync(path, "utf8"));
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: JSON.stringify(err) };
  }
}

/** One `rss.csv` data row, in the retained-artifact shape. */
export interface RssRow {
  readonly tRelS: number;
  readonly iso: string;
  readonly pid: number;
  readonly vmrssKb: number;
  readonly alive: number;
}

/** Write the retained `rss.csv` an evidence counter is derived from. */
export function writeRssCsv(dir: string, rows: readonly RssRow[]): string {
  mkdirSync(dir, { recursive: true });
  const body = rows
    .map((r) => `${r.tRelS},${r.iso},${r.pid},${r.vmrssKb},${r.alive}`)
    .join("\n");
  writeFileSync(
    join(dir, "rss.csv"),
    `t_rel_s,iso,pid,vmrss_kb,alive\n${body}\n`,
    "utf8"
  );
  return join(dir, "rss.csv");
}

/** Create `count` retained screen snapshots. */
export function writeSnapshots(dir: string, count: number): string {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(dir, `screen-${String(i).padStart(3, "0")}.txt`),
      `frame ${i}\n`,
      "utf8"
    );
  }
  return dir;
}

/**
 * A protocol document that parses clean. Tests override single fields to walk
 * one contract at a time instead of rebuilding the whole shape per case.
 */
export function validProtocol(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    label: "unit",
    dataDir: "/tmp/data",
    cwd: "/tmp/repo",
    artifactsDir: "/tmp/artifacts",
    conversationId: "conv-1",
    child: { command: "true", args: [] },
    stimuli: [
      { at: 1000, tag: "S1", text: "first" },
      { at: 2000, tag: "S2", text: "second" },
    ],
    readiness: {
      tokenPrefix: "ready",
      probeTimeoutMs: 2000,
      echoTimeoutMs: 1000,
      attempts: 2,
    },
    delivery: {
      chunkBytes: 200,
      chunkDelayMs: 10,
      settleBeforeSubmit: true,
      settleWaitMs: 5000,
      acceptTimeoutMs: 30000,
      retryEnter: false,
    },
    stop: {
      minSettleMs: 1000,
      horizonMs: 3000,
      exitGraceMs: 2000,
      innerWallMs: 60000,
    },
    outerWatchdogMs: 120000,
    rssIntervalMs: 500,
    snapshotIntervalMs: 1000,
    ...over,
  };
}
