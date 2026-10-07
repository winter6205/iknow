/**
 * ADR-0127 parent-owned review broker tests (fake-spawn PassThrough style,
 * manager.test.ts precedent — no real child processes).
 *
 * Acceptance coverage:
 *  - a worker review_request reaches the parent host route and the answer
 *    returns to the correct worker call over that child's stdin
 *    (wait:false parity: the relay is manager-owned, identical either way);
 *  - two concurrent workers: approving one never satisfies the other;
 *  - missing broker_ready (headless parent) → no route, legacy stdin-end,
 *    worker-side denial;
 *  - disconnect (child exit mid-relay) / abortTask / shutdown / per-task
 *    timeout → every pending relay settles as a deny (host prompt released
 *    via the abort signal), with no answer relayed afterwards;
 *  - approvals are never persisted (a second request re-consults the host);
 *  - stray / duplicate request_ids never hijack an in-flight relay;
 *  - worker-side control unit: envelope-first stdin dispatch, per-request_id
 *    answer binding, fail-closed on window expiry / EOF / abort / timeout /
 *    stdout failure — and the ordinary ask inlet never participates.
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import {
  parseReviewRequestFrame,
  parseReviewResponseFrame,
  parseReviewBrokerReadyFrame,
  frameTag,
} from "../../src/harness/subagent/envelope.ts";
import type { ReviewRequestFrame } from "../../src/harness/subagent/envelope.ts";
import {
  attachWorkerStdinReader,
  createWorkerReviewControl,
} from "../../src/harness/subagent/worker.ts";
import type {
  SecurityReviewRequest,
  SecurityReviewRoute,
} from "../../src/harness/permission/security-review.ts";

// ── fakes ─────────────────────────────────────────────────────────────────────

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

/** Split a PassThrough's incoming bytes into complete lines (records frames
 *  the manager writes DOWN to the child). */
function lineRecorder(stream: PassThrough): string[] {
  const lines: string[] = [];
  let carry = "";
  stream.on("data", (chunk: Buffer | string) => {
    carry += chunk.toString("utf8");
    let idx: number;
    while ((idx = carry.indexOf("\n")) !== -1) {
      lines.push(carry.slice(0, idx));
      carry = carry.slice(idx + 1);
    }
  });
  return lines;
}

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RouteCall {
  readonly req: SecurityReviewRequest;
  /** Resolves the host promise — mirrors a human answering the prompt. */
  settle: (approved: boolean) => void;
}

/** Host route mock: records requests, exposes per-call resolvers, and honors
 *  the abort signal exactly like the fail-closed serve/TUI ask bridges. */
function makeRouteMock() {
  const calls: RouteCall[] = [];
  const route: SecurityReviewRoute = {
    interactive: true,
    request: (req) =>
      new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (v: boolean): void => {
          if (done) return;
          done = true;
          resolve(v);
        };
        req.signal?.addEventListener("abort", () => finish(false), {
          once: true,
        });
        calls.push({ req, settle: finish });
      }),
  };
  return { route, calls };
}

function makeHarness(
  opts: {
    readonly securityReview?: SecurityReviewRoute;
    readonly taskTimeoutMs?: number;
  } = {}
) {
  const spawned: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: (
      _def: SubAgentDefinition,
      _taskId: string,
      _payload: WorkerEnvelope
    ) => {
      const child = makeFakeChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    ...(opts.securityReview !== undefined
      ? { securityReview: opts.securityReview }
      : {}),
    ...(opts.taskTimeoutMs !== undefined
      ? { taskTimeoutMs: opts.taskTimeoutMs }
      : {}),
  });
  /** spawn is synchronous through the factory — spawned[i] is live on return. */
  const spawn = (task: string): { readonly taskId: string } =>
    manager.spawn({ task });
  return { manager, spawned, spawn };
}

function reviewFrameLine(
  overrides: Partial<ReviewRequestFrame> & { request_id: string }
): string {
  return (
    JSON.stringify({
      type: "review_request",
      tool: "bash",
      summary_hint: "rm -rf over unresolved receiver",
      cause: "receiver-unresolved",
      span: { start: 0, end: 12 },
      detail: "heredoc receiver missing",
      ...overrides,
    }) + "\n"
  );
}

// ── schema / frame sanity ─────────────────────────────────────────────────────

describe("ADR-0127 review frames (closed tagged members beside the frozen envelopes)", () => {
  it("envelopes carry no type tag — a frame line never parses as an envelope and vice versa", () => {
    assert.equal(
      frameTag('{"status":"ok","summary":"s","result":""}'),
      undefined
    );
    assert.equal(
      frameTag(reviewFrameLine({ request_id: "r1" })),
      "review_request"
    );
    assert.equal(
      frameTag('{"type":"review_broker_ready"}'),
      "review_broker_ready"
    );
    assert.equal(frameTag("not json"), undefined);
    assert.equal(frameTag("[1,2]"), undefined);
  });

  it("review_request frame schema is closed (unknown cause / extra keys rejected); response + ready parse", () => {
    const frame = parseReviewRequestFrame(
      reviewFrameLine({ request_id: "r1" }).trim()
    );
    assert.equal(frame.request_id, "r1");
    assert.throws(() =>
      parseReviewRequestFrame(
        JSON.stringify({
          type: "review_request",
          request_id: "r1",
          tool: "bash",
          summary_hint: "x",
          cause: "not-a-cause",
          span: { start: 0, end: 1 },
          detail: "d",
        })
      )
    );
    assert.throws(() =>
      parseReviewRequestFrame(
        JSON.stringify({
          type: "review_request",
          request_id: "r1",
          tool: "bash",
          summary_hint: "x",
          cause: "receiver-unresolved",
          span: { start: 0, end: 1 },
          detail: "d",
          extra_key: true,
        })
      )
    );
    assert.deepEqual(
      parseReviewBrokerReadyFrame('{"type":"review_broker_ready"}'),
      {
        type: "review_broker_ready",
      }
    );
    assert.deepEqual(
      parseReviewResponseFrame(
        '{"type":"review_response","request_id":"a","approved":true}'
      ),
      { type: "review_response", request_id: "a", approved: true }
    );
  });
});

// ── manager broker: capability + relay ────────────────────────────────────────

describe("manager review broker — capability declaration and answer relay", () => {
  it("with a host route: broker_ready follows the envelope line and stdin stays open", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({ securityReview: route });
    spawn("brokered");
    const child = spawned[0];
    const inbound = lineRecorder(child.stdin);
    await flush();
    assert.equal(frameTag(inbound[0]), undefined); // worker envelope: untagged
    assert.deepEqual(JSON.parse(inbound[1]), { type: "review_broker_ready" });
    assert.equal(child.stdin.writableEnded, false);
    assert.equal(calls.length, 0);
  });

  it("without a host route: legacy stdin-end and no capability marker", async () => {
    const { spawned, spawn } = makeHarness();
    spawn("headless");
    const child = spawned[0];
    const inbound = lineRecorder(child.stdin);
    await flush();
    assert.equal(inbound.length, 1);
    assert.equal(frameTag(inbound[0]), undefined);
    assert.equal(child.stdin.writableEnded, true);
  });

  it("a review_request reaches the host route decorated with task origin; the answer returns on this child's stdin", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({ securityReview: route });
    const { taskId } = spawn("relay");
    const child = spawned[0];
    const inbound = lineRecorder(child.stdin);
    child.stdout.write(reviewFrameLine({ request_id: "req-1" }));
    await flush();
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.req.requestId, "req-1");
    assert.equal(call.req.tool, "bash");
    assert.equal(call.req.requirement.cause, "receiver-unresolved");
    assert.equal(call.req.requirement.detail, "heredoc receiver missing");
    assert.match(
      call.req.summaryHint,
      new RegExp(`\\[subagent ${taskId.slice(0, 8)}\\]`)
    );
    call.settle(true);
    await flush();
    assert.deepEqual(parseReviewResponseFrame(inbound[inbound.length - 1]), {
      type: "review_response",
      request_id: "req-1",
      approved: true,
    });
  });

  it("concurrent requests from one worker are answered per request_id, never cross-bound", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({ securityReview: route });
    spawn("two");
    const child = spawned[0];
    const inbound = lineRecorder(child.stdin);
    child.stdout.write(reviewFrameLine({ request_id: "a" }));
    child.stdout.write(reviewFrameLine({ request_id: "b" }));
    await flush();
    assert.equal(calls.length, 2);
    calls[0].settle(true);
    await flush();
    assert.equal(inbound.length, 3); // envelope + broker_ready + answer(a)
    assert.deepEqual(parseReviewResponseFrame(inbound[inbound.length - 1]), {
      type: "review_response",
      request_id: "a",
      approved: true,
    });
    calls[1].settle(false);
    await flush();
    assert.deepEqual(parseReviewResponseFrame(inbound[inbound.length - 1]), {
      type: "review_response",
      request_id: "b",
      approved: false,
    });
  });

  it("two concurrent workers: approving one leaves the other pending and untouched", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({ securityReview: route });
    spawn("w1");
    spawn("w2");
    const [c1, c2] = spawned;
    const in1 = lineRecorder(c1.stdin);
    const in2 = lineRecorder(c2.stdin);
    c1.stdout.write(reviewFrameLine({ request_id: "w1-r1" }));
    c2.stdout.write(reviewFrameLine({ request_id: "w2-r1" }));
    await flush();
    assert.equal(calls.length, 2);
    calls[0].settle(true);
    await flush();
    assert.equal(in1.length, 3); // answer went down w1's pipe only
    assert.equal(in2.length, 2); // envelope + broker_ready, no answer
    assert.equal(
      parseReviewResponseFrame(in1[in1.length - 1]).request_id,
      "w1-r1"
    );
  });

  it("approvals are never persisted: an identical later request re-consults the host", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({ securityReview: route });
    spawn("nopersist");
    const child = spawned[0];
    child.stdout.write(reviewFrameLine({ request_id: "same-1" }));
    await flush();
    calls[0].settle(true);
    await flush();
    child.stdout.write(reviewFrameLine({ request_id: "same-2" }));
    await flush();
    assert.equal(calls.length, 2);
  });

  it("a duplicate in-flight request_id is denied outright, never hijacks the original", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({ securityReview: route });
    spawn("dup");
    const child = spawned[0];
    const inbound = lineRecorder(child.stdin);
    child.stdout.write(reviewFrameLine({ request_id: "dup1" }));
    child.stdout.write(reviewFrameLine({ request_id: "dup1" }));
    await flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(parseReviewResponseFrame(inbound[inbound.length - 1]), {
      type: "review_response",
      request_id: "dup1",
      approved: false,
    });
    inbound.length = 0;
    calls[0].settle(true);
    await flush();
    // the original still gets its own single true answer
    assert.deepEqual(parseReviewResponseFrame(inbound[inbound.length - 1]), {
      type: "review_response",
      request_id: "dup1",
      approved: true,
    });
  });

  it("rogue review_request against a route-less parent does not crash the manager (child has no route either)", async () => {
    const { manager, spawned, spawn } = makeHarness();
    spawn("rogue");
    const child = spawned[0];
    // legacy parent already ended stdin — a write-after-end must never throw
    // the manager (the worker on the other side has no route and denies by
    // construction).
    assert.doesNotThrow(() => {
      child.stdout.write(reviewFrameLine({ request_id: "rogue-1" }));
    });
    await flush();
    assert.equal(child.stdin.writableEnded, true);
    const info = manager.listSubagents().find((t) => t.state === "failed");
    assert.equal(
      info,
      undefined,
      "rogue frame alone does not terminalize the task"
    );
  });

  it("a malformed review frame is a protocolError (closed grammar)", async () => {
    const { route } = makeRouteMock();
    const { manager, spawned, spawn } = makeHarness({ securityReview: route });
    spawn("malformed");
    const child = spawned[0];
    child.stdout.write('{"type":"review_request","request_id":"x"}\n');
    await flush();
    const info = manager.listSubagents().find((t) => t.state === "failed");
    assert.ok(info, "task fails on a malformed frame line");
    assert.equal(info.reason, "protocolError");
  });

  it("an unknown tagged frame is a protocolError, not a silently swallowed line", async () => {
    const { route } = makeRouteMock();
    const { manager, spawned, spawn } = makeHarness({ securityReview: route });
    spawn("unknown-frame");
    const child = spawned[0];
    child.stdout.write('{"type":"review_something_else"}\n');
    await flush();
    const info = manager.listSubagents().find((t) => t.state === "failed");
    assert.equal(info?.reason, "protocolError");
  });
});

// ── disposal coverage: every pending relay denies ─────────────────────────────

describe("manager review broker — disposal settles pending relays with deny", () => {
  it("child exit mid-relay: host prompt is aborted, no answer is relayed after, stdin released", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({ securityReview: route });
    spawn("disconnect");
    const child = spawned[0];
    const inbound = lineRecorder(child.stdin);
    child.stdout.write(reviewFrameLine({ request_id: "d1" }));
    await flush();
    assert.equal(calls.length, 1);
    child.emit("exit", 0, null);
    await flush();
    assert.equal(calls[0].req.signal?.aborted, true);
    // A late human answer cannot resurrect the relay:
    calls[0].settle(true);
    await flush();
    const answers = inbound.filter((l) => frameTag(l) === "review_response");
    assert.equal(answers.length, 0);
    assert.equal(child.stdin.writableEnded, true);
  });

  it("abortTask cancels pending relays with deny", async () => {
    const { route, calls } = makeRouteMock();
    const { manager, spawned, spawn } = makeHarness({ securityReview: route });
    const { taskId } = spawn("abort");
    const child = spawned[0];
    child.stdout.write(reviewFrameLine({ request_id: "ab1" }));
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(manager.abortTask(taskId), true);
    assert.equal(calls[0].req.signal?.aborted, true);
  });

  it("shutdown settles pending relays even for children that never exit", async () => {
    const { route, calls } = makeRouteMock();
    const { manager, spawned, spawn } = makeHarness({ securityReview: route });
    spawn("shutdown");
    const child = spawned[0];
    child.stdout.write(reviewFrameLine({ request_id: "sd1" }));
    await flush();
    assert.equal(calls.length, 1);
    await manager.shutdown();
    assert.equal(calls[0].req.signal?.aborted, true);
  });

  it("per-task timeout settles pending relays with deny", async () => {
    const { route, calls } = makeRouteMock();
    const { spawned, spawn } = makeHarness({
      securityReview: route,
      taskTimeoutMs: 50,
    });
    spawn("task-timeout");
    const child = spawned[0];
    child.stdout.write(reviewFrameLine({ request_id: "tt1" }));
    await flush();
    assert.equal(calls.length, 1);
    await flush(150);
    assert.equal(calls[0].req.signal?.aborted, true);
  });

  it("a route that rejects is relayed back as an explicit deny", async () => {
    const seen: SecurityReviewRequest[] = [];
    const route: SecurityReviewRoute = {
      interactive: true,
      request: (req) => {
        seen.push(req);
        return Promise.reject(new Error("host prompt exploded"));
      },
    };
    const { spawned, spawn } = makeHarness({ securityReview: route });
    spawn("rejecting-route");
    const child = spawned[0];
    const inbound = lineRecorder(child.stdin);
    child.stdout.write(reviewFrameLine({ request_id: "rj1" }));
    await flush();
    assert.equal(seen.length, 1);
    assert.deepEqual(parseReviewResponseFrame(inbound[inbound.length - 1]), {
      type: "review_response",
      request_id: "rj1",
      approved: false,
    });
  });
});

// ── worker-side control channel ───────────────────────────────────────────────

describe("worker review control — end-to-end proof + fail-closed settles", () => {
  it("no broker_ready inside the window → waitForBrokerReady false (route never built)", async () => {
    const notes: string[] = [];
    const control = createWorkerReviewControl(
      () => {},
      (m) => notes.push(m)
    );
    assert.equal(await control.waitForBrokerReady(20), false);
  });

  it("stdin EOF settles the wait immediately with false (legacy / route-less parent)", async () => {
    const stdin = new PassThrough();
    const reader = attachWorkerStdinReader(stdin);
    stdin.write(JSON.stringify({ task: "t", sandboxRoot: "/tmp/x" }) + "\n");
    stdin.end();
    const envelopeLine = await reader.envelopeLine;
    assert.equal(JSON.parse(envelopeLine).task, "t");
    const control = createWorkerReviewControl(() => {});
    reader.attach(control);
    // 5s window would hang forever without the EOF-driven settle:
    assert.equal(await control.waitForBrokerReady(5_000), false);
  });

  it("broker_ready observed → true; requests bind answers by request_id only", async () => {
    const written: string[] = [];
    const notes: string[] = [];
    const control = createWorkerReviewControl(
      (line) => written.push(line),
      (m) => notes.push(m)
    );
    control.feed('{"type":"review_broker_ready"}');
    assert.equal(await control.waitForBrokerReady(20), true);
    const route = control.createRoute({ timeoutMs: 5_000 });
    assert.equal(route.interactive, true);
    // requestId is per-call; `base` holds only the shared half.
    const base: Omit<SecurityReviewRequest, "requestId"> = {
      requirement: {
        cause: "execution-unresolved",
        span: { start: 1, end: 5 },
        detail: "inner program not proven inert",
      },
      tool: "bash",
      input: { command: "rm $(resolve.sh)" },
      summaryHint: "unresolved execution target",
    };
    const p1 = route.request({ ...base, requestId: "w1" });
    const p2 = route.request({ ...base, requestId: "w2" });
    await flush();
    assert.equal(written.length, 2);
    const frame2 = parseReviewRequestFrame(written[1].trim());
    assert.equal(frame2.request_id, "w2");
    control.feed(
      JSON.stringify({
        type: "review_response",
        request_id: "no-such-id",
        approved: true,
      })
    );
    control.feed(
      JSON.stringify({
        type: "review_response",
        request_id: frame2.request_id,
        approved: true,
      })
    );
    assert.equal(await p2, true);
    // the stray id was a note, and p1 still waits for its own answer:
    assert.ok(notes.some((n) => n.includes("unknown/reused request_id")));
    let p1Settled = false;
    void p1.then(() => {
      p1Settled = true;
    });
    await flush();
    assert.equal(p1Settled, false);
    control.feed(
      JSON.stringify({
        type: "review_response",
        request_id: "w1",
        approved: false,
      })
    );
    assert.equal(await p1, false);
  });

  it("caller abort, channel close, and response timeout each settle false", async () => {
    const written: string[] = [];
    const control = createWorkerReviewControl((line) => written.push(line));
    control.feed('{"type":"review_broker_ready"}');
    assert.equal(await control.waitForBrokerReady(20), true);
    const route = control.createRoute({ timeoutMs: 60 });
    // requestId is per-call; `base` holds only the shared half.
    const base: Omit<SecurityReviewRequest, "requestId"> = {
      requirement: {
        cause: "bounded-analysis-exhausted",
        span: { start: 0, end: 2 },
        detail: "budget exhausted with open content",
      },
      tool: "bash",
      input: {},
      summaryHint: "bounded analysis exhausted",
    };
    const ctrl = new AbortController();
    const pAbort = route.request({
      ...base,
      requestId: "a1",
      signal: ctrl.signal,
    });
    const pClose = route.request({ ...base, requestId: "a2" });
    const pTimeout = route.request({ ...base, requestId: "a3" });
    await flush();
    assert.equal(written.length, 3);
    ctrl.abort();
    assert.equal(await pAbort, false);
    control.close();
    assert.equal(await pClose, false);
    assert.equal(await pTimeout, false);
  });

  it("stdout write failure denies the request (parent gone)", async () => {
    const control = createWorkerReviewControl(() => {
      throw new Error("stdout closed");
    });
    control.feed('{"type":"review_broker_ready"}');
    assert.equal(await control.waitForBrokerReady(20), true);
    const route = control.createRoute();
    assert.equal(
      await route.request({
        requirement: {
          cause: "data-ownership-unresolved",
          span: { start: 0, end: 1 },
          detail: "text not proven inert",
        },
        tool: "bash",
        input: {},
        summaryHint: "unresolved data ownership",
        requestId: "x1",
      }),
      false
    );
  });

  it("before broker_ready there is no route and requests cannot be phoned home", async () => {
    const written: string[] = [];
    const control = createWorkerReviewControl((line) => written.push(line));
    // No EOF / no ready — window expiry is the only settle path:
    assert.equal(await control.waitForBrokerReady(20), false);
    // even if a caller builds a route anyway (post-expiry), requests deny
    // without touching stdout (fail-closed, end-to-end proof missing):
    const route = control.createRoute({ timeoutMs: 20 });
    assert.equal(
      await route.request({
        requirement: {
          cause: "receiver-unresolved",
          span: { start: 0, end: 1 },
          detail: "receiver missing",
        },
        tool: "bash",
        input: {},
        summaryHint: "h",
        requestId: "z1",
      }),
      false
    );
    assert.equal(written.length, 0);
  });
});
