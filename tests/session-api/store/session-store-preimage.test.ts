/**
 * ADR-0036: transcript-side preimage stamping via SessionStore.appendEvents.
 * appendEvents stamps `codePreimage` (the captured PreimageRef) onto the FIRST
 * non-error tool_result block whose `tool_use_id` matched. Pins:
 *   - matched id → the persisted event record carries the exact ref
 *   - is_error tool_result → NOT stamped (a failed write claims no preimage)
 *   - preimages absent → codePreimage key absent (byte-identical to the
 *     no-preimage form)
 *   - id not present in the map → NOT stamped
 * Isolated temp dir; the repo's data/ tree is never touched.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";
import type { PreimageRef } from "../../../src/session-api/store/jsonl.ts";

let store: SessionStore;
let baseDir: string;
let projectDir: string;

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-store-preimg-"));
  projectDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const sampleFile = (id: string): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: id,
  title: "",
  cwd: "/tmp/test",
  sanitized_at: new Date().toISOString(),
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: new Date().toISOString(),
  checkpoints: [],
});

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

const toolResultMsg = (
  toolUseId: string,
  opts: { isError?: boolean } = {}
) => ({
  role: "user" as const,
  content: [
    {
      type: "tool_result" as const,
      tool_use_id: toolUseId,
      content: "ok",
      ...(opts.isError ? { is_error: true } : {}),
    },
  ],
});

const ref: PreimageRef = {
  relPath: "src/a.ts",
  rootIdentity: "/identity/root",
  preimageSha: "a".repeat(64),
  postimageSha: "b".repeat(64),
};

async function readMessageRecords(
  id: string
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(sessionDirFor(id), `${id}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.type === "message");
}

describe("SessionStore.appendEvents codePreimage stamping", () => {
  it("(a) preimages 命中 tool_result 的 tool_use_id → 落库记录携带精确 codePreimage ref", async () => {
    const id = "preimg-hit";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({
      id,
      events: [userMsg("q"), toolResultMsg("tu1")],
      preimages: new Map([["tu1", ref]]),
    });
    const records = await readMessageRecords(id);
    // records[1] 是 tool_result 事件 (records[0] 是 user 文本)
    const toolRec = records[1] as { codePreimage?: PreimageRef };
    assert.deepEqual(toolRec.codePreimage, ref);
    // user 文本事件从不带 stamp
    assert.ok(!("codePreimage" in (records[0] as object)));
  });

  it("(b) is_error 的 tool_result 即便 id 命中也不 stamp (失败的写不认领 preimage)", async () => {
    const id = "preimg-error";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({
      id,
      events: [toolResultMsg("tu1", { isError: true })],
      preimages: new Map([["tu1", ref]]),
    });
    const [rec] = await readMessageRecords(id);
    assert.ok(!("codePreimage" in (rec as object)));
  });

  it("(c) preimages 缺省 → codePreimage key 不存在, 与无 preimage 处理形态一致", async () => {
    const id = "preimg-absent";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({
      id,
      events: [toolResultMsg("tu1")],
      // 不传 preimages
    });
    const [rec] = await readMessageRecords(id);
    assert.ok(!("codePreimage" in (rec as object)));

    // 显式传 undefined 应与缺省 byte-identical (剥掉 nondeterministic createdAt)
    const id2 = "preimg-undef";
    await store.save({ id: id2, file: sampleFile(id2) });
    await store.appendEvents({
      id: id2,
      events: [toolResultMsg("tu1")],
      preimages: undefined,
    });
    const [rec2] = await readMessageRecords(id2);
    const strip = (r: Record<string, unknown>) => {
      const { createdAt: _c, ...rest } = r;
      return rest;
    };
    assert.deepEqual(strip(rec!), strip(rec2!));
  });

  it("(d) tool_result 的 id 不在 map 里 → 不 stamp", async () => {
    const id = "preimg-miss";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({
      id,
      events: [toolResultMsg("tuOther")],
      preimages: new Map([["tu1", ref]]),
    });
    const [rec] = await readMessageRecords(id);
    assert.ok(!("codePreimage" in (rec as object)));
  });

  it("空 map (size 0) 视为无 stamping (matchCodePreimage 短路)", async () => {
    const id = "preimg-emptymap";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({
      id,
      events: [toolResultMsg("tu1")],
      preimages: new Map(),
    });
    const [rec] = await readMessageRecords(id);
    assert.ok(!("codePreimage" in (rec as object)));
  });
});
