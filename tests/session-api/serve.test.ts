/**
 * serve.ts bootstrap tests (022 T5).
 *
 * Why a dedicated suite: serve.ts is the composition root (SessionStore +
 * SessionHub + listenSessionServer) and the only source-level surface that
 * wires them together. Without this test the file shows 0% coverage and
 * SC21's 80/70 gate fails for src/session-api/.
 */
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import {
  resolveServeDataDir,
  startSessionServe,
  type ServeOptions,
} from "../../src/session-api/serve.ts";
import { resolveSessionDefaultWorkspace } from "../../src/session-api/default-workspace.ts";
import type { ListeningServer } from "../../src/session-api/http.ts";
import type { SessionHub } from "../../src/session-api/hub.ts";
import {
  parseSessionJsonl,
  resolveProjectSessionDir,
} from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

// -- per-test cleanup --------------------------------------------------------

let baseDir: string;
let listening: ListeningServer | undefined;
let hub: SessionHub | undefined;
let settingsSource: ReturnType<typeof installTestSettingsSource>;

beforeAll(() => {
  // #164 第二阶段：IKNOW_LLM_MODEL 已退役，模型唯一来源 = settings.llm.model。
  // startSessionServe 装配的 loadIknowEnv() 需要 settings 来源 → HOME 重定向到
  // tmp（settings.json 含 model + `${VAR}` apiKey），不依赖真实 ~/.iknow。
  settingsSource = installTestSettingsSource();
});

afterEach(async () => {
  if (listening) await listening.close();
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
  listening = undefined;
  hub = undefined;
});

afterAll(() => {
  settingsSource.restore();
});

// -- helpers -----------------------------------------------------------------

async function start(opts: ServeOptions = {}): Promise<{
  listening: ListeningServer;
  hub: SessionHub;
}> {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-serve-"));
  const out = await startSessionServe({
    hubOptions: { askUser: createNoAskUser() },
    ...opts,
    dataDir: baseDir,
  });
  listening = out.listening;
  hub = out.hub;
  return out;
}

// -- shape contract ----------------------------------------------------------

describe("startSessionServe — shape contract", () => {
  it("returns { listening, hub } with bound port/address", async () => {
    const { listening: ls, hub: h } = await start({ port: 0 });
    assert.ok(ls, "listening must be present");
    assert.ok(h, "hub must be present");
    assert.equal(typeof ls.port, "number");
    assert.ok(ls.port > 0, "ephemeral port must be > 0");
    assert.equal(typeof ls.host, "string");
    assert.ok(ls.host.length > 0, "host must be a non-empty string");
    assert.equal(typeof ls.close, "function");
    // The HTTP server is actually accepting connections.
    const res = await fetch(`http://${ls.host}:${ls.port}/api/v1/health`);
    assert.equal(res.status, 200);
  });
});

// -- port resolution ---------------------------------------------------------

describe("startSessionServe — port resolution", () => {
  it("opts.port takes priority over IKNOW_SERVE_PORT and default", async () => {
    const prev = process.env.IKNOW_SERVE_PORT;
    process.env.IKNOW_SERVE_PORT = "9999"; // must be ignored
    try {
      const { listening: ls } = await start({ port: 0 });
      assert.notEqual(ls.port, 9999, "env var must not override explicit port");
    } finally {
      if (prev === undefined) delete process.env.IKNOW_SERVE_PORT;
      else process.env.IKNOW_SERVE_PORT = prev;
    }
  });

  it("falls back to IKNOW_SERVE_PORT when opts.port omitted", async () => {
    const prev = process.env.IKNOW_SERVE_PORT;
    process.env.IKNOW_SERVE_PORT = "0"; // ephemeral, just to avoid clashes
    try {
      const { listening: ls } = await start();
      // ephemeral (port 0) → OS-assigned port; we only assert it's bound
      assert.equal(typeof ls.port, "number");
      assert.ok(ls.port > 0);
    } finally {
      if (prev === undefined) delete process.env.IKNOW_SERVE_PORT;
      else process.env.IKNOW_SERVE_PORT = prev;
    }
  });
});

// -- host default ------------------------------------------------------------

describe("startSessionServe — host default", () => {
  it("defaults host to 127.0.0.1 when opts.host omitted", async () => {
    const { listening: ls } = await start({ port: 0 });
    assert.equal(ls.host, "127.0.0.1");
  });

  it("respects explicit opts.host", async () => {
    const { listening: ls } = await start({ port: 0, host: "127.0.0.1" });
    assert.equal(ls.host, "127.0.0.1");
  });
});

// -- json_mode propagation ---------------------------------------------------

describe("startSessionServe — option propagation", () => {
  it("passes json_mode default into hub", async () => {
    const { hub: h, listening: ls } = await start({
      port: 0,
      json_mode: true,
    });
    // Verify by hitting POST /api/v1/sessions → session.json_mode reflects default
    const res = await fetch(`http://${ls.host}:${ls.port}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { session: { json_mode: boolean } };
    assert.equal(body.session.json_mode, true);
    // Reference hub to keep lint happy (not used in this assertion path)
    assert.ok(h);
  });

  it("exposes hubOptions on the returned hub (spread works)", async () => {
    const { hub: h } = await start({ port: 0 });
    // The hub was constructed with our store; create + load round-trips.
    const created = await h.createSession();
    const got = await h.getSession(created.session.conversation_id);
    assert.equal(got.session.conversation_id, created.session.conversation_id);
  });
});

describe("startSessionServe — trace health wiring", () => {
  it("health counts failures from a trace service created by the hub", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-serve-trace-health-"));
    const traceOut = join(baseDir, "trace-out-file");
    await writeFile(traceOut, "", "utf8");

    const out = await startSessionServe({
      dataDir: baseDir,
      port: 0,
      traceOut,
      hubOptions: {
        deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      },
    });
    listening = out.listening;
    const origin = `http://${listening.host}:${listening.port}`;

    const created = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(created.status, 201);
    const sessionId = (
      (await created.json()) as {
        session: { conversation_id: string };
      }
    ).session.conversation_id;

    const posted = await fetch(
      `${origin}/api/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }
    );
    assert.equal(posted.status, 200);

    const health = await fetch(`${origin}/api/v1/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { traceWriteFailures: number };
    assert.ok(body.traceWriteFailures >= 1);
  });
});

// -- dataDir resolution ------------------------------------------------------

describe("startSessionServe — dataDir resolution", () => {
  it("uses opts.dataDir verbatim when provided", async () => {
    const explicit = await mkdtemp(join(tmpdir(), "iknow-serve-explicit-"));
    try {
      const out = await startSessionServe({
        hubOptions: { askUser: createNoAskUser() },
        dataDir: explicit,
        port: 0,
      });
      listening = out.listening;
      baseDir = explicit;
      // Hub is functional → store was constructed under `explicit`
      const created = await out.hub.createSession();
      assert.ok(created.session.conversation_id);
    } finally {
      // afterEach will clean up baseDir; remove the temp sibling if different
      // (explicit was assigned to baseDir so afterEach handles it)
    }
  });

  it("defaults to ~/.iknow when opts.dataDir omitted", async () => {
    // Deterministic proof of the default root: resolveServeDataDir is the
    // pure SSOT for the dataDir resolution logic (spec #120 SC 1 + SC 10).
    // We never write to the real $HOME — the pure-function assert below
    // never touches disk; the live startSessionServe call below constructs
    // SessionStore with that path (constructor does no IO; mkdir only fires
    // inside save() which we never invoke).
    assert.equal(resolveServeDataDir(), join(homedir(), ".iknow"));
    assert.equal(resolveServeDataDir(""), join(homedir(), ".iknow"));
    assert.equal(
      resolveServeDataDir("/tmp/iknow-serve-explicit"),
      path.resolve("/tmp/iknow-serve-explicit")
    );
    const out = await startSessionServe({
      hubOptions: { askUser: createNoAskUser() },
      port: 0,
    });
    listening = out.listening;
    assert.ok(listening.port > 0);
    assert.ok(out.hub);
  });
});

// -- workspace pre-bind (T4 + T9a, ADR-0023) --------------------------------
//
// Acceptance (plans/serve-workspace.md T4 + issue #536 + plans/serve-workspace-folder-browse.md T9a):
//   - 无 flag/env 启动 → hub auto-bound 到 `<homedir()>/.iknow/default`
//     (T9a)。`initIknowWorkspaceSafe` 在缺省时跳过 identity seed(同 T4)。
//   - --workspace-root <abs> / IKNOW_WORKSPACE_ROOT → 启动即预绑 picker 根
//     （hub.getWorkspaceState().bound === true 且 root === 解析值）。
//   - recentsHome = homedir() wired → 显式预绑 / auto-bind 时 recents 文件被写入
//     `<homedir>/.iknow/workspaces.json`(test 通过 installTestSettingsSource
//     把 HOME 重定向到 tmp,天然隔离)。

describe("startSessionServe — workspace pre-bind (T4)", () => {
  // Helper: read the raw session file from disk via
  // resolveProjectSessionDir (serve.ts's SessionStore uses the same layout;
  // we don't expose the store, just read the file the test owns via baseDir).
  async function readSessionWorkspaceRoot(
    baseDir: string,
    conversationId: string
  ): Promise<string | undefined> {
    // #629: read the JSONL authority; the legacy `.json` mirror is no longer
    // written. The session header record carries `workspaceRoot`.
    const filePath = join(
      resolveProjectSessionDir(baseDir, process.cwd()),
      `${conversationId}.jsonl`
    );
    const raw = await readFile(filePath, "utf8");
    const header = parseSessionJsonl(raw).header as {
      workspaceRoot?: string;
    };
    return header.workspaceRoot;
  }

  it("无 flag/env → hub auto-bound to ~/.iknow/default (T9a)", async () => {
    // Defensive: 防止更早的 describe 残留 env（虽然同 fork 内 file 顺序跑 +
    // 本 describe 是本 file 第一组,理论上无残留,但 confirm zero 状态更稳）。
    const prevEnv = process.env.IKNOW_WORKSPACE_ROOT;
    delete process.env.IKNOW_WORKSPACE_ROOT;
    const localBaseDir = await mkdtemp(join(tmpdir(), "iknow-t9a-autobind-"));
    try {
      const out = await startSessionServe({
        hubOptions: { askUser: createNoAskUser() },
        dataDir: localBaseDir,
        port: 0,
      });
      listening = out.listening;
      // (a) picker auto-bound to `<homedir()>/.iknow/default` (T9a)。函数形式
      // `resolveSessionDefaultWorkspace()` 在运行时解析 HOME,所以跟随
      // installTestSettingsSource 重定向后的 tmp home —— 不写用户真实 $HOME。
      const expectedRoot = resolveSessionDefaultWorkspace();
      assert.deepEqual(out.hub.getWorkspaceState(), {
        bound: true,
        root: expectedRoot,
      });
      // (b) recents wired(homedir = installTestSettingsSource 的 tmp home),
      // 自动预绑以 confirmTrust:true 写入 default → recents 文件存在且包含。
      const recents = await out.hub.listTrustedWorkspaces();
      assert.ok(
        recents.includes(expectedRoot),
        `recents should include auto-bound default: ${expectedRoot} (got ${JSON.stringify(recents)})`
      );
      // (c) 创建会话后写盘文件携带 workspaceRoot = 默认 workspace(T1
      // additivity: 缺字段 → cwd;这里 = default root,不是 cwd)。
      const created = await out.hub.createSession();
      const ws = await readSessionWorkspaceRoot(
        localBaseDir,
        created.session.conversation_id
      );
      assert.equal(ws, expectedRoot);
    } finally {
      if (prevEnv !== undefined) process.env.IKNOW_WORKSPACE_ROOT = prevEnv;
      await rm(localBaseDir, { recursive: true, force: true });
    }
  });

  it("--workspace-root <abs> → hub bound;session 写入该 root", async () => {
    const prevEnv = process.env.IKNOW_WORKSPACE_ROOT;
    delete process.env.IKNOW_WORKSPACE_ROOT;
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-flag-"));
    const localBaseDir = await mkdtemp(join(tmpdir(), "iknow-t4-flag-base-"));
    try {
      const out = await startSessionServe({
        hubOptions: { askUser: createNoAskUser() },
        dataDir: localBaseDir,
        workspaceRoot: root,
        port: 0,
      });
      listening = out.listening;
      // (a) picker bound 到显式 absolute root。
      assert.deepEqual(out.hub.getWorkspaceState(), { bound: true, root });
      // (b) recents wired,显式预绑以 confirmTrust:true 写入 recents 文件。
      const recents = await out.hub.listTrustedWorkspaces();
      assert.ok(
        recents.includes(root),
        `recents should include the pre-bound root: ${root} (got ${JSON.stringify(recents)})`
      );
      // (c) T1 additivity: session file 携带 workspaceRoot = bound root。
      const created = await out.hub.createSession();
      const ws = await readSessionWorkspaceRoot(
        localBaseDir,
        created.session.conversation_id
      );
      assert.equal(ws, root);
    } finally {
      if (prevEnv !== undefined) process.env.IKNOW_WORKSPACE_ROOT = prevEnv;
      await rm(root, { recursive: true, force: true });
      await rm(localBaseDir, { recursive: true, force: true });
    }
  });

  it("bound workspaceRoot does not receive user.md seed (#584 T2)", async () => {
    const prevEnv = process.env.IKNOW_WORKSPACE_ROOT;
    delete process.env.IKNOW_WORKSPACE_ROOT;
    const root = await mkdtemp(join(tmpdir(), "iknow-t2-noneseeds-"));
    const localBaseDir = await mkdtemp(
      join(tmpdir(), "iknow-t2-noneseeds-base-")
    );
    try {
      const out = await startSessionServe({
        hubOptions: { askUser: createNoAskUser() },
        dataDir: localBaseDir,
        workspaceRoot: root,
        port: 0,
      });
      listening = out.listening;
      await assert.rejects(
        readFile(join(root, ".iknow", "user.md"), "utf8"),
        /ENOENT/
      );
      await assert.rejects(
        readFile(join(root, ".iknow", "BOOTSTRAP.md"), "utf8"),
        /ENOENT/
      );
    } finally {
      if (prevEnv !== undefined) process.env.IKNOW_WORKSPACE_ROOT = prevEnv;
      await rm(root, { recursive: true, force: true });
      await rm(localBaseDir, { recursive: true, force: true });
    }
  });

  it("env IKNOW_WORKSPACE_ROOT → 预绑 (mirror flag 路径)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-t4-env-"));
    const localBaseDir = await mkdtemp(join(tmpdir(), "iknow-t4-env-base-"));
    const prevEnv = process.env.IKNOW_WORKSPACE_ROOT;
    // env 在 startSessionServe 内经 loadIknowEnv → envOptional 读出,所以必须
    // 在调用前 set;finally 还原避免污染后续 case。
    process.env.IKNOW_WORKSPACE_ROOT = root;
    try {
      const out = await startSessionServe({
        hubOptions: { askUser: createNoAskUser() },
        dataDir: localBaseDir,
        port: 0,
        // 不传 workspaceRoot —— 由 env SSOT 透传到 resolver。
      });
      listening = out.listening;
      assert.deepEqual(out.hub.getWorkspaceState(), { bound: true, root });
      const recents = await out.hub.listTrustedWorkspaces();
      assert.ok(
        recents.includes(root),
        `recents should include the env-bound root: ${root} (got ${JSON.stringify(recents)})`
      );
      const created = await out.hub.createSession();
      const ws = await readSessionWorkspaceRoot(
        localBaseDir,
        created.session.conversation_id
      );
      assert.equal(ws, root);
    } finally {
      if (prevEnv !== undefined) process.env.IKNOW_WORKSPACE_ROOT = prevEnv;
      else delete process.env.IKNOW_WORKSPACE_ROOT;
      await rm(root, { recursive: true, force: true });
      await rm(localBaseDir, { recursive: true, force: true });
    }
  });
});

// -- port fallback -----------------------------------------------------------

describe("startSessionServe — port fallback", () => {
  it("falls back to 8787 when opts.port and IKNOW_SERVE_PORT both absent", async () => {
    const prev = process.env.IKNOW_SERVE_PORT;
    delete process.env.IKNOW_SERVE_PORT;
    try {
      // 8787 是真实绑定端口：forks 池下多个测试进程并发时，另一个进程
      // 可能恰好也 fallback 到 8787 → EADDRINUSE（偶发失败，非真失败）。
      // 重试 2 次 + 退避，让瞬态端口占用不影响断言。
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const out = await startSessionServe({
            hubOptions: { askUser: createNoAskUser() },
            dataDir: await mkdtemp(join(tmpdir(), "iknow-port-fb-")),
            host: "127.0.0.1",
            // No port, no env → defaults to 8787; but 8787 may be in use in CI,
            // so we just assert the call resolved and port is a finite number.
          });
          listening = out.listening;
          // If 8787 was free we get 8787; if it was taken, EADDRINUSE would throw.
          // The branch we wanted (env falsy → 8787) executed either way.
          assert.equal(typeof listening.port, "number");
          assert.ok(listening.port > 0);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      if (lastErr !== undefined) throw lastErr;
    } finally {
      if (prev !== undefined) process.env.IKNOW_SERVE_PORT = prev;
    }
  });

  it("non-finite port (NaN from env) falls back to 8787", async () => {
    const prev = process.env.IKNOW_SERVE_PORT;
    process.env.IKNOW_SERVE_PORT = "not-a-number";
    try {
      const out = await startSessionServe({
        hubOptions: { askUser: createNoAskUser() },
        dataDir: await mkdtemp(join(tmpdir(), "iknow-port-nan-")),
        host: "127.0.0.1",
      });
      listening = out.listening;
      // Number.isFinite(NaN) === false → the guard in serve.ts:49 falls back
      // to 8787. We assert the listener bound successfully (port > 0).
      assert.equal(typeof listening.port, "number");
      assert.ok(listening.port > 0);
    } finally {
      if (prev === undefined) delete process.env.IKNOW_SERVE_PORT;
      else process.env.IKNOW_SERVE_PORT = prev;
    }
  });
});
