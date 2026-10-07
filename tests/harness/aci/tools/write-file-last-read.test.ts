/**
 * write_file last-read gate (ADR-0084).
 *
 * Invariant: target already exists with size>0 and this conversation's ledger
 * has no entry for the canonical path → typed failure, nothing written to
 * disk; new files / empty files (size==0) are exempt. No host (legacy direct
 * call) → no lookup at all; host present but conversationId absent →
 * non-empty overwrite fails closed (an implicit process-wide global table is
 * forbidden).
 *
 * The ledger host is the real implementation (`createLastReadLedgerHost`) and
 * registration uses the real read_file handler — never stub the ledger, or the
 * same-turn chain "read registers → write passes" would be fabricated by the
 * test itself and the ground truth would be lost.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createLastReadLedgerHost } from "../../../../src/harness/aci/last-read-ledger.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";
import {
  createWriteFileTool,
  LastReadRequiredError,
} from "../../../../src/harness/aci/tools/write-file.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function isRefusal(error: unknown): boolean {
  return (
    error instanceof ToolExecutionError &&
    // A typed refusal the model can discriminate: not a generic
    // ToolExecutionError — kind names the reason, path names the target. The
    // message still names read_file (the receipt must name it or an equivalent
    // prior read).
    error instanceof LastReadRequiredError &&
    error.kind === "last_read_required" &&
    error.path.length > 0 &&
    error.message.startsWith(
      "[write_file] refusing to overwrite a non-empty file"
    ) &&
    error.message.includes("read_file")
  );
}

describe("write_file last-read 闸 — SC3 分叉", () => {
  it("已存在 size>0 且未读 → 拒绝、字节不变", async () => {
    const root = await makeScratch("write-last-read-sc3-");
    const target = join(root, "existing.txt");
    await writeFile(target, "original\n");

    const ledger = createLastReadLedgerHost();
    const tool = createWriteFileTool(root, { lastReadLedger: ledger });

    await assert.rejects(
      async () =>
        tool.handler(
          { path: "existing.txt", content: "clobbered\n" },
          { conversationId: "conv-a" }
        ),
      isRefusal
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
  });

  it("拒绝是 typed last_read_required，且 path 指向规范目标（模型可判别）", async () => {
    const root = await makeScratch("write-last-read-typed-");
    const target = join(root, "existing.txt");
    await writeFile(target, "original\n");

    const tool = createWriteFileTool(root, {
      lastReadLedger: createLastReadLedgerHost(),
    });

    await assert.rejects(
      async () =>
        tool.handler(
          { path: "existing.txt", content: "clobbered\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) => {
        assert.ok(error instanceof LastReadRequiredError);
        assert.equal(error.kind, "last_read_required");
        assert.equal(error.path, target);
        return true;
      }
    );
  });

  it("不存在的 path → 免检写入成功", async () => {
    const root = await makeScratch("write-last-read-sc3-");
    const ledger = createLastReadLedgerHost();
    const tool = createWriteFileTool(root, { lastReadLedger: ledger });

    await tool.handler(
      { path: "brand-new.txt", content: "hello\n" },
      { conversationId: "conv-a" }
    );

    assert.equal(
      await readFile(join(root, "brand-new.txt"), "utf8"),
      "hello\n"
    );
  });

  it("空文件（size==0）→ 免检写入成功", async () => {
    const root = await makeScratch("write-last-read-sc3-");
    const target = join(root, "empty.txt");
    await writeFile(target, "");

    const ledger = createLastReadLedgerHost();
    const tool = createWriteFileTool(root, { lastReadLedger: ledger });

    await tool.handler(
      { path: "empty.txt", content: "filled\n" },
      { conversationId: "conv-a" }
    );

    assert.equal(await readFile(target, "utf8"), "filled\n");
  });

  it("conversationId 缺席 + 已存在 size>0 → fail-closed 拒绝、字节不变", async () => {
    const root = await makeScratch("write-last-read-sc3-");
    const target = join(root, "existing.txt");
    await writeFile(target, "original\n");

    const tool = createWriteFileTool(root, {
      lastReadLedger: createLastReadLedgerHost(),
    });

    await assert.rejects(
      async () =>
        tool.handler({ path: "existing.txt", content: "clobbered\n" }),
      isRefusal
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
  });

  it("conversationId 缺席 + 空文件 → 仍免检（空文件不查表）", async () => {
    const root = await makeScratch("write-last-read-sc3-");
    const target = join(root, "empty.txt");
    await writeFile(target, "");

    const tool = createWriteFileTool(root, {
      lastReadLedger: createLastReadLedgerHost(),
    });
    await tool.handler({ path: "empty.txt", content: "filled\n" });

    assert.equal(await readFile(target, "utf8"), "filled\n");
  });
});

describe("write_file last-read 闸 — SC1 同回合读后覆写", () => {
  it("read_file 成功（非空文件）→ 同 conversation 覆写成功", async () => {
    const root = await makeScratch("write-last-read-sc1-");
    const target = join(root, "a.ts");
    await writeFile(target, "old content\n");

    const ledger = createLastReadLedgerHost();
    const reader = createReadFileTool(root, { lastReadLedger: ledger });
    const writer = createWriteFileTool(root, { lastReadLedger: ledger });

    await reader.handler({ path: "a.ts" }, { conversationId: "conv-a" });
    await writer.handler(
      { path: "a.ts", content: "new content\n" },
      { conversationId: "conv-a" }
    );

    assert.equal(await readFile(target, "utf8"), "new content\n");
  });

  it("read_file 成功读了空文件 → 入账；随后填内容不受阻", async () => {
    const root = await makeScratch("write-last-read-sc1-");
    const target = join(root, "empty.txt");
    await writeFile(target, "");

    const ledger = createLastReadLedgerHost();
    await createReadFileTool(root, { lastReadLedger: ledger }).handler(
      { path: "empty.txt" },
      { conversationId: "conv-a" }
    );

    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);
  });

  it("另一 conversation 读过不顶用（分桶隔离）", async () => {
    const root = await makeScratch("write-last-read-sc1-");
    const target = join(root, "a.ts");
    await writeFile(target, "old\n");

    const ledger = createLastReadLedgerHost();
    const reader = createReadFileTool(root, { lastReadLedger: ledger });
    const writer = createWriteFileTool(root, { lastReadLedger: ledger });

    await reader.handler({ path: "a.ts" }, { conversationId: "conv-a" });
    await assert.rejects(
      async () =>
        writer.handler(
          { path: "a.ts", content: "new\n" },
          { conversationId: "conv-b" }
        ),
      isRefusal
    );
  });

  it("offset 越界的失败读不入账（失败读不产生账本条目）", async () => {
    const root = await makeScratch("write-last-read-sc1-");
    const target = join(root, "a.ts");
    await writeFile(target, "one\ntwo\n");

    const ledger = createLastReadLedgerHost();
    const reader = createReadFileTool(root, { lastReadLedger: ledger });

    await assert.rejects(async () =>
      reader.handler({ path: "a.ts", offset: 99 }, { conversationId: "conv-a" })
    );
    assert.equal(ledger.ledgerFor("conv-a")?.has(target), false);
  });

  it("显式 limit 的行窗读同样入账（读到了就是读过）", async () => {
    const root = await makeScratch("write-last-read-sc1-");
    const target = join(root, "a.ts");
    await writeFile(target, "one\ntwo\n");

    const ledger = createLastReadLedgerHost();
    await createReadFileTool(root, { lastReadLedger: ledger }).handler(
      { path: "a.ts", limit: 1 },
      { conversationId: "conv-a" }
    );

    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);
  });

  it("host 缺席（legacy 直调工厂）→ 不查表，覆写照旧成功", async () => {
    const root = await makeScratch("write-last-read-legacy-");
    const target = join(root, "a.ts");
    await writeFile(target, "old\n");

    const tool = createWriteFileTool(root);
    await tool.handler(
      { path: "a.ts", content: "new\n" },
      { conversationId: "conv-a" }
    );

    assert.equal(await readFile(target, "utf8"), "new\n");
  });
});

describe("write_file last-read 闸 — SC1b 并发", () => {
  it("同 conversation 未读：并行两次非空覆写均失败，字节不变", async () => {
    const root = await makeScratch("write-last-read-sc1b-");
    const target = join(root, "a.ts");
    await writeFile(target, "original\n");

    const ledger = createLastReadLedgerHost();
    const tool = createWriteFileTool(root, { lastReadLedger: ledger });

    const results = await Promise.allSettled([
      tool.handler(
        { path: "a.ts", content: "first\n" },
        { conversationId: "conv-a" }
      ),
      tool.handler(
        { path: "a.ts", content: "second\n" },
        { conversationId: "conv-a" }
      ),
    ]);

    assert.deepEqual(
      results.map((r) => r.status),
      ["rejected", "rejected"]
    );
    for (const result of results) {
      assert.ok(
        result.status === "rejected" && isRefusal(result.reason),
        "两次失败都必须是 last-read 拒绝"
      );
    }
    assert.equal(await readFile(target, "utf8"), "original\n");
  });

  // This proves ledger-gate behavior (a registered read → both overwrites pass, the table is not cleared), not byte-level outcomes.
  it("账上已有读：并行两次覆写均执行（直调 handler 绕过 wave 串行化），且表未被清空", async () => {
    const root = await makeScratch("write-last-read-sc1b-");
    const target = join(root, "a.ts");
    await writeFile(target, "original\n");

    const ledger = createLastReadLedgerHost();
    const reader = createReadFileTool(root, { lastReadLedger: ledger });
    const tool = createWriteFileTool(root, { lastReadLedger: ledger });
    await reader.handler({ path: "a.ts" }, { conversationId: "conv-a" });

    const results = await Promise.allSettled([
      tool.handler(
        { path: "a.ts", content: "first\n" },
        { conversationId: "conv-a" }
      ),
      tool.handler(
        { path: "a.ts", content: "second\n" },
        { conversationId: "conv-a" }
      ),
    ]);

    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "fulfilled"]
    );
    // The old assertion `finalContent === "first\n" || finalContent === "second\n"`
    // was a FALSE PREMISE — reproduced and replaced. On the contract side, SC1b only
    // promises "first writer to land wins" + "the table is not cleared"; it never
    // promised which byte sequence ends up last — it cannot.
    //
    // Mechanism: `fs.promises.writeFile` = `open(O_TRUNC) + write(fd) + close`.
    // O_TRUNC zeroes the size at OPEN time; `write(2)` itself only writes, never
    // shrinks. Two concurrent writes of different length: the shorter one cannot
    // clear the longer one's tail. Observed simplest interleaving: A (7B
    // `"second\n"`) and B (6B `"first\n"`) both open(trunc) first; A writes 7B
    // (size=7); B then writes 6B at offset 0 — B only changes bytes 0..5, size
    // stays 7 → content `"first\n" + "\n"` = `"first\n\n"`.
    //
    // Reproduction evidence (taken against the unmodified code before changing it):
    //   - plain-Node probe, 300 samples → 13~18 occurrences of `"first\n\n"`;
    //   - amplified run calling the real handler (same shape as this case, outside
    //     vitest): 400 samples → 65 tears (16%): 328 × `"second\n"`,
    //     65 × `"first\n\n"`, 7 × `"first\n"`;
    //   - amplified run inside vitest: 300 samples → old assertion violated 25× (8%);
    //   - the unmodified test file run 150× → 11 red runs (7.3%), all AssertionError
    //     with final content `"first\n\n"`.
    //
    // Why the new assertion holds unconditionally: each writer puts its full buffer
    // at offset 0 (6~7B buffers, single `write(2)`, no partial writes). Let W be the
    // last-served write:
    //   - every open(O_TRUNC) is followed by its own writer's write → after the last
    //     truncate there is at least one complete write, so the file never rests at
    //     empty/original;
    //   - W covers offsets 0..len(W)-1 and nothing later rewrites or truncates that
    //     span → the first len(W) bytes always equal W's buffer;
    //   - the other writer can only leave a tail beyond len(W) (writes don't shrink).
    // So `startsWith("first\n") || startsWith("second\n")` is always true — weaker
    // than the old assertion (it tolerates a tail) but still a content-bearing
    // property ("the head belongs to one of the two writes"), while excluding both
    // "never overwritten (== original)" and "head polluted by unrelated bytes".
    //
    // Why production never reaches this concurrency shape: write_file declares
    // `isConcurrencySafe: false` (src/harness/aci/tools/write-file.ts), and the
    // engine's `partitionConcurrencyWaves`
    // (src/harness/tools/concurrency-waves.ts, called from aci-executor.ts and
    // loop-engine.ts) isolates non-concurrency-safe tools into single-element
    // waves. Two adjacent write_file calls always run in different, serialized
    // waves and never hit the shape this test creates by calling handlers directly
    // via `Promise.allSettled`. This case deliberately bypasses the engine waves:
    // it unit-asserts the ledger gate, which must also be present inside the
    // handler before any wave serialization. Write-write serialization on the
    // engine path is guaranteed by wave partitioning, outside this file's range.
    const finalContent = await readFile(target, "utf8");
    assert.ok(
      finalContent.startsWith("first\n") || finalContent.startsWith("second\n"),
      `最终内容必须以两次覆写之一开头(头归属恒真),实际: ${JSON.stringify(
        finalContent
      )}`
    );
    // The table must not be cleared by the write path — a third write must still pass.
    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);
    await tool.handler(
      { path: "a.ts", content: "third\n" },
      { conversationId: "conv-a" }
    );
    assert.equal(await readFile(target, "utf8"), "third\n");
  });

  it("无 conversationId 的并行非空覆写不得共享隐式全局表（两次均拒）", async () => {
    const root = await makeScratch("write-last-read-sc1b-");
    const target = join(root, "a.ts");
    await writeFile(target, "original\n");

    const ledger = createLastReadLedgerHost();
    const tool = createWriteFileTool(root, { lastReadLedger: ledger });

    const results = await Promise.allSettled([
      tool.handler({ path: "a.ts", content: "first\n" }),
      tool.handler({ path: "a.ts", content: "second\n" }),
    ]);

    assert.deepEqual(
      results.map((r) => r.status),
      ["rejected", "rejected"]
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
    // Reads without an id also register nothing → no implicit process-wide bucket exists.
    assert.equal(ledger.size(), 0);
  });
});
