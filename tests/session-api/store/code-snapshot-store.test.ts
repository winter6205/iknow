/**
 * T1 (ADR-0036): content-addressed preimage blob store.
 * Pins the capture/read contract the rewind restore layer depends on:
 *   - capture writes a sha256-named blob under `<sessionFolder>/code-snapshots/`
 *   - identical bytes dedup to ONE blob (write-if-missing `flag:"wx"`)
 *   - read round-trips bytes; a missing blob throws the typed
 *     `{ kind:"code_snapshot_missing" }` (NOT a bare ENOENT Error), so the
 *     caller can tell "absent" from a real IO fault (typed-error catch契约).
 * Uses an isolated temp dir so the repo's data/ tree is never touched.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  captureCodeSnapshot,
  codeSnapshotDir,
  codeSnapshotSha,
  readCodeSnapshot,
} from "../../../src/session-api/store/code-snapshot-store.ts";
import { CODE_SNAPSHOTS_DIR_NAME } from "../../../src/shared/session-tree-names.ts";

let sessionFolder: string;

beforeEach(async () => {
  sessionFolder = await mkdtemp(join(tmpdir(), "iknow-code-snap-"));
});

afterEach(async () => {
  await rm(sessionFolder, { recursive: true, force: true });
});

describe("codeSnapshotDir / codeSnapshotSha (纯投影)", () => {
  it("codeSnapshotDir 派生 <sessionFolder>/code-snapshots/ (blob 目录 SSOT)", () => {
    assert.equal(
      codeSnapshotDir("/base/sess"),
      join("/base/sess", "code-snapshots")
    );
    assert.equal(CODE_SNAPSHOTS_DIR_NAME, "code-snapshots");
  });

  it('(e) codeSnapshotSha("") == 空字节的 sha256', () => {
    const expected = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    assert.equal(codeSnapshotSha(""), expected);
    assert.equal(codeSnapshotSha(Buffer.alloc(0)), expected);
  });
});

describe("captureCodeSnapshot / readCodeSnapshot", () => {
  it("(a) 写入 blob 到 codeSnapshotDir 并返回字节的 sha256", async () => {
    const bytes = Buffer.from("hello preimage\n", "utf8");
    const sha = await captureCodeSnapshot(sessionFolder, bytes);

    assert.equal(sha, codeSnapshotSha(bytes));
    // blob physically present under the derived dir, filename == sha
    const onDisk = await readFile(join(codeSnapshotDir(sessionFolder), sha));
    assert.deepEqual(onDisk, bytes);
  });

  it("(b) 相同字节 capture 两次 → 只有一个 blob 文件 (dedup), 两次返回同一 sha", async () => {
    const bytes = "duplicate content";
    const sha1 = await captureCodeSnapshot(sessionFolder, bytes);
    const sha2 = await captureCodeSnapshot(sessionFolder, bytes);

    assert.equal(sha1, sha2);
    const entries = await readdir(codeSnapshotDir(sessionFolder));
    assert.deepEqual(entries, [sha1]);
    assert.equal(entries.length, 1);
  });

  it("(c) readCodeSnapshot 往返字节 (capture 什么读回什么)", async () => {
    const bytes = Buffer.from("round trip ✓ ünïcodé\n", "utf8");
    const sha = await captureCodeSnapshot(sessionFolder, bytes);
    const back = await readCodeSnapshot(sessionFolder, sha);
    assert.deepEqual(back, bytes);
    assert.equal(back.toString("utf8"), bytes.toString("utf8"));
  });

  it("(c') 空字节也能往返 capture→read (preimage of an emptied file)", async () => {
    const sha = await captureCodeSnapshot(sessionFolder, Buffer.alloc(0));
    const back = await readCodeSnapshot(sessionFolder, sha);
    assert.equal(back.length, 0);
  });

  it("(d) 读取不存在的 sha → 抛 typed { kind:code_snapshot_missing, sha } (非 instanceof Error)", async () => {
    const missingSha = "0".repeat(64);
    await assert.rejects(
      () => readCodeSnapshot(sessionFolder, missingSha),
      (err: unknown) => {
        // 关键契约: 抛出的是 plain typed object, 不能靠 instanceof Error 判别。
        assert.ok(
          !(err instanceof Error),
          "必须抛 plain typed object, 不是 Error"
        );
        assert.equal((err as { kind?: string }).kind, "code_snapshot_missing");
        assert.equal((err as { sha?: string }).sha, missingSha);
        return true;
      }
    );
  });
});
