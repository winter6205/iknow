/**
 * ADR-0102 / plan subagent-stop-and-continue T3 — 工人 transcript 的嵌套
 * load / append 缝。
 *
 * 为什么单独一个模块而不是 SessionStore 方法：SessionStore 的键空间是
 * 「项目池里的一棵会话叶子」（`<projectDir>/<id>/<id>.jsonl`），而工人
 * transcript 的键是 `(父 conversationId, task_id)`、落点在**父会话文件夹内**
 * `subagents/<taskId>/<taskId>.jsonl`（ADR-0102 Decision 3：不在项目池另开
 * 叶子，`listSessions` 因此不收录）。形状却是同一套 —— header +
 * parent-chained message events + trailing head 的 append-only JSONL，
 * 读路径复用 `parseSessionJsonl` / `projectSessionLog`（SessionFileV1 读
 * 路径原样能吃），写路径复刻 `appendEvents` 的编号 / 链 / 尾部丢弃语义。
 * 复用 codec 缝而不复制逻辑：SSOT 在 jsonl.ts。
 *
 * typed-error 词汇与 SessionStoreError 同 kind（not_found / write_failed /
 * parse_failed / schema_invalid / io_error）；`conversation_id` 槽承载
 * task_id —— 嵌套键语境里它就是这条账的对外句柄。
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { AnthropicNativeMessage } from "../../harness/index.js";
import type { SessionStoreError } from "./errors.js";
import { splitTurns } from "./checkpoint.js";
import { closeoutOrphanToolUses } from "./closeout-projection.js";
import {
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  sessionFileToJsonl,
  type ParsedSessionLog,
  type SessionEventRecord,
  type SessionHeadRecord,
} from "./jsonl.js";
import {
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  type SessionFileV1,
} from "./schema.js";

/** 一条工人账的落点：嵌套路径 + 对外句柄 task_id（typed error 的身份槽）。 */
export interface WorkerTranscriptLocation {
  readonly transcriptPath: string;
  readonly taskId: string;
}

/**
 * 读工人 transcript 的当前 head 投影（与 SessionStore.load 的 JSONL 臂同形：
 * orphan tool_use 补 synthetic tool_result，consumer 永远拿到 API 合法的
 * 对话链）。文件缺失 → not_found（续跑闸据此拒「无 transcript 的旧工人」）。
 */
export async function loadWorkerTranscript(
  loc: WorkerTranscriptLocation
): Promise<SessionFileV1> {
  const { transcriptPath, taskId } = loc;
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw { kind: "not_found", conversation_id: taskId } satisfies SessionStoreError;
    }
    throw {
      kind: "io_error",
      conversation_id: taskId,
      cause: errMsg(err),
    } satisfies SessionStoreError;
  }
  try {
    const file = projectSessionLog(parseSessionJsonl(raw));
    return {
      ...file,
      messages: closeoutOrphanToolUses(file.messages),
    };
  } catch (err) {
    const e = err as { kind?: string; reason?: unknown; field?: unknown };
    if (e.kind === "parse_failed") {
      throw {
        kind: "parse_failed",
        conversation_id: taskId,
        reason: typeof e.reason === "string" ? e.reason : "unknown",
      } satisfies SessionStoreError;
    }
    throw {
      kind: "schema_invalid",
      conversation_id: taskId,
      field: typeof e.field === "string" ? e.field : "root",
    } satisfies SessionStoreError;
  }
}

/**
 * 边跑边 append：一批已进权威历史的消息链到盘上 head 之后 + 一条新 head
 * （同 SessionStore.appendEvents 的编号 / 链 / createdAt stamping 纪律）。
 * 文件不存在 → 首批建账：header + events + head 一次写入（工人 transcript
 * 的出生批 = 初始历史 seed）。
 *
 * 空批 = no-op。`thinkingMs` 与 appendEvents 同边界：仅 assistant 事件 +
 * >0 有限数才挂 key。
 */
export async function appendWorkerTranscript(opts: {
  readonly location: WorkerTranscriptLocation;
  readonly events: ReadonlyArray<AnthropicNativeMessage>;
  readonly thinkingMs?: number;
  /** 首批建账时落进 header 的工作根（工人 = envelope.sandboxRoot）。 */
  readonly cwd?: string;
}): Promise<void> {
  const { location, events } = opts;
  if (events.length === 0) return;
  const { transcriptPath, taskId } = location;
  let raw: string | null;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (err) {
    if (!isEnoent(err)) {
      throw {
        kind: "io_error",
        conversation_id: taskId,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
    raw = null;
  }
  try {
    if (raw === null) {
      await mkdir(dirname(transcriptPath), { recursive: true });
      const now = new Date().toISOString();
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: taskId,
        messages: events,
        jsonMode: false,
        turnCount: splitTurns(events).length,
        updatedAt: now,
        title: extractTitle(events),
        cwd: opts.cwd ?? "",
        sanitized_at: now,
      };
      await writeFile(transcriptPath, sessionFileToJsonl(file), "utf8");
      return;
    }
    let log: ParsedSessionLog;
    try {
      log = parseSessionJsonl(raw);
    } catch (err) {
      throw attachTaskId(taskId, err);
    }
    const stampableThinkingMs =
      typeof opts.thinkingMs === "number" &&
      Number.isFinite(opts.thinkingMs) &&
      opts.thinkingMs > 0
        ? opts.thinkingMs
        : undefined;
    let next = log.maxEventIndex + 1;
    let parent = log.head;
    const lines: string[] = [];
    for (const message of events) {
      const eventId = messageEventId(next++);
      const record: SessionEventRecord = {
        type: "message",
        id: eventId,
        parent,
        message,
        createdAt: new Date().toISOString(),
        ...(message.role === "assistant" && stampableThinkingMs !== undefined
          ? { thinkingMs: stampableThinkingMs }
          : {}),
      };
      lines.push(JSON.stringify(record));
      parent = eventId;
    }
    const head: SessionHeadRecord = { type: "head", id: parent };
    lines.push(JSON.stringify(head));
    await appendFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  } catch (err) {
    if ((err as { kind?: string }).kind !== undefined) throw err;
    throw {
      kind: "write_failed",
      conversation_id: taskId,
      cause: errMsg(err),
    } satisfies SessionStoreError;
  }
}

// -- module-level helpers ----------------------------------------------------

function attachTaskId(taskId: string, err: unknown): SessionStoreError {
  const e = err as { kind?: string; reason?: unknown; field?: unknown };
  if (e.kind === "parse_failed") {
    return {
      kind: "parse_failed",
      conversation_id: taskId,
      reason: typeof e.reason === "string" ? e.reason : "unknown",
    };
  }
  return {
    kind: "schema_invalid",
    conversation_id: taskId,
    field: typeof e.field === "string" ? e.field : "root",
  };
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 路径护栏：工人账路径来自父进程算好的绝对路径（envelope 是 untrusted
 * 输入面 —— 只有 manager 生产它，worker 消费前校验形态，拒绝相对路径 /
 * 空串，不给「父没算好」留静默写到 cwd 的通道）。
 */
export function isWorkerTranscriptPathSafe(transcriptPath: string): boolean {
  return transcriptPath.length > 0 && isAbsolute(transcriptPath);
}
