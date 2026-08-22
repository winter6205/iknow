/**
 * `iknow trace` 默认探测模式三态测试（ADR-0020 D2.1/D2.2，plan T4）。
 *
 * 真实 CLI 子进程（cli.ts 顶层 main().catch 副作用，无法 import 单测）：
 *   1. 探测成功（假 serve health 在目标端口）→ exit 0 + 打印 /trace URL
 *   2. 探测失败（端口无 serve）→ exit 1 + 提示 --separate
 *   3. --separate → 起独立进程（port 0 实测 health 后 kill）
 *
 * parseArgs 侧：--separate flag 解析 + trace 默认端口按模式分派
 * （默认 8787 探测 / --separate 24881）。
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import * as http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../src/cli/parse-args.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 与 tests/cli/trace.test.ts 同款 tsx 定位（worktree node_modules 为空）。 */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续向上
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();

interface SpawnedCli {
  child: ChildProcess;
  exited: Promise<{ code: number | null; output: string }>;
}

function spawnTrace(cwd: string, args: string[]): SpawnedCli {
  const child = spawn(
    process.execPath,
    [tsxCli, join(repoRoot, "src", "cli.ts"), "trace", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  const exited = new Promise<{ code: number | null; output: string }>(
    (resolve) => {
      // close 而非 exit:stdio flush 完成后再断言,避免并行负载下 output 截断。
      child.on("close", (code) => resolve({ code, output: out + err }));
      child.on("error", () => resolve({ code: null, output: out + err }));
    }
  );
  return { child, exited };
}

/** SIGTERM 后等 close;超时再 SIGKILL。已退出则立刻返回。 */
async function terminateChild(
  child: ChildProcess,
  timeoutMs = 5_000
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// -- parseArgs 侧 --------------------------------------------------------------

describe("parseArgs — --separate flag + 模式端口默认", () => {
  it("默认模式（无 --separate）→ separate=false，port 默认 8787（探测 serve）", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.separate, false);
    assert.equal(parsed.port, 8787);
  });

  it("--separate → separate=true，port 默认 24881（#183 独立进程）", () => {
    const parsed = parseArgs({ argv: ["trace", "--separate"] });
    assert.equal(parsed.separate, true);
    assert.equal(parsed.port, 24881);
  });

  it("显式 --port 覆盖模式默认（sentinel 不被 separate 污染）", () => {
    const parsed = parseArgs({
      argv: ["trace", "--separate", "--port", "9999"],
    });
    assert.equal(parsed.port, 9999);
  });

  it("serve 不消费 --separate（trace 专属 flag 不串命令）", () => {
    const serve = parseArgs({ argv: ["serve"] });
    assert.equal(serve.separate, false);
  });
});

// -- 三态行为（真实 CLI 子进程） ---------------------------------------------------

describe("runTrace — ADR-0020 默认探测三态", () => {
  let scratch: string;
  const children: ChildProcess[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const c of children) await terminateChild(c);
    children.length = 0;
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers.length = 0;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("探测成功 → exit 0 + 打印 http://host:port/trace", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-probe-ok-"));
    // 假 serve：health 返回 { ok: true }（session-api health 形态的最小面）。
    const fake = http.createServer((req, res) => {
      if (req.url === "/api/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "iknow-session-api" }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      fake.listen(0, "127.0.0.1", resolve);
    });
    servers.push(fake);
    const addr = fake.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const spawned = spawnTrace(scratch, ["--no-open", "--port", String(port)]);
    children.push(spawned.child);
    const { code, output } = await spawned.exited;
    assert.equal(code, 0, `探测成功应 exit 0，实际输出：${output}`);
    assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}/trace`));
  }, 30_000);

  it("探测失败 → exit 1 + 提示 iknow serve / --separate", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-probe-fail-"));
    // 独占 ephemeral 端口并保持 listen:health 回 404 → probeServeHealth
    // false。不 close-then-reuse,避免并行 fork listen(0) 抢走端口,
    // 把本应 exit 1 的探测变成成功。
    const occupied = http.createServer((_req, res) => {
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      occupied.listen(0, "127.0.0.1", resolve);
    });
    servers.push(occupied);
    const addr = occupied.address();
    const occupiedPort = typeof addr === "object" && addr ? addr.port : 0;

    const spawned = spawnTrace(scratch, [
      "--no-open",
      "--port",
      String(occupiedPort),
    ]);
    children.push(spawned.child);
    const { code, output } = await spawned.exited;
    assert.equal(code, 1, `探测失败应 exit 1，实际输出：${output}`);
    assert.match(output, /iknow serve/);
    assert.match(output, /--separate/);
  }, 30_000);

  it("--separate → 独立进程起 health（port 0 实测）", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-separate-"));
    const spawned = spawnTrace(scratch, [
      "--separate",
      "--no-open",
      "--port",
      "0",
    ]);
    children.push(spawned.child);
    // 等 stderr 打出 URL（startTraceServe 成功后立刻打）。累加 buffer
    // 再 match,避免 URL 跨 chunk 时单片 regex 漏匹配。
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("--separate 未在时限内打出 URL")),
        20_000
      );
      let err = "";
      spawned.child.stderr?.on("data", (d) => {
        err += String(d);
        const m = err.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${m[1]}`);
        }
      });
    });
    const res = await fetch(`${url}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { service: string };
    assert.equal(body.service, "iknow-trace");
  }, 30_000);
});
