/**
 * #358 T7 — GET /api/v1/sessions/:id/subagents 只读端点 (spec SC7)。
 *
 * 端点是纯只读投影: hub 先经 store.load 做会话存在性门 (typed not_found →
 * 404), 再返回 manager.listSubagents() 在场列表;manager 缺席 → 200 []。
 * 本文件用 fake SubAgentManager 注入 hubOpts.subagentManager (constructor
 * 优先, ensureDeps 的 ?? 不会覆写 —— #358 T4 透传链), 断言:
 *   - happy path: 三态 (running/completed/failed) 字段完整 + Postel 在场
 *   - 无会话 → typed 404 (不裸抛)
 *   - manager 缺席 → 200 + `[]`
 *   - 只读: 两次 GET 同 snapshot + 仅只读方法被调 (写方法零调用)
 */
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionHub,
  type SessionHubOptions,
} from "../../src/session-api/hub.ts";
import {
  listenSessionServer,
  type ListeningServer,
} from "../../src/session-api/http.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import type { AssistantTurnResult } from "../../src/harness/index.ts";
import type {
  SubAgentManager,
  SubagentInfo,
} from "../../src/harness/subagent/manager.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

// -- per-test server lifecycle ------------------------------------------------

let baseDir: string;
let listening: ListeningServer;
let origin: string;

async function startServer(
  responses: AssistantTurnResult[],
  hubOpts?: Omit<SessionHubOptions, "store" | "deps">
): Promise<void> {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-http-subagents-"));
  const store = new SessionStore(baseDir);
  const hub = new SessionHub({
    store,
    deps: makeDeps(responses),
    ...hubOpts,
  });
  listening = await listenSessionServer({ hub, host: "127.0.0.1", port: 0 });
  origin = `http://${listening.host}:${listening.port}`;
}

const DEFAULT_RESPONSES: AssistantTurnResult[] = [
  assistantResult({ texts: ["hello"] }),
];

/** 完整成员面 fake: 写方法全 spy, 只读投影由调用方固定。 */
function makeFakeManager(subagents: SubagentInfo[] = []) {
  const listSubagents = vi.fn(() => subagents);
  const spawn = vi.fn(() => ({ taskId: "noop" }));
  const queryBuffer = vi.fn(() => ({ status: "not_found" }) as const);
  const waitFor = vi.fn(
    async () => ({ status: "ok", summary: "", result: "" }) as const
  );
  const shutdown = vi.fn(async () => {});
  const drainCompleted = vi.fn(() => []);
  const listActive = vi.fn(() => []);
  const abortTask = vi.fn(() => false);
  const manager: SubAgentManager = {
    spawn,
    queryBuffer,
    waitFor,
    shutdown,
    drainCompleted,
    listActive,
    abortTask,
    listSubagents,
  };
  return {
    manager,
    listSubagents,
    spawn,
    abortTask,
    shutdown,
    waitFor,
  };
}

afterEach(async () => {
  await listening.close();
  await rm(baseDir, { recursive: true, force: true });
});

// -- helpers ------------------------------------------------------------------

async function getJson(
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function postJson(opts: {
  readonly path: string;
  readonly payload: unknown;
}): Promise<{ status: number; body: unknown }> {
  const { path, payload } = opts;
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? "" : JSON.stringify(payload),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function assertNestedError(opts: {
  readonly body: unknown;
  readonly kind: string;
}): void {
  const { body, kind } = opts;
  const b = body as { error?: { kind?: string; message?: string } };
  assert.ok(b.error, "body must have top-level `error` object");
  assert.equal(b.error!.kind, kind);
  assert.ok(
    typeof b.error!.message === "string" && b.error!.message.length > 0
  );
}

async function createSession(): Promise<string> {
  const { status, body } = await postJson({
    path: "/api/v1/sessions",
    payload: {},
  });
  assert.equal(status, 201);
  return (body as { session: { conversation_id: string } }).session
    .conversation_id;
}

// -- happy path ---------------------------------------------------------------

describe("GET /api/v1/sessions/:id/subagents — 正常路径", () => {
  beforeEach(async () => {
    await startServer(DEFAULT_RESPONSES);
  });

  it("返回在场子代理列表: running/completed/failed 三态字段完整上行", async () => {
    const { manager, listSubagents } = makeFakeManager([
      {
        taskId: "run-1",
        state: "running",
        taskPreview: "explore the repo",
        startedAt: "2026-08-18T00:00:00.000Z",
      },
      {
        taskId: "done-1",
        state: "completed",
        taskPreview: "write spec",
        startedAt: "2026-08-18T00:00:01.000Z",
        endedAt: "2026-08-18T00:00:02.000Z",
        summary: "spec written",
      },
      {
        taskId: "fail-1",
        state: "failed",
        taskPreview: "verify output",
        startedAt: "2026-08-18T00:00:03.000Z",
        endedAt: "2026-08-18T00:00:04.000Z",
        summary: "worker crashed",
        reason: "crashed",
      },
    ]);
    // 注: fake manager 已注入管理面, 重建 server 以接入注入。
    await listening!.close();
    await startServer(DEFAULT_RESPONSES, { subagentManager: manager });

    const sid = await createSession();
    const { status, body } = await getJson(`/api/v1/sessions/${sid}/subagents`);
    assert.equal(status, 200);
    const b = body as { subagents: SubagentInfo[] };
    assert.equal(b.subagents.length, 3);
    // running 态 Postel: 可选字段缺席 (不落 undefined 键)。
    assert.deepEqual(b.subagents[0], {
      taskId: "run-1",
      state: "running",
      taskPreview: "explore the repo",
      startedAt: "2026-08-18T00:00:00.000Z",
    });
    assert.equal(b.subagents[1]!.state, "completed");
    assert.equal(b.subagents[1]!.endedAt, "2026-08-18T00:00:02.000Z");
    assert.equal(b.subagents[1]!.summary, "spec written");
    assert.equal(b.subagents[2]!.state, "failed");
    assert.equal(b.subagents[2]!.reason, "crashed");
    assert.equal(b.subagents[2]!.summary, "worker crashed");
    assert.equal(listSubagents.mock.calls.length, 1);
  });

  it("manager 缺席 → 200 + 空列表 []", async () => {
    // hubOpts 不注入 subagentManager (服务 "ask 形态") → no-op 空投影。
    const sid = await createSession();
    const { status, body } = await getJson(`/api/v1/sessions/${sid}/subagents`);
    assert.equal(status, 200);
    assert.deepEqual(body, { subagents: [] });
  });

  it("无会话 → typed 404 not_found (失败路径不裸抛)", async () => {
    const { status, body } = await getJson(
      "/api/v1/sessions/does-not-exist/subagents"
    );
    assert.equal(status, 404);
    assertNestedError({ body, kind: "not_found" });
  });

  it("只读: 两次 GET 同 snapshot + 仅只读方法被调 (写方法零调用)", async () => {
    const { manager, listSubagents, spawn, abortTask } = makeFakeManager([
      {
        taskId: "run-1",
        state: "running",
        taskPreview: "explore",
        startedAt: "2026-08-18T00:00:00.000Z",
      },
    ]);
    await listening!.close();
    await startServer(DEFAULT_RESPONSES, { subagentManager: manager });

    const sid = await createSession();
    const url = `/api/v1/sessions/${sid}/subagents`;
    const first = await getJson(url);
    const second = await getJson(url);
    assert.equal(first.status, 200);
    assert.deepEqual(second.body, first.body);
    // 端点无写路径: 写方法零调用; 只读投影按需调用。
    assert.equal(spawn.mock.calls.length, 0);
    assert.equal(abortTask.mock.calls.length, 0);
    assert.equal(listSubagents.mock.calls.length, 2);
  });
});
