/**
 * ADR-0136 §4 at the host boundary: what session ENTRY hands the next turn.
 *
 * Three host-side claims, each against a real `SessionStore`, the real hub and
 * the real filesystem. The model is the only stub: a scripted adapter behind a
 * step observer, so "the next request saw the published body" is an
 * observation rather than an inference.
 *
 *  1. the next turn's model context is the PUBLISHED body, not the store's
 *     transcript projection (spec §2.1: "Do not rebuild from the transcript"),
 *     and a settled turn's own committed tail is never discarded;
 *  2. a corrupt committed mid-log record reaches the visible `blocked`
 *     classification instead of a raw store error (SC1a);
 *  3. the entry status carries the reconciled per-operation detail, so a
 *     `recovered` verdict can never hide the per-file facts behind it (SC11).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import { captureCodeSnapshot } from "../../src/session-api/store/code-snapshot-store.ts";
import {
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  SESSION_JSONL_EXT,
} from "../../src/session-api/store/index.ts";
import { mainCheckoutOf } from "../../src/harness/isolation/worktree-gate.ts";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-entry-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-hub-entry-root-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(baseDir, taskRoot);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string =>
  join(sessionDirFor(id), `${id}${SESSION_JSONL_EXT}`);

/** The hub's live root identity for this fixture (its `rootIdentityFor`). */
const liveRootIdentity = (): string => mainCheckoutOf(taskRoot);

/** Scripted deps plus a synchronous read of every request at dispatch time. */
function observingDeps(responses: AssistantTurnResult[]): {
  readonly deps: LoopEngineDeps;
  readonly requests: () => ReadonlyArray<ReadonlyArray<AnthropicNativeMessage>>;
} {
  const base = makeDeps(responses);
  const seen: Array<ReadonlyArray<AnthropicNativeMessage>> = [];
  const step = base.adapter.step.bind(base.adapter);
  return {
    deps: {
      ...base,
      adapter: {
        ...base.adapter,
        step: (...args: Parameters<typeof step>) => {
          seen.push(args[0].messages);
          return step(...args);
        },
      },
    },
    requests: () => seen,
  };
}

const makeHub = (deps: LoopEngineDeps): SessionHub =>
  new SessionHub({ store, deps, workspaceRoot: taskRoot });

/** Plain text of a request's text blocks, in order. */
const textsOf = (
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<string> =>
  messages.flatMap((m) =>
    m.content.filter((b) => b.type === "text").map((b) => b.text)
  );

const hasBlock = (
  messages: ReadonlyArray<AnthropicNativeMessage>,
  type: string
): boolean => messages.some((m) => m.content.some((b) => b.type === type));

describe("session entry seeds the next turn from the published state", () => {
  it("hands the model the published body, not the longer transcript (spec §2.1)", async () => {
    const { deps, requests } = observingDeps([
      assistantResult({ texts: ["answered one"] }),
      assistantResult({ texts: ["answered two"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "first input" });

    // The abnormal exit: a second host committed a tool_use and died before its
    // result. The store projection therefore holds a SYNTHESIZED closeout
    // tool_result for it (closeout-projection) — a fabrication the model must
    // never be shown, and post-anchor growth the published body excludes.
    await store.appendEvents({
      id,
      events: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t-orphan", name: "write_file", input: {} },
          ],
        },
      ],
    });
    const projection = await store.load(id);
    assert.ok(
      projection.messages.length > 2,
      "the transcript really is longer than the published body"
    );

    await hub.getSession(id);
    await hub.postMessage({ conversationId: id, text: "second input" });

    const first = requests()[1] ?? [];
    // The selected state is the turn's terminal boundary, so the assistant
    // answer is part of the restored context; what the transcript additionally
    // carried — the orphaned tool_use and its synthesized closeout
    // tool_result — is still not in the request.
    assert.deepEqual(
      textsOf(first),
      ["first input", "answered one", "second input"],
      "the next request is the published body plus the new input"
    );
    assert.equal(
      hasBlock(first, "tool_use"),
      false,
      "the dead turn's tool_use never enters the next request"
    );
    assert.equal(
      hasBlock(first, "tool_result"),
      false,
      "the synthesized closeout tool_result never enters the next request"
    );
  });

  it("keeps a settled turn's own committed answer as the next context", async () => {
    const { deps, requests } = observingDeps([
      assistantResult({ texts: ["answered one"] }),
      assistantResult({ texts: ["answered two"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "first input" });

    // A completed turn: its answer is committed AND settled, so the published
    // input boundary is an earlier boundary, not a loss. Dropping it would make
    // the model unable to see what it just said.
    await hub.getSession(id);
    await hub.postMessage({ conversationId: id, text: "second input" });

    assert.deepEqual(textsOf(requests()[1] ?? []), [
      "first input",
      "answered one",
      "second input",
    ]);
  });
});

describe("a damaged log reaches the visible blocked classification (SC1a)", () => {
  it("classifies a torn committed mid-log record instead of throwing a store error", async () => {
    const { deps } = observingDeps([
      assistantResult({ texts: ["answered one"] }),
    ]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    await hub.postMessage({ conversationId: id, text: "first input" });

    // Real damage: a committed event line torn mid-record. The transcript is
    // unreadable, so recovery must fail closed VISIBLY, not rebuild anything.
    const lines = (await readFile(jsonlFor(id), "utf8")).split("\n");
    lines[1] = '{"type":"message"';
    await writeFile(jsonlFor(id), lines.join("\n"), "utf8");

    const view = await hub.getSession(id);
    const recovery = view.session.recovery;
    assert.equal(recovery?.status, "blocked");
    assert.equal(
      recovery?.status === "blocked" ? recovery.reason : "",
      "session_log_corrupt"
    );
    assert.deepEqual(view.turns, [], "no transcript is reconstructed");
  });

  it("still reports a conversation that does not exist as not_found", async () => {
    const { deps } = observingDeps([]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    await assert.rejects(
      () => hub.getSession("never-created"),
      (err: unknown) => (err as { kind?: string }).kind === "not_found",
      "a missing conversation is an error, never a recovery state"
    );
  });
});

describe("the entry status carries the reconciled operations (SC11)", () => {
  it("reports each operation's settlement and per-file verdict on the wire", async () => {
    const { deps } = observingDeps([]);
    const hub = makeHub(deps);
    await hub.bindWorkspace(taskRoot);
    const { session } = await hub.createSession();
    const id = session.conversation_id;

    // The published body sits at the input boundary, so the write below is
    // genuinely post-anchor and has to be reconciled.
    await store.appendEvents({
      id,
      events: [
        { role: "user", content: [{ type: "text", text: "write a.ts" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-1", name: "write_file", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu-1", content: "wrote" },
          ],
        },
      ],
    });
    await store.appendNativeState({
      id,
      anchorEventId: "e0",
      boundary: "input",
      snapshot: {
        boundary: "input",
        messages: [
          { role: "user", content: [{ type: "text", text: "write a.ts" }] },
        ],
      },
    });
    const folder = sessionDirFor(id);
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [
        {
          relPath: "a.ts",
          rootIdentity: liveRootIdentity(),
          absentBefore: true,
          preimageSha: await captureCodeSnapshot(folder, ""),
          postimageSha: await captureCodeSnapshot(folder, "NEW BYTES"),
        },
      ],
    });
    await writeFile(join(taskRoot, "a.ts"), "NEW BYTES", "utf8");

    const view = await hub.getSession(id);
    const recovery = view.session.recovery as
      | {
          readonly status: string;
          readonly operations?: ReadonlyArray<{
            readonly toolUseId: string;
            readonly settlement: string;
            readonly targets: ReadonlyArray<{ readonly state: string }>;
            readonly needsOperatorAction: boolean;
          }>;
        }
      | undefined;
    assert.equal(recovery?.status, "recovered");
    assert.deepEqual(recovery?.operations, [
      {
        toolUseId: "tu-1",
        settlement: "settled_success",
        targets: [{ relPath: "a.ts", state: "verified_effect" }],
        needsOperatorAction: false,
      },
    ]);
    // Recovery reports; it never re-performs the write.
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "NEW BYTES");
  });
});
