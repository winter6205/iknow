/**
 * 归档自 tests/cli/trace.test.ts (T3, plans/session-folder-consolidation.md
 * SC6 / ADR-0071 Decision 1)。归档原因:三条测试钉死的形态已随 T3 退役:
 *
 *   1. 「默认读 ./trace/ 目录」— `DEFAULT_TRACE_DIR = "./trace/"` 退役,trace
 *      锚点迁入会话文件夹;`iknow trace` 读侧默认退到 `resolveServeDataDir()`
 *      (≈ `<home>/.iknow`),两级树 discovery 是 T6 范围。
 *   2. 「旧 ./trace.jsonl fail-fast 提示迁移」— `LEGACY_TRACE_FILE` 与
 *      `detectLegacyTrace` 已从 cli.ts 移除;仓库根不再有 `./trace.jsonl` 形态。
 *   3. 「--trace-out 指向旧单文件 fail-fast」— 同上。
 *
 * 第 4 条「serve 与 trace 分开」认证的不变式(parseArgs 不连带 trace 读侧默认)
 * 仍然真实,已重写为 tests/cli/trace.test.ts 的
 * `describe("parseArgs — serve 与 trace 命令的 traceOut 隔离")`。
 *
 * SSOT 落点: cli.ts:resolveTraceRoot;spec SC6。按 test.md 过时测试规则归档,
 * 不留挂着假前提的旧名字。
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
);

interface SpawnedTrace {
  child: ChildProcess;
}

function spawnTraceCli(cwd: string, args: string[]): SpawnedTrace {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(repoRoot, "src", "cli.ts"), "trace", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"] }
  );
  return { child };
}

describe("runTrace — T7 默认目录 / fail-fast (RETIRED by T3 SC6)", () => {
  let scratch: string;
  let spawned: SpawnedTrace | undefined;
  afterEach(async () => {
    if (spawned) spawned.child.kill("SIGKILL");
    spawned = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("默认读 ./trace/ 目录(无需 --trace-out)", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t7-default-"));
    mkdirSync(join(scratch, "trace"));
    writeFileSync(
      join(scratch, "trace", "c7.jsonl"),
      JSON.stringify({
        conversation_id: "c7",
        record_type: "session",
        agent_version: "test",
        status: "ok",
      }) + "\n",
      "utf8"
    );
    spawned = spawnTraceCli(scratch, ["--separate", "--no-open", "--port", "0"]);
    assert.ok(spawned, "retired shape: default ./trace/ directory read");
  }, 30_000);

  it("旧 ./trace.jsonl 存在 → fail-fast exit 1 + 提示迁移", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t7-legacy-"));
    writeFileSync(
      join(scratch, "trace.jsonl"),
      '{"conversation_id":"c1","record_type":"turn"}\n',
      "utf8"
    );
    spawned = spawnTraceCli(scratch, []);
    assert.ok(scratch, "retired shape: legacy single-file fail-fast");
  }, 30_000);

  it("显式 --trace-out 指向旧单文件 → fail-fast 提示迁移", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t7-explicit-"));
    const file = join(scratch, "old.jsonl");
    writeFileSync(file, '{"conversation_id":"c1"}\n', "utf8");
    spawned = spawnTraceCli(scratch, ["--trace-out", file]);
    assert.ok(file, "retired shape: explicit single-file fail-fast");
  }, 30_000);
});
