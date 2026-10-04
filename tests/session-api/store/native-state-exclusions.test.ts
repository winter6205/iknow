/**
 * Consumer-side exclusion validation for the persisted runtime/fact
 * representation (spec §2.3/§2.8, SC18; plan-review low finding "store does not
 * interpret `runtimeFacts` — exclusion enforced only by producer").
 *
 * The guard is EXECUTED, not documented: each case builds a crafted payload the
 * snapshot validator must reject, and asserts both the typed port outcome and
 * that no immutable body was written. A payload that is legitimate must still
 * pass, so the guard cannot degenerate into "reject everything".
 *
 * No real secret, key, or credential appears here: every credential-ish value
 * is a fabricated, obviously-fake placeholder.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { createNativeStatePort } from "../../../src/session-api/store/native-state-port-host.ts";
import {
  CURRENT_SCHEMA_VERSION,
  nativeStateBlobsDir,
  parseSessionJsonl,
  resolveConversationDir,
  SessionStore,
  type SessionFileV1,
} from "../../../src/session-api/store/index.ts";
import { forbiddenPersistedField } from "../../../src/session-api/store/native-state-store.ts";
import {
  isNativeStatePortError,
  type NativeStateSnapshot,
} from "../../../src/shared/native-state-port.ts";
import { readFile } from "node:fs/promises";

let baseDir: string;
let store: SessionStore;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-exclusions-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const sessionDirFor = (id: string): string =>
  resolveConversationDir({
    projectDir: store.getProjectDir(),
    conversationId: id,
  });

const jsonlFor = (id: string): string => join(sessionDirFor(id), `${id}.jsonl`);

const sampleFile = (id: string): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: id,
  title: "",
  cwd: "/tmp/test",
  sanitized_at: new Date().toISOString(),
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: new Date().toISOString(),
  checkpoints: [],
});

async function seedChain(id: string): Promise<string> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  });
  const head = parseSessionJsonl(await readFile(jsonlFor(id), "utf8")).head;
  assert.ok(head !== null, "fixture must have a persisted head");
  return head;
}

const baseSnapshot = (): NativeStateSnapshot => ({
  boundary: "input",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
});

/** Every immutable body written under the session, so "nothing was written" is
 *  checked on the filesystem rather than inferred from an error. */
async function writtenBodies(id: string): Promise<ReadonlyArray<string>> {
  try {
    return await readdir(nativeStateBlobsDir(sessionDirFor(id)));
  } catch {
    return [];
  }
}

async function rejectsValidation(
  id: string,
  anchorEventId: string,
  snapshot: NativeStateSnapshot
): Promise<void> {
  const before = await writtenBodies(id);
  const port = createNativeStatePort({ store });
  await assert.rejects(
    () =>
      port.publishNativeState({
        conversationId: id,
        anchorEventId,
        boundary: snapshot.boundary,
        snapshot,
      }),
    (err: unknown) => isNativeStatePortError(err) && err.code === "VALIDATION",
    "a rejected payload must be a typed VALIDATION failure"
  );
  assert.deepEqual(
    await writtenBodies(id),
    before,
    "the guard must reject BEFORE any write"
  );
}

describe("persisted-payload exclusions — credentials and secret registry", () => {
  it("(a) a credential-ish key in the opaque facts bag is VALIDATION and writes nothing", async () => {
    const id = "cred-bag";
    const anchor = await seedChain(id);
    await rejectsValidation(id, anchor, {
      ...baseSnapshot(),
      runtimeFacts: { apiKey: "sk-fake-placeholder-not-a-real-key" },
    });
  });

  it("(b) a credential nested deep inside the message payload is VALIDATION", async () => {
    const id = "cred-nested";
    const anchor = await seedChain(id);
    await rejectsValidation(id, anchor, {
      ...baseSnapshot(),
      runtimeFacts: {
        loop: { pending: { retry: { authorization: "Bearer fake" } } },
      },
    });
  });

  it("(c) a credential key smuggled onto a message object is VALIDATION", async () => {
    const id = "cred-on-message";
    const anchor = await seedChain(id);
    await rejectsValidation(id, anchor, {
      ...baseSnapshot(),
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          apiKey: "fake-placeholder",
        } as never,
      ],
    });
  });

  it("(d) the in-memory secret-roundtrip registry is VALIDATION", async () => {
    const id = "secret-registry";
    const anchor = await seedChain(id);
    await rejectsValidation(id, anchor, {
      ...baseSnapshot(),
      runtimeFacts: { secretRegistry: { fake: "fake" } },
    });
  });
});

describe("persisted-payload exclusions — live handles and grants", () => {
  it("(a) a live process handle is VALIDATION and writes nothing", async () => {
    const id = "live-handle";
    const anchor = await seedChain(id);
    await rejectsValidation(id, anchor, {
      ...baseSnapshot(),
      runtimeFacts: {
        worker: { process: { pid: 4242, startTime: 1, kill: () => undefined } },
      },
    });
  });

  it("(b) a bare handle / stream / timer key is VALIDATION", async () => {
    for (const key of ["handle", "stdin", "abortSignal", "timer"]) {
      const id = `handle-${key}`;
      const anchor = await seedChain(id);
      await rejectsValidation(id, anchor, {
        ...baseSnapshot(),
        runtimeFacts: { [key]: { close: () => undefined } },
      });
    }
  });

  it("(c) a process-memory permission grant is VALIDATION (SC18: allow-once is never restored)", async () => {
    const id = "allow-once";
    const anchor = await seedChain(id);
    await rejectsValidation(id, anchor, {
      ...baseSnapshot(),
      runtimeFacts: { permissionGrants: { "Bash(pwd)": "allow-once" } },
    });
  });

  it("(d) a worker fact carrying a handle in its process identity is VALIDATION", async () => {
    const id = "worker-handle";
    const anchor = await seedChain(id);
    await rejectsValidation(id, anchor, {
      ...baseSnapshot(),
      workers: [
        {
          kind: "worker_progress",
          taskId: "w1",
          ownership: "foreground",
          state: "running",
          process: {
            pid: 7,
            startTime: 1,
            kill: () => undefined,
          } as never,
        },
      ],
    });
  });
});

describe("persisted-payload exclusions — the guard is not a no-op", () => {
  it("(a) a legitimate worker process IDENTITY is accepted and written", async () => {
    const id = "identity-ok";
    const anchor = await seedChain(id);
    const port = createNativeStatePort({ store });
    const res = await port.publishNativeState({
      conversationId: id,
      anchorEventId: anchor,
      boundary: "input",
      snapshot: {
        ...baseSnapshot(),
        workers: [
          {
            kind: "worker_progress",
            taskId: "w1",
            ownership: "background",
            state: "running",
            process: { pid: 4242, startTime: 987654 },
          },
          {
            kind: "worker_progress",
            taskId: "w2",
            ownership: "foreground",
            state: "needs_handling",
            process: { pid: 4243, startTime: null },
          },
        ],
      },
    });

    assert.match(res.bodySha, /^[0-9a-f]{64}$/);
    assert.equal((await writtenBodies(id)).length, 1);
    const body = await store.readPublishedNativeStateBody({
      id,
      bodySha: res.bodySha,
    });
    assert.equal(
      body.workers?.[1]?.process?.startTime,
      null,
      "an unreadable start time stays null — never synthesized"
    );
  });

  it("(b) a clean payload reports no forbidden field, a crafted one names the path", () => {
    assert.equal(
      forbiddenPersistedField({
        assembly: { systemPrefix: "sys", skillIndexSeen: ["a"] },
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        workers: [
          {
            kind: "worker_progress",
            taskId: "w1",
            process: { pid: 1, startTime: null },
            transcriptPath: "/tmp/w1.jsonl",
          },
        ],
      }),
      null
    );
    assert.equal(
      forbiddenPersistedField({ a: { b: [{ apiKey: "fake" }] } }),
      "a.b[0].apiKey"
    );
  });

  it("(c) a tool argument's own keys are NOT scanned (that schema is the model's, not this layer's)", async () => {
    const id = "tool-arg-keys";
    const anchor = await seedChain(id);
    const port = createNativeStatePort({ store });
    // `read_mcp_resource`'s real input schema is {server, uri}: a guard that
    // matched `server` would reject a legitimate publication over a word in a
    // payload the model wrote, breaking the accepted-input checkpoint.
    const res = await port.publishNativeState({
      conversationId: id,
      anchorEventId: anchor,
      boundary: "input",
      snapshot: {
        ...baseSnapshot(),
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu-1",
                name: "read_mcp_resource",
                input: { server: "fake-mcp", uri: "fake://x", stream: false },
              },
            ],
          },
        ],
      },
    });
    assert.match(res.bodySha, /^[0-9a-f]{64}$/);
    assert.equal((await writtenBodies(id)).length, 1);
  });

  it("(d) a self-referential payload is rejected instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;
    assert.equal(forbiddenPersistedField(cyclic), "self");
  });

  it("(e) the READ path enforces the same exclusions (a hand-written body cannot smuggle one in)", async () => {
    const id = "read-path";
    const anchor = await seedChain(id);
    const { writeNativeStateBody } =
      await import("../../../src/session-api/store/native-state-store.ts");
    const bodySha = await writeNativeStateBody(
      sessionDirFor(id),
      JSON.stringify({
        ...baseSnapshot(),
        runtimeFacts: { apiKey: "fake-placeholder" },
      })
    );

    // The bytes are readable and well-formed JSON; only the exclusion stops it.
    await assert.rejects(
      () => store.readPublishedNativeStateBody({ id, bodySha }),
      (err: unknown) =>
        (err as { kind?: string }).kind === "schema_invalid" &&
        (err as { field?: string }).field === "runtimeFacts.apiKey"
    );
    assert.ok(anchor);
  });
});
