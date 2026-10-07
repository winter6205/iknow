/**
 * bash-service-loop closed-loop integration e2e (the two tracks' meeting point).
 *
 * Full flow:
 *   1. bash({command: start an http server on a unix socket, background: true})
 *      gets ask approval through permission-executor → manager.spawn returns
 *      task_id immediately
 *   2. the handler returns {task_id, log_path} in milliseconds (no blocking,
 *      no tier occupancy)
 *   3. bash_output polls until it reads the server's LISTENING evidence
 *   4. a real host-side client receives the response body over the same unix socket
 *   5. bash_stop(task_id) → the listening resource is released: further host
 *      client connects fail
 *   6. the registry json status converges to killed
 *
 * Transport choice (ADR-0097: `--unshare-net` is constant): the sandbox has
 * its own netns; a TCP loopback listener lives only inside it, so the host
 * can neither connect nor observe port lifecycle. Unix-domain-socket
 * visibility is decided by the **filesystem**, orthogonal to netns, and both
 * sides address the same host path via `--bind / /` — so this e2e uses UDS to
 * keep the closed loop of "a sandboxed service genuinely visible to the host
 * → genuinely released after bash_stop" without depending on the egress path
 * (the egress seam carries only outbound CONNECT, never inbound connections).
 *
 * Port strategy: the socket path sits in a host-side mkdtemp dir (UDS has no
 * port concept); the connect-retry window tolerates ~2s of process
 * startup/reap latency.
 *
 * The in-sandbox service is a one-line node http server (the sandbox has
 * /usr/bin/node; the "node runs" probe confirms v22) — steadier than an nc
 * loop: a node process naturally keeps the event loop alive.
 *
 * Permission shape: bash's category defaults to ask; askUser is injected
 * always-true to focus on the "after-approval closed loop"; the hint goes
 * through summarizeInput's JSON shape.
 *
 * fresh workspaceRoot (the test-rules command-handler contract): an mkdtemp
 * temp dir with no pre-existing session/tasks files. fresh conversationId:
 * ctx.conversationId passes through to spawn, and bash_output / bash_stop use
 * the same conversationId to pass the scope filter.
 *
 * Teardown afterEach: manager.shutdown() + temp dir cleanup, guaranteeing no
 * leaked processes (a classic pitfall: test servers must be stopped cleanly).
 */

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "vitest";

import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createBashOutputTool } from "../../../src/harness/aci/tools/bash-output.js";
import { createBashStopTool } from "../../../src/harness/aci/tools/bash-stop.js";
import { createPermissionExecutor } from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import type { AskUser } from "../../../src/harness/permission/types.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  Registry,
  ToolCall,
  ToolDef,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
} from "../../../src/harness/background/manager.ts";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.ts";
import { resolveTasksDir } from "../../../src/harness/background/paths.ts";

/**
 * `ToolExecutionResult.payload` is `AnthropicContentBlock[]`, a union whose
 * `text` member only exists on the text arm. Every ok result read here is a
 * single text block, so narrow it in one place instead of casting at each
 * `payload[0]!.text`.
 */
function okText(result: ToolExecutionResult): string {
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") throw new Error("not ok");
  const block = result.payload[0]!;
  assert.equal(block.type, "text");
  if (block.type !== "text") throw new Error("not text");
  return block.text;
}

// ── bwrap guard ──────────────────────────────────────────────────────────────

function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

// ── Registry adapter (local mini version) ────────────────────────────────────
// Preserve aci metadata — permission-executor's createAciCatalog projection
// depends on def.aci; dropping aci empties the catalog → Step 0 delegates
// straight to inner, bypassing the permission layer (askUser never fires).

function makeRegistry(defs: AciToolDef[]): Registry {
  const list: ToolDef[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema as Record<string, unknown>,
    handler: d.handler,
    ...(d.aci ? { aci: d.aci } : {}),
  }));
  return Object.freeze({
    list: () => list,
    get: (name: string) => list.find((d) => d.name === name),
  });
}

// ── unix socket connect / HTTP helpers ───────────────────────────────────────

/** A connectable socket = the listening process is alive (stale socket file → ECONNREFUSED). */
function canConnectSocket(
  socketPath: string,
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ path: socketPath });
    sock.setTimeout(timeoutMs);
    const settle = (ok: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
    sock.once("timeout", () => settle(false));
  });
}

function httpGetBodyOverSocket(
  socketPath: string,
  path: string,
  timeoutMs = 1_000
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = httpGet({ socketPath, path }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    r.on("error", reject);
    r.setTimeout(timeoutMs, () => {
      r.destroy(new Error(`http timeout on ${socketPath}${path}`));
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Teardown tracking (one manager + temp dir per it; afterEach shuts down) ──

let lastManager: BackgroundTaskManager | undefined;
let lastTempDir: string | undefined;

afterEach(async () => {
  if (lastManager) {
    try {
      await lastManager.shutdown();
    } catch {
      /* shutdown best-effort */
    }
  }
  if (lastTempDir) {
    try {
      await rm(lastTempDir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  }
  lastManager = undefined;
  lastTempDir = undefined;
});

// ── Closed-loop e2e ──────────────────────────────────────────────────────────

describe("bash-service-loop closed loop e2e (#502 + #503)", () => {
  it.skipIf(!hasBwrap())(
    "起服务 → host 验证 → bash_stop 监听释放 + registry 状态收敛 killed",
    async () => {
      // 1) Setup: fresh workspaceRoot temp dir + fresh conversationId
      const tempRoot = await mkdtemp(join(tmpdir(), "iknow-svc-loop-"));
      lastTempDir = tempRoot;
      const conversationId = `conv-svc-${randomBytes(6).toString("hex")}`;
      // The socket lives in the same temp dir (host / sandbox share the path; UDS is orthogonal to netns).
      const socketPath = join(tempRoot, "svc.sock");

      // 2) Assembly: manager + bash/bash_output/bash_stop tools + approving askUser
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({
          dataDir: tempRoot,
          projectIdentityRoot: tempRoot,
        }),
        spawn: defaultBackgroundSpawn,
      });
      lastManager = manager;
      const bashTool = createBashTool(tempRoot, {
        backgroundManager: manager,
      });
      const bashOutputTool = createBashOutputTool({
        backgroundManager: manager,
      });
      const bashStopTool = createBashStopTool({ backgroundManager: manager });

      const askCalls: Array<Parameters<AskUser>[0]> = [];
      const askUser: AskUser = async (ctx) => {
        askCalls.push(ctx);
        return true; // approve: focus on the post-approval closed loop
      };
      const inner: Executor = Object.freeze({
        executeAll: async (
          calls: ReadonlyArray<ToolCall>,
          signal?: AbortSignal,
          _timeoutMs?: number,
          convId?: string
        ): Promise<ReadonlyArray<ToolExecutionResult>> => {
          const call = calls[0]!;
          // Dispatch by call.name to the right handler — the bash handler
          // validates that input.command exists, but bash_output/bash_stop
          // carry no command field, so they cannot all go through bash.handler.
          const toolByName: Record<string, AciToolDef> = {
            bash: bashTool,
            bash_output: bashOutputTool,
            bash_stop: bashStopTool,
          };
          const def = toolByName[call.name];
          if (!def) {
            throw new Error(`e2e inner: unknown tool ${call.name}`);
          }
          const payload = await def.handler(call.input, {
            ...(signal ? { signal } : {}),
            ...(convId ? { conversationId: convId } : {}),
          });
          const text =
            typeof payload === "string" ? payload : JSON.stringify(payload);
          return [
            {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text }],
            },
          ];
        },
      });
      const executor = createPermissionExecutor({
        inner,
        registry: makeRegistry([bashTool, bashOutputTool, bashStopTool]),
        policy: createPermissionPolicy(),
        askUser,
      });

      // 3) Start the service: bash background:true → in-sandbox node starts a UDS http server on a host-visible path
      const nodeCmd = `node -e 'const s=require("http").createServer((q,r)=>{r.end("iknow-svc-ok")});s.listen(${JSON.stringify(socketPath)},()=>{console.log("listening on ${socketPath}")})'`;
      const t0 = Date.now();
      const [spawnResult] = await executor.executeAll(
        [
          {
            id: "u1",
            name: "bash",
            input: {
              command: nodeCmd,
              background: true,
            },
          },
        ],
        undefined,
        undefined,
        conversationId
      );
      const elapsedMs = Date.now() - t0;

      // ask ctx assertions: bash's category defaults to ask, and the hint goes
      // through summarizeInput's JSON shape — a single summaryHint, with no
      // second network-approval-axis marker.
      assert.equal(askCalls.length, 1);
      assert.equal(askCalls[0]?.tool, "bash");
      assert.match(askCalls[0]?.summaryHint ?? "", /^\{"command":/);
      assert.equal(
        (askCalls[0]?.summaryHint ?? "").includes("network-guard"),
        false
      );

      // The handler returns ok in milliseconds (no blocking, no tier occupancy)
      assert.equal(spawnResult.kind, "ok");
      assert.ok(
        elapsedMs < 5_000,
        `background spawn should return in ms, got ${elapsedMs}ms`
      );
      const spawnPayload = JSON.parse(okText(spawnResult)) as {
        task_id: string;
        log_path: string;
      };
      assert.match(spawnPayload.task_id, /^bg-[0-9a-f]{12}$/);
      assert.ok(spawnPayload.log_path.endsWith(`${spawnPayload.task_id}.log`));
      const { task_id: taskId, log_path: logPath } = spawnPayload;

      // 4) bash_output polls until it reads the server's LISTENING evidence (in-sandbox stdout → log)
      let listeningSeen = false;
      const outputDeadline = Date.now() + 5_000;
      while (Date.now() < outputDeadline) {
        const [outResult] = await executor.executeAll(
          [
            {
              id: "u2",
              name: "bash_output",
              input: { task_id: taskId, max_bytes: 4_096 },
            },
          ],
          undefined,
          undefined,
          conversationId
        );
        if (outResult.kind === "ok") {
          const out = JSON.parse(okText(outResult)) as {
            text: string;
            status: string;
          };
          if (out.text.includes(`listening on ${socketPath}`)) {
            listeningSeen = true;
            break;
          }
        }
        await sleep(50);
      }
      assert.ok(
        listeningSeen,
        `bash_output never showed listening evidence; log tail=${await safeTail(
          logPath
        )}`
      );

      // 5) A real host-side client receives the response body over the same
      //    socket — the listening resource held by the in-sandbox process
      //    genuinely exists from the host's perspective (UDS visibility is
      //    carried by the filesystem).
      let bodySeen: string | null = null;
      const connectDeadline = Date.now() + 3_000;
      while (Date.now() < connectDeadline) {
        try {
          const body = await httpGetBodyOverSocket(socketPath, "/");
          if (body === "iknow-svc-ok") {
            bodySeen = body;
            break;
          }
        } catch {
          /* retry */
        }
        await sleep(50);
      }
      assert.equal(bodySeen, "iknow-svc-ok");

      // 6) bash_stop(task_id) → listener released + registry json status converges
      const [stopResult] = await executor.executeAll(
        [{ id: "u3", name: "bash_stop", input: { task_id: taskId } }],
        undefined,
        undefined,
        conversationId
      );
      assert.equal(stopResult.kind, "ok");
      const stopPayload = JSON.parse(okText(stopResult)) as {
        task_id: string;
        status: string;
      };
      assert.equal(stopPayload.task_id, taskId);
      assert.equal(stopPayload.status, "stopped");

      // A further host client connect should fail (process group dead → socket no longer accepts)
      // The retry window ~2s tolerates SIGTERM→SIGKILL escalation and OS socket reclamation
      let listenerReleased = false;
      const closeDeadline = Date.now() + 3_000;
      while (Date.now() < closeDeadline) {
        if (!(await canConnectSocket(socketPath, 200))) {
          listenerReleased = true;
          break;
        }
        await sleep(50);
      }
      assert.ok(
        listenerReleased,
        `socket ${socketPath} should be released after bash_stop but still accepting connections`
      );

      // 7) registry json status converges to killed (reads <pool>/projects/<slug>/tasks/<id>.json)
      // The status flip is an async settle driven by the exit event (manager.stop
      // returns in ms, non-blocking); the listener may release before the settle's
      // writeFile lands on disk → reading the JSON once after the listener closes
      // can catch the spawn-time "running" record (sporadic under full concurrent
      // vitest, passes when run alone). Wait for convergence in the same shape as
      // the connect-poll above (3s cap / 50ms interval).
      const jsonPath = logPath.replace(/\.log$/, ".json");
      let rec:
        | { status: string; task_id: string; conversation_id: string }
        | undefined;
      const regDeadline = Date.now() + 3_000;
      while (Date.now() < regDeadline) {
        try {
          rec = JSON.parse(await readFile(jsonPath, "utf8")) as typeof rec;
        } catch {
          rec = undefined;
        }
        if (rec && rec.status !== "running") break;
        await sleep(50);
      }
      assert.ok(rec, "registry json should exist and be parseable");
      assert.equal(rec.task_id, taskId);
      assert.equal(rec.conversation_id, conversationId);
      assert.equal(
        rec.status,
        "killed",
        `registry json status should converge to killed after stop; got ${rec.status}`
      );
    },
    25_000
  );
});

/** Reads the log tail — diagnostics when bash_output never showed the listening evidence. */
async function safeTail(logPath: string): Promise<string> {
  try {
    const raw = await readFile(logPath, "utf8");
    return raw.slice(-512);
  } catch {
    return "(log missing)";
  }
}
