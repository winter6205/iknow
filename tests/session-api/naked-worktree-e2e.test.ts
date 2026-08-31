/**
 * T6 (plans/worktree-session-roots.md) — 裸 worktree 端到端。
 *
 * 真 `git worktree add`（走 hub 的 create-task-worktree 工具缝，不 mock
 * provision）+ 真 `__subagent_worker__` 子进程。验收（硬要求 1、3、6）：
 *  1. 树上**不** mkdir `.iknow`、**不**链 `node_modules` —— 操作员什么都不用先建；
 *  2. 改绑后仍读主仓的 `.iknow/rules`、项目 `AGENTS.md`、`.iknow/permissions.toml`，
 *     记忆库仍落主仓 `.iknow/memory`（T3 + T4 在真树上的联合验收）；
 *  3. 真 worker 在裸树上不 fatal，且它注入的说明书来自主仓（T5 + T3）；
 *  4. 一次 mutate 只落在树上，主仓零写入；同回合旧根 mutate 仍被拦。
 *
 * LLM 是本机 stub HTTP 服务（形态照 tests/cli/chat-subagent-trace.test.ts）——
 * 本票测的是根的走向，不是模型。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type {
  LoopEngineDeps,
  ToolExecutionResult,
} from "../../src/harness/index.ts";
import { resolveProjectMemoryDir } from "../../src/harness/memory/paths.ts";
import { resolveSubagentWorkerSpawnArgs } from "../../src/harness/subagent/spawn.ts";
import { resolveInstallRoot } from "../../src/harness/session-roots.ts";
import {
  PRODUCT_ROOT_ENV_KEY,
  WORKSPACE_ROOT_ENV_KEY,
} from "../../src/config/workspace-root.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntry = join(repoRoot, "src", "cli.ts");

const roots: string[] = [];
let baseDir: string;
let store: SessionStore;
let settingsSource: ReturnType<typeof installTestSettingsSource>;
let server: Server | undefined;
let child: ChildProcess | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** 主仓：真 git 仓 + `.iknow/` gitignore（生产形态）+ 项目身份三件套。 */
function makeMainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-t6-main-"));
  roots.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".iknow/\n", "utf8");
  writeFileSync(join(dir, "AGENTS.md"), "T6_MAIN_AGENTS_MARKER\n", "utf8");
  mkdirSync(join(dir, ".iknow", "rules"), { recursive: true });
  writeFileSync(
    join(dir, ".iknow", "rules", "house.md"),
    "T6_MAIN_RULE_MARKER\n",
    "utf8"
  );
  writeFileSync(
    join(dir, ".iknow", "permissions.toml"),
    "# T6 main-repo project permissions\n",
    "utf8"
  );
  git(dir, "add", ".gitignore", "AGENTS.md");
  git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-qm",
    "init"
  );
  return dir;
}

async function setSettingsIsolation(enabled: boolean): Promise<void> {
  const settingsPath = join(settingsSource.home, ".iknow", "settings.json");
  const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
  raw["isolation"] = { worktreeOnMutate: enabled };
  await writeFile(settingsPath, JSON.stringify(raw), "utf8");
}

function ensure(hub: SessionHub, root: string): Promise<LoopEngineDeps> {
  return (
    hub as unknown as {
      ensureDeps: (root?: string) => Promise<LoopEngineDeps>;
    }
  ).ensureDeps.bind(hub)(root);
}

async function exec(
  deps: LoopEngineDeps,
  conversationId: string,
  call: { id: string; name: string; input: unknown }
): Promise<ToolExecutionResult> {
  const [result] = await deps.executor.executeAll(
    [call],
    undefined,
    undefined,
    conversationId
  );
  return result;
}

const writeCall = {
  id: "t6-mutate-1",
  name: "write_file",
  input: { path: "hello.txt", content: "only the tree may receive this" },
};

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "iknow-t6-store-"));
  roots.push(baseDir);
  store = new SessionStore(baseDir);
  settingsSource = installTestSettingsSource();
  await setSettingsIsolation(true);
});

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child?.once("close", () => resolve()));
  }
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  settingsSource.restore();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("T6 — naked task worktree end-to-end (real git, real worker)", () => {
  it("identity from the main repo, writes on the tree, worker alive — with nothing pre-created on the tree", async () => {
    const repo = makeMainRepo();
    const hub = new SessionHub({ store, askUser: createNoAskUser() });
    await hub.bindWorkspace(repo);
    const { session } = await hub.createSession();
    const conversationId = session.conversation_id;

    // ── 1. 门禁拦第一次写，模型调工具建真树 ────────────────────────────────
    const deps = await ensure(hub, repo);
    const blocked = await exec(deps, conversationId, writeCall);
    expect(blocked.kind).toBe("execution_failed");
    expect(blocked.message).toContain("create-task-worktree ACI tool");
    const created = await exec(deps, conversationId, {
      id: "t6-tool-1",
      name: "create-task-worktree",
      input: {},
    });
    expect(created.kind).toBe("ok");
    const taskRoot = join(repo, ".iknow", "worktrees", conversationId);
    expect(git(repo, "worktree", "list")).toContain(taskRoot);

    // ── 2. 树是裸的：没有 .iknow，没有 node_modules ─────────────────────────
    const onTree = readdirSync(taskRoot);
    expect(onTree).not.toContain(".iknow");
    expect(onTree).not.toContain("node_modules");
    // 主仓的 checkout 内容照常在树上（git 自己放的），身份文件不是被拷进来的
    expect(existsSync(join(taskRoot, ".git"))).toBe(true);

    // ── 3. 同回合旧根仍被拦 ───────────────────────────────────────────────
    const sameTurn = await exec(deps, conversationId, writeCall);
    expect(sameTurn.kind).toBe("execution_failed");
    expect(sameTurn.message).toContain("[worktree_isolation]");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);

    // ── 4. 改绑后的引擎：身份读主仓，写落树上 ──────────────────────────────
    const reboundDeps = await ensure(hub, taskRoot);

    const prompt = (await reboundDeps.system?.()) ?? "";
    // AGENTS.md 是 git 管的文件，树上有同名副本 —— 单看 marker 分不出读的是
    // 哪一份，所以身份证据用 gitignored 的 `.iknow` 内容：rules 索引里的绝对
    // 路径必须指进主仓（树上没有 `.iknow/rules`，缺目录视为空 → 段会缺席）。
    expect(prompt).toContain("T6_MAIN_AGENTS_MARKER");
    expect(prompt).toContain(join(repo, ".iknow", "rules", "house.md"));
    expect(prompt).not.toContain(join(taskRoot, ".iknow"));

    // permissions.toml：主仓的项目文件可只读，树上根本没有这个文件
    const readFileTool = reboundDeps.registry.get("read_file");
    expect(readFileTool).toBeDefined();
    const ctx = { signal: new AbortController().signal };
    await expect(
      readFileTool!.handler(
        { path: join(repo, ".iknow", "permissions.toml") },
        ctx
      )
    ).resolves.toBeDefined();
    expect(existsSync(join(taskRoot, ".iknow", "permissions.toml"))).toBe(
      false
    );

    // 记忆库仍落主仓（T4）——真存一条，看它落哪儿
    const memorySave = reboundDeps.registry.get("memory_save");
    expect(memorySave).toBeDefined();
    await memorySave!.handler(
      {
        title: "t6 memory anchor",
        body: "written from the task worktree",
        type: "fact",
      },
      ctx
    );
    const mainMemoryDir = resolveProjectMemoryDir(repo, repo);
    expect(existsSync(mainMemoryDir)).toBe(true);
    expect(readdirSync(mainMemoryDir).length).toBeGreaterThan(0);
    expect(existsSync(join(taskRoot, ".iknow", "memory"))).toBe(false);

    // 写落树上，主仓零写入
    const landed = await exec(reboundDeps, conversationId, writeCall);
    expect(landed.kind).toBe("ok");
    expect(existsSync(join(taskRoot, "hello.txt"))).toBe(true);
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");

    // ── 5. 真 worker 起在裸树上，注入的说明书来自主仓 ──────────────────────
    const systemPrompts: string[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { system?: unknown };
          systemPrompts.push(
            typeof parsed.system === "string"
              ? parsed.system
              : JSON.stringify(parsed.system ?? "")
          );
        } catch {
          systemPrompts.push("");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_final",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "worker ok on the naked tree" }],
            model: "test-model",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        );
      });
    });
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", () => resolve())
    );
    const address = server.address();
    expect(address && typeof address === "object").toBe(true);
    const port = (address as { port: number }).port;

    child = spawn(
      process.execPath,
      resolveSubagentWorkerSpawnArgs({
        execPath: process.execPath,
        argv1: cliEntry,
        installRoot: resolveInstallRoot(),
      }),
      {
        // 生产改绑后的形态：worker cwd = 树，身份根 = 主仓。
        cwd: taskRoot,
        env: {
          ...process.env,
          HOME: settingsSource.home,
          [PRODUCT_ROOT_ENV_KEY]: repo,
          [WORKSPACE_ROOT_ENV_KEY]: taskRoot,
          IKNOW_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
          IKNOW_LLM_STREAM: "off",
          IKNOW_LLM_TIMEOUT_MS: "10000",
          IKNOW_LLM_MAX_OUTPUT_TOKENS: "1024",
          IKNOW_PERMISSION_MODE: "full_auto",
        },
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
    const exited = new Promise<number | null>((resolve) => {
      child?.once("close", (code) => resolve(code));
    });
    // worker 协议：stdin 一行信封 → stdout 一行结果。
    child.stdin?.end(
      `${JSON.stringify({ task: "say hi from the naked tree", sandboxRoot: taskRoot })}\n`
    );
    const exitCode = await exited;

    expect(stderr).not.toContain("[subagent-worker] fatal");
    expect(stderr).not.toContain("scandir");
    expect(stderr).not.toContain("Cannot find package");
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.trim().split("\n").pop()!) as {
      status: string;
    };
    expect(envelope.status).toBe("ok");

    // worker 注入的说明书是主仓上已存在的那份，不是树上的空拷贝
    expect(systemPrompts.length).toBeGreaterThan(0);
    const workerSystem = systemPrompts.join("\n");
    expect(workerSystem).toContain("T6_MAIN_AGENTS_MARKER");
    expect(workerSystem).toContain("T6_MAIN_RULE_MARKER");

    // 全程主仓零写入（worker 也没往主仓写）
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, 120_000);
});
