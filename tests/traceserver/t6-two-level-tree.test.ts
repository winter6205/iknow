/**
 * T6 (ADR-0071 / SC14–SC17): traceserver 读侧
 * 三工具走两级树 + query_trace 补 content 解引用。
 *
 * T4 后读侧关键变化:
 *   - blob 唯一模式: `messages[i] = {role, content:{sha,bytes}}`,content 正文
 *     经 `toBlobReferences` 写成 `{kind:"str"|"blocks", v:content}` 落盘。
 *   - session folder 归并: trace 落 `<baseDir>/projects/<slug>/<convId>/trace.jsonl`,
 *     blob = `<...>/<convId>/blobs/<sha>`。
 *
 * 既有 dereferenceTraceMessages 用 `"sha" in message` 判据只覆盖**整条 message ref**,
 * 不覆盖**content 级 ref** (T4 表 C)。本文件验证 T6 之后:
 *   - 读侧接受 content-ref message 并解出 {kind:"str"|"blocks", v:...} 形状;
 *   - query_trace 三 preview 返正文(SC14);
 *   - 同一 messages 数组里内联 + content-ref 混排逐元素独立判定(SC17);
 *   - 既有的 fail-closed 不抛进 turn 行为保持(blob 缺失 → 空数组/无 preview)。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";

import { dereferenceTraceMessages } from "../../src/traceserver/project-tool-results.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeSessionFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-t6-deref-"));
  tempDirs.push(dir);
  return dir;
}

interface ContentPayload {
  kind: "str" | "blocks";
  v: unknown;
}

function writeBlob(
  blobDir: string,
  content: unknown,
  encoding: "str" | "blocks" = "blocks"
): { sha: string; bytes: number } {
  const payload: ContentPayload = { kind: encoding, v: content };
  const serialized = JSON.stringify(payload);
  const sha = createHash("sha256").update(serialized).digest("hex");
  writeFileSync(join(blobDir, sha), serialized, "utf8");
  return { sha, bytes: Buffer.byteLength(serialized) };
}

describe("dereferenceTraceMessages (T6 SC14 / SC17)", () => {
  it("decodes content-ref messages of shape {role, content:{sha,bytes}} (T4 SC10)", async () => {
    // T4 改后形状: messages[i] = {role, content:{sha,bytes}} — role 内联在场,
    // content 走 blob, blob 正文 = {kind:"blocks", v:[...]} 或 {kind:"str", v:"..."}。
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const ref = writeBlob(blobDir, [{ type: "text", text: "hello" }]);
    const messages = [{ role: "user", content: ref }];

    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    assert.equal(out.length, 1);
    // 解出形状: content = 数组(JSON 形状,因为 JSON.parse 还原了外层 {kind,v},再
    // 由形状恢复为字符串或数组)。本测试仅钉: 解出的 message.role == "user"
    // 且 message.content 是数组(blocks 形状),role 在场。
    const msg = out[0] as { role: string; content: unknown };
    assert.equal(msg.role, "user");
    assert.deepEqual(msg.content, [{ type: "text", text: "hello" }]);
  });

  it("decodes content-ref messages with kind='str' (T4 表 C 形状 2)", async () => {
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const ref = writeBlob(blobDir, "raw string content", "str");
    const messages = [{ role: "system", content: ref }];

    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    const msg = out[0] as { role: string; content: unknown };
    assert.equal(msg.role, "system");
    assert.equal(msg.content, "raw string content");
  });

  it("mixes inline messages and content-ref messages per element (SC17 混排)", async () => {
    // 同一 messages 数组里:第一条内联,第二条 content-ref — 逐元素独立判定,
    // 既不把内联误判为 ref 也不把 ref 误判为内联。
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const inline = { role: "user", content: [{ type: "text", text: "first" }] };
    const ref = writeBlob(blobDir, "second");
    const messages = [inline, { role: "user", content: ref }];

    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], inline);
    const second = out[1] as { role: string; content: unknown };
    assert.equal(second.role, "user");
    assert.equal(second.content, "second");
  });

  it("keeps full-message-ref shape {sha, bytes} as the historical escape hatch (T4 fixture 兼容)", async () => {
    // T4 之前整条 message ref 的形状仍在旧 fixture 残留;读侧必须能继续读,
    // 解出的 content 是 message 整体 JSON.parse 形状(无 {kind,v} 包裹,
    // 因为旧 ref 走的是直接 message 序列化的路径,本测试不复活该路径,只
    // 保留 {sha,bytes} 形状的容错。
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const inner = { role: "user", content: "legacy whole-message ref" };
    const serialized = JSON.stringify(inner);
    const sha = createHash("sha256").update(serialized).digest("hex");
    writeFileSync(join(blobDir, sha), serialized, "utf8");

    const out = await dereferenceTraceMessages(
      [{ sha, bytes: Buffer.byteLength(serialized) }],
      { traceFilePath }
    );
    assert.deepEqual(out[0], inner);
  });

  it("returns [] on any blob failure (读侧 fail-closed 既有契约保持)", async () => {
    // 整条 message 失败 / 字段缺 role 失败 / blob 损坏失败 — 都不抛进调用方 turn,
    // 一律降级到空数组 (projectToolResultsFromTrace 既有的 EXIT)。
    const sessionFolder = makeSessionFolder();
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const ref = writeBlob(blobDir, [{ type: "text", text: "x" }]);
    // 写一个 blob 但 sha 与 ref 不对应 → 读侧按 ref.sha 找不到 blob → 失败降级。
    rmSync(join(blobDir, ref.sha));
    const messages = [{ role: "user", content: ref }];
    const out = await dereferenceTraceMessages(messages, { traceFilePath });
    assert.deepEqual(out, []);
  });
});
