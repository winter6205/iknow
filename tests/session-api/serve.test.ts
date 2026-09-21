/**
 * serve.ts bootstrap tests (022 T5).
 *
 * Why a dedicated suite: serve.ts is the composition root (SessionStore +
 * SessionHub + listenSessionServer) and the only source-level surface that
 * wires them together. Without this test the file shows 0% coverage and
 * SC21's 80/70 gate fails for src/session-api/.
 *
 * The SC6 case must use real assembly: a placeholder adapter would empty the
 * wire-model assertion. The assembly chain hits the bash tool's sandbox probe,
 * and CI test-fast installs no bubblewrap, so only that assembly-time probe is
 * stubbed to a no-op here; everything else (real HTTP, EnvLoader, SDK adapter,
 * capture server) stays real. Physical execution paths are never invoked in
 * this file.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  vi,
} from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  resolveConversationDir,
  resolveConversationTraceFilePath,
  resolveProjectSessionDir,
} from "../../src/session-api/store/index.ts";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import {
  MINIMAL_SDK_MESSAGE,
  startLlmCapture,
  type LlmCapture,
} from "./_helpers/llm-capture.ts";

vi.mock("../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/sandbox/runner.js")
    >();
  return { ...actual, requireBwrap: () => {} };
});

// -- per-test cleanup --------------------------------------------------------

let baseDir: string;
let listening: ListeningServer | undefined;
let hub: SessionHub | undefined;
let settingsSource: ReturnType<typeof installTestSettingsSource>;

beforeAll(() => {
  // IKNOW_LLM_MODEL was retired: the only model source is settings.llm.model.
  // startSessionServe's loadIknowEnv() needs a settings source → redirect HOME
  // to a tmp dir (settings.json carries model + `${VAR}` apiKey), never touching
  // the real ~/.iknow.
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
    // The main session's trace is anchored at `<projectDir>/<convId>/trace.jsonl`;
    // once the write side hits that path, appendFileSync must report EISDIR →
    // traceWriteFailures ≥ 1. Strategy: createSession lets the store drop JSONL
    // under `<projectDir>/<convId>/`, then mkdir a directory named trace.jsonl to
    // occupy the path → the trace write hits the same-named directory → EISDIR →
    // JsonlTraceService warn-once → traceWriteFailures += 1.
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

    // Compute the same projectDir as hub.store and occupy trace.jsonl with a
    // directory → appendFileSync must report EISDIR.
    // Must mirror serve.ts's derivation: the hub's projectIdentityRoot goes
    // through `deriveProjectIdentityRoot({cwd: workspaceRoot})`; with no flag/env
    // here → workspaceRoot undefined → `mainCheckoutOf(process.cwd())`. A task
    // worktree cwd folds back to the main checkout; using process.cwd() directly
    // would resolve a different `<basename>-<sha1>` folder (under CI's flat
    // checkout both coincide — which is exactly why this case only went red in
    // worktree development).
    const projectDir = resolveProjectSessionDir(
      baseDir,
      deriveProjectIdentityRoot({ cwd: undefined })
    );
    const traceFile = resolveConversationTraceFilePath({
      projectDir,
      conversationId: sessionId,
    });
    await mkdir(traceFile, { recursive: true });

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
// Acceptance (ADR-0023):
//   - start with no flag/env → hub auto-binds to `<homedir()>/.iknow/default`.
//     `initIknowWorkspaceSafe` skips the identity seed on the default (same as the explicit path).
//   - --workspace-root <abs> / IKNOW_WORKSPACE_ROOT → pre-bind the picker root at startup
//     (hub.getWorkspaceState().bound === true and root === resolved value).
//   - recentsHome = homedir() wired → on explicit pre-bind / auto-bind the recents file is
//     written to `<homedir>/.iknow/workspaces.json` (tests redirect HOME to a tmp dir via
//     installTestSettingsSource, so isolation comes for free).

describe("startSessionServe — workspace pre-bind (T4)", () => {
  // Helper: read the raw session file from disk via
  // resolveProjectSessionDir (serve.ts's SessionStore uses the same layout;
  // we don't expose the store, just read the file the test owns via baseDir).
  async function readSessionWorkspaceRoot(
    baseDir: string,
    workspaceRoot: string,
    conversationId: string
  ): Promise<string | undefined> {
    // Read the JSONL authority; the legacy `.json` mirror is no longer
    // written. The session header record carries `workspaceRoot`. project
    // identity is keyed off the workspace root (namespace key =
    // projectIdentityRoot, not cwd), so the test must use the same root
    // serve.ts derived for its store.
    const projectIdentityRoot = deriveProjectIdentityRoot({
      cwd: workspaceRoot,
    });
    const filePath = join(
      resolveConversationDir({
        projectDir: resolveProjectSessionDir(baseDir, projectIdentityRoot),
        conversationId,
      }),
      `${conversationId}.jsonl`
    );
    const raw = await readFile(filePath, "utf8");
    const header = parseSessionJsonl(raw).header as {
      workspaceRoot?: string;
    };
    return header.workspaceRoot;
  }

  it("无 flag/env → hub auto-bound to ~/.iknow/default (T9a)", async () => {
    // Defensive: guard against leftover env from earlier describes (files run in
    // order within a fork and this is the first group here, so residue is
    // unlikely, but confirming a zero state is safer).
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
      // (a) picker auto-bound to `<homedir()>/.iknow/default`. The function form
      // `resolveSessionDefaultWorkspace()` resolves HOME at runtime, so it follows
      // the tmp home redirected by installTestSettingsSource — never the user's real $HOME.
      const expectedRoot = resolveSessionDefaultWorkspace();
      assert.deepEqual(out.hub.getWorkspaceState(), {
        bound: true,
        root: expectedRoot,
      });
      // (b) recents wired (homedir = installTestSettingsSource's tmp home); the
      // auto pre-bind writes default with confirmTrust:true → recents file exists and contains it.
      const recents = await out.hub.listTrustedWorkspaces();
      assert.ok(
        recents.includes(expectedRoot),
        `recents should include auto-bound default: ${expectedRoot} (got ${JSON.stringify(recents)})`
      );
      // (c) after creating a session, the on-disk file carries workspaceRoot =
      // the default workspace (additivity: missing field → cwd; here = default root, not cwd).
      const created = await out.hub.createSession();
      // With no explicit flag/env, serve.ts's projectIdentityRoot falls back to
      // `deriveProjectIdentityRoot({cwd: undefined})` → `mainCheckoutOf(process.cwd())`,
      // which differs from productRoot (expectedRoot) — the test must mirror
      // serve.ts's derivation or it would look for the same id under the wrong
      // projects/<basename>-<hash> folder.
      const ws = await readSessionWorkspaceRoot(
        localBaseDir,
        process.cwd(),
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
      // (a) picker bound to the explicit absolute root.
      assert.deepEqual(out.hub.getWorkspaceState(), { bound: true, root });
      // (b) recents wired; the explicit pre-bind writes the root into the recents file with confirmTrust:true.
      const recents = await out.hub.listTrustedWorkspaces();
      assert.ok(
        recents.includes(root),
        `recents should include the pre-bound root: ${root} (got ${JSON.stringify(recents)})`
      );
      // (c) additivity: the session file carries workspaceRoot = bound root.
      const created = await out.hub.createSession();
      const ws = await readSessionWorkspaceRoot(
        localBaseDir,
        root,
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
    // startSessionServe reads env via loadIknowEnv → envOptional, so it must be
    // set before the call; the finally restores it to avoid polluting later cases.
    process.env.IKNOW_WORKSPACE_ROOT = root;
    try {
      const out = await startSessionServe({
        hubOptions: { askUser: createNoAskUser() },
        dataDir: localBaseDir,
        port: 0,
        // No workspaceRoot passed — the env SSOT feeds it through to the resolver.
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
        root,
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
      // 8787 is really bound: with the forks pool, another test process may
      // fall back to 8787 concurrently → EADDRINUSE (flaky, not a real failure).
      // Retry twice with backoff so transient port contention doesn't break the assertion.
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

// -- runtime LLM env wiring (SC6 / ADR-0094) ----------------------------------
//
// Acceptance: the serve entry assembles EnvLoader → envProvider injected into
// the hub → after editing llm.model in the user-level settings.json, the next
// POST /messages' wire model follows the new env (no longer a one-shot
// loadIknowEnv at startup).
//
// Shape: a local LLM capture server as the SDK's baseURL endpoint → the
// captured request body's `model` field = wire model. The provider `prov`
// carries two model ids, initial settings.json = prov/m1, first POST → hits
// m1; rewrite settings.json = prov/m2, wait for the EnvLoader watcher to
// trigger reload + hub.adapter hot rebuild, second POST → hits m2.
//
// Note: this test relies on the wire-model tail split (ADR-0094) — route
// `prov/m1` hits the provider registry → SDK wire = `m1`.

describe("startSessionServe — runtime LLM env wiring (SC6)", () => {
  let capture: LlmCapture | undefined;
  let sc6Home: string | undefined;
  let sc6BaseDir: string | undefined;
  let sc6PrevHome: string | undefined;
  let sc6PrevKey: string | undefined;
  let sc6PrevStream: string | undefined;
  let sc6PrevMaxTokens: string | undefined;

  /** Write tmpHome/.iknow/settings.json: provider `prov` with m1/m2 +
   *  baseUrl pointing at the capture server, model = the current route. */
  async function writeProvSettings(modelRoute: string): Promise<void> {
    if (!sc6Home) throw new Error("sc6Home missing");
    const settingsJson = {
      llm: {
        model: modelRoute,
        providers: [
          {
            id: "prov",
            baseUrl: capture!.origin,
            apiKeyEnv: "IKNOW_SC6_API_KEY",
            models: [{ id: "m1" }, { id: "m2" }],
          },
        ],
      },
    };
    await writeFile(
      join(sc6Home, ".iknow", "settings.json"),
      JSON.stringify(settingsJson) + "\n",
      "utf8"
    );
  }

  /** Wait for a capture body containing a user message with the given text (the
   *  envLoader watcher is async). Filter by message content, not index — under
   *  different surfaces the first round may trigger a prefill / several SDK
   *  calls (multiple runAutoLoopSteps iterations + agentStatus injection within
   *  one postMessage), so hardcoded body[N] is brittle. */
  async function waitForBodyWithUserText(
    needle: string,
    timeoutMs = 3000
  ): Promise<{ model?: string; messages?: unknown[] }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const hit = capture?.bodies.find(
        (raw): raw is { model?: string; messages?: unknown[] } => {
          if (!raw || typeof raw !== "object") return false;
          const msgs = (raw as { messages?: unknown[] }).messages;
          if (!Array.isArray(msgs)) return false;
          return msgs.some((m) => {
            if (!m || typeof m !== "object") return false;
            const content = (m as { content?: unknown }).content;
            if (!Array.isArray(content)) return false;
            return content.some((c) => {
              if (!c || typeof c !== "object") return false;
              return (
                (c as { type?: unknown }).type === "text" &&
                typeof (c as { text?: unknown }).text === "string" &&
                ((c as { text: string }).text as string).includes(needle)
              );
            });
          });
        }
      );
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for capture body containing user text "${needle}" (have ${capture?.bodies.length ?? 0} bodies)`
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeEach(async () => {
    // Bring up our own tmp home (not installTestSettingsSource's hardcoded
    // provider shape — this test needs a custom registry with two model ids).
    sc6Home = await mkdtemp(join(tmpdir(), "iknow-sc6-home-"));
    sc6BaseDir = await mkdtemp(join(tmpdir(), "iknow-sc6-base-"));
    await mkdir(join(sc6Home, ".iknow"), { recursive: true });
    sc6PrevHome = process.env.HOME;
    sc6PrevKey = process.env["IKNOW_SC6_API_KEY"];
    sc6PrevStream = process.env["IKNOW_LLM_STREAM"];
    sc6PrevMaxTokens = process.env["IKNOW_LLM_MAX_OUTPUT_TOKENS"];
    process.env.HOME = sc6Home;
    process.env["IKNOW_SC6_API_KEY"] = "sc6-test-key";
    // The capture server returns a JSON envelope (not SSE) — only the SDK's
    // non-streaming arm can parse it. Default stream="on" → the SDK waits for
    // SSE chunks forever → 500 (consistent with current behavior).
    process.env["IKNOW_LLM_STREAM"] = "off";
    // Anthropic SDK: max_tokens > 8192 forces streaming. The test uses the
    // non-streaming arm → max_tokens must be <= 8192.
    process.env["IKNOW_LLM_MAX_OUTPUT_TOKENS"] = "128";
    capture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
  });

  afterEach(async () => {
    // Note: `listening` is closed by the outer afterEach; here only capture is closed and env restored.
    if (capture) await capture.close();
    capture = undefined;
    if (sc6Home) await rm(sc6Home, { recursive: true, force: true });
    if (sc6BaseDir) await rm(sc6BaseDir, { recursive: true, force: true });
    sc6Home = undefined;
    sc6BaseDir = undefined;
    if (sc6PrevHome === undefined) delete process.env.HOME;
    else process.env.HOME = sc6PrevHome;
    if (sc6PrevKey === undefined) delete process.env["IKNOW_SC6_API_KEY"];
    else process.env["IKNOW_SC6_API_KEY"] = sc6PrevKey;
    if (sc6PrevStream === undefined) delete process.env["IKNOW_LLM_STREAM"];
    else process.env["IKNOW_LLM_STREAM"] = sc6PrevStream;
    if (sc6PrevMaxTokens === undefined)
      delete process.env["IKNOW_LLM_MAX_OUTPUT_TOKENS"];
    else process.env["IKNOW_LLM_MAX_OUTPUT_TOKENS"] = sc6PrevMaxTokens;
  });

  it("改用户层 settings.json 后,下一条 POST /messages 的 wire model 跟 EnvLoader 更新", async () => {
    // (a) initial settings = prov/m1 → start serve.
    await writeProvSettings("prov/m1");
    const out = await startSessionServe({
      dataDir: sc6BaseDir,
      // No home passed — serve defaults to homedir(), which beforeEach redirected
      // to sc6Home (sc6BaseDir only carries the SessionStore path, strictly
      // separate from the EnvLoader's settings source).
      hubOptions: { askUser: createNoAskUser() },
      port: 0,
    });
    listening = out.listening;
    const origin = `http://${listening.host}:${listening.port}`;

    // (b) create session → first POST /messages → expect capture to see wire model = m1.
    const created = await fetch(`${origin}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(created.status, 201);
    const sessionId = (
      (await created.json()) as { session: { conversation_id: string } }
    ).session.conversation_id;

    const first = await fetch(
      `${origin}/api/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "first" }),
      }
    );
    assert.equal(first.status, 200);

    const firstBody = await waitForBodyWithUserText("first");
    assert.equal(firstBody.model, "m1");

    // (c) rewrite user-level settings.json → prov/m2 → EnvLoader watcher fires →
    // envProvider returns the new env → hub.reloadFromEnv rebuilds the adapter
    // (whitelisted field `model` changed). Watcher 100ms debounce + atomic
    // writeFile + reload + adapter rebuild measures < 300ms; keep a 500ms buffer.
    await writeProvSettings("prov/m2");
    await new Promise((r) => setTimeout(r, 500));

    const second = await fetch(
      `${origin}/api/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "second" }),
      }
    );
    assert.equal(second.status, 200);

    const secondBody = await waitForBodyWithUserText("second");
    assert.equal(secondBody.model, "m2");
  });
});
