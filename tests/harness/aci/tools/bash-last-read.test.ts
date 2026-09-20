/**
 * bash → last-read ledger accounting (ADR-0084, the second accounting source).
 *
 * Invariant: a **successful** (exit 0) command that is a whitelisted read
 * with exactly one file operand, no pipes and no redirections → the
 * canonical path is recorded; nothing else is. Once recorded, a non-empty
 * `write_file` overwrite in the same conversation is allowed — verified
 * through the real write_file gate, not just the ledger size.
 *
 * This suite runs the real bwrap sandbox (same as current bash tests);
 * environments without a sandbox are covered by the CI exclude set
 * (`vitest.ci-excludes.ts` — the exclude-list SSOT).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createBashTool } from "../../../../src/harness/aci/tools/bash.ts";
import { createLastReadLedgerHost } from "../../../../src/harness/aci/last-read-ledger.ts";
import { createWriteFileTool } from "../../../../src/harness/aci/tools/write-file.ts";
import type { AciToolDef } from "../../../../src/harness/aci/types.ts";
import type { ToolExecutionContext } from "../../../../src/harness/tools/types.ts";

/** The bash handler returns an envelope: model-facing output + observation-facing meta. */
interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}

async function runBash(
  tool: AciToolDef,
  input: unknown,
  ctx?: ToolExecutionContext
): Promise<{ code: number; stdout: string; stderr: string }> {
  const envelope = (await tool.handler(input, ctx)) as BashEnvelope;
  return JSON.parse(envelope.output) as {
    code: number;
    stdout: string;
    stderr: string;
  };
}

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

describe("bash — last-read 入账", () => {
  it("cat 单文件成功 → 账本含该 path，随后同 conversation 覆写放行（SC1 bash 臂）", async () => {
    const cwd = await makeScratch("bash-last-read-cat-");
    const target = join(cwd, "a.ts");
    await writeFile(target, "original\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    await bash.handler({ command: "cat a.ts" }, { conversationId: "conv-a" });

    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);
    await writer.handler(
      { path: "a.ts", content: "rewritten\n" },
      { conversationId: "conv-a" }
    );
    assert.equal(await readFile(target, "utf8"), "rewritten\n");
  });

  it("grep 单文件成功（pattern + 文件）→ 入账文件是第二个操作数", async () => {
    const cwd = await makeScratch("bash-last-read-grep-");
    const target = join(cwd, "a.ts");
    await writeFile(target, "needle\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });

    await bash.handler(
      { command: "grep needle a.ts" },
      { conversationId: "conv-a" }
    );

    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);
  });

  it("head -n 成功 → 入账", async () => {
    const cwd = await makeScratch("bash-last-read-head-");
    const target = join(cwd, "a.ts");
    await writeFile(target, "one\ntwo\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });

    await bash.handler(
      { command: "head -n 1 a.ts" },
      { conversationId: "conv-a" }
    );

    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);
  });

  it("命令失败（exit != 0）→ 不入账", async () => {
    const cwd = await makeScratch("bash-last-read-fail-");
    await writeFile(join(cwd, "a.ts"), "x\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "cat missing.txt" },
      { conversationId: "conv-a" }
    );
    assert.notEqual(result.code, 0);
    assert.equal(ledger.ledgerFor("conv-a")?.size(), 0);
  });

  it("ls / 管道 / 重定向 / 多文件 → 不入账", async () => {
    const cwd = await makeScratch("bash-last-read-negative-");
    await writeFile(join(cwd, "a.ts"), "one\n");
    await writeFile(join(cwd, "b.ts"), "two\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });

    for (const command of [
      "ls",
      "stat a.ts",
      "cat a.ts | head -n 1",
      "cat a.ts > out.txt",
      "cat a.ts b.ts",
    ]) {
      await bash.handler({ command }, { conversationId: "conv-a" });
    }

    assert.equal(
      ledger.ledgerFor("conv-a")?.size(),
      0,
      "非「白名单 + 单文件 + 无管道无重定向」的命令一律不入账"
    );
  });

  it("conversationId 缺席 → 读可执行但不入账（无隐式全局桶）", async () => {
    const cwd = await makeScratch("bash-last-read-noid-");
    await writeFile(join(cwd, "a.ts"), "x\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(bash, { command: "cat a.ts" });
    assert.equal(result.code, 0);
    assert.equal(ledger.size(), 0);
  });

  it("session tmp pad 与 write_file 同键：`cat <pad>/x` 入账后，写工具覆写该 pad 文件放行", async () => {
    const cwd = await makeScratch("bash-last-read-tmp-");
    const pad = await makeScratch("bash-last-read-pad-");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger, tmpDir: pad });
    const writer = createWriteFileTool(cwd, {
      lastReadLedger: ledger,
      tmpDir: pad,
    });

    // ADR-0092: pad is the host path behind `$TMPDIR`; guest `/tmp` no longer aliases to it.
    const note = join(pad, "note.txt");
    await writeFile(note, "pad content\n");
    const result = await runBash(
      bash,
      { command: `cat ${note}` },
      { conversationId: "conv-a" }
    );
    assert.equal(result.code, 0);

    await writer.handler(
      { path: note, content: "rewritten\n" },
      { conversationId: "conv-a" }
    );
    assert.equal(await readFile(note, "utf8"), "rewritten\n");
  });

  it("grep -q 成功但 stdout 为空（没看到内容）→ 不入账，随后覆写被拒", async () => {
    const cwd = await makeScratch("bash-last-read-quiet-");
    const target = join(cwd, "cfg.ts");
    await writeFile(target, "SECRET\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "grep -q SECRET cfg.ts" },
      { conversationId: "conv-a" }
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      ledger.ledgerFor("conv-a")?.has(target),
      false,
      "-q 抑制内容输出，模型没看到现态 → 不得入账"
    );

    await assert.rejects(
      () =>
        writer.handler(
          { path: "cfg.ts", content: "rewritten\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("refusing to overwrite")
    );
    assert.equal(await readFile(target, "utf8"), "SECRET\n");
  });

  it("grep --qui（GNU 长旗标无歧义前缀 = --quiet）成功但 stdout 为空 → 不入账，随后覆写被拒且字节不变", async () => {
    const cwd = await makeScratch("bash-last-read-quiet-prefix-");
    const target = join(cwd, "cfg.ts");
    await writeFile(target, "SECRET\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "grep --qui SECRET cfg.ts" },
      { conversationId: "conv-a" }
    );
    // GNU grep 3.12 inside real bwrap accepts the `--qui` prefix: exit 0, no output.
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      ledger.ledgerFor("conv-a")?.has(target),
      false,
      "--qui 等价 --quiet，模型没看到现态 → 不得入账"
    );

    await assert.rejects(
      () =>
        writer.handler(
          { path: "cfg.ts", content: "rewritten\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("refusing to overwrite")
    );
    assert.equal(await readFile(target, "utf8"), "SECRET\n");
  });

  it("rg --c（ripgrep 单字母双横线别名 = -c，只打印条数）成功但没看到内容 → 不入账，随后覆写被拒且字节不变", async () => {
    const cwd = await makeScratch("bash-last-read-rg-alias-");
    const target = join(cwd, "cfg.ts");
    await writeFile(target, "SECRET\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "rg --c SECRET cfg.ts" },
      { conversationId: "conv-a" }
    );
    // Measured vendored rg 15.1.0: `rg --c` equals `-c` — prints only the count, exit 0.
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "1");
    assert.equal(
      ledger.ledgerFor("conv-a")?.has(target),
      false,
      "--c 等价 -c，模型没看到文件内容 → 不得入账"
    );

    await assert.rejects(
      async () =>
        writer.handler(
          { path: "cfg.ts", content: "rewritten\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("refusing to overwrite")
    );
    assert.equal(await readFile(target, "utf8"), "SECRET\n");
  });

  it("sed -n -e d（exit 0、stdout 为空）→ 不入账，随后覆写被拒且字节不变", async () => {
    const cwd = await makeScratch("bash-last-read-sed-e-");
    const target = join(cwd, "cfg.ts");
    await writeFile(target, "SECRET\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "sed -n -e d cfg.ts" },
      { conversationId: "conv-a" }
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      ledger.ledgerFor("conv-a")?.has(target),
      false,
      "-e 的脚本不是 X,Yp 行范围打印，命令 exit 0 也没打印任何内容 → 不得入账"
    );

    await assert.rejects(
      async () =>
        writer.handler(
          { path: "cfg.ts", content: "rewritten\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("refusing to overwrite")
    );
    assert.equal(await readFile(target, "utf8"), "SECRET\n");
  });

  it("sed -i 原地改（exit 0、文件被改写）→ 不入账，随后覆写仍被拒", async () => {
    const cwd = await makeScratch("bash-last-read-inplace-");
    const target = join(cwd, "f.ts");
    await writeFile(target, "one\ntwo\nthree\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "sed -n -i.bak -e 1,2p f.ts" },
      { conversationId: "conv-a" }
    );
    assert.equal(result.code, 0);
    // In-place editing is a write, not a read: sed already rewrote the file (bwrap does not mount cwd read-only).
    assert.equal(await readFile(target, "utf8"), "one\ntwo\n");
    assert.equal(
      ledger.ledgerFor("conv-a")?.has(target),
      false,
      "原地改命令不得当作读过"
    );

    await assert.rejects(
      () =>
        writer.handler(
          { path: "f.ts", content: "clobbered\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("refusing to overwrite")
    );
  });

  it("host 缺席 → 命令照常执行、不抛", async () => {
    const cwd = await makeScratch("bash-last-read-nohost-");
    await writeFile(join(cwd, "a.ts"), "x\n");

    const bash = createBashTool(cwd);
    const result = await runBash(
      bash,
      { command: "cat a.ts" },
      { conversationId: "conv-a" }
    );

    assert.equal(result.code, 0);
  });

  it("cat --help 成功但根本没打开文件 → 不入账，随后覆写被拒且字节不变（簇 A 端到端）", async () => {
    // Inside real bwrap, the sandbox's /usr/bin/cat is the host's uutils
    // coreutils 0.8.0: `cat --help a.txt` exits 0 with only
    // "Concatenate FILE(s), ..." help text on stdout, and a.txt is never
    // opened. The old extractor looked only at "exactly one operand left" →
    // recorded a.txt, after which `write_file` could clobber the unread
    // PRECIOUS into CLOBBERED (exploitable, measured in the real sandbox).
    const cwd = await makeScratch("bash-last-read-help-");
    const target = join(cwd, "a.txt");
    await writeFile(target, "PRECIOUS\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "cat --help a.txt" },
      { conversationId: "conv-a" }
    );
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes("PRECIOUS"),
      false,
      "帮助文本里不应有文件内容（前提校验：这条命令确实什么都没读）"
    );
    assert.equal(
      ledger.ledgerFor("conv-a")?.has(target),
      false,
      "--help 让 cat 打印完帮助就退出，文件没被打开 → 不得入账"
    );

    await assert.rejects(
      () =>
        writer.handler(
          { path: "a.txt", content: "CLOBBERED\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("refusing to overwrite")
    );
    assert.equal(await readFile(target, "utf8"), "PRECIOUS\n");
  });

  it("正向对照：同一条命令去掉 --help（真读）→ 入账且覆写放行", async () => {
    // Same file and tool as the previous case, minus only the
    // short-circuit flag. Guards against over-tightening like "reject
    // anything with --": if the reject set hit a real read, the model would
    // be forced to re-read and the ledger's usefulness would be destroyed.
    const cwd = await makeScratch("bash-last-read-help-control-");
    const target = join(cwd, "a.txt");
    await writeFile(target, "PRECIOUS\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "cat a.txt" },
      { conversationId: "conv-a" }
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes("PRECIOUS"), true);
    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);

    await writer.handler(
      { path: "a.txt", content: "rewritten\n" },
      { conversationId: "conv-a" }
    );
    assert.equal(await readFile(target, "utf8"), "rewritten\n");
  });

  it("rg --pre COMMAND（伪造视图）成功但 stdout 不是磁盘现态 → 不入账，随后覆写被拒", async () => {
    // End-to-end exploit surface: `rg --pre rev <PATTERN> a.txt` makes rg
    // run `rev a.txt` and search its output — stdout holds **reversed file
    // bytes**, so the model thinks it read the file while seeing a view
    // transformed by a model-chosen command. Measured with vendored rg
    // 15.1.0 in a real bwrap sandbox (on-disk a.txt = `PRECIOUS_DISK_CONTENT`):
    //   `rg --pre rev TNETNOC_KSID_SUOICERP a.txt`   rc=0 stdout=TNETNOC_KSID_SUOICERP
    //   `rg --pre=rev TNETNOC_KSID_SUOICERP a.txt`   rc=0 same (the `=` spelling is equivalent)
    //   `rg --pre cat PRECIOUS_DISK a.txt`          rc=0 stdout=PRECIOUS_DISK_CONTENT
    // All three spellings must be rejected: `--pre cat` is an identity
    // preprocessor that happens to match the disk bytes, but the same slot
    // filled with `rev` fabricates a view — the verdict is by **shape**
    // (same family as `-r`), not by one run happening to be equal. A miss
    // would ledger a never-read nonempty file and let write_file clobber it.
    const cwd = await makeScratch("bash-last-read-rg-pre-");
    const target = join(cwd, "a.txt");
    await writeFile(target, "PRECIOUS_DISK_CONTENT\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const cases: ReadonlyArray<{
      command: string;
      fakeInStdout: string;
      /** Whether the on-disk text appears in stdout — `rev` fabricates a view (absent), `cat` is identity (present). */
      diskContentInStdout: boolean;
    }> = [
      // Reversed fabricated text (the fake view `rev` produces for the pattern).
      {
        command: "rg --pre rev TNETNOC_KSID_SUOICERP a.txt",
        fakeInStdout: "TNETNOC_KSID_SUOICERP",
        diskContentInStdout: false,
      },
      // The `=` spelling is equivalent.
      {
        command: "rg --pre=rev TNETNOC_KSID_SUOICERP a.txt",
        fakeInStdout: "TNETNOC_KSID_SUOICERP",
        diskContentInStdout: false,
      },
      // `cat` is an identity preprocessor: the output really is the disk
      // text, but the "read" passes through an arbitrary model-chosen
      // command — the same seam could carry `rev`/`sed`/any script.
      // Rejected by **shape** (same family as `-r`: what is printed is not
      // guaranteed to be the current disk state), not by one run happening
      // to be equal.
      {
        command: "rg --pre cat PRECIOUS_DISK a.txt",
        fakeInStdout: "PRECIOUS_DISK",
        diskContentInStdout: true,
      },
    ];
    for (const { command, fakeInStdout, diskContentInStdout } of cases) {
      const result = await runBash(
        bash,
        { command },
        { conversationId: "conv-a" }
      );
      assert.equal(
        result.code,
        0,
        `前提：${command} 必须 exit 0（否则 fail-closed 失效）`
      );
      assert.equal(
        result.stdout.includes(fakeInStdout),
        true,
        `前提：${command} 的 stdout 含 ${fakeInStdout} —— 锁定「模型自选内容能进 stdout」的形态`
      );
      assert.equal(
        result.stdout.includes("PRECIOUS_DISK_CONTENT"),
        diskContentInStdout,
        `前提：${command} 的 stdout 磁盘原文可见性必须与预处理命令语义一致（rev 不可见 / cat 恒等可见）`
      );
      assert.equal(
        ledger.ledgerFor("conv-a")?.has(target),
        false,
        `${command} → --pre 让 rg 搜 COMMAND 的输出而非文件原文，模型没看到磁盘现态 → 不得入账`
      );
    }

    // All three rejected: the following write_file in the same conversation
    // must be refused, bytes unchanged.
    await assert.rejects(
      () =>
        writer.handler(
          { path: "a.txt", content: "CLOBBERED\n" },
          { conversationId: "conv-a" }
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("refusing to overwrite")
    );
    assert.equal(await readFile(target, "utf8"), "PRECIOUS_DISK_CONTENT\n");
  });

  it("正向对照：同一条命令去掉 --pre（真读）→ 入账且覆写放行", async () => {
    // Same file and tool as the previous case, minus only `--pre`. If the
    // reject set hit a real read, the model would be forced to re-read and
    // the ledger's usefulness would be destroyed.
    const cwd = await makeScratch("bash-last-read-rg-pre-control-");
    const target = join(cwd, "a.txt");
    await writeFile(target, "PRECIOUS\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    const result = await runBash(
      bash,
      { command: "rg PRECIOUS a.txt" },
      { conversationId: "conv-a" }
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout.includes("PRECIOUS"), true);
    assert.equal(ledger.ledgerFor("conv-a")?.has(target), true);

    await writer.handler(
      { path: "a.txt", content: "rewritten\n" },
      { conversationId: "conv-a" }
    );
    assert.equal(await readFile(target, "utf8"), "rewritten\n");
  });
});
