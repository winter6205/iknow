/**
 * ADR-0132 SC4 — the main session's own scratch exception must be WIRED on
 * every production host that owns a session folder.
 *
 * `cleanup-roots-production-wiring.test.ts` already proves the mechanics: it
 * assembles `buildHarnessEngine` directly and hands it a `sessionConversationId`
 * reader, then observes the scratch cleanup execute. What it cannot see is the
 * part that decides whether the exception exists in the product at all: no
 * production entry passed that reader, so the one arm ADR-0132 added was
 * correct in tests and dead in every real session.
 *
 * This file closes that. Each case drives a REAL host assembly the way the
 * product does and asserts on the observed outcome of one real `bash` call:
 *
 *   - TUI  — `buildTuiDeps`, the exact assembly `tui/run.tsx` calls, with the
 *            inflight registry the bridge marks before `postMessage`.
 *   - serve — a real `SessionHub` on its PRODUCTION engine path (no
 *            `buildEngine` / `deps` injection), driving a real `postMessage`
 *            turn against a loopback model.
 *   - chat — a real `iknow chat` child process (real CLI parse, real
 *            assembly, real fence), the entry that owns a single pinned
 *            conversationId.
 *
 * The command is EXECUTED, not merely classified: "the wall stopped
 * answering" and "the file was really deleted" are different claims and only
 * the second one is the repair. The negatives matter just as much — an
 * over-broad root, a wrong scratch, or a containment check that stopped
 * resolving would all show up as a deleted foreign file, so every refusal is
 * asserted through the SAME assembly that now admits the positives.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

import { buildTuiDeps } from "../../src/tui/deps.js";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore, resolveProjectSessionDir } from "../../src/session-api/store/index.ts";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.ts";
import { createPermissionModeContext } from "../../src/harness/permission/modes.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import {
  TEST_LLM_PROVIDER,
  TEST_LLM_PROVIDER_API_KEY_ENV,
} from "../_helpers/test-llm-settings.ts";
import { installTestSettingsSource } from "../_helpers/install-test-settings-source.ts";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

/**
 * A real git repository. ADR-0037's assembly resolves a main checkout from the
 * session root, and `requireBoundRoot` / `bindWorkspace` both demand an
 * existing directory; a plain tmpdir passes the second but leaves
 * `mainCheckoutOf` walking a tree shape nothing here established.
 */
function plantRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.test"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], {
    stdio: "ignore",
  });
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "scratch-host-wiring-")));

/** The main session's live `taskRoot` (a real repo checkout). */
const taskRoot = join(root, "repo");
plantRepo(taskRoot);

/**
 * The session-folder pool root, and the project dir the production formula
 * derives from it. `buildTuiDeps` computes the project dir as
 * `resolveProjectSessionDir(dataDir, deriveProjectIdentityRoot({workspaceRoot}))`
 * — a hashed slug, so the fixture asks the production resolver where this
 * session's scratch lands rather than assuming a convenient path shape. A
 * hardcoded approximation would let the two gates disagree about the scratch
 * and make a real wiring defect look like a passing test.
 */
const poolRoot = join(root, "pool");
const projectDir = resolveProjectSessionDir(
  poolRoot,
  deriveProjectIdentityRoot({ cwd: taskRoot })
);
const mainConversationId = "11111111-2222-3333-4444-555555555555";
const mainScratch = join(projectDir, mainConversationId, "fence-tmp");
/** A DIFFERENT identity's scratch, same project pool. */
const otherConversationId = "99999999-8888-7777-6666-555555555555";
const otherScratch = join(projectDir, otherConversationId, "fence-tmp");
/** Lives outside every root, reachable only through the `escape` symlink. */
const outside = join(root, "outside");

function plant(dir: string, files: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(join(dir, name), "x");
}

plant(mainScratch, ["a.cjs"]);
plant(otherScratch, ["c.cjs"]);
plant(taskRoot, ["tmp_pycheck.cjs", "user-note.md", ".env"]);
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "x");
symlinkSync(outside, join(taskRoot, "escape"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Recreate a fixture file a prior case consumed, so cases stay independent. */
function restore(path: string, body = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

type BashResult = {
  readonly kind: string;
  readonly message?: string;
  readonly payload?: ReadonlyArray<{ readonly text?: string }>;
};

/** Whether the call was refused by a hard wall rather than by the ask gate. */
function deniedByHardWall(result: BashResult): boolean {
  return result.message?.includes("[hard_wall]") === true;
}

/* ================================================================== */
/* TUI host — `buildTuiDeps`, exactly as `tui/run.tsx` assembles it     */
/* ================================================================== */

const TUI_ENV = {
  llm: {
    baseUrl: "http://127.0.0.1:9999",
    model: "test-model",
    fallback: [],
    apiKey: "sk-host-wiring",
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
    temperature: 0,
    thinking: "off",
    thinkingEffort: "",
    stream: "off",
  },
  chat: { showThinking: false },
  web: { searchUrl: undefined, proxy: undefined },
  compress: { contextWindow: 200_000, thresholdTokens: undefined },
  mcp: { connectTimeoutMs: 60_000 },
  subagent: { taskTimeoutMs: undefined },
} as unknown as IknowEnv;

function makeBundle(): RuntimeBundle {
  // buildTuiDeps delegates to build-engine and reads only `env`; the rest of
  // the bundle is stubbed, same as tests/tui/deps-tools.test.ts.
  return { env: TUI_ENV } as unknown as RuntimeBundle;
}

/**
 * Assemble the TUI host and return its flat deps plus the inflight registry
 * the caller marks exactly as `hub-bridge.postMessage` does — before the turn
 * runs, released after it settles.
 */
async function buildTuiHost(
  mode: "default" | "full_auto",
  askUser: () => Promise<boolean>
): Promise<{
  readonly run: (command: string) => Promise<BashResult>;
}> {
  const inflight = createInflightRegistry();
  const deps = await buildTuiDeps(makeBundle(), {
    askUser,
    permissionMode: createPermissionModeContext(mode),
    soleInflightId: () => inflight.soleId(),
    userHome: join(root, "home"),
    cwd: taskRoot,
    // The pool root, not the project dir: `buildTuiDeps` derives the project
    // dir from `(dataDir, projectIdentityRoot)` with a hashed slug, so the
    // fixture asks the production formula where this session's scratch lands
    // instead of assuming a path shape.
    dataDir: poolRoot,
    workspaceRoot: taskRoot,
  });
  return {
    run: async (command: string): Promise<BashResult> => {
      inflight.mark(mainConversationId);
      try {
        const [result] = await deps.executor.executeAll(
          [{ id: "t1", name: "bash", input: { command } }],
          undefined,
          undefined,
          mainConversationId
        );
        return result as BashResult;
      } finally {
        inflight.unmark(mainConversationId);
      }
    },
  };
}

describe("TUI host — ADR-0132 scratch exception is live through buildTuiDeps", () => {
  it("full_auto admits and REALLY deletes a file in this identity's scratch", async () => {
    const target = join(mainScratch, "a.cjs");
    restore(target);
    const host = await buildTuiHost("full_auto", async () => true);

    const result = await host.run("rm -f $TMPDIR/a.cjs");

    assert.equal(
      deniedByHardWall(result),
      false,
      `own scratch must not hit a hard wall: ${result.message ?? result.kind}`
    );
    assert.equal(result.kind, "ok", result.message ?? "");
    assert.equal(
      existsSync(target),
      false,
      "an admitted scratch cleanup must actually delete the file"
    );
  });

  it("default ASKS rather than denying at the wall", async () => {
    const target = join(mainScratch, "a.cjs");
    restore(target);
    // A DECLINING inlet, so the observed outcome distinguishes "the wall no
    // longer answers" from "the mode arm admitted it". With an auto-approving
    // inlet the two are indistinguishable at the result envelope.
    const host = await buildTuiHost("default", async () => false);

    const result = await host.run("rm -f $TMPDIR/a.cjs");

    assert.equal(
      deniedByHardWall(result),
      false,
      `default mode must not be a hard-wall deny: ${result.message ?? ""}`
    );
    assert.equal(
      result.message,
      "[user_denied] user declined tool call: bash",
      "a declined ordinary ask is the observable signature of `default` asking"
    );
    assert.equal(existsSync(target), true, "a declined ask must leave the file");
  });

  it("another identity's scratch gets NO exception through the same assembly", async () => {
    const target = join(otherScratch, "c.cjs");
    restore(target);
    const host = await buildTuiHost("full_auto", async () => true);

    const result = await host.run(`rm -f ${otherScratch}/c.cjs`);

    assert.equal(
      deniedByHardWall(result),
      true,
      "another identity's scratch must keep its hard-wall deny"
    );
    assert.equal(existsSync(target), true, "the foreign scratch file must survive");
  });

  it("concurrent sessions attribute nothing, so no scratch scope exists", async () => {
    // The inflight registry returns a sole id only when exactly one session is
    // running. Two in flight means the scratch of "the current identity" is
    // not a fact this host can establish, and the reader must report no
    // identity rather than guess one — the cross-identity deletion
    // ADR-0132 withholds.
    const inflight = createInflightRegistry();
    inflight.mark(mainConversationId);
    inflight.mark(otherConversationId);
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: async () => true,
      permissionMode: createPermissionModeContext("full_auto"),
      soleInflightId: () => inflight.soleId(),
      userHome: join(root, "home"),
      cwd: taskRoot,
      dataDir: poolRoot,
      workspaceRoot: taskRoot,
    });
    const target = join(mainScratch, "a.cjs");
    restore(target);

    const [result] = await deps.executor.executeAll(
      [{ id: "t1", name: "bash", input: { command: "rm -f $TMPDIR/a.cjs" } }],
      undefined,
      undefined,
      mainConversationId
    );
    const observed = result as BashResult;

    assert.equal(
      deniedByHardWall(observed),
      true,
      "with two sessions in flight the host must establish no identity"
    );
    assert.equal(existsSync(target), true, "the scratch file must survive");
  });
});

/**
 * The negatives that matter most are the ones a wrong root or a containment
 * check that stopped resolving would break: each case must still deny through
 * the SAME assembly that now admits the positives.
 */
describe("TUI host — the wiring widened nothing", () => {
  const denied: ReadonlyArray<readonly [string, string]> = [
    ["the scratch root itself", "rm -f $TMPDIR"],
    ["recursive in scratch", "rm -rf $TMPDIR/a.cjs"],
    ["a glob in scratch", "rm -f $TMPDIR/*.cjs"],
    ["an unresolved variable in scratch", "rm -f $NAME.cjs"],
    ["escaping the scratch through `..`", "rm -f $TMPDIR/../../outside/secret.txt"],
    ["command substitution", "rm -f $(echo $TMPDIR)/a.cjs"],
    ["a wrapper around the rm", "sudo rm -f $TMPDIR/a.cjs"],
    ["a nested shell", "bash -c 'rm -f $TMPDIR/a.cjs'"],
    ["the taskRoot itself", `rm -f ${taskRoot}`],
    ["a protected target in the workspace", "rm -f .env"],
    ["outside every root", `rm -f ${outside}/secret.txt`],
    ["escaping the workspace through a symlinked ancestor", "rm -f escape/secret.txt"],
  ];

  for (const [why, command] of denied) {
    it(`still denies: ${why}`, async () => {
      const host = await buildTuiHost("full_auto", async () => true);
      const result = await host.run(command);
      assert.equal(
        deniedByHardWall(result),
        true,
        `${command} must keep a hard-wall deny, got: ${result.kind} ${
          result.message ?? ""
        }`
      );
    });
  }
});

/* ================================================================== */
/* serve host — real SessionHub, production engine assembly            */
/* ================================================================== */

let settingsSource: ReturnType<typeof installTestSettingsSource>;
let loopback: Server;
let loopbackOrigin: string;
let portRequests = 0;
/** The tool_use input the loopback model serves next, per turn index. */
const script: Array<{ readonly command: string } | null> = [];
let settingsHome: string;
let dataDir: string;

beforeAll(async () => {
  settingsSource = installTestSettingsSource();
  settingsHome = settingsSource.home;
  dataDir = join(root, "serve-data");
  // A scripted Anthropic-compatible endpoint: turn N answers with the Nth
  // entry's bash command, the last answers with text. Only the model
  // transport is stubbed — real parse, real permission wall, real fence.
  loopback = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // B6 overflow governance calls /v1/messages/count_tokens before the
      // first turn; only a real messages request consumes a script entry.
      if (req.url?.includes("count_tokens") === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const turn = script[portRequests] ?? null;
      portRequests += 1;
      const content: Array<Record<string, unknown>> =
        turn === null
          ? [{ type: "text", text: "done" }]
          : [
              {
                type: "tool_use",
                id: `call_${portRequests}`,
                name: "bash",
                input: {},
              },
            ];
      // SSE, because the real adapter takes the SDK's `.stream()` arm
      // (stream="on"). A tool_use block carries its arguments in
      // `input_json_delta`; a block that only carried `input` would parse to
      // {} and the handler would see no command at all.
      const events: Array<Record<string, unknown>> = [
        {
          type: "message_start",
          message: {
            id: `msg_${portRequests}`,
            type: "message",
            role: "assistant",
            model: "stub-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ];
      content.forEach((block, i) => {
        events.push({ type: "content_block_start", index: i, content_block: block });
        if (block["type"] === "tool_use") {
          events.push({
            type: "content_block_delta",
            index: i,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({ command: turn?.command }),
            },
          });
        } else {
          events.push({
            type: "content_block_delta",
            index: i,
            delta: { type: "text_delta", text: block["text"] ?? "" },
          });
        }
        events.push({ type: "content_block_stop", index: i });
      });
      events.push({
        type: "message_delta",
        delta: { stop_reason: turn === null ? "end_turn" : "tool_use" },
        usage: { output_tokens: 1 },
      });
      events.push({ type: "message_stop" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) {
        res.write(`event: ${e["type"]}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    loopback.listen(0, "127.0.0.1", () => resolve())
  );
  loopbackOrigin = `http://127.0.0.1:${(loopback.address() as AddressInfo).port}/v1`;
  // The provider route must exist in llm.providers; the listener port is
  // allocated dynamically, so baseUrl is written only once it is known.
  writeFileSync(
    join(settingsHome, ".iknow", "settings.json"),
    JSON.stringify({
      llm: {
        model: "test/model",
        providers: [
          {
            ...TEST_LLM_PROVIDER,
            baseUrl: loopbackOrigin,
            models: [{ id: "model", maxTokens: 1024 }],
          },
        ],
        permissions: { defaultMode: "full_auto" },
      },
    })
  );
});

afterEach(async () => {
  script.length = 0;
  portRequests = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => loopback.close(() => resolve()));
  settingsSource.restore();
});

/** A hub on its PRODUCTION engine path: no `deps`, no `buildEngine`. */
async function makeServeHub(): Promise<SessionHub> {
  const hub = new SessionHub({
    store: new SessionStore(dataDir, taskRoot),
    askUser: async () => true,
    surface: "serve",
    envProvider: () =>
      ({
        ...TUI_ENV,
        llm: {
          ...TUI_ENV.llm,
          baseUrl: loopbackOrigin,
          model: "model",
          apiKey: "test-key",
          // The real adapter takes the SDK's streaming arm by default, and the
          // non-streaming arm rejects a request whose timeout exceeds ten
          // minutes. The loopback answers in SSE, so the streaming arm is both
          // the default and the only one that works here.
          stream: "on",
        },
      }) as unknown as IknowEnv,
  });
  await hub.bindWorkspace(taskRoot);
  return hub;
}

describe("serve host — ADR-0132 scratch exception is live through the real hub", () => {
  it("a real postMessage turn admits and REALLY deletes in that session's own scratch", async () => {
    const target = join(mainScratch, "a.cjs");
    restore(target);
    const hub = await makeServeHub();
    const { session } = await hub.createSession();
    // The hub mints its own id; the scratch it must judge is THAT id's pad.
    const ownScratch = join(
      hub["store"].getProjectDir(),
      session.conversation_id,
      "fence-tmp"
    );
    restore(join(ownScratch, "a.cjs"));
    script.push({ command: "rm -f $TMPDIR/a.cjs" }, null);

    const resp = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "clean the scratch",
    });

    assert.match(
      resp.turn.answer.finalText,
      /done/,
      "the turn must have completed rather than stopped on a denial"
    );
    assert.equal(
      existsSync(join(ownScratch, "a.cjs")),
      false,
      "an admitted scratch cleanup must actually delete the file"
    );
  });

  it("a turn in one session does not inherit another session's scratch", async () => {
    const first = await hub1Session();
    const hub = first.hub;
    // The OTHER session's pad, spelled absolutely, from inside the first
    // session's turn.
    const otherScratch = join(
      hub["store"].getProjectDir(),
      first.otherId,
      "fence-tmp"
    );
    restore(join(otherScratch, "c.cjs"));
    script.push({ command: `rm -f ${otherScratch}/c.cjs` }, null);

    const resp = await hub.postMessage({
      conversationId: first.id,
      text: "reach out",
    });

    // The turn must have RUN: a turn that never reached the tool call would
    // leave the foreign file in place for the uninteresting reason.
    assert.match(resp.turn.answer.finalText, /done/);
    assert.equal(
      existsSync(join(otherScratch, "c.cjs")),
      true,
      "one session must never delete another session's scratch"
    );
    // And the two identities are genuinely distinct pads, so a passing result
    // is not the trivial one where both point at the same directory.
    assert.notEqual(otherScratch, first.scratch);
  });
});

/** Two sessions on one hub; returns the first plus the second's id + pad. */
async function hub1Session(): Promise<{
  readonly hub: SessionHub;
  readonly id: string;
  readonly scratch: string;
  readonly otherId: string;
}> {
  const hub = await makeServeHub();
  const one = await hub.createSession();
  const two = await hub.createSession();
  const projectDirOf = hub["store"].getProjectDir();
  return {
    hub,
    id: one.session.conversation_id,
    otherId: two.session.conversation_id,
    scratch: join(projectDirOf, one.session.conversation_id, "fence-tmp"),
  };
}

/* ================================================================== */
/* chat host — a real `iknow chat` process                             */
/* ================================================================== */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveTsxCli(): string {
  let dir = repoRoot;
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (realpathSync(candidate)) return candidate;
    } catch {
      // keep climbing toward the workspace root
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();
let child: ChildProcess | undefined;
let chatScratchRoot: string;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child?.once("close", () => resolve()));
  }
  child = undefined;
  if (chatScratchRoot) {
    rmSync(chatScratchRoot, { recursive: true, force: true });
    chatScratchRoot = "";
  }
});

describe("chat host — a real `iknow chat` process admits its own scratch cleanup", () => {
  it("full_auto: a seeded scratch file is really deleted by the next line's turn", async () => {
    const home = join(root, "chat-home");
    mkdirSync(join(home, ".iknow"), { recursive: true });
    // llm is a user-level key (ADR-0084): the fixture must sit in the user
    // layer the child resolves via HOME.
    writeFileSync(
      join(home, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          model: "test/model",
          providers: [
            {
              ...TEST_LLM_PROVIDER,
              baseUrl: loopbackOrigin,
              models: [{ id: "model", maxTokens: 1024 }],
            },
          ],
        },
      })
    );
    // `--data-dir` isolates the session pool so the conversation folder — and
    // therefore the scratch this turn judges — is ours to observe.
    const chatData = join(root, "chat-data");
    mkdirSync(chatData, { recursive: true });
    chatScratchRoot = chatData;

    /**
     * The scratch leaf, located by shape. The conversation id is minted inside
     * the child, so the pad is found by walking the isolated pool rather than
     * predicted — which also means a passing result cannot come from pointing
     * both the copy and the delete at a directory this test invented.
     */
    const scratchLeaf = (): string | undefined => {
      const projectsDir = join(chatData, "projects");
      if (!existsSync(projectsDir)) return undefined;
      for (const slug of readdirSync(projectsDir)) {
        const slugDir = join(projectsDir, slug);
        if (!statSync(slugDir).isDirectory()) continue;
        for (const conv of readdirSync(slugDir)) {
          const leaf = join(slugDir, conv, "fence-tmp", "a.cjs");
          if (existsSync(leaf)) return leaf;
        }
      }
      return undefined;
    };

    // Line 1 seeds the file through the same `$TMPDIR` the rm will use; line 2
    // deletes it. Observing the file EXIST between the two turns is what makes
    // the later "it is gone" a claim about deletion rather than about a
    // `rm -f` of something that was never there.
    script.push(
      { command: `cp ${join(taskRoot, "tmp_pycheck.cjs")} $TMPDIR/a.cjs` },
      null,
      { command: "rm -f $TMPDIR/a.cjs" },
      null
    );

    child = spawn(
      process.execPath,
      [tsxCli, join(repoRoot, "src", "cli.ts"), "chat", "--data-dir", chatData],
      {
        cwd: taskRoot,
        env: {
          ...process.env,
          HOME: home,
          [TEST_LLM_PROVIDER_API_KEY_ENV]: "test-key",
          IKNOW_PERMISSION_MODE: "full_auto",
          IKNOW_LLM_STREAM: "on",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    child.stdin?.write("seed the scratch\n");

    const seeded = await waitFor(scratchLeaf, 60_000);
    assert.ok(seeded !== undefined, "the chat turn must have created its own scratch file");
    child.stdin?.end("clean the scratch\n");

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child?.kill("SIGKILL");
        reject(new Error("iknow chat did not exit within 60s"));
      }, 60_000);
      child?.once("error", reject);
      child?.once("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    assert.equal(code, 0, "the chat process must exit cleanly");
    assert.equal(
      existsSync(seeded),
      false,
      "a real chat turn must really delete the seeded scratch file"
    );
  });
});

/** Poll `probe` until it yields a value, or fail with `what`. */
async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
