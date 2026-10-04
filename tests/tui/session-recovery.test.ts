/**
 * tests/tui/session-recovery.test.ts (bun:test)
 *
 * Session-ENTRY recovery on the TUI open path (ADR-0136 §4, SC1a / SC23 / SC27):
 *  - the restored state is the SAVED native context read out of the published
 *    body, provably NOT a transcript projection (post-anchor log growth does
 *    not leak into it);
 *  - all five outcomes are distinguishable, with the handling paths named;
 *  - recovery runs no model request, no tool, and no file mutation — the
 *    rewind head and the workspace bytes survive it byte-identical (SC27);
 *  - a second open of the same session re-runs recovery without duplicating a
 *    record, re-publishing a state, or changing a file (SC27 tree bytes);
 *  - a path that never ran recovery carries no recovery field at all, so a
 *    non-entry reader can never read "not recovered" out of it.
 *
 * Real temp dirs, real production SessionStore, real body pool, real code
 * snapshot blobs, real workspace files. The model boundary is the stub deps
 * object (`makeDeps([])`), which THROWS on any request — so a recovery that
 * made one would fail the test rather than pass it quietly. The repo's `data/`
 * tree and any user session dir are never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import {
  attachSession,
  recoveryNoticeLines,
  type TuiSessionRecovery,
} from "../../src/tui/session-state.js";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
import { mainCheckoutOf } from "../../src/harness/isolation/worktree-gate.js";
import { captureCodeSnapshot } from "../../src/session-api/store/code-snapshot-store.js";
import {
  NATIVE_STATE_FORMAT_VERSION,
  RECOVERY_IN_PROGRESS_LABEL,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/schema.js";
import type { FileIntentTarget } from "../../src/session-api/store/jsonl.js";
import type { NativeStateSnapshot } from "../../src/shared/native-state-port.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let taskRoot: string;
let projectDir: string;
let store: SessionStore;
let bridge: TuiBridge;

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});
const assistantMsg = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
});
const toolUseMsg = (id: string) => ({
  role: "assistant" as const,
  content: [
    {
      type: "tool_use" as const,
      id,
      name: "write_file",
      input: { file_path: "a.ts" },
    },
  ],
});

const sampleFile = (
  id: string,
  over: Partial<SessionFileV1> = {}
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
    ...over,
  }) as SessionFileV1;

const sessionDirFor = (id: string): string =>
  resolveConversationDir({ projectDir, conversationId: id });

const snapshotOf = (
  messages: NativeStateSnapshot["messages"]
): NativeStateSnapshot => ({ boundary: "input", messages });

/** New-format session whose published body anchors at the current head. */
async function seedPublished(
  id: string,
  saved: NativeStateSnapshot["messages"]
): Promise<void> {
  await seedPublishedReturningBody(id, saved);
}

async function seedPublishedReturningBody(
  id: string,
  saved: NativeStateSnapshot["messages"] = [userMsg("accepted input")],
  over: Partial<SessionFileV1> = {}
): Promise<{ readonly bodySha: string }> {
  await store.save({ id, file: sampleFile(id, over) });
  await store.appendEvents({
    id,
    events: [userMsg("accepted input"), assistantMsg("acknowledged")],
  });
  const published = await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "input",
    snapshot: snapshotOf(saved),
  });
  return { bodySha: published.bodySha };
}

const recover = async (id: string): Promise<TuiSessionRecovery> =>
  (await bridge.openSession(id)).recovery;

/** Every byte under the session folder, as relative path → content. */
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

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-recovery-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-tui-recovery-root-"));
  projectDir = resolveProjectSessionDir(baseDir, taskRoot);
  store = new SessionStore(
    baseDir,
    deriveProjectIdentityRoot({ cwd: taskRoot })
  );
  // makeDeps([]): the stub adapter throws "scripted responses exhausted" on
  // ANY model request, so recovery reaching the adapter fails these tests.
  bridge = createTuiBridge({
    dataDir: baseDir,
    workspaceRoot: taskRoot,
    deps: makeDeps([]),
    inflight: createInflightRegistry(),
  });
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

describe("TUI session open restores the SAVED native context", () => {
  test("SC1a: restored context is the published body, not the transcript projection", async () => {
    const id = "restored-is-published";
    const saved = [userMsg("accepted input")];
    await seedPublished(id, saved);

    const report = await recover(id);
    expect(report.status.status).toBe("recovered");
    expect(report.messages).toEqual(saved);

    const attached = attachSession(await bridge.loadSessionFile(id), report);
    // The display keeps the transcript projection …
    expect(attached.messages).toHaveLength(2);
    // … while the restored state is the SAVED body.
    expect(attached.recovery?.messages).toEqual(saved);
    expect(attached.recovery?.savedMessageCount).toBe(1);
  });

  test("log growth after the published state does not leak into the restored context", async () => {
    const id = "post-anchor-growth";
    const saved = [userMsg("accepted input")];
    await seedPublished(id, saved);
    // Post-anchor log growth: the transcript projection now holds 4 messages
    // while the published body still holds 1.
    await store.appendEvents({
      id,
      events: [
        toolUseMsg("t1"),
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "t1",
              content: [{ type: "text" as const, text: "wrote" }],
            },
          ],
        },
      ],
    });

    const { file, recovery } = await bridge.openSession(id);
    expect(file?.messages).toHaveLength(4);

    const attached = attachSession(file!, recovery);
    expect(attached.messages).toHaveLength(4);
    expect(attached.recovery?.messages).toEqual(saved);
    expect(attached.recovery?.messages).toHaveLength(1);
  });

  test("a read path that never ran recovery carries no recovery field", async () => {
    const id = "no-recovery-field";
    await seedPublished(id, [userMsg("accepted input")]);
    const attached = attachSession(await bridge.loadSessionFile(id));
    expect(attached.recovery).toBeUndefined();
    expect(recoveryNoticeLines(attached)).toEqual([]);
  });
});

describe("TUI recovery status vocabulary is visibly distinct", () => {
  test("recovered names the restored count, and the unsaved post-anchor gap", async () => {
    const id = "status-recovered";
    await seedPublished(id, [userMsg("accepted input")]);
    await store.appendEvents({
      id,
      events: [assistantMsg("later"), userMsg("more")],
    });

    const { file, recovery } = await bridge.openSession(id);
    const attached = attachSession(file!, recovery);
    const lines = recoveryNoticeLines(attached);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("restored 1 saved message");
    expect(lines.join("\n")).toContain(
      "3 unsaved messages after the last checkpoint"
    );
  });

  test("needs handling names the affected operation path and the reason", async () => {
    const id = "status-handling";
    await seedPublished(id, [userMsg("accepted input")]);
    // The abnormal exit: the tool_use is committed, the intent is durable, the
    // bytes landed, and the tool result was never recorded.
    await store.appendEvents({ id, events: [toolUseMsg("t-write")] });
    const sessionFolder = sessionDirFor(id);
    const target: FileIntentTarget = {
      relPath: "a.ts",
      rootIdentity: deriveProjectIdentityRoot({ cwd: taskRoot }),
      absentBefore: false,
      preimageSha: await captureCodeSnapshot(sessionFolder, "OLD BYTES"),
      postimageSha: await captureCodeSnapshot(sessionFolder, "NEW BYTES"),
    };
    await store.appendFileIntent({
      id,
      toolUseId: "t-write",
      targets: [target],
      captured: true,
    });
    await writeFile(join(taskRoot, "a.ts"), "NEW BYTES", "utf8");

    const attached = attachSession(
      await bridge.loadSessionFile(id),
      await recover(id)
    );
    expect(attached.recovery?.status.status).toBe("needs handling");
    const text = recoveryNoticeLines(attached).join("\n");
    expect(text).toContain("needs 1 item");
    expect(text).toContain("a.ts");
    expect(text).toContain("tool_outcome_unknown");
    expect(text).toContain("no file was changed");
    // Fail closed on the mutation side: the live bytes are left as the crash
    // left them.
    expect(await readFile(join(taskRoot, "a.ts"), "utf8")).toBe("NEW BYTES");
  });

  test("blocked fails closed, names the reason, and restores nothing", async () => {
    const id = "status-blocked";
    const { bodySha } = await seedPublishedReturningBody(id);
    // The selected checkpoint's body is gone: recovery must block rather than
    // fall back to transcript reconstruction or an older state.
    await rm(join(sessionDirFor(id), "blobs", "native", bodySha));

    const report = await recover(id);
    expect(report.status.status).toBe("blocked");
    expect(report.messages).toEqual([]);
    expect(report.savedMessageCount).toBe(0);

    const text = recoveryNoticeLines(
      attachSession(await bridge.loadSessionFile(id), report)
    ).join("\n");
    expect(text).toContain("Recovery blocked");
    expect(text).toContain("published_state_body_missing");
    expect(text).toContain("nothing was restored");
    expect(text).toContain("Nothing was reverted");
  });

  test("unsupported_format leaves the old bytes alone and offers the new-session path", async () => {
    const id = "status-unsupported";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q"), assistantMsg("a")] });
    // An old session file never carried the format stamp: strip it at the byte
    // level, which is the only honest way to present one.
    const jsonlPath = join(sessionDirFor(id), `${id}.jsonl`);
    const legacy = (await readFile(jsonlPath, "utf8")).replace(
      /,"nativeStateFormat":\d+/,
      ""
    );
    expect(legacy).not.toContain("nativeStateFormat");
    await writeFile(jsonlPath, legacy, "utf8");
    const before = await sessionTreeBytes(id);

    const report = await recover(id);
    expect(report.status.status).toBe("unsupported_format");
    expect(await sessionTreeBytes(id)).toEqual(before);

    const text = recoveryNoticeLines(
      attachSession(await bridge.loadSessionFile(id), report)
    ).join("\n");
    expect(text).toContain("predates recoverable checkpoints");
    expect(text).toContain("/new");
  });

  test("no_published_state reads as a non-error", async () => {
    const id = "status-none";
    await store.save({ id, file: sampleFile(id) });
    await store.appendEvents({ id, events: [userMsg("q")] });

    const report = await recover(id);
    expect(report.status.status).toBe("no_published_state");
    const text = recoveryNoticeLines(
      attachSession(await bridge.loadSessionFile(id), report)
    ).join("\n");
    expect(text).toContain("no saved checkpoint yet");
    expect(text).not.toContain("blocked");
  });

  test("the in-flight transient is a label, never an outcome", async () => {
    expect(RECOVERY_IN_PROGRESS_LABEL).toBe("recovery in progress");
    const id = "never-outcome";
    await seedPublished(id, [userMsg("accepted input")]);
    const report = await recover(id);
    expect(JSON.stringify(report.status)).not.toContain(
      RECOVERY_IN_PROGRESS_LABEL
    );
  });
});

describe("TUI recovery runs nothing and writes nothing (SC23 / SC27)", () => {
  test("SC27: opening twice leaves the session tree byte-identical", async () => {
    const id = "repeat-open";
    await seedPublished(id, [userMsg("accepted input")]);
    const first = await recover(id);
    const before = await sessionTreeBytes(id);

    const second = await recover(id);
    expect(second.status).toEqual(first.status);
    expect(second.messages).toEqual(first.messages);
    expect(await sessionTreeBytes(id)).toEqual(before);
  });

  test("the rewind head and the workspace file survive recovery untouched", async () => {
    const id = "no-mutation";
    await seedPublished(id, [userMsg("accepted input")]);
    const workspaceFile = join(taskRoot, "a.ts");
    await writeFile(workspaceFile, "WORKSPACE BYTES\n", "utf8");
    const jsonlPath = join(sessionDirFor(id), `${id}.jsonl`);
    const beforeHead = (await readFile(jsonlPath, "utf8"))
      .split("\n")
      .filter(Boolean).length;
    const beforeTree = await sessionTreeBytes(id);

    await recover(id);

    expect(
      (await readFile(jsonlPath, "utf8")).split("\n").filter(Boolean).length
    ).toBe(beforeHead);
    expect(await sessionTreeBytes(id)).toEqual(beforeTree);
    expect(await readFile(workspaceFile, "utf8")).toBe("WORKSPACE BYTES\n");
  });

  test("a legacy JSON-only session opens and classifies as unsupported_format", async () => {
    // Reachable from the picker: the store's `load` reads a session whose log
    // is still a bare `.json`, while the published-state read finds no log to
    // read a checkpoint out of. The open must still succeed.
    const id = "legacy-json-only";
    const dir = resolveConversationDir({ projectDir, conversationId: id });
    await mkdir(dir, { recursive: true });
    const file = sampleFile(id, {
      messages: [userMsg("legacy-q"), assistantMsg("legacy-a")],
    });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({ ...file, nativeStateFormat: undefined }, null, 2),
      "utf8"
    );

    const opened = await bridge.openSession(id);
    expect(opened.file?.messages.length ?? 0).toBeGreaterThan(0);
    expect(opened.recovery.status.status).toBe("unsupported_format");
    expect(opened.recovery.messages).toEqual([]);
    const text = recoveryNoticeLines(
      attachSession(opened.file!, opened.recovery)
    ).join("\n");
    expect(text).toContain("predates recoverable checkpoints");
    expect(text).toContain("/new");
  });

  test("an unknown conversation id propagates the store's typed error", async () => {
    await expect(recover("never-created")).rejects.toThrow();
  });
});

describe("a damaged log opens as blocked, not as a store error (SC1a)", () => {
  test("a torn committed mid-log record is classified, and no transcript is returned", async () => {
    const id = "log-corrupt";
    await seedPublished(id, [userMsg("accepted input")]);
    // Real damage: a committed event line torn mid-record. A strict load throws
    // `parse_failed`, so an entry surface that loads first can never reach the
    // required visible `blocked`.
    const jsonlPath = join(sessionDirFor(id), `${id}.jsonl`);
    const lines = (await readFile(jsonlPath, "utf8")).split("\n");
    lines[1] = '{"type":"message"';
    await writeFile(jsonlPath, lines.join("\n"), "utf8");

    const opened = await bridge.openSession(id);
    expect(opened.file).toBeNull();
    // The strict projection read still fails, which is why entry classification
    // cannot be layered on top of it: the status has to come from the contract.
    await expect(bridge.loadSessionFile(id)).rejects.toMatchObject({
      kind: "parse_failed",
    });
    expect(opened.recovery.status).toMatchObject({
      status: "blocked",
      reason: "session_log_corrupt",
    });
    expect(opened.recovery.restoredContext).toBeNull();

    // The operator still gets the one-line status in the existing notice lane.
    const linesOut = recoveryNoticeLines({
      messages: [],
      recovery: opened.recovery,
    }).join("\n");
    expect(linesOut).toContain("Recovery blocked (session_log_corrupt)");
    expect(linesOut).toContain("nothing was restored");
  });
});

describe("the entry status carries the reconciled operations (SC11)", () => {
  test("a verified target is named in the same one-line status", async () => {
    const id = "verified-effect";
    await seedPublished(id, [userMsg("accepted input")]);
    // Post-anchor: a settled tool plus a target whose live bytes match the
    // recorded postimage. The operation is reconciled, never re-performed.
    await store.appendEvents({
      id,
      events: [
        toolUseMsg("t1"),
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "t1",
              content: [{ type: "text" as const, text: "wrote" }],
            },
          ],
        },
      ],
    });
    const folder = sessionDirFor(id);
    await writeFile(join(taskRoot, "a.ts"), "NEW BYTES", "utf8");
    const rootIdentity = mainCheckoutOf(
      deriveProjectIdentityRoot({ cwd: taskRoot })
    );
    await store.appendFileIntent({
      id,
      toolUseId: "t1",
      captured: true,
      targets: [
        {
          relPath: "a.ts",
          rootIdentity,
          absentBefore: true,
          preimageSha: await captureCodeSnapshot(folder, ""),
          postimageSha: await captureCodeSnapshot(folder, "NEW BYTES"),
        },
      ],
    });

    const report = await recover(id);
    expect(report.status.status).toBe("recovered");
    // M11: the operations arrive on the TUI shape without a hand-written field
    // list, and the notice names the file behind the verdict.
    expect(report.operations).toEqual([
      {
        toolUseId: "t1",
        settlement: "settled_success",
        targets: [{ relPath: "a.ts", state: "verified_effect" }],
        needsOperatorAction: false,
      },
    ]);
    const text = recoveryNoticeLines({
      messages: [],
      recovery: report,
    }).join("\n");
    expect(text).toContain("1 file operation");
    expect(text).toContain("a.ts=verified_effect");
    // Recovery reports; it never re-performs the write.
    expect(await readFile(join(taskRoot, "a.ts"), "utf8")).toBe("NEW BYTES");
  });
});

describe("the next turn starts from the published state (H1)", () => {
  test("the dead turn's tool_use and the synthesized closeout never reach the model", async () => {
    const id = "next-turn-seeds-published";
    const saved = [userMsg("first input")];
    // The session is bound to the workspace, as a real created session is:
    // postMessage refuses to execute an unbound session.
    await seedPublishedReturningBody(id, saved, { workspaceRoot: taskRoot });
    // The abnormal exit: a second host committed a tool_use and died before its
    // result, so the transcript projection holds a SYNTHESIZED closeout
    // tool_result for it.
    await store.appendEvents({ id, events: [toolUseMsg("t-orphan")] });
    const projection = await store.load(id);
    expect(projection.messages.length).toBeGreaterThan(saved.length);

    const seen: Array<
      ReadonlyArray<{
        readonly content: ReadonlyArray<{
          readonly type: string;
          readonly text?: string;
        }>;
      }>
    > = [];
    const base = makeDeps([assistantResult({ texts: ["answered"] })]);
    const step = base.adapter.step.bind(base.adapter);
    const scripted = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: taskRoot,
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
      inflight: createInflightRegistry(),
    });
    await scripted.hub.bindWorkspace(taskRoot);
    await scripted.openSession(id);
    await scripted.postMessage({ conversationId: id, text: "second input" });

    const request = seen[0] ?? [];
    expect(JSON.stringify(request)).not.toContain("t-orphan");
    expect(
      request.some((m) => m.content.some((b) => b.type === "tool_result"))
    ).toBe(false);
    const requestTexts = request.flatMap((m) =>
      m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    );
    expect(requestTexts).toEqual(["first input", "second input"]);
  });
});
