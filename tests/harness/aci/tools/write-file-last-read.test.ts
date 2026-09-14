/**
 * write_file last-read 闸（ADR-0084 / spec D1 + SC1 / SC1b / SC3）。
 *
 * 不变式：目标**已存在且 size>0** 且本 conversation 账上无该规范 path →
 * typed 失败、**不写盘**；新建 / 空文件（size==0）免检。host 缺席（legacy
 * 直调）→ 不查表；host 在场但 conversationId 缺席 → 非空覆写 fail-closed
 * （禁止隐式进程级全局表）。
 *
 * 账本 host 走真实实现（`createLastReadLedgerHost`），入账用真实 read_file
 * handler —— 不 stub 账本，否则「read 入账 → write 放行」这条同回合链路
 * 会被测试自己假造，SC1 的 ground truth 就没了。
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
    // 模型可判别的 typed 拒绝：不是泛化 ToolExecutionError，kind 点名原因、
    // path 点名目标。message 仍点名 read_file（spec：回执点名或等价先读）。
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
      () =>
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
      () =>
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
      () => tool.handler({ path: "existing.txt", content: "clobbered\n" }),
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
      () =>
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

    await assert.rejects(() =>
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

  // 证明的是账本闸行为（账上有读 → 两次覆写都放行、表未被清空），不是字节级结果。
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
    // 旧断言 `finalContent === "first\n" || finalContent === "second\n"` 是
    // **假前提**,已复现并替换。契约侧:spec SC1b 只承诺「先落盘者赢」+「表
    // 未被清空」,没有承诺最终字节等于哪一次 —— 它也没法承诺。
    //
    // 机制:`fs.promises.writeFile` = `open(O_TRUNC) + write(fd) + close`。
    // O_TRUNC 在 **open** 时把 size 归零,`write(2)` 本身**只写不缩**。两次
    // 并发、长度不同时,短的那次写完不会清掉长的那次在后面的尾巴。实测最简
    // 交错:A(7B `"second\n"`)与 B(6B `"first\n"`)都先 open(trunc,size=0),
    // A 写入 7B(size=7),B 再在 offset 0 写 6B —— B 只改 offset 0..5,size
    // 仍是 7 → 内容 `"first\n" + "\n"` = `"first\n\n"`。
    //
    // 复现数字(**先在未修改的代码上取证,再改**):
    //   - 纯 Node 探针 `/home/winner/.claude/jobs/0df87588/tmp/probe-tear.mts`:
    //     300 样本 → 13~18 次 `"first\n\n"`(leader 13 / 我 18);
    //   - 直调真实 handler 的放大跑(同用例形状,不进 vitest):400 样本 →
    //     65 次撕裂(16%):328 × `"second\n"`、65 × `"first\n\n"`、7 × `"first\n"`;
    //   - vitest runtime 内放大跑:300 样本 → 旧断言 25 次违反(8%);
    //   - **未修改的该测试文件整跑 150 次 → 11 次红**(7.3%),全部是
    //     AssertionError `最终内容必须是两次覆写之一,实际: "first\n\n"`。
    //
    // 新断言的恒真性:两次写入各自把完整 buffer 写到 offset 0(6~7B 缓冲区,
    // 单次 `write(2)`,不存在部分写)。设最后被服务的那次写为 W:
    //   - 每次 open(O_TRUNC) 之后,其写者的 write 必在其后 → 最后一个 truncate
    //     之后必然至少有一次完整 write,故文件不会停在空/original;
    //   - W 的 write 覆盖 offset 0..len(W)-1;此后没有更晚的写去改这段,也没
    //     有 truncate → **文件头 len(W) 字节恒等于 W 的缓冲区**;
    //   - 另一写者只可能在 len(W) 之外留下尾巴(write 不缩文件)。
    // 所以 `startsWith("first\n") || startsWith("second\n")` 恒真 —— 它比旧
    // 断言弱(容许尾巴),但仍是「头归属 = 两次写入之一」这一有内容的性质,
    // 同时排除了「文件没被覆写(== original)」与「头部被无关字节污染」。
    //
    // 为何生产面到不了这个并发形态:`write_file` 在
    // `src/harness/aci/tools/write-file.ts:237` 声明 `isConcurrencySafe: false`,
    // 引擎的 `partitionConcurrencyWaves`(`src/harness/tools/concurrency-waves.ts:5-24`,
    // 调用点 `src/harness/aci/aci-executor.ts:158` 与
    // `src/harness/loop-engine.ts:1712`)把非并发安全工具逐个隔成单元素
    // wave。两次相邻 `write_file` 永远落在不同 wave 串行执行,不会撞到本测试
    // 用 `Promise.allSettled` 直调 handler 模拟出的并发形状。**本用例是刻意
    // 绕过引擎 wave 的账本闸单元断言**(闸在被 wave 串行化之前的 handler 里
    // 也必须在场),引擎路径的写-写串行化由 wave 划分保证、不在本文件的射程。
    const finalContent = await readFile(target, "utf8");
    assert.ok(
      finalContent.startsWith("first\n") || finalContent.startsWith("second\n"),
      `最终内容必须以两次覆写之一开头(头归属恒真),实际: ${JSON.stringify(
        finalContent
      )}`
    );
    // 表不得被写路径清空 —— 再写第三次仍应放行。
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
    // 无 id 的读也不入账 → 进程里不存在任何隐式全局桶。
    assert.equal(ledger.size(), 0);
  });
});
