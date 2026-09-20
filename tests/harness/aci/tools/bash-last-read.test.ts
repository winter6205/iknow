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
import { ROLE_SUBSTITUTION_PREFIX } from "../../../../src/harness/aci/tools/role-substitution.ts";
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

  it("grep 单文件命令被替岗闸先拒（ADR-0117）→ 不执行、不入账", async () => {
    // ADR-0117 supersedes the bash-side grep booking route: bash must not
    // impersonate the grep family, so the command never reaches the
    // extractor. The read-shape invariant itself (pattern + single file →
    // second operand) is pinned at the extractor level in
    // bash-read-extract.test.ts; here the handler-level truth is refusal.
    const cwd = await makeScratch("bash-last-read-grep-");
    const target = join(cwd, "a.ts");
    await writeFile(target, "needle\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });

    await assert.rejects(
      async () => {
        await bash.handler({ command: "grep needle a.ts" }, { conversationId: "conv-a" });
      },
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.startsWith(ROLE_SUBSTITUTION_PREFIX)
    );
    assert.equal(ledger.ledgerFor("conv-a")?.size(), 0);
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

  it("grep 抑制内容旗标（-q / --qui）与 rg 计数别名（--c）在 handler 层即被替岗拒绝 → 不入账且覆写仍被拒", async () => {
    // ADR-0117 moved the verdict upstream: the whole grep family (whatever
    // flags) is refused before execution, so the ledger can never be
    // booked through bash and a later non-empty overwrite stays refused.
    // The per-flag shape analysis (which suppressions fabricate a "read")
    // is pinned at the extractor level in bash-read-extract.test.ts.
    const cwd = await makeScratch("bash-last-read-quiet-");
    const target = join(cwd, "cfg.ts");
    await writeFile(target, "SECRET\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    for (const command of [
      "grep -q SECRET cfg.ts",
      "grep --qui SECRET cfg.ts",
      "rg --c SECRET cfg.ts",
    ]) {
      await assert.rejects(
        async () => {
          await bash.handler({ command }, { conversationId: "conv-a" });
        },
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          error.message.startsWith(ROLE_SUBSTITUTION_PREFIX),
        `${command} → 替岗拒绝（fail-closed，不执行）`
      );
    }
    assert.equal(ledger.ledgerFor("conv-a")?.size(), 0);

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

  it("rg --pre 伪造视图命令在 handler 层即被替岗拒绝 → 不执行、不入账、覆写仍被拒", async () => {
    // ADR-0117 moved this verdict upstream: every rg spelling — fabricated
    // view (`--pre rev`), the `=` form, the identity `--pre cat`, and the
    // plain read alike — is refused at the gate, so none can book the
    // ledger through bash and a later non-empty overwrite stays refused.
    // The per-shape analysis (why --pre fabricates a view, why --pre-glob
    // alone is exempt, why the plain rg shape is a read) is pinned at the
    // extractor level in bash-read-extract.test.ts.
    const cwd = await makeScratch("bash-last-read-rg-pre-");
    const target = join(cwd, "a.txt");
    await writeFile(target, "PRECIOUS_DISK_CONTENT\n");

    const ledger = createLastReadLedgerHost();
    const bash = createBashTool(cwd, { lastReadLedger: ledger });
    const writer = createWriteFileTool(cwd, { lastReadLedger: ledger });

    for (const command of [
      "rg --pre rev TNETNOC_KSID_SUOICERP a.txt",
      "rg --pre=rev TNETNOC_KSID_SUOICERP a.txt",
      "rg --pre cat PRECIOUS_DISK a.txt",
      // Role-based, not exploit-based: the plain rg read form is refused too.
      "rg PRECIOUS_DISK_CONTENT a.txt",
    ]) {
      await assert.rejects(
        async () => {
          await bash.handler({ command }, { conversationId: "conv-a" });
        },
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          error.message.startsWith(ROLE_SUBSTITUTION_PREFIX),
        `${command} → 替岗拒绝（fail-closed，不执行）`
      );
    }
    assert.equal(ledger.ledgerFor("conv-a")?.size(), 0);

    // All refused: the following write_file in the same conversation
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

  it("正向对照：职分闸没有吃掉读族——白名单行窗读照常执行且入账、覆写放行", async () => {
    // The old control used the plain rg read; ADR-0117 refuses that form at
    // the gate, so the over-tightening guard moves to the read forms the
    // policy keeps (cat line read). If the gate ate these too, the ledger's
    // usefulness would be destroyed.
    const cwd = await makeScratch("bash-last-read-role-sub-control-");
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
});
