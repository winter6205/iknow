/**
 * SC4: the piped chat entry point always records subagent lifecycle events.
 *
 * This intentionally starts the real CLI assembly path. The Anthropic API is
 * a local deterministic stub: the first response requests spawn_subagent and
 * every subsequent response completes the turn.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue up to the workspace root.
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();

/**
 * T5 (ADR-0071 / SC8): 递归搜 dataDir/projects
 * 下任意 slug/convId/subagents 子目录,返回第一个存在的 subagents 目录。
 * cli 测试把 HOME 重定向到 scratch 后, projectDir 含 basename 加 12 位
 * sha1 后缀不可硬编码; walker 形态直接拿真实路径。
 */
function findSubagentsDir(dataDir: string): string | undefined {
  const projectsDir = join(dataDir, "projects");
  if (!existsSync(projectsDir)) return undefined;
  for (const slug of readdirSync(projectsDir)) {
    const slugDir = join(projectsDir, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    for (const convId of readdirSync(slugDir)) {
      const subagents = join(slugDir, convId, "subagents");
      if (existsSync(subagents)) return subagents;
    }
  }
  return undefined;
}
const toolUseResponse = {
  id: "msg_tool_use",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "call_spawn_subagent",
      name: "spawn_subagent",
      input: { task: "return a deterministic handoff" },
    },
  ],
  model: "test-model",
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const finalResponse = {
  id: "msg_final",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "test-model",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

let server: Server | undefined;
let child: ChildProcess | undefined;
let scratch: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child?.once("close", () => resolve()));
  }
  child = undefined;
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("CLI chat pipe — unconditional subagent lifecycle trace", () => {
  it("writes spawn/state_change/stop to trace/subagent.jsonl without traceOut", async () => {
    scratch = mkdtempSync(join(tmpdir(), "iknow-cli-chat-trace-"));
    const home = join(scratch, "home");
    mkdirSync(join(scratch, ".iknow"), { recursive: true });
    writeFileSync(
      join(scratch, ".iknow", "settings.json"),
      JSON.stringify({
        llm: { model: "test-model", apiKey: "sk-test-chat-trace" },
      })
    );

    let requestCount = 0;
    server = createServer((req, res) => {
      // B6 overflow governance (ADR-0043 §3) makes the real CLI assembly call
      // POST /v1/messages/count_tokens before the first turn. The stub must
      // route by path: count_tokens returns a token count, and only /messages
      // requests consume the toolUseResponse/finalResponse rotation — a naive
      // request-count rotation would hand the first turn the final text
      // response and the model would never call spawn_subagent.
      if (req.url?.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      requestCount += 1;
      const body = requestCount === 1 ? toolUseResponse : finalResponse;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", () => resolve())
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const childEnv = {
      ...process.env,
      HOME: home,
      IKNOW_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      IKNOW_LLM_STREAM: "off",
      IKNOW_PERMISSION_MODE: "full_auto",
      IKNOW_LLM_TIMEOUT_MS: "5000",
      IKNOW_LLM_MAX_OUTPUT_TOKENS: "1024",
    };
    delete childEnv.IKNOW_TRACE_OUT;

    child = spawn(
      process.execPath,
      [tsxCli, join(repoRoot, "src", "cli.ts"), "chat"],
      {
        cwd: scratch,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<{ code: number | null; stderr: string }>(
      (resolve) => {
        child?.once("close", (code) => resolve({ code, stderr }));
      }
    );
    child.stdin?.end("please spawn a subagent\n");
    const result = await exited;

    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      requestCount >= 2,
      `the parent and worker should call the stub model (stdout=${stdout}, stderr=${stderr})`
    );
    // T5 (ADR-0071 / SC8 + L2): 子代理 lifecycle /
    // content trace 改走 per-agent 形态 — `<父会话文件夹>/subagents/agent-<taskId>.jsonl`。
    // 本测试把 HOME 重定向到 `<scratch>/home` → dataDir 落到
    // `<scratch>/home/.iknow`, projectDir 落到
    // `<scratch>/home/.iknow/projects/<basename>-<sha1[:12]>/<convId>/subagents/`。
    // 用 readdirSync 找 `agent-*.jsonl` 文件, 不硬编码路径(避免依赖
    // resolveProjectSessionDir 的 `<basename>-<sha1[:12]>` 后缀)。
    const dataDir = join(home, ".iknow");
    const subagentsRoot = findSubagentsDir(dataDir);
    assert.ok(
      subagentsRoot !== undefined,
      `missing subagents/ tree (stdout=${stdout}, stderr=${stderr}, requests=${requestCount})`
    );
    const agentFiles = readdirSync(subagentsRoot!).filter(
      (f) => f.startsWith("agent-") && f.endsWith(".jsonl")
    );
    assert.ok(
      agentFiles.length >= 1,
      `expected at least one agent-*.jsonl, got ${agentFiles.join(",")} in ${subagentsRoot}`
    );
    const records = readFileSync(join(subagentsRoot!, agentFiles[0]!), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { record_type: string });
    const recordTypes = records.map((record) => record.record_type);
    assert.ok(recordTypes.includes("subagent_spawn"), recordTypes.join(", "));
    assert.ok(
      recordTypes.includes("subagent_state_change"),
      recordTypes.join(", ")
    );
    assert.ok(recordTypes.includes("subagent_stop"), recordTypes.join(", "));
  }, 30_000);
});
