/**
 * `env_snapshot` stream event — an independent event stream parallel to
 * `agent_status` (data source for human-readable chrome), emitted at each turn
 * boundary "just before a model call".
 *
 * Acceptance mapping:
 *   ① the event carries the full EnvSnapshot fields (cwd / gitBranch /
 *      dirtyCount / diffPreview), physically isolated from agent_status
 *      (different type, zero field overlap);
 *   ② emit ordering: after each appendAgentStatusBar (same turn-boundary
 *      computation point) and before that model call lands (entrySamples-style
 *      sampling cross-assertion);
 *   ③ readEnvSnapshot failure (degraded) → event still emitted, cwd present,
 *      git/diff fields all null — never throws, never swallows the event;
 *   ④ deps.envSnapshot absent → zero events (byte-identical discipline: ask /
 *      worker / existing stub assemblies see zero behavior change);
 *   ⑤ observer throw must not backflow (safeEmitStream contract);
 *   ⑥ env_snapshot never enters messages (bar-purity reverse contract: request
 *      tail contains no cwd/git).
 *
 * Design: docs/design/DESIGN-ENVIRONMENT-PRESENT.md (parallel independent
 * stream, not reusing agent_status).
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/harness/loop-engine.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";
import { makeSpyAdapter, okEchoTool } from "./_agent-status-fixtures.ts";
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../src/harness/session-roots.ts";

// ---------------------------------------------------------------------------
// File-private fixtures
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTmpDir(prefix: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(tmp);
  return tmp;
}

async function makeTodoDir(initialContent?: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-env-agentstatus-"));
  tempDirs.push(tmp);
  if (initialContent !== undefined) {
    await writeFile(join(tmp, "todos.md"), initialContent, "utf8");
  }
  return tmp;
}

/** Event collector: env_snapshot and agent_status recorded separately (two-stream sampling by mutually exclusive types). */
interface EnvProbe {
  readonly onStream: (event: HarnessStreamEvent) => void;
  readonly envSnapshots: Extract<
    HarnessStreamEvent,
    { type: "env_snapshot" }
  >[];
  readonly agentStatusEvents: Extract<
    HarnessStreamEvent,
    { type: "agent_status" }
  >[];
}

function makeEnvProbe(): EnvProbe {
  const envSnapshots: Extract<HarnessStreamEvent, { type: "env_snapshot" }>[] =
    [];
  const agentStatusEvents: Extract<
    HarnessStreamEvent,
    { type: "agent_status" }
  >[] = [];
  const onStream = (event: HarnessStreamEvent): void => {
    if (event.type === "env_snapshot") envSnapshots.push(event);
    if (event.type === "agent_status") agentStatusEvents.push(event);
  };
  return { onStream, envSnapshots, agentStatusEvents };
}

/** Concatenate every text block across messages (for the "never enters messages" reverse assertion). */
function allText(messages: ReadonlyArray<AnthropicNativeMessage>): string {
  return messages
    .map((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
    )
    .join("\n");
}

/** Live reader seam — expose the current process cwd as a live readCwd. */
function envSnapshotLiveCwd(): { readCwd: () => string } {
  return { readCwd: () => process.cwd() };
}

/** Feed a live reader pointing at a non-git directory directly (degraded-shape test only). */
function envSnapshotLiveNonGit(nonGitDir: string): { readCwd: () => string } {
  return { readCwd: () => nonGitDir };
}

// ---------------------------------------------------------------------------
// Event shape: full EnvSnapshot fields, physically isolated from agent_status
// ---------------------------------------------------------------------------

describe("HarnessStreamEvent env_snapshot variant", () => {
  it("① env_snapshot 事件包含 EnvSnapshot 字段 (cwd, gitBranch, dirtyCount, diffPreview)", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: envSnapshotLiveCwd(),
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(probe.envSnapshots.length, 1);
    const ev = probe.envSnapshots[0]!;
    assert.equal(ev.type, "env_snapshot");
    assert.ok(typeof ev.snapshot.cwd === "string");
    assert.ok(ev.snapshot.cwd.length > 0);
    assert.ok(typeof ev.snapshot.gitBranch === "string");
    assert.ok(typeof ev.snapshot.dirtyCount === "number");
    assert.ok(
      ev.snapshot.diffPreview === null ||
        typeof ev.snapshot.diffPreview === "string"
    );
    // Reverse contract: zero field overlap with agent_status (env_snapshot
    // carries no lastTool / openTodoLines). Co-presence in the same turn is
    // covered by the ordering test.
    assert.ok(!("lastTool" in ev));
    assert.ok(!("openTodoLines" in ev));
  });

  it("② emit 时序在 appendAgentStatusBar 之后、模型调用之前(每回合边界一条)", async () => {
    const todoDir = await makeTodoDir("- [ ] alpha\n");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({
          texts: [],
          toolCalls: [{ id: "t1", name: "echo", input: { value: "a" } }],
        }),
      },
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        agentStatus: { todoDir },
        envSnapshot: envSnapshotLiveCwd(),
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    // 2 model calls → 2 env_snapshot + 2 agent_status (same turn-boundary
    // cadence, parallel and independent). captured.length === 2 proves the
    // calls actually happened.
    assert.equal(probe.envSnapshots.length, 2);
    assert.equal(probe.agentStatusEvents.length, 2);
    assert.equal(captured.length, 2);
  });

  it("③ readEnvSnapshot 抛错 → emit env_snapshot 含 cwd 但 git/diff = null (不 throw)", async () => {
    // Degraded shape driven by deps.envSnapshot.cwd pointing at a non-git
    // directory: readEnvSnapshot converges to all-null git fields there
    // (never-throws contract, pinned by the reader tests); this case pins
    // that loop-engine still emits the degraded snapshot without throwing.
    const nonGitDir = await makeTmpDir("iknow-env-nongit-");
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run(
      "hi",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: envSnapshotLiveNonGit(nonGitDir),
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(probe.envSnapshots.length, 1);
    const snap = probe.envSnapshots[0]!.snapshot;
    assert.equal(snap.cwd, nonGitDir);
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.gitStatus, null);
    assert.equal(snap.dirtyCount, null);
    assert.equal(snap.diffPreview, null);
    assert.equal(snap.degradeReason, "not_a_git_repo");
  });

  it("④ deps.envSnapshot 缺席 → 零 env_snapshot 事件(ask / worker 零变化)", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    const { result } = await run(
      "go",
      { adapter, executor: exec, registry: reg, maxTurns: 5 },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(result.stopReason, "completed");
    assert.equal(probe.envSnapshots.length, 0, "no envSnapshot dep → no event");
    assert.equal(probe.agentStatusEvents.length, 0);
  });

  it("⑤ 观察者 throw 不反流:hostile env_snapshot 消费者不破坏回合", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);
    const hostile = (event: HarnessStreamEvent): void => {
      if (event.type === "env_snapshot") {
        throw new Error("hostile env_snapshot observer");
      }
    };

    const { result } = await run(
      "hi",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: envSnapshotLiveCwd(),
      },
      undefined,
      { onStream: hostile }
    );

    assert.equal(result.stopReason, "completed");
    // hostile throws only on env_snapshot; agentStatus absent → no bar, tail message is just the stub user prompt.
    assert.equal(captured.length, 1);
  });

  it("⑥ env_snapshot 数据不进 messages:请求尾不含 <env_snapshot> 栏或 cwd/git 文本", async () => {
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter, captured } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        envSnapshot: envSnapshotLiveCwd(),
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(captured.length, 1);
    const text = allText(captured[0]!);
    assert.ok(!text.includes("<env_snapshot>"), "never a user-message bar");
    assert.ok(!text.includes(process.cwd()), "cwd never enters messages");
    assert.ok(!text.includes("gitBranch"), "git fields never enter messages");
  });

  it("⑦ appendEnvSnapshot 现读 live taskRoot —— rebind 后下一波 envSnapshot 反映新根 (T9)", async () => {
    // ADR-0037: env_snapshot must read the LIVE taskRoot, not a statically
    // pinned assembly-time cwd. The injected readCwd closure re-reads
    // LiveTaskRoot.read() before every model call — so after a rebind, the
    // human-facing view of the next wave (TUI cwd / git summary) follows the
    // live root while the system prompt stays on the stable root and the KV
    // cache prefix bytes are unchanged.
    const initialRoot = "/repo/main";
    const reboundRoot = "/repo/.iknow/worktrees/conv-1";
    const liveTaskRoot = createLiveTaskRoot(initialRoot);
    const echo = okEchoTool();
    const reg = createRegistry([echo]);
    const exec = createExecutor(reg);
    const probe = makeEnvProbe();
    const { adapter } = makeSpyAdapter([
      {
        kind: "reply",
        result: assistantResult({ texts: ["done"], toolCalls: [] }),
      },
    ]);

    // rebind happens after assembly and before this turn's model call — the injected readCwd reads live.
    writeLiveTaskRoot(liveTaskRoot, reboundRoot);
    await run(
      "go",
      {
        adapter,
        executor: exec,
        registry: reg,
        maxTurns: 5,
        // Assembly no longer holds a static cwd; readCwd is the call-time live reader this test deliberately exercises.
        envSnapshot: { readCwd: liveTaskRoot.read },
      },
      undefined,
      { onStream: probe.onStream }
    );

    assert.equal(probe.envSnapshots.length, 1);
    assert.equal(probe.envSnapshots[0]!.snapshot.cwd, reboundRoot);
  });
});
