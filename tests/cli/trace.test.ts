/**
 * `iknow trace` CLI tests (spec #183 R2 + v2 T7).
 *
 * Covers:
 *   - parseArgs recognizes the `trace` positional
 *   - flag parsing: --trace-out / --port / --host / --max-bytes / --no-open
 *   - defaults: port 24881, host 127.0.0.1, noOpen=false
 *   - bad --port throws a parse error
 *   - integration: startTraceServe from parsed opts → /api/v1/health live
 *   - T7: runTrace 默认 ./trace/ 目录 + 旧 ./trace.jsonl fail-fast + serve 与 trace 分开
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../src/cli/parse-args.ts";
import {
  startTraceServe,
  type TraceListeningServer,
} from "../../src/traceserver/serve.ts";

// 仓库根（cli.ts 有 main().catch 副作用，不能 import，只能子进程跑真实 CLI）。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 解析 tsx 运行时入口：worktree 的 node_modules 是空的（依赖从主仓库提升），
 * 从测试文件所在目录逐级向上找第一个含 node_modules/tsx/dist/cli.mjs 的目录。
 * npx 能解析到但测试要显式可复现，故手动定位。
 */
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

let listening: TraceListeningServer | undefined;

afterEach(async () => {
  if (listening) await listening.close();
  listening = undefined;
});

// -- parseArgs: trace subcommand ----------------------------------------------

describe("parseArgs — `trace` subcommand", () => {
  it("parses trace --port 9999 --trace-out X.jsonl", () => {
    const parsed = parseArgs({
      argv: ["trace", "--port", "9999", "--trace-out", "X.jsonl"],
    });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.port, 9999);
    assert.equal(parsed.traceOut, "X.jsonl");
    assert.equal(parsed.host, "127.0.0.1");
  });

  it("defaults port to 24881 when --port omitted", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.port, 24881);
  });

  // Sentinel regression: `iknow trace --port 8787` must honor the explicit
  // value, NOT be silently bumped to the default 24881 (which would collide
  // with serve's 8787 only by user-supplied coincidence).
  it("honors explicit --port 8787 instead of using default 24881", () => {
    const parsed = parseArgs({ argv: ["trace", "--port", "8787"] });
    assert.equal(parsed.port, 8787);
  });

  it("defaults host to 127.0.0.1 when --host omitted", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.host, "127.0.0.1");
  });

  it("parses --host", () => {
    const parsed = parseArgs({
      argv: ["trace", "--host", "0.0.0.0"],
    });
    assert.equal(parsed.host, "0.0.0.0");
  });

  it("parses --max-bytes as an integer", () => {
    const parsed = parseArgs({
      argv: ["trace", "--max-bytes", "1048576"],
    });
    assert.equal(parsed.command, "trace");
    const maxBytes = (parsed as unknown as { maxBytes?: number }).maxBytes;
    assert.equal(maxBytes, 1048576);
  });

  // T7 SC-C 19: --no-open 布尔 flag → ParsedCli.noOpen=true。
  it("parses --no-open → noOpen=true", () => {
    const parsed = parseArgs({
      argv: ["trace", "--no-open"],
    });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.noOpen, true);
  });

  it("noOpen defaults to false (auto-open default)", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.noOpen, false);
  });

  it("--no-open coexists with --port / --trace-out (no cross-flag contamination)", () => {
    const parsed = parseArgs({
      argv: ["trace", "--no-open", "--port", "9999", "--trace-out", "/tmp/t"],
    });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.noOpen, true);
    assert.equal(parsed.port, 9999);
    assert.equal(parsed.traceOut, "/tmp/t");
  });

  it("throws on bad --port", () => {
    assert.throws(
      () => parseArgs({ argv: ["trace", "--port", "abc"] }),
      /--port/
    );
  });
});

// -- integration: parsed opts → live server ----------------------------------

describe("iknow trace — integration", () => {
  it("parsed opts can drive startTraceServe and /api/v1/health returns iknow-trace", async () => {
    const parsed = parseArgs({
      argv: ["trace", "--port", "0"],
    });
    assert.equal(parsed.command, "trace");
    listening = await startTraceServe({
      host: parsed.host,
      port: parsed.port,
    });
    const res = await fetch(
      `http://${listening.host}:${listening.port}/api/v1/health`
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; service: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "iknow-trace");
  });

  // CLI-layer 404 contract: omitting --trace-out leaves traceOut undefined,
  // which startTraceServe surfaces as 404 not_found (no default-path fallback
  // on the reader side - env/default is write-side only).
  it("omitting --trace-out yields 404 not_found on /api/v1/traces", async () => {
    const parsed = parseArgs({ argv: ["trace", "--port", "0"] });
    assert.equal(parsed.traceOut, undefined);
    listening = await startTraceServe({
      traceOut: parsed.traceOut,
      host: parsed.host,
      port: parsed.port,
    });
    const res = await fetch(
      `http://${listening.host}:${listening.port}/api/v1/traces`
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as {
      error: { kind: string; message: string };
    };
    assert.equal(body.error.kind, "not_found");
  });
});

// -- T7: runTrace 真实 CLI（子进程） -------------------------------------------
//
// cli.ts 顶层 `main().catch` 是副作用，无法 import 单测；这里用子进程跑真实
// CLI 验证 T7 行为。每个用例在临时 CWD 里启动，避免污染仓库根的 ./trace*。
// tsx 入口经 node_modules/tsx/dist/cli.mjs（worktree node_modules 为空但
// npx 能解析到根仓库的 tsx；测试显式给绝对路径以保证可复现）。

interface SpawnedTrace {
  child: ChildProcess;
  /** 解析后给出 trace CLI 打到 stderr 的 URL（含端口）。 */
  url: Promise<string>;
  /** 进程自行退出（fail-fast / 报错）时 resolve { code, output }。 */
  exited: Promise<{ code: number | null; output: string }>;
}

/** 起 `iknow trace` 子进程，返回 URL / exited 两个信号 + child 句柄。 */
function spawnTraceCli(cwd: string, args: string[]): SpawnedTrace {
  const child = spawn(
    process.execPath,
    [tsxCli, join(repoRoot, "src", "cli.ts"), "trace", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));

  const urlPromise = new Promise<string>((resolveUrl, rejectUrl) => {
    const check = () => {
      const m = err.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        resolveUrl(`http://127.0.0.1:${m[1]}/`);
        return true;
      }
      return false;
    };
    child.stderr.on("data", check);
    child.on("error", rejectUrl);
  });

  const exited = new Promise<{ code: number | null; output: string }>(
    (resolveExit) => {
      child.on("exit", (code) => resolveExit({ code, output: out + err }));
      child.on("error", () => resolveExit({ code: null, output: out + err }));
    }
  );

  return { child, url: urlPromise, exited };
}

describe("runTrace — T7 默认目录 / fail-fast / serve 分开", () => {
  let scratch: string;
  let spawned: SpawnedTrace | undefined;
  afterEach(() => {
    if (spawned) spawned.child.kill();
    spawned = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("默认读 ./trace/ 目录（无需 --trace-out），/api/v1/sessions 服务该目录", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t7-default-"));
    // 预置 ./trace/<convId>.jsonl（每会话独立文件语义）。
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
    spawned = spawnTraceCli(scratch, ["--no-open", "--port", "0"]);
    const url = await Promise.race([
      spawned.url,
      spawned.exited.then((e) => {
        throw new Error(`trace exited early (code ${e.code}):\n${e.output}`);
      }),
    ]);
    const sessions = await fetch(`${url}api/v1/sessions`);
    assert.equal(sessions.status, 200);
    const body = (await sessions.json()) as {
      sessions: Array<{ conversation_id: string }>;
    };
    assert.ok(
      body.sessions.some((s) => s.conversation_id === "c7"),
      "默认 ./trace/ 目录下 c7 会话应被列出"
    );
  });

  it("旧 ./trace.jsonl 存在 → fail-fast exit 1 + 提示迁移（不静默当目录）", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t7-legacy-"));
    writeFileSync(
      join(scratch, "trace.jsonl"),
      '{"conversation_id":"c1","record_type":"turn"}\n',
      "utf8"
    );
    spawned = spawnTraceCli(scratch, []);
    const legacy = await spawned.exited;
    assert.equal(legacy.code, 1, "旧 ./trace.jsonl → fail-fast exit 1");
    assert.match(legacy.output, /迁移|migrate/);
    assert.match(legacy.output, /trace-migrate/);
  });

  it("显式 --trace-out 指向旧单文件（非目录）→ fail-fast 提示迁移", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t7-explicit-"));
    const file = join(scratch, "old.jsonl");
    writeFileSync(file, '{"conversation_id":"c1"}\n', "utf8");
    spawned = spawnTraceCli(scratch, ["--trace-out", file]);
    const explicit = await spawned.exited;
    assert.equal(explicit.code, 1, "显式单文件 --trace-out → fail-fast exit 1");
    assert.match(explicit.output, /迁移|migrate/);
  });

  it("serve 与 trace 分开：serve 解析不连带 trace 读侧字段（SC-C 20/22）", () => {
    // T7 改动是 trace 专属：serve 的 parseArgs 不应被默认 ./trace/ 目录或
    // --no-open 污染 —— traceOut 仍 undefined（serve 只写不读），noOpen 仍
    // false（自动 open 只属于 trace 命令）。
    const serve = parseArgs({ argv: ["serve"] });
    assert.equal(serve.command, "serve");
    assert.equal(
      serve.traceOut,
      undefined,
      "serve 不因 T7 获得默认 trace 读目录"
    );
    assert.equal(serve.noOpen, false, "no-open 是 trace 专属 flag，serve 不设");
    // serve 显式传 --trace-out 仍只表达写路径（test 不校验行为，仅示切换）。
    const serveWithTrace = parseArgs({
      argv: ["serve", "--trace-out", "/tmp/t"],
    });
    assert.equal(serveWithTrace.traceOut, "/tmp/t");
  });
});
