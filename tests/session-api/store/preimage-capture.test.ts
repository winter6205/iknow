/**
 * T1 (ADR-0036): host-side PreimageCapture (session-api impl).
 * The capture closure the assembly injects into harness write tools. Pins:
 *   - enabled → writes BOTH pre and post blobs to the conversation's
 *     code-snapshots dir and records a ledger ref { relPath, rootIdentity,
 *     preimageSha, postimageSha } keyed by (conversationId, toolUseId)
 *   - isEnabled false → total no-op (no blob, no ledger entry)
 *   - missing routing id (conversationId or toolUseId) → no-op (a blob is only
 *     useful once it can be stamped, which needs both ids)
 *   - a blob-IO throw propagates out of the closure (must NOT swallow: a
 *     throwing capture aborts the pending workspace write)
 */
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile as writeFileRaw,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { createPreimageCapture } from "../../../src/session-api/store/preimage-capture.ts";
import { createPreimageLedger } from "../../../src/session-api/store/preimage-ledger.ts";
import { codeSnapshotSha } from "../../../src/session-api/store/code-snapshot-store.ts";
import { resolveConversationDir } from "../../../src/session-api/store/session-store.ts";
import { CODE_SNAPSHOTS_DIR_NAME } from "../../../src/shared/session-tree-names.ts";
import type { PreimageCaptureInput } from "../../../src/harness/aci/preimage-port.ts";

let projectDir: string;
let ledger: ReturnType<typeof createPreimageLedger>;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "iknow-preimg-cap-"));
  ledger = createPreimageLedger();
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

const blobDir = (conversationId: string): string =>
  join(
    resolveConversationDir({ projectDir, conversationId }),
    CODE_SNAPSHOTS_DIR_NAME
  );

const input = (
  over: Partial<PreimageCaptureInput> = {}
): PreimageCaptureInput => ({
  toolUseId: "tu1",
  conversationId: "conv-1",
  relPath: "src/a.ts",
  rootIdentity: "/identity/root",
  preBytes: Buffer.from("old bytes", "utf8"),
  postBytes: Buffer.from("new bytes", "utf8"),
  ...over,
});

async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("createPreimageCapture", () => {
  it("(a) enabled → 写 pre+post 两个 blob 并记录带两 sha/relPath/rootIdentity 的 ledger ref", async () => {
    const capture = createPreimageCapture({
      getProjectDir: () => projectDir,
      ledger,
      isEnabled: () => true,
    });
    const inp = input();
    await capture(inp);

    const preSha = codeSnapshotSha(inp.preBytes);
    const postSha = codeSnapshotSha(inp.postBytes);

    // 两个 blob 都落在该 conversation 的 code-snapshots 目录
    const blobs = await readdir(blobDir("conv-1"));
    assert.deepEqual(new Set(blobs), new Set([preSha, postSha]));

    // ledger 记录了 keyed ref, 两 sha + relPath + rootIdentity 全对
    const consumed = ledger.consume("conv-1", ["tu1"]);
    assert.deepEqual(consumed.get("tu1"), {
      relPath: "src/a.ts",
      rootIdentity: "/identity/root",
      preimageSha: preSha,
      postimageSha: postSha,
    });
  });

  it("(b) isEnabled false → 无 blob, 无 ledger 条目", async () => {
    const capture = createPreimageCapture({
      getProjectDir: () => projectDir,
      ledger,
      isEnabled: () => false,
    });
    await capture(input());

    assert.equal(await dirExists(blobDir("conv-1")), false);
    assert.equal(ledger.consume("conv-1", ["tu1"]).size, 0);
  });

  it("(c1) 缺 conversationId → no-op (无 blob, 无 ledger)", async () => {
    const capture = createPreimageCapture({
      getProjectDir: () => projectDir,
      ledger,
      isEnabled: () => true,
    });
    await capture(input({ conversationId: undefined }));
    // 没有 conversationId 无法派生 folder; 也不应有任意 conv 桶被写
    assert.equal(
      await dirExists(join(projectDir, CODE_SNAPSHOTS_DIR_NAME)),
      false
    );
    assert.equal(ledger.consume("conv-1", ["tu1"]).size, 0);
  });

  it("(c2) 缺 toolUseId → no-op (有 folder 也不建 blob, 无 ledger)", async () => {
    const capture = createPreimageCapture({
      getProjectDir: () => projectDir,
      ledger,
      isEnabled: () => true,
    });
    await capture(input({ toolUseId: undefined }));
    assert.equal(await dirExists(blobDir("conv-1")), false);
    assert.equal(ledger.consume("conv-1", ["tu1"]).size, 0);
  });

  it("(d) blob IO 报错 (projectDir 落在一个普通文件上) → 从 capture 抛出, 不吞", async () => {
    // getProjectDir 返回一个普通文件路径, resolveConversationDir 拼出的
    // <file>/<seg>/code-snapshots 递归 mkdir 必失败 (ENOTDIR), 与 uid 无关。
    const notADir = join(projectDir, "iam-a-file");
    await writeFileRaw(notADir, "x", "utf8");
    const capture = createPreimageCapture({
      getProjectDir: () => notADir,
      ledger,
      isEnabled: () => true,
    });
    await assert.rejects(async () => {
      await capture(input());
    });
    // 抛错后不应留下半截 ledger 条目
    assert.equal(ledger.consume("conv-1", ["tu1"]).size, 0);
  });
});
