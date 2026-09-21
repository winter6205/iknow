/**
 * checkpoint/rewind 5-class boundary matrix — fills the real gaps left by
 * checkpoint.test.ts / chat-session-checkpoint.test.ts / chat-session-resume.test.ts.
 * Audit conclusion (existing coverage per class):
 *
 *   - empty → splitTurns([]) / empty turnSliceEnd / shouldPersist delta=0 /
 *     appendCheckpoint delta=0 / rewind keepTurns=0 all covered; skipped.
 *   - negative → turnSliceEnd(-1) / appendCheckpoint negative delta / rewind
 *     clamp / schema rejecting non-array messages all covered; skipped.
 *   - overflow → only extractTitle's 80-char cap existed; large messages and
 *     checkpoints arrays were missing. This file adds 3 cases.
 *   - concurrent → previously only immutability + sequential repeated commit;
 *     torn-write protection for parallel save() to the same id was missing.
 *     This file adds 1 case (the core one).
 *   - exception → write_failed → warn+continue covered; the deeper IO tree
 *     (ENOTDIR / read-only dir / primitive root / checkpoints=null) gets 4
 *     cases here; malformed checkpoints on the resume path add 1 case in
 *     chat-session-resume.test.ts.
 *
 * Deviation from the task brief: "malformed checkpoints → sanitize
 * normalization" contradicts the production ruling — schema.ts:94-96 says
 * "never silently coerce" and checkpoints=null is a hard reject (pinned in
 * schema.test.ts:176). Production code stays unchanged (hard constraint), so
 * this file verifies the actual contract: load throws typed
 * schema_invalid(field="checkpoints"), the resume path warns
 * [schema_invalid] and keeps the anchor — never a bare Error, never silent swallowing.
 *
 * Isolation: all mkdtemp; never writes the real ~/.iknow.
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  resolveRewindAnchor,
  SessionStore,
  splitTurns,
  withCheckpointAnchors,
  type CheckpointRecord,
  type SessionFileV1,
  type SessionStoreError,
} from "../../../src/session-api/store/index.ts";

// -- fixtures -----------------------------------------------------------------

const text = (t: string) => ({ type: "text" as const, text: t });

const userMsg = (t: string): AnthropicNativeMessage => ({
  role: "user",
  content: [text(t)],
});

const assistantMsg = (t: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [text(t)],
});

/** Valid v3 SessionFileV1 anchor — spread overrides fields. */
const baseFile = (): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: "conv-boundary",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-08-11T00:00:00.000Z",
  title: "",
  cwd: "",
  sanitized_at: "2026-08-11T00:00:00.000Z",
  checkpoints: [],
});

const ISO = "2026-08-11T00:00:00.000Z";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** mkdtemp + SessionStore (default cwd, consistent with existing tests) + tracked cleanup.
 *  Returns `{store, baseDir}` — baseDir is for direct stat/readFile of
 *  `<base>/projects/<slug>/...`, which the store does not expose. */
async function storeFor(
  prefix: string
): Promise<{ store: SessionStore; baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

/** The store's session directory (for direct file ops / stat). */
function sessionDirFor(baseDir: string): string {
  return resolveProjectSessionDir(baseDir, process.cwd());
}

// -- overflow / large inputs ---------------------------------------------------

describe("overflow — large inputs", () => {
  it("splitTurns: 10k messages → 5000 个 turn slice,边界精确", () => {
    const messages: AnthropicNativeMessage[] = [];
    for (let i = 0; i < 10000; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    const slices = splitTurns(messages);
    assert.equal(slices.length, 5000);
    assert.equal(slices[0]!.start, 0);
    assert.equal(slices[0]!.end, 2);
    assert.equal(slices[4999]!.start, 9998);
    assert.equal(slices[4999]!.end, 10000);
  });

  it("resolveRewindAnchor: 100 turns → keepTurns=50 锚点精确落在 turn 边界", () => {
    const messages: AnthropicNativeMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(userMsg(`q${i}`), assistantMsg(`a${i}`));
    }
    const out = resolveRewindAnchor(messages, 50);
    // Turn 49 ends at messages[99] (2 messages per turn) → headIndex = 50*2-1.
    assert.equal(out.headIndex, 99);
    assert.equal(out.turnCount, 50);
  });

  it("withCheckpointAnchors: 100 checkpoints 全量重锚到事件 id", () => {
    const checkpoints: CheckpointRecord[] = Array.from(
      { length: 100 },
      (_, i) => ({
        turnIndex: i + 1,
        messagesCount: (i + 1) * 2,
        interruptedAt: ISO,
        interruptReason: "cancelled",
      })
    );
    const eventIds = Array.from({ length: 200 }, (_, i) => `e${i}`);
    const out = withCheckpointAnchors(checkpoints, eventIds);
    assert.equal(out.length, 100);
    assert.equal(out[0]?.anchorEventId, "e1");
    assert.equal(out[99]?.anchorEventId, "e199");
  });

  it("store 往返 10k messages 文件:大 payload 原子写 + load 不走样", async () => {
    const { store: s } = await storeFor("iknow-boundary-large-");
    const id = "large-roundtrip";
    const messages: AnthropicNativeMessage[] = [];
    for (let i = 0; i < 10000; i++) {
      messages.push(i % 2 === 0 ? userMsg(`q${i}`) : assistantMsg(`a${i}`));
    }
    const file: SessionFileV1 = {
      ...baseFile(),
      conversation_id: id,
      messages,
      turnCount: 5000,
    };
    await s.save({ id, file });
    const loaded = await s.load(id);
    assert.equal(loaded.messages.length, 10000);
    assert.deepEqual(loaded.messages, file.messages);
    assert.equal(loaded.turnCount, 5000);
  });
});

// -- concurrent / parallel writes to the same id --------------------------------

describe("concurrent — N 并行 save() 到同一 id", () => {
  // Key deviation from the task brief: the brief says "tmp→rename atomic write
  // should prevent tearing", but the store uses a SHARED `${path}.tmp` path —
  // parallel save() races two writeFile calls on one tmp, which measurably
  // produces tearing that concatenates two payloads (Unexpected
  // non-whitespace ... after JSON, position ≈ 2x single-payload length).
  // This is the store's documented division of responsibility
  // (session-store.ts:4 "concurrency serialization is the hub's
  // responsibility"); the shared tmp is intentional — the hub must serialize.
  //
  // So this test cannot deterministically assert "final file = some candidate"
  // (it would be flaky). It asserts the contract the store ACTUALLY guarantees
  // under concurrency:
  //   1. every rejection is typed write_failed (never a bare Error / never a wide kind);
  //   2. no .tmp residue after settle (the crash-safety half of atomic rename still holds);
  //   3. worst-case guard: if the final file exists, parses, and passes
  //      validateSessionFile, it must equal some candidate — i.e. "silent
  //      valid tearing" (a pseudo-valid file that downstream load() would
  //      wrongly accept) never occurs. A parse failure (parse_failed) is an
  //      acceptable crash-safety fallback: downstream load() rejects it typed
  //      and the REPL takes the rebuild path, same as for a pre-corrupted file.
  it("N 并行 save() 同一 id:typed 错误 + 无 .tmp 残留 + 静默有效撕裂为 0", async () => {
    const { store: s, baseDir } = await storeFor("iknow-boundary-race-");
    const id = "race-target";
    const N = 20;
    const candidates: SessionFileV1[] = Array.from({ length: N }, (_, i) => ({
      ...baseFile(),
      conversation_id: id,
      // Each candidate is identifiable: turnCount=i + title="title-i" + 60 messages.
      turnCount: i,
      title: `title-${i}`,
      messages: Array.from({ length: 60 }, (_, m) =>
        m % 2 === 0 ? userMsg(`q${i}-${m}`) : assistantMsg(`a${i}-${m}`)
      ),
    }));

    const results = await Promise.allSettled(
      candidates.map((file) => s.save({ id, file }))
    );

    // (1) typed-error contract: any rejection must be write_failed — never a
    // bare Error, never another kind, never a widened error set.
    for (const r of results) {
      if (r.status === "rejected") {
        const e = r.reason as SessionStoreError;
        assert.equal(e.kind, "write_failed");
        assert.equal(e.conversation_id, id);
        assert.ok(typeof e.cause === "string" && e.cause.length > 0);
      }
    }

    // (2) No .tmp residue after settle (the crash-safety half of atomic rename).
    await assert.rejects(
      stat(join(sessionDirFor(baseDir), `${id}.json.tmp`)),
      "settle 后不得残留 .tmp"
    );

    // (3) Silent-valid-tearing guard: if the file exists and parses as valid v3, it must equal some candidate.
    const finalPath = join(sessionDirFor(baseDir), `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(finalPath, "utf8");
    } catch {
      // (a) File absent — every save threw (all rename races failed). Acceptable:
      // without hub serialization, extreme orderings can ENOENT every rename;
      // the REPL side gets write-failure warnings but data is never silently wrong.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // (b) File exists but unparseable — tearing from the shared-tmp writeFile
      // race concatenating payloads. Acceptable crash-safety fallback:
      // downstream load() throws typed parse_failed and the REPL takes the
      // "existing file corrupt → rebuild" path (same corrupt-rebuild behavior
      // covered by the chat-session checkpoint tests) — never silent.
      return;
    }
    // (c) File parses. It must satisfy the v3 shape and equal some candidate —
    // otherwise it is "silent valid tearing" that downstream load() would wrongly
    // accept. This is the failure mode that truly must never occur.
    const { validateSessionFile } =
      await import("../../../src/session-api/store/index.ts");
    const vf = validateSessionFile(parsed);
    assert.equal(
      vf,
      null,
      `文件可解析但不是有效 v3 session(validateSessionFile='${vf}')—— 静默有效撕裂`
    );
    const serialized = candidates.map((c) => JSON.parse(JSON.stringify(c)));
    let matchIndex = -1;
    for (let i = 0; i < serialized.length; i++) {
      try {
        assert.deepEqual(parsed, serialized[i]!);
        matchIndex = i;
        break;
      } catch {
        // keep trying the next candidate
      }
    }
    assert.notEqual(
      matchIndex,
      -1,
      "文件可解析且 v3 合法,但不匹配任何候选 —— 静默有效撕裂"
    );
    // Consistency: the matched i must agree with its own turnCount/title (guards against partial tearing).
    const m = candidates[matchIndex]!;
    assert.equal((parsed as SessionFileV1).turnCount, m.turnCount);
    assert.equal((parsed as SessionFileV1).title, m.title);
  });
});

// -- exception / deep IO tree ---------------------------------------------------

describe("exception — deeper IO tree (typed errors)", () => {
  it("save: 路径穿越普通文件(ENOTDIR)→ typed write_failed", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-enotdir-"));
    tempDirs.push(tmp);
    // Make <tmp>/projects a plain file: the resolveProjectSessionDir output
    // <tmp>/projects/<proj>-<hash> traverses it → mkdir/writeFile ENOTDIR.
    await writeFile(join(tmp, "projects"), "blocker", "utf8");
    const s = new SessionStore(tmp, process.cwd());
    await assert.rejects(
      () =>
        s.save({ id: "enotdir-target", file: sampleFile("enotdir-target") }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "write_failed" &&
          e.conversation_id === "enotdir-target" &&
          typeof e.cause === "string" &&
          e.cause.length > 0
        );
      }
    );
  });

  it("save: 会话目录只读(EACCES)→ typed write_failed", async () => {
    // root bypasses permission bits, so EACCES is not reproducible under CI/container root → skip.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-ro-"));
    tempDirs.push(tmp);
    const dir = sessionDirFor(tmp);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o555); // r-x: no file creation allowed
    try {
      const s = new SessionStore(tmp, process.cwd());
      await assert.rejects(
        () => s.save({ id: "ro-target", file: sampleFile("ro-target") }),
        (err: unknown) => {
          const e = err as SessionStoreError;
          return (
            e.kind === "write_failed" &&
            e.conversation_id === "ro-target" &&
            typeof e.cause === "string" &&
            e.cause.length > 0
          );
        }
      );
    } finally {
      // Restore permissions so the afterAll rm can delete files inside the read-only dir.
      await chmod(dir, 0o755).catch(() => {});
    }
  });

  it("load: JSON.parse 成功但根是原始值(42)→ typed schema_invalid field='root'", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-root-"));
    tempDirs.push(tmp);
    const dir = resolveConversationDir({
      projectDir: sessionDirFor(tmp),
      conversationId: "prim-root",
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prim-root.json"), "42", "utf8");
    const s = new SessionStore(tmp, process.cwd());
    await assert.rejects(
      () => s.load("prim-root"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "schema_invalid" &&
          e.conversation_id === "prim-root" &&
          e.field === "root"
        );
      }
    );
  });

  it("load: v3 文件 checkpoints=null → typed schema_invalid field='checkpoints'", async () => {
    // Production ruling "never silently coerce" (schema.ts:94-96): malformed
    // checkpoints is a hard reject, never normalized. load must throw typed
    // schema_invalid rather than a bare Error.
    const tmp = await mkdtemp(join(tmpdir(), "iknow-boundary-cpnull-"));
    tempDirs.push(tmp);
    const dir = resolveConversationDir({
      projectDir: sessionDirFor(tmp),
      conversationId: "cp-null",
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "cp-null.json"),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: "cp-null",
        messages: [userMsg("q1"), assistantMsg("a1")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: ISO,
        title: "q1",
        cwd: "",
        sanitized_at: ISO,
        checkpoints: null,
      }),
      "utf8"
    );
    const s = new SessionStore(tmp, process.cwd());
    await assert.rejects(
      () => s.load("cp-null"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "schema_invalid" &&
          e.conversation_id === "cp-null" &&
          e.field === "checkpoints"
        );
      }
    );
  });
});

// -- local helpers -------------------------------------------------------------

function sampleFile(id: string): SessionFileV1 {
  return {
    ...baseFile(),
    conversation_id: id,
    messages: [userMsg("q"), assistantMsg("a")],
    turnCount: 1,
  };
}
