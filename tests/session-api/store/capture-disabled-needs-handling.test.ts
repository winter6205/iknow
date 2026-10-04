/**
 * SC9a end to end, with a real crash and a real second process.
 * `specs/session-checkpoint-architecture.md:161` — "Capture disabled: set the
 * existing `codeRestore.enabled` policy to false without changing settings
 * schema. The existing write path remains available, no new code snapshot is
 * created, and a fresh process reports the effect as unverified/needs handling
 * rather than inferring completion or retrying it."
 *
 * The four halves, each asserted on the surface an operator actually reads:
 *   (a) the write path stays available — the write lands on disk;
 *   (b) no code snapshot and no preimage body is created for that write;
 *   (c) the fresh process reports the status an operator sees: `needs handling`
 *       with the real `capture_disabled` classification
 *       (`src/session-api/store/recovery-status.ts`), rendered through the
 *       production renderer `formatChatRecoveryStatus` — not a private flag;
 *   (d) recovery neither infers completion (matching bytes prove nothing once
 *       capture was suppressed — `recovery-status.ts:43`) nor retries the write
 *       (a post-crash edit by someone else survives the reopen untouched).
 *
 * The writer is a REAL `SessionHub` whose only difference from a default host
 * is the existing `codeRestore.enabled` policy set to false — no new settings
 * key, no mocked capture, no stubbed tool. The write goes through the hub's own
 * tool executor, the surface the model drives, so no provider is involved (the
 * seam `tests/session-api/hub-file-intent.test.ts` already documents).
 *
 * The host that dies is a real forked child, SIGKILLed to its process group at
 * its first main-loop model dispatch; the reopen is a SECOND real process
 * reading the same real temp pool. Both halves run the reused harness
 * `tests/session-api/crash/crash-harness.ts`, unmodified.
 *
 * On the live root identity: the writer host stamps the target with its own
 * derivation (`SessionHub.rootIdentityFor`), and the harness supplies the
 * reopen with the live identity it was created with. The two differ here, and
 * that difference is not what these cases claim: `capture_disabled` is
 * precedence 1 of the documented table
 * (`src/session-api/store/recovery-reconcile.ts:200`), reached only when
 * `captured === false`, so the reported reason identifies the capture gate and
 * nothing else. Flip the policy to `enabled: true` and this same fixture
 * reports `root_identity_mismatch` instead — the reason discriminates.
 */
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { formatChatRecoveryStatus } from "../../../src/cli/chat-session.ts";
import type { IknowSettings } from "../../../src/config/settings.js";
import type { LoopEngineDeps } from "../../../src/harness/index.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import { SessionHub } from "../../../src/session-api/hub.ts";
import {
  codeSnapshotDir,
  codeSnapshotSha,
} from "../../../src/session-api/store/code-snapshot-store.ts";
import {
  parseSessionJsonl,
  type ParsedSessionLog,
  type SessionFileIntentRecord,
} from "../../../src/session-api/store/jsonl.ts";
import type { RecoveredFileOperation } from "../../../src/session-api/store/recovery-reconcile.ts";
import type { RecoveryStatus } from "../../../src/session-api/store/recovery-status.ts";
import type {
  RestoredTurnOutcome,
  SessionRecoveryReport,
} from "../../../src/session-api/store/recovery.ts";
import { SessionStore } from "../../../src/session-api/store/session-store.ts";
import type { NativeStateMessage } from "../../../src/shared/native-state-port.ts";
import {
  createCrashHost,
  disposeAllCrashHosts,
  realConversationDir,
  realLogBytes,
  realLogPath,
  realSessionFingerprint,
  runHostToCrashPoint,
  runRoleInFreshProcess,
  type CrashHost,
} from "../crash/crash-harness.ts";

const CRASH_TEST_TIMEOUT = 180_000;

const TARGET = "off.ts";
const WRITE = "payload written under the opt-out\n";
const TOOL_USE_ID = "sc9a-tu-1";

const toolUseMsg = (id: string) => ({
  role: "assistant" as const,
  content: [
    {
      type: "tool_use" as const,
      id,
      name: "write_file",
      input: { path: TARGET },
    },
  ],
});

interface ReopenResult {
  readonly status: RecoveryStatus;
  readonly savedMessageCount: number;
  readonly restoredContext: ReadonlyArray<NativeStateMessage> | null;
  readonly messages: ReadonlyArray<NativeStateMessage>;
  readonly outcome: RestoredTurnOutcome | null;
  readonly operations: ReadonlyArray<RecoveredFileOperation>;
  readonly tripwire: {
    readonly armed: boolean;
    readonly hits: ReadonlyArray<{ code: string; op_index: number }>;
  };
}

/** The exact report the fresh process printed for the operator: the production
 *  renderer fed the second process's own report. `runtime` /
 *  `operationFacts` are null there (not serialized by the harness child) and
 *  the operator line reads neither. */
const operatorLine = (conversationId: string, reopened: ReopenResult): string =>
  formatChatRecoveryStatus({
    conversationId,
    status: reopened.status,
    messages: reopened.messages,
    savedMessageCount: reopened.savedMessageCount,
    operations: reopened.operations,
    outcome: reopened.outcome ?? { state: "unknown", reason: "no_record" },
    runtime: null,
    operationFacts: null,
  } satisfies SessionRecoveryReport);

async function codeSnapshotEntries(
  host: CrashHost
): Promise<ReadonlyArray<string>> {
  try {
    return (await readdir(codeSnapshotDir(realConversationDir(host)))).sort();
  } catch {
    return [];
  }
}

const ensureDeps = (hub: SessionHub, root: string): Promise<LoopEngineDeps> =>
  (
    hub as unknown as { ensureDeps: (root?: string) => Promise<LoopEngineDeps> }
  ).ensureDeps.bind(hub)(root);

interface CrashedSession {
  readonly host: CrashHost;
  readonly log: ParsedSessionLog;
  readonly record: SessionFileIntentRecord;
}

/**
 * A real host takes the input, publishes a state, dies on SIGKILL; a real
 * `write_file` under the existing opt-out then records an uncaptured intent on
 * the surviving head, exactly as the host would after its crash.
 */
async function crashThenWriteWithCaptureOff(
  conversationId: string
): Promise<CrashedSession> {
  const host = await createCrashHost({ prefix: "iknow-sc9a-", conversationId });

  const crashed = await runHostToCrashPoint({
    host,
    crashPoint: "first_model_dispatch",
    request: { role: "chat_turn", line: `write ${TARGET}` },
  });
  assert.equal(crashed.signal, "SIGKILL", "the host must die abnormally");

  // Production order: the assistant response carrying the tool_use is
  // committed before the tool runs, so the intent anchors post-anchor and no
  // tool_result ever lands.
  await new SessionStore(host.sessionPoolDir, host.workspaceRoot).appendEvents({
    id: conversationId,
    events: [toolUseMsg(TOOL_USE_ID)],
  });

  const settings = {
    codeRestore: { enabled: false },
  } as IknowSettings;
  const hub = new SessionHub({
    store: new SessionStore(host.sessionPoolDir, host.workspaceRoot),
    askUser: createNoAskUser(),
    workspaceRoot: host.workspaceRoot,
    settings,
  });
  await hub.bindWorkspace(host.workspaceRoot);
  const deps = await ensureDeps(hub, host.workspaceRoot);
  const [result] = await deps.executor.executeAll(
    [
      {
        id: TOOL_USE_ID,
        name: "write_file",
        input: { path: TARGET, content: WRITE },
      },
    ],
    undefined,
    undefined,
    conversationId
  );
  assert.equal(result.kind, "ok", `the write of ${TARGET} must stay available`);

  const log = parseSessionJsonl(await realLogBytes(host));
  const records = log.records.filter(
    (r): r is SessionFileIntentRecord => r.type === "file_intent"
  );
  assert.equal(records.length, 1, "one intent record for the one write");
  return { host, log, record: records[0]! };
}

afterEach(async () => {
  await disposeAllCrashHosts();
});

describe("SC9a capture disabled, operator-visible in a fresh process", () => {
  it(
    "SC9a (a)(b)(c): the write lands, no snapshot body exists, and a fresh process reports needs handling",
    async () => {
      const { host, record } = await crashThenWriteWithCaptureOff(
        "sc9a-needs-handling"
      );

      // (a) The existing write path remained available under the opt-out.
      assert.equal(
        await readFile(join(host.workspaceRoot, TARGET), "utf8"),
        WRITE
      );

      // (b) No code snapshot / preimage body for this write: the record claims
      // no evidence, and the snapshot dir holds nothing.
      const target = record.targets[0]!;
      assert.equal(
        record.captured,
        false,
        "capture was suppressed, not the write"
      );
      assert.equal(target.relPath, TARGET);
      assert.equal(target.preimageSha, undefined);
      assert.equal(target.postimageSha, undefined);
      const snapshotEntries = await codeSnapshotEntries(host);
      assert.ok(
        !snapshotEntries.includes(codeSnapshotSha(WRITE)),
        "the write's postimage bytes were never stored as a recoverable body"
      );
      assert.deepEqual(
        snapshotEntries,
        [],
        "no code snapshot body was created for the write"
      );

      // (c) The second real process's report, as an operator reads it.
      const before = await realSessionFingerprint(host);
      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: { role: "reopen_chat" },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });

      assert.equal(reopened.status.status, "needs handling");
      assert.deepEqual(reopened.status.handling, [
        {
          relPath: TARGET,
          reason: "capture_disabled",
          toolUseId: TOOL_USE_ID,
        },
      ]);
      assert.deepEqual(
        reopened.operations[0]?.targets.map((t) => t.state),
        ["needs_handling"],
        "no target claims a verified effect while capture was suppressed"
      );
      assert.equal(
        reopened.operations[0]?.needsOperatorAction,
        true,
        "the call is left for an operator, not resolved"
      );
      assert.equal(
        reopened.operations[0]?.settlement,
        "unknown",
        "the call never settled: its effect is unverified"
      );
      const line = operatorLine(host.conversationId, reopened);
      assert.match(line, /^\[recovery\] needs handling — /);
      assert.ok(
        line.includes(`${TARGET} (capture_disabled, ${TOOL_USE_ID})`),
        `operator line must name the real classification, got: ${line}`
      );
      assert.ok(
        line.includes("需人工确认后再继续"),
        `operator line must reach the operator instruction, got: ${line}`
      );
      assert.equal(reopened.tripwire.armed, true);
      assert.deepEqual(reopened.tripwire.hits, []);
      assert.equal(
        await realSessionFingerprint(host),
        before,
        "the reopen neither wrote into the session nor created a checkpoint"
      );
      assert.equal(
        realLogPath(host).includes(host.root),
        true,
        "the session log lives under the real temp pool root"
      );
    },
    CRASH_TEST_TIMEOUT
  );

  it(
    "SC9a (d) no inferred completion: bytes that match the write still report needs handling",
    async () => {
      const { host } = await crashThenWriteWithCaptureOff("sc9a-no-inference");
      // The postimage the write left, re-stated after the crash: the recovery
      // side must still refuse to read it as proof, because nothing was
      // captured to compare.
      await writeFile(join(host.workspaceRoot, TARGET), WRITE, "utf8");

      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: { role: "reopen_chat" },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });

      assert.equal(reopened.status.status, "needs handling");
      assert.equal(reopened.status.handling[0]?.reason, "capture_disabled");
      assert.deepEqual(
        reopened.operations[0]?.targets.map((t) => t.state),
        ["needs_handling"],
        "matching bytes are never read as a verified effect"
      );
    },
    CRASH_TEST_TIMEOUT
  );

  it(
    "SC9a (d) no retry: a post-crash edit by someone else survives the reopen untouched",
    async () => {
      const { host } = await crashThenWriteWithCaptureOff("sc9a-no-retry");
      await writeFile(
        join(host.workspaceRoot, TARGET),
        "SOMEONE ELSE EDITED\n",
        "utf8"
      );
      const before = await readFile(join(host.workspaceRoot, TARGET), "utf8");

      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: { role: "reopen_chat" },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });

      assert.equal(reopened.status.status, "needs handling");
      assert.equal(
        await readFile(join(host.workspaceRoot, TARGET), "utf8"),
        before,
        "needs handling never overwrites the drifted bytes — no retry, no restore"
      );
      assert.deepEqual(
        await codeSnapshotEntries(host),
        [],
        "the reopen regenerated no preimage body to retry the write with"
      );
    },
    CRASH_TEST_TIMEOUT
  );
});
