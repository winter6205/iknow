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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { storeWorkerTranscriptIo } from "../../src/cli/worker-transcript.ts";
import type { SessionStoreError } from "../../src/session-api/store/index.ts";
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
