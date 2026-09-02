/**
 * listSessions tests (trace inspection panel v2, TDD-first).
 *
 * Categories covered (S2 defensive contract):
 *   - happy path: readdir + stat → conversation_id / mtime / size / agent_version.
 *   - agent_version extraction: from the session root record (written at run end = last line).
 *   - root-not-first test: agent_version still extracted when the session root is the last line.
 *   - no directory: readdir ENOENT → empty list, no throw.
 *   - stat ENOENT: session deleted between readdir and stat → skipped.
 *   - bad/missing root record: agent_version absent, list does not fail overall.
 *   - bounded prefix: a root record past the 64 KiB pread bound → agent_version absent.
 *   - IO error: traceDir pointing at a regular file → TraceReadError (kind io_error).
 *   - newestConversationId: the single owner behind both the panel's and the
 *     tool's implicit "default to the most recent session" (SC-R 12).
 *   - sessionsByRecency: the same index as a deterministic page order (mtime
 *     descending, conversation_id ascending) for the `list_sessions` tool face.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSessions,
  newestConversationId,
  sessionsByRecency,
  type SessionSummary,
} from "../../src/traceserver/sessions.ts";
import { TraceReadError } from "../../src/traceserver/types.ts";

// -- helpers ------------------------------------------------------------------

/** Build a session root JSONL line mirroring the snake_case wire format. */
function sessionLine(
  agentVersion?: string,
  extra?: Record<string, unknown>
): string {
  const obj: Record<string, unknown> = {
    conversation_id: "conv-uuid",
    record_type: "session",
    session_id: "session-uuid",
    started_at: "2026-08-01T00:00:00.000Z",
    ended_at: "2026-08-01T00:00:05.000Z",
    duration_ms: 5000,
    status: "ok",
    ...extra,
  };
  if (agentVersion !== undefined) obj["agent_version"] = agentVersion;
  return JSON.stringify(obj);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "iknow-trace-sessions-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- happy path ---------------------------------------------------------------

describe("listSessions — happy path", () => {
  it("returns conversation_id / mtime / size / agent_version per session file", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine("1.2.3") + "\n",
      "utf8"
    );
    writeFileSync(
      join(tmpDir, "uuid-b.jsonl"),
      sessionLine("2.0.0") + "\n" + '{"record_type":"turn"}\n',
      "utf8"
    );

    const sessions = listSessions(tmpDir);

    assert.equal(sessions.length, 2);
    const byId = new Map(sessions.map((s) => [s.conversation_id, s]));
    const a = byId.get("uuid-a");
    assert.ok(a);
    assert.equal(a.agent_version, "1.2.3");
    assert.equal(typeof a.mtime, "number");
    assert.equal(typeof a.size, "number");
    assert.ok(a.size > 0);
    const b = byId.get("uuid-b");
    assert.ok(b);
    assert.equal(b.agent_version, "2.0.0");
  });

  it("reports mtime as the file's last-modified time", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine("1.2.3") + "\n",
      "utf8"
    );
    // Re-write with new content to advance mtime deterministically.
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine("1.2.4") + "\n",
      "utf8"
    );

    const sessions = listSessions(tmpDir);
    assert.equal(sessions.length, 1);
    const stat = statSync(join(tmpDir, "uuid-a.jsonl"));
    assert.equal(sessions[0].mtime, stat.mtimeMs);
  });

  it("reports size as the file's byte length without reading full content", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine("1.2.3") + "\n",
      "utf8"
    );

    const sessions = listSessions(tmpDir);
    assert.equal(sessions.length, 1);
    const stat = statSync(join(tmpDir, "uuid-a.jsonl"));
    assert.equal(sessions[0].size, stat.size);
  });
});

// -- agent_version extraction -------------------------------------------------

describe("listSessions — agent_version extraction", () => {
  it("reads agent_version from the session root record (first line)", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine("0.9.1") + "\n" + '{"record_type":"llm_call"}\n',
      "utf8"
    );

    const [s] = listSessions(tmpDir);
    assert.equal(s.agent_version, "0.9.1");
  });

  it("extracts agent_version when the session root is the LAST line (run-end write)", () => {
    // 真实 writer(loop-engine run 末尾 recordSession)把 session 根写在最后一行,
    // 首行是 llm_call/turn。读首行会使 agent_version 恒 absent —— 这是 SC-R 18
    // 修复的回归靶:必须扫描全文件找 record_type==="session"。
    writeFileSync(
      join(tmpDir, "uuid-last.jsonl"),
      '{"record_type":"llm_call","llm_call_id":"l1"}\n' +
        '{"record_type":"turn","turn_id":"t1"}\n' +
        sessionLine("3.4.5") +
        "\n",
      "utf8"
    );

    const [s] = listSessions(tmpDir);
    assert.ok(s, "session list must include the file");
    assert.equal(s.agent_version, "3.4.5");
  });

  it("extracts agent_version when a corrupt line precedes the session root", () => {
    writeFileSync(
      join(tmpDir, "uuid-corrupt.jsonl"),
      "{broken-json\n" + sessionLine("2.2.2") + "\n",
      "utf8"
    );

    const [s] = listSessions(tmpDir);
    assert.ok(s);
    assert.equal(s.agent_version, "2.2.2");
  });

  it("agent_version absent when the root record lacks the field", () => {
    writeFileSync(join(tmpDir, "uuid-a.jsonl"), sessionLine() + "\n", "utf8");

    const [s] = listSessions(tmpDir);
    assert.ok(s);
    assert.ok(
      !("agent_version" in s),
      "agent_version must be absent, not undefined-valued"
    );
  });

  it("agent_version absent when the root record line is corrupt JSON", () => {
    writeFileSync(join(tmpDir, "uuid-a.jsonl"), "{not-json\n", "utf8");

    const [s] = listSessions(tmpDir);
    assert.ok(s);
    assert.ok(!("agent_version" in s));
  });

  it("agent_version absent when the first line is not a session record", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      '{"record_type":"turn","agent_version":"9.9.9"}\n',
      "utf8"
    );

    const [s] = listSessions(tmpDir);
    assert.ok(s);
    assert.ok(!("agent_version" in s));
  });

  it("agent_version absent when the value is not a string", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine(undefined, { agent_version: 42 }) + "\n",
      "utf8"
    );

    const [s] = listSessions(tmpDir);
    assert.ok(s);
    assert.ok(!("agent_version" in s));
  });

  it("a corrupt root record in one session does not fail the whole list", () => {
    writeFileSync(join(tmpDir, "uuid-a.jsonl"), "{broken\n", "utf8");
    writeFileSync(
      join(tmpDir, "uuid-b.jsonl"),
      sessionLine("1.0.0") + "\n",
      "utf8"
    );

    const sessions = listSessions(tmpDir);
    assert.equal(sessions.length, 2);
    const a = sessions.find((x) => x.conversation_id === "uuid-a");
    assert.ok(a);
    assert.ok(!("agent_version" in a));
    const b = sessions.find((x) => x.conversation_id === "uuid-b");
    assert.ok(b);
    assert.equal(b.agent_version, "1.0.0");
  });

  it("agent_version is scanned only within the bounded 64 KiB prefix", () => {
    // readBounded() preads 65536 bytes and never the whole file, so a session
    // root pushed past that bound is simply not seen → field absent.
    const padding = `${JSON.stringify({
      record_type: "llm_call",
      conversation_id: "uuid-a",
      filler: "p".repeat(1000),
    })}\n`;
    const padCount = Math.ceil(70_000 / padding.length);
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      padding.repeat(padCount) + `${sessionLine("9.9.9")}\n`,
      "utf8"
    );

    const [beyond] = listSessions(tmpDir);
    assert.ok(beyond);
    assert.ok(
      beyond.size > 65_536,
      `fixture must exceed the read bound, got ${beyond.size}`
    );
    assert.ok(
      !("agent_version" in beyond),
      "a root record past the bounded prefix must not be reported"
    );

    // Same record content, root moved inside the prefix → field present, so the
    // absence above is the read bound and not a parse failure.
    writeFileSync(
      join(tmpDir, "uuid-b.jsonl"),
      `${sessionLine("9.9.9")}\n${padding}`,
      "utf8"
    );
    const sessions = listSessions(tmpDir);
    const inside = sessions.find((x) => x.conversation_id === "uuid-b");
    assert.ok(inside);
    assert.equal(inside.agent_version, "9.9.9");
  });
});

// -- boundary: empty / missing / deleted / IO ---------------------------------

describe("listSessions — boundary", () => {
  it("empty directory → empty list", () => {
    assert.deepEqual(listSessions(tmpDir), []);
  });

  it("missing directory → empty list (no throw, not 500)", () => {
    const missing = join(tmpDir, "does-not-exist");
    assert.deepEqual(listSessions(missing), []);
  });

  it("non-.jsonl files are ignored", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine("1.2.3") + "\n",
      "utf8"
    );
    writeFileSync(join(tmpDir, "README.txt"), "not a session\n", "utf8");
    writeFileSync(join(tmpDir, ".DS_Store"), "nope\n", "utf8");

    const sessions = listSessions(tmpDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].conversation_id, "uuid-a");
  });

  it("stat ENOENT (deleted between readdir and stat) → skipped", () => {
    // Simulate: the file disappears after readdir. We can't race the fs from a
    // sync scanner, so prove the skip path via a symlink whose target is gone.
    const target = join(tmpDir, "gone.jsonl");
    writeFileSync(target, sessionLine("1.2.3") + "\n", "utf8");
    const link = join(tmpDir, "uuid-a.jsonl");
    symlinkSync(target, link, "file");
    rmSync(target);

    const sessions = listSessions(tmpDir);
    assert.deepEqual(sessions, []);
  });

  it("traceDir pointing at a regular file → TraceReadError (kind io_error)", () => {
    const file = join(tmpDir, "not-a-dir.jsonl");
    writeFileSync(file, sessionLine("1.2.3") + "\n", "utf8");

    assert.throws(
      () => listSessions(file),
      (err: unknown) => err instanceof TraceReadError && err.kind === "io_error"
    );
  });

  it("traceDir pointing at a directory that got removed → empty list (no throw)", () => {
    const dir = join(tmpDir, "trace-sub");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "uuid-a.jsonl"),
      sessionLine("1.2.3") + "\n",
      "utf8"
    );
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(listSessions(dir), []);
  });
});

// -- wire shape ---------------------------------------------------------------

describe("listSessions — wire shape", () => {
  it("returns SessionSummary objects with exactly the contract fields", () => {
    writeFileSync(
      join(tmpDir, "uuid-a.jsonl"),
      sessionLine("1.2.3") + "\n",
      "utf8"
    );

    const [s] = listSessions(tmpDir) as [SessionSummary];
    assert.deepEqual(Object.keys(s).sort(), [
      "agent_version",
      "conversation_id",
      "mtime",
      "size",
    ]);
  });

  it("omits agent_version key entirely when absent (not null / empty string)", () => {
    writeFileSync(join(tmpDir, "uuid-a.jsonl"), sessionLine() + "\n", "utf8");

    const [s] = listSessions(tmpDir);
    assert.ok(s);
    assert.ok(!("agent_version" in s));
    assert.equal(s.conversation_id, "uuid-a");
  });
});

// -- 最近会话推导（panel 与 tool 共用的唯一 owner） -----------------------------

function sessionFile(conversationId: string): string {
  return join(tmpDir, `${conversationId}.jsonl`);
}

function touch(conversationId: string, atEpochSeconds: number): void {
  const at = new Date(atEpochSeconds * 1000);
  utimesSync(sessionFile(conversationId), at, at);
}

describe("newestConversationId — the default both faces share (SC-R 12)", () => {
  it("empty directory → undefined (no session to default to)", () => {
    assert.equal(newestConversationId(tmpDir), undefined);
  });

  it("missing directory → undefined, inheriting listSessions' no-throw semantics", () => {
    assert.equal(
      newestConversationId(join(tmpDir, "does-not-exist")),
      undefined
    );
  });

  it("picks the greatest mtime whichever end of the index it sits on", () => {
    // A positional read of the index would answer one of these two wrongly.
    writeFileSync(sessionFile("newest-first"), sessionLine() + "\n", "utf8");
    writeFileSync(sessionFile("older"), sessionLine() + "\n", "utf8");
    touch("newest-first", 1_600_000_200);
    touch("older", 1_600_000_100);
    assert.equal(newestConversationId(tmpDir), "newest-first");

    rmSync(sessionFile("newest-first"));
    writeFileSync(sessionFile("newest-last"), sessionLine() + "\n", "utf8");
    touch("newest-last", 1_600_000_300);
    assert.equal(newestConversationId(tmpDir), "newest-last");
  });

  it("ignores entries that are not session files", () => {
    writeFileSync(sessionFile("stale"), sessionLine() + "\n", "utf8");
    touch("stale", 1_600_000_000);
    writeFileSync(sessionFile("live"), sessionLine() + "\n", "utf8");
    touch("live", 1_600_000_600);
    writeFileSync(join(tmpDir, "notes.txt"), "not a session\n", "utf8");
    mkdirSync(sessionFile("a-directory"));

    assert.equal(newestConversationId(tmpDir), "live");
  });

  it("an exact mtime tie is deterministic and only a strictly newer file breaks it", () => {
    const tiedMtime = 1_600_000_000_000;
    writeFileSync(sessionFile("a"), sessionLine() + "\n", "utf8");
    writeFileSync(sessionFile("b"), sessionLine("1.0.0") + "\n", "utf8");
    touch("a", tiedMtime / 1000);
    touch("b", tiedMtime / 1000);
    assert.deepEqual(
      listSessions(tmpDir).map((s) => s.mtime),
      [tiedMtime, tiedMtime]
    );

    // Which name wins is decided by readdir order, which the filesystem owns,
    // so the tie is pinned as the rule "strictly newer is required" plus
    // repeatability — not as a particular id.
    const tied = newestConversationId(tmpDir);
    assert.ok(tied === "a" || tied === "b");
    assert.equal(newestConversationId(tmpDir), tied);

    writeFileSync(sessionFile("c"), sessionLine() + "\n", "utf8");
    touch("c", (tiedMtime + 1000) / 1000);
    assert.equal(newestConversationId(tmpDir), "c");
  });

  it("re-reads the index each call, so a session appended mid-stream takes over", () => {
    // The panel polls this and the tool answers back-to-back calls; a memoized
    // newest would go stale with no caller able to see it happen.
    writeFileSync(sessionFile("first"), sessionLine() + "\n", "utf8");
    assert.equal(newestConversationId(tmpDir), "first");

    writeFileSync(sessionFile("second"), sessionLine() + "\n", "utf8");
    touch("second", Math.floor(Date.now() / 1000) + 600);
    assert.equal(newestConversationId(tmpDir), "second");
  });
});

// -- 分页顺序（list_sessions tool face 的确定性页） -----------------------------

/**
 * `sessionsByRecency` is `listSessions` turned into a page order. It lives beside
 * `newestConversationId` because that is where the index's derivations are owned
 * (plan `trace-mcp-read-side-split` T4/T5b).
 */
describe("sessionsByRecency — the deterministic page order", () => {
  function subDir(label: string): string {
    const dir = join(tmpDir, label);
    mkdirSync(dir);
    return dir;
  }

  function sessionIn(
    dir: string,
    conversationId: string,
    atEpochSeconds: number,
    body = sessionLine()
  ): void {
    const path = join(dir, `${conversationId}.jsonl`);
    writeFileSync(path, `${body}\n`, "utf8");
    const at = new Date(atEpochSeconds * 1000);
    utimesSync(path, at, at);
  }

  function idsOf(dir: string): string[] {
    return sessionsByRecency(dir).map((s) => s.conversation_id);
  }

  it("empty directory and missing directory both answer with an empty list, no throw", () => {
    assert.deepEqual(sessionsByRecency(subDir("empty")), []);
    assert.deepEqual(sessionsByRecency(join(tmpDir, "never-created")), []);
  });

  it("orders by mtime descending, newest first, whatever order readdir gave", () => {
    const dir = subDir("staggered");
    // Created newest-first so the expected answer cannot be readdir creation order.
    sessionIn(dir, "newest", 1_600_000_300);
    sessionIn(dir, "middle", 1_600_000_200);
    sessionIn(dir, "oldest", 1_600_000_100);

    assert.deepEqual(idsOf(dir), ["newest", "middle", "oldest"]);
  });

  it("breaks an exact mtime tie by conversation_id, not by readdir order", () => {
    // What this pair can and cannot prove. Measured on this host, readdirSync
    // answers in codepoint order for both filesystems tried (the tmp dir and
    // /dev/shm), so with tied mtimes an **absent** tie-break yields the same
    // page — and an inverted `mtime` comparator does too, because every mtime
    // here is equal. The only mutation these two dirs can catch is a
    // name-descending comparator. The mtime direction is pinned by the
    // "mixes both rules" case below, not here. The tie-break exists for
    // filesystems whose readdir order is not already sorted, which no fixture
    // on this host can produce.
    const tied = 1_600_000_000;
    const forward = subDir("tie-forward");
    const backward = subDir("tie-backward");
    sessionIn(forward, "aaa", tied);
    sessionIn(forward, "mmm", tied);
    sessionIn(forward, "zzz", tied);
    sessionIn(backward, "zzz", tied);
    sessionIn(backward, "mmm", tied);
    sessionIn(backward, "aaa", tied);

    assert.deepEqual(idsOf(forward), ["aaa", "mmm", "zzz"]);
    assert.deepEqual(idsOf(backward), ["aaa", "mmm", "zzz"]);
    assert.deepEqual(idsOf(forward), idsOf(backward));

    // The one tie assertion above that does not lean on what readdir happens to
    // return: an ICU collation (`localeCompare`) ranks "a" before "B", while the
    // codepoint comparison compareByRecency uses keeps "B" (0x42) first whatever
    // the process locale is. Page order must not move with locale.
    const codepoint = subDir("tie-codepoint");
    sessionIn(codepoint, "B", tied);
    sessionIn(codepoint, "a", tied);
    assert.deepEqual(idsOf(codepoint), ["B", "a"]);
  });

  it("mixes both rules: a newer session outranks an earlier name", () => {
    const dir = subDir("mixed");
    sessionIn(dir, "aaa-old", 1_600_000_000);
    sessionIn(dir, "zzz-old", 1_600_000_000);
    sessionIn(dir, "zzz-new", 1_600_000_900);

    assert.deepEqual(idsOf(dir), ["zzz-new", "aaa-old", "zzz-old"]);
  });

  it("passes entries through unchanged — agent_version absence survives the sort", () => {
    const dir = subDir("passthrough");
    const rooted = sessionLine("1.2.3");
    const rootless = '{"record_type":"llm_call"}';
    sessionIn(dir, "rooted", 1_600_000_100, rooted);
    // No session root record at all: a crash / in-progress session.
    sessionIn(dir, "rootless", 1_600_000_200, rootless);

    assert.deepEqual(sessionsByRecency(dir), [
      {
        conversation_id: "rootless",
        mtime: 1_600_000_200_000,
        size: Buffer.byteLength(`${rootless}\n`, "utf8"),
      },
      {
        conversation_id: "rooted",
        mtime: 1_600_000_100_000,
        size: Buffer.byteLength(`${rooted}\n`, "utf8"),
        agent_version: "1.2.3",
      },
    ]);
  });

  it("leaves listSessions' own unsorted readdir return alone", () => {
    // The panel face keeps calling listSessions directly (http.ts), so the
    // sorted view must be a separate derivation. The fixture names and mtimes
    // run opposite ways (names ascend, mtimes descend), so a listSessions that
    // ever sorted for itself shows up in the snapshot below — and re-asserting
    // that snapshot after the sorted call is what goes red if the index read
    // ever becomes shared state that `.sort()` mutates.
    const dir = subDir("unsorted");
    sessionIn(dir, "zzz", 1_600_000_300);
    sessionIn(dir, "aaa", 1_600_000_100);

    const raw = listSessions(dir);
    assert.deepEqual(
      sessionsByRecency(dir).map((s) => s.conversation_id),
      ["zzz", "aaa"]
    );
    // Asserted after the sorted call on purpose: this is both "listSessions did
    // not sort" and "the array the earlier call handed back is still intact".
    assert.deepEqual(
      raw.map((s) => s.conversation_id),
      ["aaa", "zzz"]
    );
  });
});
