/**
 * The final SDK request is readable through the existing content axis
 * (Plan C task 3, SC22).
 *
 * An `llm_call` row's `dispatch_evidence` holds one entry per governed
 * invocation, each body content-addressed into the session pool. A reference is
 * not evidence: until the read side dereferences it, the exact request that was
 * dispatched exists on disk and no reader can see it. So these cases drive the
 * production writer, real pool files, and the production reader, and pin the
 * resolved entry per invocation — messages, system, and tool definitions.
 *
 * Nothing here mocks the reader or a deref step. The one injected seam is the
 * read side's own `readBlob` port, used to record which addresses were asked
 * for, never to supply content.
 */
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { writeTraceBody } from "../../src/harness/trace/trace-body.ts";
import type { DispatchEvidenceInput } from "../../src/harness/trace/types.ts";
import {
  TRACE_BODY_REPRESENTATION,
  type TraceBodyRef,
} from "../../src/shared/trace-body-contract.ts";
import {
  createGetRecordCore,
  type GetRecordCoreHandler,
} from "../../src/traceserver/get-record-core.ts";
import { dereferenceDispatchEvidenceWithStatus } from "../../src/traceserver/project-tool-results.ts";

const TEST_PROJECT_SLUG = "test-project-final-evidence";
/** Stands in for raw native recovery state; it shares the pool physically. */
const RAW_SECRET = "RAW-NATIVE-CHECKPOINT-SECRET";
/** The representation a foreign (raw) body would carry. */
const FOREIGN_REPRESENTATION = "raw-native-state";
const HEX = "0123456789abcdef".repeat(4);
const BASELINE_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "_fixtures",
  "full-mode-baseline.trace.jsonl"
);

const MESSAGES_A = [{ role: "user", content: [{ type: "text", text: "go" }] }];
const MESSAGES_B = [
  { role: "user", content: [{ type: "text", text: "go on" }] },
];
const SYSTEM_TEXT = "you are the harness";
const TOOLS = [{ name: "bash", description: "run a command" }];

const traceDirs: string[] = [];

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

function makeTraceDir(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-final-evidence-"));
  traceDirs.push(traceDir);
  return traceDir;
}

function sessionDir(traceDir: string, conversationId: string): string {
  return join(traceDir, "projects", TEST_PROJECT_SLUG, conversationId);
}

function core(traceDir: string): GetRecordCoreHandler {
  return createGetRecordCore({ traceDir });
}

/** A hand-built row, for the ref shapes the writer cannot produce. */
function writeRow(
  traceDir: string,
  conversationId: string,
  extra: Record<string, unknown>
): void {
  const dir = sessionDir(traceDir, conversationId);
  mkdirSync(dir, { recursive: true });
  const row = {
    record_type: "llm_call",
    conversation_id: conversationId,
    llm_call_id: "llm-1",
    turn_id: "turn-1",
    started_at: "2026-01-01T00:00:01.000Z",
    ...extra,
  };
  writeFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * One evidence body stored by the production body writer, so the ref on the row
 * is the shape a real `llm_call` carries. Identity mask: redaction is the
 * writer's own suite; what is under test here is which reference the reader may
 * follow.
 */
function evidenceBody(
  traceDir: string,
  conversationId: string,
  value: unknown
): TraceBodyRef {
  return writeTraceBody(sessionDir(traceDir, conversationId), value, (t) => t);
}

function ref(ref_: Record<string, unknown>): TraceBodyRef {
  return ref_ as unknown as TraceBodyRef;
}

async function readManifest(
  traceDir: string,
  conversationId: string,
  recordId = "llm-1",
  extra: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const raw = await core(traceDir)({
    conversation_id: conversationId,
    record_id: recordId,
    ...extra,
  });
  return JSON.parse(raw) as Record<string, unknown>;
}

function entriesOf(
  manifest: Record<string, unknown>
): ReadonlyArray<Record<string, unknown>> {
  return (manifest["final_request_evidence"] ?? []) as ReadonlyArray<
    Record<string, unknown>
  >;
}

/**
 * A row written by the real writer: the service is handed the session folder
 * itself, so bodies land in `<sessionDir>/blobs/` exactly as in production, then
 * the file is renamed to the read side's `trace.jsonl`.
 */
async function writeProductionRow(
  traceDir: string,
  conversationId: string,
  evidence: ReadonlyArray<DispatchEvidenceInput>,
  messages?: ReadonlyArray<unknown>
): Promise<string> {
  const dir = sessionDir(traceDir, conversationId);
  mkdirSync(dir, { recursive: true });
  const trace = createJsonlTraceService({
    filePath: dir,
    conversationId,
  });
  const id = await trace.recordLlmCall({
    startedAt: "2026-01-01T00:00:01.000Z",
    endedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 1000,
    stream: true,
    messagesCaptured: messages !== undefined,
    ...(messages === undefined ? {} : { messages }),
    status: "ok",
    dispatchEvidence: evidence,
  });
  assert.equal(typeof id, "string", "the writer retained the evidence");
  renameSync(join(dir, `${conversationId}.jsonl`), join(dir, "trace.jsonl"));
  return id!;
}

describe("final-request evidence — what the reader returns", () => {
  it("returns each invocation's dispatched request, in row order", async () => {
    const traceDir = makeTraceDir();
    const recordId = await writeProductionRow(traceDir, "c1", [
      {
        invocationId: "inv-1",
        stream: true,
        messages: MESSAGES_A,
        system: SYSTEM_TEXT,
        tools: TOOLS,
      },
      { invocationId: "inv-2", stream: false, messages: MESSAGES_B },
    ]);

    const manifest = await readManifest(traceDir, "c1", recordId);
    // The exact request object of the dispatch boundary, not the engine's
    // pre-projection state: resolved bodies, one entry per invocation.
    assert.deepEqual(entriesOf(manifest), [
      {
        invocationId: "inv-1",
        stream: true,
        messages: JSON.stringify(MESSAGES_A),
        system: SYSTEM_TEXT,
        tools: JSON.stringify(TOOLS),
      },
      {
        invocationId: "inv-2",
        stream: false,
        messages: JSON.stringify(MESSAGES_B),
      },
    ]);
    assert.equal(manifest["evidence_gap"], undefined);
  });

  it("omits the system and tools keys the invocation did not carry", async () => {
    // The writer leaves absent keys absent (never null, never an empty body),
    // so the reader must not invent an empty system instruction to fill a slot.
    const traceDir = makeTraceDir();
    const recordId = await writeProductionRow(traceDir, "c1", [
      { invocationId: "inv-sparse", stream: false, messages: MESSAGES_A },
    ]);

    const [entry] = entriesOf(await readManifest(traceDir, "c1", recordId));
    assert.deepEqual(Object.keys(entry!), [
      "invocationId",
      "stream",
      "messages",
    ]);
  });

  it("keeps the stored references readable alongside the resolved text", async () => {
    // The row's own `dispatch_evidence` is scalar passthrough, so the addresses
    // stay inspectable — the resolved field is added next to them, not over
    // them.
    const traceDir = makeTraceDir();
    const recordId = await writeProductionRow(traceDir, "c1", [
      { invocationId: "inv-1", stream: true, messages: MESSAGES_A },
    ]);

    const record = (await readManifest(traceDir, "c1", recordId))["record"] as
      Record<string, unknown> | undefined;
    const stored = (record!["dispatch_evidence"] ?? []) as Array<
      Record<string, unknown>
    >;
    assert.equal(stored.length, 1);
    assert.equal(
      (stored[0]!["messages"] as TraceBodyRef).representation,
      TRACE_BODY_REPRESENTATION
    );
  });

  it("adds nothing to a record that carries no dispatch_evidence", async () => {
    // The historical full-mode shape: inline messages, no bodies, no evidence.
    // Its manifest keys are byte-for-byte what they were.
    const traceDir = makeTraceDir();
    const dir = sessionDir(traceDir, "baseline-conv");
    mkdirSync(dir, { recursive: true });
    copyFileSync(BASELINE_FIXTURE, join(dir, "trace.jsonl"));

    const manifest = await readManifest(traceDir, "baseline-conv");
    assert.deepEqual(Object.keys(manifest), [
      "record",
      "matched_on",
      "detail",
      "parts",
    ]);
    assert.equal(manifest["evidence_gap"], undefined);
    assert.ok(!("final_request_evidence" in manifest));
  });

  it("leaves the window arm a character window, with text last", async () => {
    const traceDir = makeTraceDir();
    const recordId = await writeProductionRow(
      traceDir,
      "c1",
      [{ invocationId: "inv-1", stream: true, messages: MESSAGES_A }],
      MESSAGES_A
    );
    const manifest = await readManifest(traceDir, "c1", recordId, {
      detail: "messages",
    });
    const part = (manifest["parts"] as Array<Record<string, unknown>>)[0]!;
    const window = JSON.parse(
      await core(traceDir)({
        conversation_id: "c1",
        record_id: recordId,
        detail: "messages",
        message_index: 0,
        part_index: 0,
        count: part["chars"] as number,
      })
    ) as Record<string, unknown>;
    // The content axis pages content; full evidence rides the inventory arm
    // only, and the tail-cut contract of the window arm is untouched.
    assert.equal(
      Object.keys(window).at(-1),
      "text",
      "a face's tail-cut must hit the body, never the coordinates"
    );
    assert.ok(!("final_request_evidence" in window));
  });
});

describe("final-request evidence — one gate with the message refs", () => {
  it("refuses a traversing, non-hex, or foreign-tagged ref before any read", async () => {
    // The recorder proves the gate is pre-read, not "the read failed anyway":
    // a laxer evidence path would have asked for these addresses.
    const requested: string[] = [];
    const options = {
      traceFilePath: "/nonexistent/trace.jsonl",
      readBlob: (sha: string): string => {
        requested.push(sha);
        return JSON.stringify("read anyway");
      },
    };
    const refused = [
      `../code-snapshots/${HEX}`,
      `..%2f..%2f${HEX}`,
      HEX.toUpperCase(),
      HEX.slice(0, 32),
    ];

    for (const sha of refused) {
      requested.length = 0;
      const out = await dereferenceDispatchEvidenceWithStatus(
        [
          {
            invocationId: "inv-1",
            stream: true,
            messages: {
              sha,
              bytes: 10,
              representation: TRACE_BODY_REPRESENTATION,
            },
          },
        ],
        options
      );
      assert.deepEqual(out.entries, [], `sha ${sha} must not dereference`);
      assert.equal(out.evidenceGap, true);
      assert.deepEqual(requested, [], `sha ${sha} reached the body read`);
    }

    requested.length = 0;
    const foreign = await dereferenceDispatchEvidenceWithStatus(
      [
        {
          invocationId: "inv-1",
          stream: true,
          messages: {
            sha: HEX,
            bytes: 10,
            representation: FOREIGN_REPRESENTATION,
          },
        },
      ],
      options
    );
    assert.deepEqual(foreign.entries, []);
    assert.equal(foreign.evidenceGap, true);
    assert.deepEqual(
      requested,
      [],
      "a foreign representation reached the read"
    );
  });

  it("refuses an untagged evidence ref, which the writer never produces", async () => {
    // Message blobs keep the untagged legacy shape (ADR-0036/0071 residue);
    // `writeTraceBody` stamps the tag on every body, so an untagged evidence ref
    // names bytes nothing authorized.
    const traceDir = makeTraceDir();
    const body = evidenceBody(traceDir, "c1", ["unauthorized"]);
    const { representation: _omitted, ...untagged } = body;
    writeRow(traceDir, "c1", {
      dispatch_evidence: [
        { invocationId: "inv-1", stream: true, messages: untagged },
      ],
    });

    const manifest = await readManifest(traceDir, "c1");
    assert.deepEqual(entriesOf(manifest), []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
  });

  it("refuses a traversing ref that resolves to a raw native body", async () => {
    const traceDir = makeTraceDir();
    const dir = sessionDir(traceDir, "c1");
    const native = join(dir, "code-snapshots");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, HEX), JSON.stringify(RAW_SECRET), "utf8");
    writeRow(traceDir, "c1", {
      dispatch_evidence: [
        {
          invocationId: "inv-1",
          stream: true,
          messages: ref({
            sha: `../code-snapshots/${HEX}`,
            bytes: 10,
            representation: TRACE_BODY_REPRESENTATION,
          }),
        },
      ],
    });

    const manifest = await readManifest(traceDir, "c1");
    assert.deepEqual(entriesOf(manifest), []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
    assert.ok(!JSON.stringify(manifest).includes(RAW_SECRET));
  });

  it("refuses a foreign representation even when the file answers there", async () => {
    // The body sits at a valid body address, so only the declared
    // representation can be refusing it — the same authority the message path
    // applies.
    const traceDir = makeTraceDir();
    const body = evidenceBody(traceDir, "c1", [RAW_SECRET]);
    writeRow(traceDir, "c1", {
      dispatch_evidence: [
        {
          invocationId: "inv-1",
          stream: true,
          messages: {
            ...body,
            representation: FOREIGN_REPRESENTATION,
          },
        },
      ],
    });

    const manifest = await readManifest(traceDir, "c1");
    assert.deepEqual(entriesOf(manifest), []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
    assert.ok(!JSON.stringify(manifest).includes(RAW_SECRET));
  });
});

describe("final-request evidence — fail closed", () => {
  it("reports the gap and omits the entry when its body is missing", async () => {
    const traceDir = makeTraceDir();
    writeRow(traceDir, "c1", {
      dispatch_evidence: [
        {
          invocationId: "inv-1",
          stream: true,
          messages: ref({
            sha: "b".repeat(64),
            bytes: 10,
            representation: TRACE_BODY_REPRESENTATION,
          }),
        },
      ],
    });

    // No throw: a trace read must not crash the caller turn (ADR-0036 exit).
    const manifest = await readManifest(traceDir, "c1");
    assert.deepEqual(entriesOf(manifest), []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
  });

  it("omits the whole entry when only one of its bodies is missing", async () => {
    // All-or-nothing per invocation: an entry that lost its system instructions
    // would otherwise read as a request that carried none.
    const traceDir = makeTraceDir();
    const messages = evidenceBody(traceDir, "c1", MESSAGES_A);
    writeRow(traceDir, "c1", {
      dispatch_evidence: [
        {
          invocationId: "inv-1",
          stream: true,
          messages,
          system: ref({
            sha: "c".repeat(64),
            bytes: 10,
            representation: TRACE_BODY_REPRESENTATION,
          }),
        },
      ],
    });

    const manifest = await readManifest(traceDir, "c1");
    assert.deepEqual(entriesOf(manifest), []);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
  });

  it("keeps the readable invocations when a sibling entry is not", async () => {
    const traceDir = makeTraceDir();
    const readable = evidenceBody(traceDir, "c1", MESSAGES_B);
    writeRow(traceDir, "c1", {
      dispatch_evidence: [
        { invocationId: "inv-1", stream: true, messages: MESSAGES_A },
        { invocationId: "inv-2", stream: false, messages: readable },
      ],
    });

    const manifest = await readManifest(traceDir, "c1");
    assert.deepEqual(entriesOf(manifest), [
      {
        invocationId: "inv-2",
        stream: false,
        messages: JSON.stringify(MESSAGES_B),
      },
    ]);
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
  });
});

describe("final-request evidence — portable copies", () => {
  /** A session whose trace references three bodies, sharing its pool with a
   *  raw native body and a body no trace references. */
  async function writePortableSource(traceDir: string): Promise<string> {
    const native = join(sessionDir(traceDir, "portable"), "code-snapshots");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, HEX), JSON.stringify(RAW_SECRET), "utf8");
    evidenceBody(traceDir, "portable", "unreferenced body");
    return writeProductionRow(traceDir, "portable", [
      {
        invocationId: "inv-1",
        stream: true,
        messages: MESSAGES_A,
        system: SYSTEM_TEXT,
      },
    ]);
  }

  function referencedShas(traceDir: string): string[] {
    const row = JSON.parse(
      readFileSync(
        join(sessionDir(traceDir, "portable"), "trace.jsonl"),
        "utf8"
      )
    ) as Record<string, unknown>;
    const entries = (row["dispatch_evidence"] ?? []) as Array<
      Record<string, TraceBodyRef>
    >;
    return entries.flatMap((entry) =>
      [entry.messages, entry.system]
        .filter((r): r is TraceBodyRef => r !== undefined)
        .map((r) => r.sha)
    );
  }

  function copySession(source: string, copy: string): void {
    const from = sessionDir(source, "portable");
    const to = sessionDir(copy, "portable");
    mkdirSync(to, { recursive: true });
    copyFileSync(join(from, "trace.jsonl"), join(to, "trace.jsonl"));
  }

  it("reports a trace copied without its bodies as visibly incomplete", async () => {
    const source = makeTraceDir();
    const recordId = await writePortableSource(source);
    const copy = makeTraceDir();
    copySession(source, copy);

    const manifest = await readManifest(copy, "portable", recordId);
    assert.ok(!("final_request_evidence" in manifest));
    assert.equal(manifest["evidence_gap"], "unreadable_referenced_body");
    assert.ok(!JSON.stringify(manifest).includes("go on"));
    assert.ok(!JSON.stringify(manifest).includes(SYSTEM_TEXT));
  });

  it("reproduces the same view when only the referenced bodies travel along", async () => {
    const source = makeTraceDir();
    const recordId = await writePortableSource(source);

    const copy = makeTraceDir();
    copySession(source, copy);
    const blobs = join(sessionDir(copy, "portable"), "blobs");
    mkdirSync(blobs, { recursive: true });
    for (const sha of referencedShas(source)) {
      copyFileSync(
        join(sessionDir(source, "portable"), "blobs", sha),
        join(blobs, sha)
      );
    }

    const copied = await readManifest(copy, "portable", recordId);
    const original = await readManifest(source, "portable", recordId);
    assert.deepEqual(entriesOf(copied), entriesOf(original));
    assert.equal(copied["evidence_gap"], undefined);
    // The bodies that did not travel stay unreadable, and the raw native one is
    // not in the copy at all.
    const serialized = JSON.stringify(copied);
    assert.ok(!serialized.includes(RAW_SECRET));
    assert.ok(!serialized.includes("unreferenced body"));
  });
});

describe("final-request evidence — shared pool", () => {
  it("reads its own references and discloses no other body of the pool", async () => {
    const traceDir = makeTraceDir();
    // A real shared pool: raw native bodies at perfectly valid body addresses
    // (no reference, or a foreign-tagged one) beside the masked trace bodies.
    evidenceBody(traceDir, "c1", RAW_SECRET);
    evidenceBody(traceDir, "c1", "another body's content");
    const recordId = await writeProductionRow(traceDir, "c1", [
      {
        invocationId: "inv-1",
        stream: true,
        messages: MESSAGES_A,
        system: SYSTEM_TEXT,
      },
    ]);

    const pool = readdirSync(join(sessionDir(traceDir, "c1"), "blobs")).sort();
    assert.ok(
      pool.length >= 4,
      "the pool must hold bodies this trace does not reference"
    );

    const manifest = await readManifest(traceDir, "c1", recordId);
    const serialized = JSON.stringify(manifest);
    // Enumeration is not a capability: the view names the referenced bodies and
    // the content behind them, and nothing else in the pool.
    assert.ok(serialized.includes(SYSTEM_TEXT));
    assert.ok(!serialized.includes(RAW_SECRET));
    assert.ok(!serialized.includes("another body's content"));
    for (const sha of pool) {
      // The stored refs are the only addresses the row names; anything else in
      // the pool must not be discoverable through the read side.
      const referenced = JSON.stringify(manifest["record"]).includes(sha);
      if (!referenced) {
        assert.ok(
          !serialized.includes(sha),
          `an unreferenced body address leaked into the view: ${sha}`
        );
      }
    }
  });
});
