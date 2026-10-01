/**
 * T8 / SC12: the serve route's runtime evidence, read back off disk.
 *
 * `hub-violation.test.ts` pins the interruption *behavior* (streak, retention,
 * next-turn reset). This file pins the evidence contract on top of it: a
 * safety-interrupted turn must be reconstructable from the JSONL alone, and a
 * reviewer must be able to name, for every cancelled item, its owner and
 * whether its teardown was actually confirmed.
 *
 * The hub runs real against a real SessionStore and the production JSONL trace
 * service, in a temp directory (test.md: exercise the real store and
 * filesystem, never the repo's data/). Only the model and the tools are stubs.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  resolveConversationTraceFilePath,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { assistantResult } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;
let traceDir: string;
let convId: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-trace-evidence-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
  traceDir = baseDir;
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const DENIAL = "[hard_wall] dangerous command rejected";

/**
 * Deps whose turn launches one worker and one finite background job and then
 * hard-denies three times.
 *
 * Ownership is registered the way production registers it: the turn-work
 * ledger reads a `task_id` out of a *successful* tool result, so the launcher
 * tools answer with one and the denial tool throws. Nothing here reaches into
 * the hub's internals — the hub wraps this executor with its own per-turn
 * scope, and the ids below land in that real registry because the real
 * wrapper put them there.
 */
function makeDeps(): LoopEngineDeps {
  const deny = createStubTool({
    name: "dangerous",
    next: () => {
      throw new ToolExecutionError(DENIAL);
    },
  });
  const spawn = createStubTool({
    name: "spawn_subagent",
    next: () => ({ task_id: "worker-1" }),
  });
  const background = createStubTool({
    name: "bash",
    next: () => ({ task_id: "bg-1" }),
  });
  const registry = createRegistry([deny, spawn, background]);
  const adapter = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "u1", name: "spawn_subagent", input: {} }],
      }),
      assistantResult({
        texts: [],
        toolCalls: [
          { id: "u2", name: "bash", input: { command: "sleep 30", background: true } },
        ],
      }),
      assistantResult({
        texts: [],
        toolCalls: [{ id: "u3", name: "dangerous", input: {} }],
      }),
      assistantResult({
        texts: [],
        toolCalls: [{ id: "u4", name: "dangerous", input: {} }],
      }),
      assistantResult({
        texts: [],
        toolCalls: [{ id: "u5", name: "dangerous", input: {} }],
      }),
      // Reached only if the third denial really stopped the turn.
      assistantResult({ texts: ["second turn"] }),
    ],
  });
  return { adapter, executor: createExecutor(registry), registry, maxTurns: 8 };
}

function rowsOf(file: string): Array<Record<string, unknown>> {
  return file
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("Serve route: interrupted-turn evidence is reconstructable from the JSONL", () => {
  it("names the turn, the cause, every cancelled item's owner, and each cleanup verdict", async () => {
    const hub = new SessionHub({
      store,
      workspaceRoot: process.cwd(),
      deps: makeDeps(),
      traceOut: traceDir,
    });
    const created = await hub.createSession();
    convId = created.session.conversation_id;
    await hub.postMessage({ conversationId: convId, text: "go" });

    const tracePath = resolveConversationTraceFilePath({
      projectDir: store.getProjectDir(),
      conversationId: convId,
    });
    expect(existsSync(tracePath)).toBe(true);
    const rows = rowsOf(await readFile(tracePath, "utf8"));

    // ── Step 1: find the structured report row (the one carrying cleanup).
    const violations = rows.filter((r) => r["record_type"] === "violation");
    const report = violations.find(
      (v) => v["confirmed_violations"] !== undefined && "cleanup" in v
    );
    expect(report).toBeDefined();

    // ── Step 2: the cause, read without touching the displayed outcome.
    expect(report!["tier"]).toBe("mid");
    expect(report!["tool"]).toBe("dangerous");
    expect(report!["message"]).toContain("hard_wall");
    expect(report!["confirmed_violations"]).toBe(3);

    // ── Step 3: bind the report to a concrete turn row.
    const turnId = report!["turn_id"] as string;
    expect(typeof turnId).toBe("string");
    const turn = rows.find(
      (r) => r["record_type"] === "turn" && r["turn_id"] === turnId
    );
    expect(turn).toBeDefined();
    // The interrupted turn's own outcome is in the trace, not just on screen.
    expect(turn!["decision"]).toBe("cancelled");

    // ── Step 4: the offending calls, joined to the turn.
    const toolRows = rows.filter(
      (r) =>
        r["record_type"] === "tool_call" &&
        (turn!["tool_call_ids"] as string[]).includes(r["tool_call_id"] as string)
    );
    expect(toolRows.length).toBeGreaterThan(0);
    // Each denial is on the trace as a policy fact, with no cause invented:
    // a gate verdict is recorded, not adjudicated.
    for (const row of toolRows) {
      expect(row["tool_kind"]).toBe("execution_failed");
      expect((row["error"] as { message: string }).message).toContain(
        "hard_wall"
      );
      expect("cause" in row).toBe(false);
    }

    // ── Step 5: per-item owner identity + cleanup verdict.
    const cleanup = report!["cleanup"] as Array<Record<string, unknown>>;
    expect(cleanup.map((c) => c["id"]).sort()).toEqual(["bg-1", "worker-1"]);

    const bg = cleanup.find((c) => c["id"] === "bg-1")!;
    expect(bg["kind"]).toBe("background_task");
    // This hub has no background manager, so the plane's route is absent. The
    // registry reports `unconfirmed` with the typed cause rather than
    // reporting a stop nobody observed — the exact honesty the spec requires.
    expect(bg["state"]).toBe("unconfirmed");
    expect(bg["reason"]).toBe("no_background_cancel_route");
    expect(bg["cleanup"]).toEqual({ state: "not_started" });

    const worker = cleanup.find((c) => c["id"] === "worker-1")!;
    expect(worker["kind"]).toBe("subagent");
    // A signalled child is `stop_requested`, NOT `confirmed_stopped`: the
    // worker plane returns "a signal went out" and must never claim an exit it
    // did not observe. With no manager registered the route is absent, so the
    // registry reports unconfirmed rather than fabricating either verdict.
    expect(["stop_requested", "unconfirmed"]).toContain(worker["state"]);
    expect(worker["cleanup"]).toEqual({ state: "not_started" });
    // And nothing anywhere on the item claims a confirmed stop.
    expect(JSON.stringify(worker)).not.toContain("confirmed_stopped");
  });
});

describe("Serve route: a lost trace is reported, not silently treated as success", () => {
  it("a hub whose trace writes fail reports the failure through getTraceWriteFailures", async () => {
    // The spec's explicit requirement: missing/failed trace evidence must be
    // covered, never quietly read as "the run produced evidence".
    //
    // The failure is established on the real filesystem the writer uses, not
    // by injecting a fake writer: a regular file sits exactly where the trace
    // directory must be, so mkdirSync of the target dir raises ENOTDIR on
    // every recordXxx. The turn still completes — observability never breaks
    // the route — and the health counter is what says the evidence is gone.
    const blocked = await mkdtemp(join(tmpdir(), "iknow-hub-trace-blocked-"));
    const projectDir = resolveProjectSessionDir(blocked, process.cwd());
    const blockedStore = new SessionStore(blocked, process.cwd());
    try {
      const hub = new SessionHub({
        store: blockedStore,
        workspaceRoot: process.cwd(),
        deps: makeDeps(),
        traceOut: blocked,
      });
      const created = await hub.createSession();
      const id = created.session.conversation_id;
      // Occupy the conversation's trace path with a directory, so the
      // writer's `appendFileSync` onto it raises EISDIR on every record.
      await mkdir(
        resolveConversationTraceFilePath({ projectDir, conversationId: id }),
        { recursive: true }
      );
      const answer = await hub.postMessage({ conversationId: id, text: "go" });

      // The served turn still answers — the turn reached its own stop and
      // projected a turn DTO back.
      expect(answer.turn.query).toBe("go");
      expect(answer.turn.answer.outcome).toBeDefined();
      // And the failure is counted rather than swallowed: a reviewer looking
      // at the health endpoint sees the evidence is missing.
      expect(hub.getTraceWriteFailures()).toBeGreaterThan(0);
    } finally {
      await rm(blocked, { recursive: true, force: true });
    }
  });

  it("a hub without traceOut writes no trace file and reports no failure", async () => {
    // The other half of the same contract: "no trace configured" is not a
    // failure. Without this, the counter above could not be read as evidence
    // of a lost trace rather than of a route that never intended one.
    const scratch = await mkdtemp(join(tmpdir(), "iknow-hub-trace-absent-"));
    try {
      resolveProjectSessionDir(scratch, process.cwd());
      const noTraceStore = new SessionStore(scratch, process.cwd());
      const hub = new SessionHub({
        store: noTraceStore,
        workspaceRoot: process.cwd(),
        deps: makeDeps(),
      });
      const created = await hub.createSession();
      const id = created.session.conversation_id;
      await hub.postMessage({ conversationId: id, text: "go" });

      expect(
        existsSync(
          resolveConversationTraceFilePath({
            projectDir: noTraceStore.getProjectDir(),
            conversationId: id,
          })
        )
      ).toBe(false);
      expect(hub.getTraceWriteFailures()).toBe(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
