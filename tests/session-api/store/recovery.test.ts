/**
 * Session-entry recovery: the status vocabulary, the restored SAVED context
 * (not a transcript projection), the terminal-outcome posture, and the
 * read-only / no-replay guarantee.
 *
 * Real temporary store, real body pool, real workspace files, real code
 * snapshot blobs: the repo's `data/` tree and any user session dir are never
 * touched. The two malformed-record cases (mid-log corruption, invalid
 * selected head) are hand-written lines and say so — a production writer
 * cannot emit them, which is the point of the case.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  recoverSession,
  RECOVERY_IN_PROGRESS_LABEL,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
  type SessionStoreError,
} from "../../../src/session-api/store/index.ts";
import { codeSnapshotSha } from "../../../src/session-api/store/code-snapshot-store.ts";
import type { FileIntentTarget } from "../../../src/session-api/store/jsonl.ts";
import type { NativeStateSnapshot } from "../../../src/shared/native-state-port.ts";

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;
const liveRootIdentity = "/live/main-checkout";

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });
const jsonlFor = (id: string): string => join(sessionDirFor(id), `${id}.jsonl`);

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-recovery-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-recovery-taskroot-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(baseDir, taskRoot);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

const sampleFile = (
  id: string,
  overrides: Partial<SessionFileV1> = {}
): SessionFileV1 =>
  ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: taskRoot,
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
    ...overrides,
  }) as SessionFileV1;

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
const assistantMsg = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});
const toolUseMsg = (id: string, name = "write_file") => ({
  role: "assistant" as const,
  content: [
    { type: "tool_use" as const, id, name, input: { file_path: "a.ts" } },
  ],
});
const toolResultMsg = (id: string, isError = false) => ({
  role: "user" as const,
  content: [
    {
      type: "tool_result" as const,
      tool_use_id: id,
      content: [{ type: "text" as const, text: isError ? "boom" : "ok" }],
      ...(isError ? { is_error: true } : {}),
    },
  ],
});

const snapshotOf = (
  messages: NativeStateSnapshot["messages"],
  overrides: Partial<NativeStateSnapshot> = {}
): NativeStateSnapshot => ({
  boundary: "input",
  messages,
  ...overrides,
});

/** New-format session with a published state anchored at the current head. */
async function seedPublished(
  id: string,
  opts: { readonly saved?: NativeStateSnapshot["messages"] } = {}
): Promise<{ readonly bodySha: string; readonly anchor: string }> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({
    id,
    events: [userMsg("accepted input"), assistantMsg("acknowledged")],
  });
  const saved = opts.saved ?? [userMsg("accepted input")];
  const published = await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "input",
    snapshot: snapshotOf(saved),
  });
  return { bodySha: published.bodySha, anchor: "e1" };
}

const captureTarget = async (
  id: string,
  over: Partial<FileIntentTarget> = {}
): Promise<FileIntentTarget> => {
  const { captureCodeSnapshot } =
    await import("../../../src/session-api/store/code-snapshot-store.ts");
  const sessionFolder = sessionDirFor(id);
  const pre = over.absentBefore === true ? null : "OLD BYTES";
  const post = "NEW BYTES";
  const target: FileIntentTarget = {
    relPath: "a.ts",
    rootIdentity: liveRootIdentity,
    absentBefore: false,
    preimageSha:
      pre === null ? undefined : await captureCodeSnapshot(sessionFolder, pre),
    postimageSha: await captureCodeSnapshot(sessionFolder, post),
    ...over,
  };
  return target;
};

const recover = (id: string) =>
  recoverSession({
    store,
    conversationId: id,
    taskRoot,
    liveRootIdentity,
  });

/** Every byte under the session folder, as path → content. The SC27
 *  "recovery wrote nothing" assertion compares this whole map before and
 *  after a repeated recovery. */
async function sessionTreeBytes(id: string): Promise<Record<string, string>> {
  const root = sessionDirFor(id);
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      out[full.slice(root.length)] = await readFile(full, "utf8");
    }
  };
  await walk(root);
  return out;
}

describe("recovery status vocabulary", () => {
  it("(a) exposes the host's in-progress transient as a label, not a result", () => {
    // Wave 3 renders this string while the call is in flight; recovery itself
    // must never return it as an outcome.
    assert.equal(RECOVERY_IN_PROGRESS_LABEL, "recovery in progress");
  });
});

describe("recoverSession format and publication gating", () => {
  it("(a) a new-format session with nothing published is no_published_state, not an error", async () => {
    const id = "no-published";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q")] });
    const report = await recover(id);
    assert.equal(report.status.status, "no_published_state");
    assert.deepEqual(report.messages, []);
    assert.equal(report.savedMessageCount, 0);
  });

  it("(b) an old-format session is unsupported_format and its bytes are untouched", async () => {
    const id = "old-format";
    await store.save({
      id,
      file: { ...sampleFile(id) } as SessionFileV1 & {
        nativeStateFormat?: number;
      },
    });
    // strip the key at the byte level: an old session file never had it
    const raw = await readFile(jsonlFor(id), "utf8");
    const legacy = raw.replace(/,"nativeStateFormat":\d+/, "");
    assert.ok(!legacy.includes("nativeStateFormat"), "fixture is old format");
    await writeFile(jsonlFor(id), legacy, "utf8");
    const before = await readFile(jsonlFor(id), "utf8");

    const report = await recover(id);
    assert.equal(report.status.status, "unsupported_format");
    assert.deepEqual(report.messages, []);
    assert.equal(
      await readFile(jsonlFor(id), "utf8"),
      before,
      "SC23: old bytes are not rewritten"
    );
  });

  it("(c) a selected state with nothing after it is recovered and carries the SAVED messages", async () => {
    const id = "clean";
    const saved = [userMsg("accepted input"), assistantMsg("echo")];
    await seedPublished(id, { saved });
    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.equal(report.savedMessageCount, 2);
    assert.deepEqual(report.messages, saved);
    assert.deepEqual(report.operations, []);
    assert.equal(report.outcome.state, "unknown");
  });
});

describe("recoverSession restored context is the saved state, not the transcript", () => {
  it("(a) post-anchor transcript events do not leak into the restored context", async () => {
    const id = "saved-only";
    const saved = [userMsg("accepted input")];
    await seedPublished(id, { saved });
    // Facts published AFTER the saved state: an assistant tool_use and its
    // settled result. They are reconcilable progress, not restored context.
    await store.appendEvents({
      id,
      events: [toolUseMsg("tu-1"), toolResultMsg("tu-1")],
    });

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.deepEqual(
      report.messages.map((m) => m.role),
      ["user"],
      "restored context is exactly the saved snapshot"
    );
    const raw = await readFile(jsonlFor(id), "utf8");
    assert.ok(raw.includes("tu-1"), "the later facts are still on disk");
  });
});

describe("recoverSession fails closed on unusable published state", () => {
  it("(a) a missing body blocks with the DISTINCT missing reason", async () => {
    const id = "body-missing";
    const { bodySha } = await seedPublished(id);
    await rm(join(sessionDirFor(id), "blobs", "native", bodySha));

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(
      report.status.status === "blocked" && report.status.reason,
      "published_state_body_missing"
    );
    assert.equal(
      report.status.status === "blocked" &&
        report.status.detail.includes(bodySha),
      true,
      "the detail names the absent content address"
    );
  });

  it("(b) damaged body bytes block as corrupt, not as missing", async () => {
    const id = "body-corrupt";
    const { bodySha } = await seedPublished(id);
    const bodyPath = join(sessionDirFor(id), "blobs", "native", bodySha);
    await writeFile(bodyPath, "{not json", "utf8");

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(
      report.status.status === "blocked" && report.status.reason,
      "published_state_body_corrupt"
    );
  });

  it("(c) a schema-invalid body blocks, and never falls back to an older state", async () => {
    const id = "body-invalid";
    const { bodySha } = await seedPublished(id);
    const bodyPath = join(sessionDirFor(id), "blobs", "native", bodySha);
    // parses as JSON, is not a native state
    await writeFile(bodyPath, JSON.stringify({ nope: true }), "utf8");

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(
      report.status.status === "blocked" && report.status.reason,
      "published_state_body_schema_invalid"
    );
  });

  it("(d) a corrupt committed mid-log record blocks as a corrupt log", async () => {
    const id = "log-corrupt";
    await seedPublished(id);
    // Hand-written: a production writer cannot emit a damaged committed line.
    const raw = await readFile(jsonlFor(id), "utf8");
    const lines = raw.split("\n");
    lines[1] = '{"type":"message"'; // torn committed event
    await writeFile(jsonlFor(id), lines.join("\n"), "utf8");

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(
      report.status.status === "blocked" && report.status.reason,
      "session_log_corrupt"
    );
    assert.ok(
      report.status.status === "blocked" && report.status.detail.length > 0,
      "the blocked status carries the codec's own detail"
    );
  });

  it("(e) an invalid selected head blocks instead of silently selecting nothing", async () => {
    const id = "bad-head";
    await seedPublished(id);
    // Hand-written tail: a head record naming an event that does not exist.
    await writeFile(
      jsonlFor(id),
      `${await readFile(jsonlFor(id), "utf8")}${JSON.stringify({
        type: "head",
        id: "e999",
      })}\n`,
      "utf8"
    );

    const report = await recover(id);
    assert.equal(report.status.status, "blocked");
    assert.equal(
      report.status.status === "blocked" && report.status.reason,
      "selected_head_invalid"
    );
  });

  it("(f) an unknown conversation propagates the store's typed not_found", async () => {
    await assert.rejects(recover("no-such-conversation"), (err: unknown) => {
      const e = err as SessionStoreError;
      assert.equal(e.kind, "not_found");
      assert.equal(e.conversation_id, "no-such-conversation");
      return true;
    });
  });
});

/** The real store with ONE hook: once the published body has been read, the
 *  session log is replaced by a DIRECTORY on the real filesystem, so the
 *  head-chain read that follows it fails with a genuine EISDIR. Every store
 *  method is the real one — only the filesystem changes. */
class LogFaultStore extends SessionStore {
  fault: (() => Promise<void>) | null = null;

  override async readPublishedNativeStateBody(opts: {
    readonly id: string;
    readonly bodySha: string;
  }): Promise<NativeStateSnapshot> {
    const snapshot = await super.readPublishedNativeStateBody(opts);
    await this.fault?.();
    return snapshot;
  }
}

describe("recoverSession IO faults are not relabelled", () => {
  it("(a) an unreadable log propagates the real read fault, not session_log_corrupt", async () => {
    const id = "log-io-fault";
    await seedPublished(id);
    const logPath = jsonlFor(id);
    const faulted = new LogFaultStore(baseDir, taskRoot);
    faulted.fault = async () => {
      await rm(logPath, { force: true });
      await mkdir(logPath); // a directory where the log file belongs
    };

    await assert.rejects(
      recoverSession({
        store: faulted,
        conversationId: id,
        taskRoot,
        liveRootIdentity,
      }),
      (err: unknown) => {
        assert.equal(
          (err as NodeJS.ErrnoException).code,
          "EISDIR",
          "the operator must see the real read fault, not a claim that the log is damaged"
        );
        return true;
      }
    );
  });
});

describe("recoverSession terminal outcome posture (SC6)", () => {
  it("(a) a settled terminal outcome is reported with its own stop reason", async () => {
    const id = "outcome-settled";
    await seedPublished(id);
    await store.appendOutcome({ id, turnId: "e1", stopReason: "completed" });
    const report = await recover(id);
    assert.deepEqual(report.outcome, {
      state: "settled",
      turnEventId: "e1",
      stopReason: "completed",
    });
  });

  it("(b) a missing outcome stays unknown and is never projected as completed", async () => {
    const id = "outcome-missing";
    await seedPublished(id);
    // assistant text that reads like a completion must not become an outcome
    await store.appendEvents({ id, events: [assistantMsg("all done!")] });
    const report = await recover(id);
    assert.deepEqual(report.outcome, {
      state: "unknown",
      reason: "no_record",
    });
  });

  it("(c) an outstanding operation withholds the outcome even when a record exists", async () => {
    const id = "outcome-outstanding";
    await seedPublished(id);
    const target = await captureTarget(id);
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [target],
    });
    await store.appendOutcome({ id, turnId: "e1", stopReason: "completed" });

    const report = await recover(id);
    assert.equal(report.status.status, "needs handling");
    assert.deepEqual(report.outcome, {
      state: "unknown",
      reason: "operation_outstanding",
    });
  });
});

describe("recoverSession is read-only and repeatable (SC27, SC14)", () => {
  it("(a) two recoveries over one injected exit produce an identical report and write nothing", async () => {
    const id = "repeat";
    await seedPublished(id);
    const target = await captureTarget(id);
    // The abnormal exit: the tool_use is committed, the intent is durable, the
    // bytes landed, and the tool result was never recorded.
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [target],
    });
    await writeFile(join(taskRoot, "a.ts"), "NEW BYTES", "utf8");

    const sessionBefore = await sessionTreeBytes(id);
    const headBefore = await store.readHead(id);
    const fileBefore = await readFile(join(taskRoot, "a.ts"), "utf8");
    const mtimeBefore = (await stat(join(taskRoot, "a.ts"))).mtimeMs;

    const first = await recover(id);
    const second = await recover(id);

    assert.deepEqual(
      second,
      first,
      "SC27: a repeated recovery reports exactly the same classification"
    );
    assert.deepEqual(
      await sessionTreeBytes(id),
      sessionBefore,
      "SC27: no record, receipt, checkpoint or blob was added"
    );
    assert.equal(
      await store.readHead(id),
      headBefore,
      "SC14: recovery never moves the rewind head"
    );
    assert.equal(
      await readFile(join(taskRoot, "a.ts"), "utf8"),
      fileBefore,
      "SC14: recovery performs no file mutation"
    );
    assert.equal(
      (await stat(join(taskRoot, "a.ts"))).mtimeMs,
      mtimeBefore,
      "the target was not even re-written with identical bytes"
    );
  });

  it("(b) a recovery that ends in needs handling stays in needs handling on reopen", async () => {
    const id = "sticky-handling";
    await seedPublished(id);
    const target = await captureTarget(id);
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [target],
    });
    // drifted bytes: neither recorded image
    await writeFile(join(taskRoot, "a.ts"), "SOMEONE ELSE EDITED", "utf8");

    const first = await recover(id);
    assert.equal(first.status.status, "needs handling");
    const second = await recover(id);
    assert.deepEqual(second.status, first.status);
    assert.equal(
      await readFile(join(taskRoot, "a.ts"), "utf8"),
      "SOMEONE ELSE EDITED",
      "needs handling never overwrites the drifted bytes"
    );
  });

  it("(c) the restored state is not replaced by a projection of the full transcript", async () => {
    const id = "not-projection";
    await seedPublished(id, { saved: [userMsg("accepted input")] });
    await store.appendEvents({
      id,
      events: [assistantMsg("second turn"), userMsg("later input")],
    });
    const report = await recover(id);
    assert.equal(report.messages.length, 1);
    const file = await store.load(id);
    assert.equal(
      file.messages.length,
      4,
      "the transcript is longer than the restored context — they are not the same projection"
    );
  });
});

describe("recoverSession session tmp (SC13)", () => {
  it("(a) real session-tmp content is reread in place: no tmp checkpoint, no copy", async () => {
    const id = "tmp";
    await seedPublished(id);
    // The production session-scoped host directory, with real dispensable
    // intermediates in it.
    const { mainSessionFenceTmpPath } =
      await import("../../../src/harness/sandbox/fence-tmp.ts");
    const tmpDir = mainSessionFenceTmpPath(sessionDirFor(id));
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, "scratch-a"), "INTERMEDIATE", "utf8");
    const before = await sessionTreeBytes(id);

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.deepEqual(
      await sessionTreeBytes(id),
      before,
      "SC13: recovery neither checkpoints nor copies session tmp"
    );
  });

  it("(b) a missing tmp directory is not progress and does not change the status", async () => {
    const id = "tmp-missing";
    await seedPublished(id);
    const { mainSessionFenceTmpPath } =
      await import("../../../src/harness/sandbox/fence-tmp.ts");
    const tmpDir = mainSessionFenceTmpPath(sessionDirFor(id));
    await assert.rejects(stat(tmpDir), "the fixture must have no tmp dir");

    const report = await recover(id);
    assert.equal(report.status.status, "recovered");
    assert.equal(report.savedMessageCount, 1);
    // Recovery creates nothing: the dispensable dir is still absent, and the
    // saved progress is the published state alone.
    await assert.rejects(stat(tmpDir));
  });
});

describe("recoverSession input contract", () => {
  it("(a) an empty conversationId is rejected, not silently defaulted", async () => {
    await assert.rejects(recover(""), (err: unknown) => {
      const e = err as { kind?: string };
      assert.ok(
        e.kind === "missing_root" || e.kind === "invalid_root",
        `expected a root rejection, got ${JSON.stringify(e)}`
      );
      return true;
    });
  });
});

describe("recoverSession body-address integrity", () => {
  it("(a) a postimage blob whose recorded sha names bytes the pool does not hold blocks as missing", async () => {
    const id = "blob-missing";
    await seedPublished(id);
    const sessionFolder = sessionDirFor(id);
    const { captureCodeSnapshot } =
      await import("../../../src/session-api/store/code-snapshot-store.ts");
    const realSha = await captureCodeSnapshot(sessionFolder, "REAL");
    await store.appendEvents({ id, events: [toolUseMsg("tu-1")] });
    await store.appendFileIntent({
      id,
      toolUseId: "tu-1",
      captured: true,
      targets: [
        {
          relPath: "a.ts",
          rootIdentity: liveRootIdentity,
          absentBefore: true,
          preimageSha: realSha,
          postimageSha: codeSnapshotSha("NEVER STORED"),
        },
      ],
    });

    const report = await recover(id);
    assert.equal(report.status.status, "needs handling");
    assert.equal(
      report.status.status === "needs handling" &&
        report.status.handling[0]?.reason,
      "body_missing"
    );
  });
});
