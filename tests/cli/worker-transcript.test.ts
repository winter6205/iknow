/**
 * ADR-0102 / plan subagent-stop-and-continue T3 — cli 注入缝
 * `storeWorkerTranscriptIo` 的路径护栏接线测试。
 *
 * 钉住的不变式：envelope 是 untrusted 输入面，工人账路径必须是父进程算好的
 * 绝对路径；相对路径 / 空串在工厂入口 typed 拒绝（`isWorkerTranscriptPathSafe`
 * 是唯一判定源），不给「父没算好」留静默写到 process.cwd() 的通道。
 * 合法绝对路径照常构造 IO：load 只折叠 not_found → absent，其余 typed
 * kind 原样上抛（损坏的账不得被读成无账）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { storeWorkerTranscriptIo } from "../../src/cli/worker-transcript.ts";
import {
  parseSessionJsonl,
  type SessionStoreError,
} from "../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";

function user(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iknow-worker-transcript-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** typed 错误按 kind 分流校验（禁 instanceof Error 折叠渲染）。 */
function assertTypedPathRefusal(err: unknown): true {
  const e = err as SessionStoreError;
  assert.equal(e.kind, "schema_invalid");
  assert.equal(
    (e as { kind: "schema_invalid"; field: string }).field,
    "transcript_path"
  );
  assert.equal(e.conversation_id, "t-guard");
  return true;
}

describe("storeWorkerTranscriptIo — 非法路径 typed 拒绝", () => {
  it("相对路径（无前缀点号形态）→ 工厂入口抛 schema_invalid，不静默写 cwd", () => {
    assert.throws(
      () =>
        storeWorkerTranscriptIo({
          transcriptPath: "subagents/t-guard/t-guard.jsonl",
          taskId: "t-guard",
          cwd: dir,
        }),
      assertTypedPathRefusal
    );
  });

  it("显式相对形态（./ 前缀）→ 同一条 typed 拒绝", () => {
    assert.throws(
      () =>
        storeWorkerTranscriptIo({
          transcriptPath: "./t-guard.jsonl",
          taskId: "t-guard",
          cwd: dir,
        }),
      assertTypedPathRefusal
    );
  });

  it("空串 → 同一条 typed 拒绝（worker 侧空串退路是「不接线」，工厂不留第二解释）", () => {
    assert.throws(
      () =>
        storeWorkerTranscriptIo({
          transcriptPath: "",
          taskId: "t-guard",
          cwd: dir,
        }),
      assertTypedPathRefusal
    );
  });
});

describe("storeWorkerTranscriptIo — 合法绝对路径形态", () => {
  it("新工人 load 折叠 not_found → absent；append 后 load present", async () => {
    const io = storeWorkerTranscriptIo({
      transcriptPath: join(dir, "t-ok", "t-ok.jsonl"),
      taskId: "t-ok",
      cwd: dir,
    });
    assert.deepEqual(await io.loadMessages(), { status: "absent" });
    await io.appendMessages([user("hello")]);
    const loaded = await io.loadMessages();
    assert.equal(loaded.status, "present");
  });
});

describe("storeWorkerTranscriptIo — 并发 append 串行化", () => {
  /**
   * 钉住的不变式：worker loop 的 flushPrefix 可被并发回调重入，同一实例的
   * appendMessages/loadMessages 必须按调用顺序串行执行 —— store 的
   * appendWorkerTranscript 是 read-modify-write 且无内部锁（架构纪律：锁在
   * 装配边界，不在 store）。交错实现下两批读到同一 head → 重复 event id →
   * parseSessionJsonl 抛 schema_invalid，或首批交错 → 先批被覆盖丢失。
   */
  it("不 await 地并发发起多批 append，全部完成后账上无重复 id、链合法、批次按入队顺序齐全", async () => {
    const transcriptPath = join(dir, "t-race", "t-race.jsonl");
    const io = storeWorkerTranscriptIo({
      transcriptPath,
      taskId: "t-race",
      cwd: dir,
    });
    const batches: string[][] = [
      ["a1", "a2"],
      ["b1"],
      ["c1", "c2"],
    ];
    const inFlight = batches.map((texts) =>
      io.appendMessages(texts.map(user))
    );
    await Promise.all(inFlight);

    const raw = await readFile(transcriptPath, "utf8");
    const log = parseSessionJsonl(raw); // 重复 id / 断链会在此抛 schema_invalid
    const ids = log.events.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "event id 不得重复");
    let parent: string | null = null;
    for (const ev of log.events) {
      assert.equal(ev.parent, parent, "事件链必须按文件序衔接");
      parent = ev.id;
    }
    assert.equal(log.head, parent, "生效 head 指向链尾");
    const texts = log.events.flatMap((e) =>
      e.message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
    );
    assert.deepEqual(texts, batches.flat(), "三批事件齐全且按入队顺序");
  });

  it("某批 append 失败后队列不卡死：后续 append/load 仍按序执行", async () => {
    const transcriptPath = join(dir, "t-recover", "t-recover.jsonl");
    const io = storeWorkerTranscriptIo({
      transcriptPath,
      taskId: "t-recover",
      cwd: dir,
    });
    // 往路径里塞一本无法解析的坏账：append / load 都必须 typed reject
    // （store 折叠后的 schema_invalid），且队列不被前序 reject 卡死。
    mkdirSync(join(dir, "t-recover"), { recursive: true });
    await writeFile(transcriptPath, "not-a-jsonl-line\n", "utf8");
    await assert.rejects(
      () => io.appendMessages([user("bad")]),
      (err: unknown) => (err as { kind?: string }).kind === "schema_invalid"
    );
    await assert.rejects(
      () => io.loadMessages(),
      (err: unknown) => (err as { kind?: string }).kind === "schema_invalid"
    );
  });
});
