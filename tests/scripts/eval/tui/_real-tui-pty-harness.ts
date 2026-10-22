/**
 * Real-product-TUI harness for the #1219 EVIDENCE LAYER.
 *
 * WHAT THIS IS FOR. Every pre-existing #1219 driver test drives
 * `fixture-tui-child.ts` — a deterministic FAKE pty child that treats CR and LF
 * identically and submits on both. `pty-fixture.test.ts` says outright that the
 * real product "cannot be driven here (it would need model calls and
 * credentials)". So the measured #1221 failure trigger — the first stimulus
 * never being persisted as an INDEPENDENT user event — was never reproduced on
 * the real input/store path, and "CR is accepted" stayed an ASSUMPTION carried
 * by the fixture. This harness makes it an OBSERVATION.
 *
 * Division of labour (nothing here is reinvented):
 *   - `scripts/eval/tui/pty.ts` `openPty`/`dispose` owns the PTY substrate
 *     (Python `pty.fork()` relay, verbatim master capture, process-group reap).
 *     Read-only use; this file never edits it.
 *   - `scripts/eval/tui/session-store-reader.ts` owns the acceptance
 *     predicates and the store's location discipline (`listSessionFiles`,
 *     `sessionFilePath`, `isRealUserMessage`, `isInputBoundary`,
 *     `isTerminalBoundary`, `messageText`, `ObserverError`). Read-only use.
 *     Its `SessionTailReader` is deliberately NOT used: it carries a monotonic
 *     byte offset, and the real product rewrites the store's header line in
 *     place, so that offset desynchronizes mid-turn. See `StoreObserver`.
 *   - `tests/cli/_ask-loopback-model.ts` is NOT reused. It cannot be slowed per
 *     turn, and proof 3 needs a response the test HOLDS so the round is
 *     observably still running; `startLoopbackModel` has no such gate. The SSE
 *     shape this stub emits is the same Anthropic shape the real adapter's
 *     `.stream()` arm consumes (including `/v1/messages/count_tokens`), which is
 *     the wire contract, not a fixture detail.
 *
 * The model boundary is stubbed because it is the external boundary
 * (`.claude/rules/test.md`: stub an external model, network service, or host
 * process at its boundary when that external behavior is not the subject of the
 * test). Everything under it stays real: the real renderer under `bun` (OpenTUI
 * is FFI/Bun-only — `src/cli.ts:1059-1060` re-execs under bun and exits 1 under
 * Node, so the product TUI CANNOT be imported in-process and MUST be spawned),
 * the real key parser, the real session hub, the real `SessionStore` on a real
 * filesystem. The loopback HTTP server lives in-process in this Vitest worker
 * (same as both existing harnesses) and is closed in teardown.
 *
 * ISOLATION. Every run gets a fresh temp root, a fresh temp `HOME`, a fresh
 * `--data-dir`, a fresh `--workspace-root` and a fresh conversation. The
 * repository's own `data/` and the developer's `~/.iknow` are never touched, and
 * the api key is a literal this file generates — no real credential is read,
 * required, logged or asserted anywhere.
 *
 * WHY A TIMELINE. Proof 4 needs a reader to tell "the TUI never became ready"
 * apart from "the TUI was ready and the input was not accepted". That is only
 * decidable from an ordered, timestamped record of: every outbound pty write,
 * every stub request, the first persisted user event, the boundaries, and the
 * relay's exit. `Timeline` is that record, appended as each event happens (not
 * reconstructed afterwards) and embedded in every assertion message so a
 * failure ships its own evidence.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import {
  disposeAllPtySessions,
  isProcessAlive,
  openPty,
  tail,
  type PtySession,
} from "../../../../scripts/eval/tui/pty.ts";
import {
  isInputBoundary,
  isRealUserMessage,
  isTerminalBoundary,
  listSessionFiles,
  messageText,
  ObserverError,
  sessionFilePath,
  type SessionEventRecord,
  type SessionLocation,
  type StoreRecord,
} from "../../../../scripts/eval/tui/session-store-reader.ts";
import { parseSessionJsonl } from "../../../../src/session-api/store/jsonl.ts";
import { computeProjectSlug } from "../../../../src/shared/project-slug.ts";

/** The real CLI entry, resolved from this file so cwd cannot drift it. */
export const CLI_ENTRY = fileURLToPath(
  new URL("../../../../src/cli.ts", import.meta.url)
);

/** The env var the hermetic settings file reads the fake key from. */
export const FAKE_KEY_ENV = "IKNOW_TUI_EVIDENCE_TEST_KEY";

/** Model route + provider id the hermetic settings file declares. */
const PROVIDER_ID = "tui-evidence";
const MODEL_ID = "stub-model";
const MODEL_ROUTE = `${PROVIDER_ID}/${MODEL_ID}`;

/**
 * The composer's own placeholder, rendered by `PromptInput` (app.tsx:5100).
 *
 * It is the readiness marker this harness trusts, and the reason is exact: the
 * kernel line-discipline can only echo bytes the PARENT wrote, and this harness
 * never writes CJK placeholder text. So its presence in the pty stream proves
 * the app painted a composer. A token the harness typed itself carries no such
 * guarantee — that asymmetry is what proof 5 measures.
 */
export const COMPOSER_PLACEHOLDER = "输入消息或 /help";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | "spawn"
  | "readiness"
  | "write"
  | "stub-request"
  | "stub-answer"
  | "store-discovered"
  | "store-user-event"
  | "store-head"
  | "store-input-boundary"
  | "store-terminal-boundary"
  | "store-outcome"
  | "store-error"
  | "relay-exit"
  | "teardown";

export interface EvidenceEntry {
  /** Milliseconds since the harness was built. Monotonic, one base. */
  readonly atMs: number;
  readonly kind: EvidenceKind;
  readonly detail: string;
}

/**
 * An append-only, timestamped record of the run, written as each event happens.
 *
 * The point is causal ORDER, not just content: a bare list of "the token was
 * echoed" and "no user event was persisted" cannot separate a startup race from
 * a refusal, while "wrote CR at 4210 ms / first stub request at 4980 ms / user
 * event e1 at 4990 ms" can.
 */
export class Timeline {
  private readonly base = Date.now();
  private readonly entries: EvidenceEntry[] = [];

  add(kind: EvidenceKind, detail: string): EvidenceEntry {
    const entry: EvidenceEntry = { atMs: Date.now() - this.base, kind, detail };
    this.entries.push(entry);
    return entry;
  }

  get all(): readonly EvidenceEntry[] {
    return this.entries;
  }

  first(kind: EvidenceKind): EvidenceEntry | null {
    return this.entries.find((e) => e.kind === kind) ?? null;
  }

  of(kind: EvidenceKind): readonly EvidenceEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  /** A readable rendering, safe to embed in an assertion message. */
  render(): string {
    return this.entries
      .map(
        (e) =>
          `  +${String(e.atMs).padStart(6)}ms ${e.kind.padEnd(22)} ${e.detail}`
      )
      .join("\n");
  }
}

// ---------------------------------------------------------------------------
// Loopback model
// ---------------------------------------------------------------------------

/** One real request the stub received, with its arrival time on the stub clock. */
export interface StubRequest {
  readonly n: number;
  readonly atMs: number;
  readonly path: string;
  /** Concatenated text of every `text` block across every message. */
  readonly userText: string;
  /** True when the request carried a `tool_result` — a tool already ran. */
  readonly hasToolResult: boolean;
  readonly messageCount: number;
}

export interface StubModel {
  readonly baseUrl: string;
  readonly requests: readonly StubRequest[];
  /** Arrivals of real `/v1/messages` requests (count_tokens excluded). */
  readonly turns: readonly StubRequest[];
  /** Withhold the next `n` model responses until `releaseHeld()`. */
  hold(n: number): void;
  /** How many held responses are still unanswered. */
  readonly heldCount: number;
  /** Release the gate: held responses are answered from this instant on. */
  releaseHeld(): void;
  waitForTurns(n: number, ms: number, what: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * A scripted SSE-speaking Anthropic-shaped server with a RESPONSE GATE.
 *
 * The gate is what makes proof 3 possible without a real model: hold the first
 * turn's answer, submit a second stimulus into a round that is observably still
 * running, and only then let the round finish. The measured #1221 run recorded
 * an 8.0 s `llm_call`, so a held response reproduces a real, observable busy
 * window rather than a synthetic one.
 *
 * Answers are always short text with `stop_reason: "end_turn"` — never a
 * `tool_use` — so the permission fence is never reached and no mutating tool
 * can run.
 */
export async function startLoopbackTuiModel(
  timeline: Timeline
): Promise<StubModel> {
  const requests: StubRequest[] = [];
  const turnWaiters: Array<{ at: number; resolve: () => void }> = [];
  const held: Array<() => void> = [];
  const base = Date.now();
  let hold = 0;
  let released = false;
  let closed = false;

  const turns = (): readonly StubRequest[] =>
    requests.filter(
      (r) =>
        r.path.startsWith("/v1/messages") && !r.path.includes("count_tokens")
    );

  const settleTurnWaiters = (): void => {
    const count = turns().length;
    for (const w of [...turnWaiters]) {
      if (count >= w.at) {
        turnWaiters.splice(turnWaiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };

  const answer = (res: ServerResponse, turnNumber: number): void => {
    const text = `stub reply ${turnNumber}`;
    const events: Array<Record<string, unknown>> = [
      {
        type: "message_start",
        message: {
          id: `msg_${turnNumber}`,
          type: "message",
          role: "assistant",
          model: MODEL_ID,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const e of events)
      res.write(`event: ${e["type"]}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
    timeline.add(
      "stub-answer",
      `answered model turn ${turnNumber} with ${JSON.stringify(text)}`
    );
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const path = req.url ?? "";
      if (path.includes("count_tokens")) {
        // Token accounting shares the transport and must never consume a turn.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      let messages: ReadonlyArray<Record<string, unknown>> = [];
      try {
        const parsed = JSON.parse(body === "" ? "{}" : body) as {
          messages?: unknown;
        };
        messages = Array.isArray(parsed.messages)
          ? (parsed.messages as ReadonlyArray<Record<string, unknown>>)
          : [];
      } catch {
        // An unparseable body is still a real request: answer it rather than
        // hanging the child, so a gap shows up as wrong evidence, not a timeout.
      }
      const parts: string[] = [];
      let hasToolResult = false;
      for (const m of messages) {
        const content = m["content"];
        if (typeof content === "string") parts.push(content);
        else if (Array.isArray(content)) {
          for (const c of content as ReadonlyArray<Record<string, unknown>>) {
            if (c["type"] === "text" && typeof c["text"] === "string")
              parts.push(c["text"]);
            if (c["type"] === "tool_result") hasToolResult = true;
          }
        }
      }
      const record: StubRequest = {
        n: requests.length + 1,
        atMs: Date.now() - base,
        path,
        userText: parts.join(" | "),
        hasToolResult,
        messageCount: messages.length,
      };
      requests.push(record);
      timeline.add(
        "stub-request",
        `request #${record.n} ${path} msgs=${record.messageCount} ` +
          `tool_result=${record.hasToolResult} text=${JSON.stringify(
            record.userText.slice(0, 240)
          )}`
      );
      settleTurnWaiters();

      const turnNumber = turns().length;
      if (hold > 0 && !released) {
        hold -= 1;
        timeline.add(
          "stub-answer",
          `GATE: holding the answer to turn ${turnNumber}, so the round stays observably running`
        );
        held.push(() => {
          timeline.add("stub-answer", `GATE released turn ${turnNumber}`);
          answer(res, turnNumber);
        });
        return;
      }
      answer(res, turnNumber);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    get turns() {
      return turns();
    },
    hold(n) {
      hold = n;
      timeline.add(
        "stub-answer",
        `GATE armed: holding the next ${n} model response(s)`
      );
    },
    get heldCount() {
      return held.length;
    },
    releaseHeld() {
      released = true;
      while (held.length > 0) held.shift()?.();
    },
    async waitForTurns(n, ms, what) {
      if (turns().length >= n) return;
      await new Promise<void>((resolve, reject) => {
        const waiter = { at: n, resolve };
        turnWaiters.push(waiter);
        setTimeout(() => {
          const at = turnWaiters.indexOf(waiter);
          if (at >= 0) turnWaiters.splice(at, 1);
          reject(
            new Error(
              `${what}: only ${turns().length} of ${n} model turns arrived within ${ms}ms`
            )
          );
        }, ms);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      turnWaiters.length = 0;
      held.length = 0;
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Paint-vs-echo classification (proof 5)
// ---------------------------------------------------------------------------

export type PaintVerdict = "rendered" | "bare-echo" | "absent";

export interface PaintClassification {
  readonly verdict: PaintVerdict;
  /** The raw bytes around the token, so the verdict is checkable by hand. */
  readonly context: string;
}

/**
 * Decide, from raw pty bytes alone, whether `token` reached the surface as an
 * APP PAINT or as TERMINAL ECHO.
 *
 * WHY THE BYTES DISTINGUISH THEM. A cell-addressing renderer that repaints a
 * changed cell emits a CSI cursor move and/or an erase line before the glyphs.
 * The kernel line-discipline echo, in contrast, happens when the TUI has NOT yet
 * put the tty in raw mode, and it emits the typed bytes BARE — no escape, no
 * addressing. So a token occurrence preceded (within a short window) by an
 * escape sequence was painted by the app; a bare occurrence was echoed by the
 * kernel with no composer render at all.
 *
 * This is a measurement, not a claim: the raw context is reported either way, so
 * a reader can disagree with the verdict and check.
 */
export function classifyTokenPaint(
  since: string,
  token: string
): PaintClassification {
  const at = since.indexOf(token);
  if (at < 0) return { verdict: "absent", context: "" };
  const from = Math.max(0, at - 96);
  const window = since.slice(from, at);
  const verdict: PaintVerdict = /\u001b\[/.test(window)
    ? "rendered"
    : "bare-echo";
  return {
    verdict,
    context: JSON.stringify(since.slice(from, at + token.length + 24)),
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Wait until the REAL product has painted a composer.
 *
 * The gate is the placeholder, and the gate is sound for a structural reason
 * rather than a heuristic one: the kernel can only echo bytes this harness
 * wrote, and the harness never writes the placeholder. Its arrival therefore
 * proves the app rendered an input surface, which is exactly the claim a
 * readiness probe has to make. `probeReadiness` in `pty.ts` cannot make that
 * claim, because the token it searches for is one the harness itself typed.
 */
export async function waitForComposerReady(
  run: RealTuiRun,
  ms: number
): Promise<{ ready: boolean; atMs: number; detail: string }> {
  const mark = run.session.captureMark;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const seen = run.session.since(mark);
    if (seen.includes(COMPOSER_PLACEHOLDER)) {
      const atMs = run.timeline.add(
        "readiness",
        `composer painted its placeholder (${JSON.stringify(COMPOSER_PLACEHOLDER)}) — the ` +
          `surface is ready; the kernel cannot echo bytes this harness never wrote`
      ).atMs;
      return { ready: true, atMs, detail: "placeholder painted" };
    }
    const exit = run.session.relayLog();
    if (exit.includes("EXIT ")) {
      const atMs = run.timeline.add(
        "readiness",
        `composer NEVER painted before the child exited; relay log=${JSON.stringify(exit.slice(0, 400))}`
      ).atMs;
      return { ready: false, atMs, detail: `child exited: ${exit.trim()}` };
    }
    await delay(25);
  }
  const atMs = run.timeline.add(
    "readiness",
    `composer never painted its placeholder within ${ms}ms; raw bytes=${run.session.totalBytes}`
  ).atMs;
  return { ready: false, atMs, detail: `placeholder absent after ${ms}ms` };
}

// ---------------------------------------------------------------------------
// Store observation
// ---------------------------------------------------------------------------

/**
 * Incremental observer over the ONE conversation a run persists.
 *
 * WHY DISCOVERY IS NEEDED. The first-input path a real operator takes is the
 * draft one (`iknow tui` with no id): the conversation id is minted by
 * `ensureSession` on the first ACCEPTED input (app.tsx:3130), so it is not
 * knowable before the run. It is discovered from the filesystem with the
 * production lister (`listSessionFiles`, which already excludes sub-agent
 * transcripts by path), and the fresh temp pool makes "the one file"
 * unambiguous — two files is an error, never a silent pick.
 *
 * WHY IT RE-ANCHORS ON CONTENT, NOT BYTES — a measured product fact, not a
 * preference. `SessionStore.save()` (src/session-api/store/session-store.ts:
 * 433-467) always writes the WHOLE log to a tmp file and renames it over the
 * authority, even on its "identical projection → header-refresh only" path. The
 * `session` header is line 1 and it GROWS as the turn progresses (`turnCount`,
 * `title`, `lastUsage`). Measured on a real run: file size grew
 * 362 → 544 → 741 → 1311 → 1686 bytes while line 1 went 335 → 452 bytes with a
 * different sha1. So the store is append-only in SIZE but not in BYTE OFFSET,
 * and any reader that carries a monotonic `consumed` offset across a header
 * rewrite parses from the middle of a record. That is exactly what
 * `SessionTailReader` does, and against the real product it raises
 * `ObserverError(malformed_line)` mid-turn (reproduced; see the report).
 *
 * So this observer re-reads the whole file each poll and de-duplicates by
 * RECORD IDENTITY (event id / head id / boundary+anchor+bodySha / outcome
 * turnId). That is sound under appends AND under whole-file rewrites, and it
 * still parses with the production `parseSessionJsonl` — the same codec
 * `validateWholeFile` delegates to, including its documented tolerance for a
 * crash-interrupted trailing line.
 *
 * FAILURE POSTURE. A schema violation, an unknown record type, a duplicate
 * event id, a dangling parent, or a corrupt line anywhere but the tail is
 * raised as an `ObserverError` and recorded in the timeline. Absence is NOT an
 * error: the writer creates the conversation file lazily, so "no file yet" is a
 * normal pre-first-input state.
 */
export class StoreObserver {
  private readonly projectLocation: SessionLocation;
  private readonly timeline: Timeline;
  private readonly label: string;
  private discovered: string | null = null;
  private known: StoreRecord[] = [];
  private readonly seen = new Set<string>();
  private readonly userIds = new Set<string>();
  private readonly inputAnchors = new Set<string>();
  private readonly terminalAnchors = new Set<string>();
  private readonly outcomeTurns = new Set<string>();
  private firstUserEventAtMs: number | null = null;

  constructor(
    projectLocation: SessionLocation,
    timeline: Timeline,
    label: string
  ) {
    this.projectLocation = projectLocation;
    this.timeline = timeline;
    this.label = label;
  }

  /** `<data>/projects/<slug(cwd)>/` — knowable before the child starts. */
  get projectDir(): string {
    return join(
      this.projectLocation.dataDir,
      "projects",
      computeProjectSlug(this.projectLocation.cwd)
    );
  }

  /** The conversation id, once the product has minted one. */
  get conversationId(): string | null {
    return this.discovered;
  }

  get storeFile(): string | null {
    if (this.discovered === null) return null;
    return sessionFilePath({
      ...this.projectLocation,
      conversationId: this.discovered,
    });
  }

  /** Timeline offset of the first observed real user event, or null. */
  get observedFirstUserEventAtMs(): number | null {
    return this.firstUserEventAtMs;
  }

  userEventIds(): readonly string[] {
    return [...this.userIds];
  }

  /** Every record observed so far, in file order. */
  records(): readonly StoreRecord[] {
    return this.known;
  }

  userEvents(): readonly StoreRecord[] {
    return this.known.filter(
      (r) => r.type === "message" && isRealUserMessage(r)
    );
  }

  inputBoundaryAnchors(): readonly string[] {
    return [...this.inputAnchors];
  }

  terminalBoundaryAnchors(): readonly string[] {
    return [...this.terminalAnchors];
  }

  /**
   * One observation: discover the conversation, re-read the file through the
   * production parser, absorb any record identities not seen before. Returns
   * every record known so far. Throws an `ObserverError` on a broken read —
   * never returns a quiet result that a stop rule could read as settled.
   */
  poll(): readonly StoreRecord[] {
    this.discover();
    const file = this.storeFile;
    if (file === null) return this.known;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.known;
      this.fail("read_failed", 0, `${file}: ${String(err)}`);
    }
    if (raw.trim().length === 0) return this.known;
    let log: { records: readonly unknown[] };
    try {
      log = parseSessionJsonl(raw);
    } catch (err) {
      const e = err as { kind?: string; reason?: unknown; field?: unknown };
      this.fail(
        typeof e.kind === "string" ? e.kind : "schema_invalid",
        0,
        JSON.stringify(err)
      );
    }
    this.absorb(log.records as readonly StoreRecord[]);
    return this.known;
  }

  private fail(kind: string, line: number, detail: string): never {
    this.timeline.add(
      "store-error",
      `${this.label}: ${kind} at line ${line}: ${detail}`
    );
    throw new ObserverError(kind as "malformed_line", line, detail);
  }

  private discover(): void {
    if (this.discovered !== null) return;
    const files = listSessionFiles(this.projectLocation);
    if (files.length === 0) return;
    if (files.length > 1)
      throw new Error(
        `${this.label}: expected exactly one conversation under ${this.projectDir}, ` +
          `found ${files.length}: ${files.join(", ")}`
      );
    const path = files[0]!;
    // The conversation id is the directory segment the production lister
    // produced: <pool>/projects/<slug>/<conversationId>/<conversationId>.jsonl
    const parts = path.split(sep);
    this.discovered = parts[parts.length - 2]!;
    this.timeline.add(
      "store-discovered",
      `${this.label}: conversation=${this.discovered} file=${path}`
    );
  }

  private absorb(records: readonly StoreRecord[]): void {
    for (const record of records) {
      if (record.type === "session") continue;
      const key = recordKey(record);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.known.push(record);
      this.note(record);
    }
  }

  private note(record: StoreRecord): void {
    // `isRealUserMessage` is a predicate, not a type guard, so the message
    // shape is narrowed here rather than assumed.
    if (
      record.type === "message" &&
      isRealUserMessage(record) &&
      !this.userIds.has(record.id)
    ) {
      this.userIds.add(record.id);
      this.firstUserEventAtMs ??= this.timeline.add(
        "store-user-event",
        `FIRST real user message ${record.id} parent=${String(record.parent)} ` +
          `createdAt=${String(record.createdAt)} text=${JSON.stringify(
            messageText(record).slice(0, 200)
          )}`
      ).atMs;
    }
    if (
      isInputBoundary(record) &&
      !this.inputAnchors.has(record.anchorEventId)
    ) {
      this.inputAnchors.add(record.anchorEventId);
      this.timeline.add(
        "store-input-boundary",
        `input boundary anchored at ${record.anchorEventId} bodySha=${String(record.bodySha)}`
      );
    }
    if (
      isTerminalBoundary(record) &&
      !this.terminalAnchors.has(record.anchorEventId)
    ) {
      this.terminalAnchors.add(record.anchorEventId);
      this.timeline.add(
        "store-terminal-boundary",
        `terminal boundary anchored at ${record.anchorEventId}`
      );
    }
    if (record.type === "outcome" && !this.outcomeTurns.has(record.turnId)) {
      this.outcomeTurns.add(record.turnId);
      this.timeline.add(
        "store-outcome",
        `outcome turnId=${record.turnId} stopReason=${record.stopReason}`
      );
    }
    if (record.type === "head")
      this.timeline.add("store-head", `head advanced to ${String(record.id)}`);
  }
}

function recordKey(record: StoreRecord): string {
  if (record.type === "head") return `head:${String(record.id)}`;
  if (record.type === "outcome") return `outcome:${record.turnId}`;
  if (record.type === "message") return `message:${record.id}`;
  if (record.type === "native_state")
    return `native_state:${record.boundary}:${record.anchorEventId}:${String(record.bodySha)}`;
  return `${record.type}:${JSON.stringify(record).slice(0, 160)}`;
}

// ---------------------------------------------------------------------------
// The real TUI under a real pty
// ---------------------------------------------------------------------------

export interface RealTuiRun {
  readonly label: string;
  readonly timeline: Timeline;
  readonly session: PtySession;
  readonly observer: StoreObserver;
  readonly projectLocation: SessionLocation;
  readonly root: string;
  readonly home: string;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  /** The id this run WOULD have resumed; null on the draft path. */
  readonly requestedConversationId: string | null;
  /** Every stimulus byte this run wrote, in order (control lines excluded). */
  readonly outbound: readonly string[];
  /** ANSI-stripped tail of the raw pty capture, for readable evidence. */
  screen(n?: number): string;
  /** Write a stimulus chunk, timestamping it into the timeline first. */
  writeChunk(text: string, note: string): void;
  /** Pace `text` into the real composer. Never contains CR or LF. */
  typeStimulus(
    text: string,
    opts?: { chunkBytes?: number; delayMs?: number }
  ): Promise<void>;
  /**
   * Write one CR — the submit keystroke — as its own timestamped write, after a
   * settle interval.
   *
   * WHY THE SETTLE. The driver this layer replaces sent `SUBMIT_KEYSTROKE`
   * immediately after the last paced chunk, and the #1221 audit flagged that as
   * a suspect. It is also measurably lossy: with a zero-gap CR under a loaded
   * machine (the suite running beside two other files in a 3-fork pool), the
   * real composer dropped the final character and persisted a TRUNCATED
   * stimulus. A short settle before Enter removes that race, and it is what a
   * human does anyway. A content-addressed wait would be better still, but this
   * surface cannot currently confirm its own composer contents — which is
   * exactly the readiness weakness documented in the probe evidence.
   */
  pressEnter(settleMs?: number): Promise<void>;
  /** One store observation; every record known so far. */
  pollStore(): readonly StoreRecord[];
  /**
   * Poll to a deadline for a real user event beyond `afterIds`. Returns the
   * first NEW one, or null. Never sleeps a fixed interval hoping.
   */
  waitForNewUserEvent(
    afterIds: readonly string[],
    ms: number,
    what: string
  ): Promise<SessionEventRecord | null>;
  /** The pids this run owns, for the teardown leak check. */
  readonly pids: readonly number[];
  dispose(): Promise<void>;
}

const openRuns: RealTuiRun[] = [];

/** Drain every run this module started. Safe to call repeatedly. */
export async function disposeAllRealTuiRuns(): Promise<void> {
  for (const run of openRuns.splice(0)) {
    await run.dispose().catch(() => undefined);
  }
  await disposeAllPtySessions().catch(() => undefined);
}

/**
 * The hermetic child environment.
 *
 * `HOME` is the temp home (how `os.homedir()` resolves inside the child), the
 * key is a literal this file generates, `NO_COLOR` keeps the capture free of
 * colour-introduction sequences, and the posture env vars are DELETED so the
 * child cannot inherit an operator's permission override — the same hermetic
 * shape `pty-harness.ts` uses. Any real provider credential variable is deleted
 * too, so a leaked key in the ambient environment cannot reach the child.
 */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    [FAKE_KEY_ENV]: `tui-evidence-fake-key-${randomBytes(8).toString("hex")}`,
    NO_COLOR: "1",
    TERM: "xterm-256color",
  };
  for (const forbidden of [
    "IKNOW_PERMISSION_MODE",
    "IKNOW_EVAL_STATE",
    "IKNOW_YOLO",
    "IKNOW_LLM_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
  ]) {
    delete env[forbidden];
  }
  return env;
}

/**
 * Point the child at a loopback origin.
 *
 * Model stubbing is SETTINGS-FILE BASED, not env-based: `llm.providers[].baseUrl`
 * is the validated seam (`src/config/settings.ts:208-222`, `:1027-1045`) and
 * `IKNOW_LLM_BASE_URL` is only a legacy fallback. An api key is mandatory — a
 * missing one is a typed `provider_api_key_missing` (`src/config/env.ts:365`) —
 * so the settings file declares `apiKeyEnv` and the key itself is the literal
 * placed in the hermetic env above.
 */
function hermeticSettings(baseUrl: string): string {
  return JSON.stringify(
    {
      llm: {
        model: MODEL_ROUTE,
        providers: [
          {
            id: PROVIDER_ID,
            baseUrl,
            apiKeyEnv: FAKE_KEY_ENV,
            models: [
              {
                id: MODEL_ID,
                name: MODEL_ID,
                contextWindow: 200_000,
                maxTokens: 4096,
              },
            ],
          },
        ],
      },
    },
    null,
    2
  );
}

/**
 * Boot the REAL product TUI in a REAL pty against the loopback stub.
 *
 * The child is `bun <repo>/src/cli.ts tui [--data-dir <tmp> --workspace-root
 * <tmp> --auto-mode]`, plus a conversation id when
 * `launchWithConversationId` is set. `--auto-mode` matches the measured #1221
 * launch; it selects full-auto permission mode, and since the stub never emits a
 * `tool_use` it is never the reason a case passes or fails.
 */
export async function startRealTui(opts: {
  readonly label: string;
  readonly timeline?: Timeline;
  readonly model: StubModel;
  /** Hold this many model responses at the gate (proof 3). */
  readonly holdTurns?: number;
  /**
   * Resume a NAMED conversation id instead of starting a new session.
   *
   * Defaults to false, and the default is a measured product fact rather than a
   * convenience: `run.tsx:1048-1054` runs the startup resume through
   * `bridge.openSession(id)`, which reads the store, so `iknow tui <id>` against
   * a conversation that does not exist is a typed startup failure
   * (`{"kind":"not_found","conversation_id":"<id>"}` prefixed by
   * `TUI_RENDERER_ERROR_PREFIX`, exit 1) before any renderer exists. The
   * first-input path a real operator takes is the draft one, so that is the
   * default here; proof 4 pins the named-id behaviour down as its own
   * observation.
   */
  readonly launchWithConversationId?: boolean;
}): Promise<RealTuiRun> {
  const timeline = opts.timeline ?? new Timeline();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iknow-tui-evidence-")));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const workspaceRoot = join(root, "ws");
  for (const dir of [home, dataDir, workspaceRoot])
    mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    hermeticSettings(opts.model.baseUrl),
    "utf8"
  );
  const requestedConversationId = `tui-evidence-${randomBytes(6).toString("hex")}`;
  const projectLocation: SessionLocation = {
    dataDir,
    cwd: workspaceRoot,
    conversationId: requestedConversationId,
  };
  // The project slug is a pure function of the identity root, so the store
  // DIRECTORY is knowable before the child exists even though the CONVERSATION
  // id is not. StoreObserver discovers the id.
  const observer = new StoreObserver(projectLocation, timeline, opts.label);

  if (opts.holdTurns !== undefined && opts.holdTurns > 0)
    opts.model.hold(opts.holdTurns);

  const env = hermeticEnv(home);
  const session = await openPty({
    command: "bun",
    args: [
      CLI_ENTRY,
      "tui",
      ...(opts.launchWithConversationId === true
        ? [requestedConversationId]
        : []),
      "--data-dir",
      dataDir,
      "--workspace-root",
      workspaceRoot,
      "--auto-mode",
    ],
    cwd: workspaceRoot,
    env,
    rows: 40,
    cols: 120,
  });
  timeline.add(
    "spawn",
    `${opts.label}: bun ${CLI_ENTRY} tui${
      opts.launchWithConversationId === true
        ? ` ${requestedConversationId}`
        : ""
    } --data-dir ${dataDir} --workspace-root ${workspaceRoot} --auto-mode | ` +
      `childPid=${session.childPid} relayPid=${session.relayPid} ` +
      `projectDir=${observer.projectDir} home=${home}`
  );

  const outbound: string[] = [];

  const run: RealTuiRun = {
    label: opts.label,
    timeline,
    session,
    observer,
    projectLocation,
    root,
    home,
    dataDir,
    workspaceRoot,
    requestedConversationId:
      opts.launchWithConversationId === true ? requestedConversationId : null,
    outbound,
    screen(n = 3000) {
      return tail(session.since(Math.max(0, session.captureMark - 12_000)), n);
    },
    writeChunk(text, note) {
      outbound.push(text);
      timeline.add(
        "write",
        `${note} bytes=${JSON.stringify(text)} len=${text.length}`
      );
      session.write(text);
    },
    async typeStimulus(text, pacing = {}) {
      if (/[\r\n]/.test(text))
        throw new Error(
          `a stimulus must not contain CR or LF; the relay treats a newline-led ` +
            `buffer as a control line. got ${JSON.stringify(text)}`
        );
      const chunkBytes = pacing.chunkBytes ?? 6;
      const step = pacing.delayMs ?? 25;
      for (let i = 0; i < text.length; i += chunkBytes) {
        run.writeChunk(text.slice(i, i + chunkBytes), `stimulus chunk @${i}`);
        await delay(step);
      }
    },
    async pressEnter(settleMs = 400) {
      if (settleMs > 0) await delay(settleMs);
      run.writeChunk("\r", "SUBMIT keystroke CR");
    },
    pollStore() {
      return observer.poll();
    },
    async waitForNewUserEvent(afterIds, ms, what) {
      const known = new Set(afterIds);
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const fresh = observer
          .poll()
          .find(
            (r): r is SessionEventRecord =>
              r.type === "message" && isRealUserMessage(r) && !known.has(r.id)
          );
        if (fresh !== undefined) return fresh;
        await delay(40);
      }
      this.timeline.add(
        "readiness",
        `${opts.label}: no new user event within ${ms}ms waiting for ${what}`
      );
      return null;
    },
    get pids() {
      return [session.childPid, session.relayPid].filter((p) => p > 0);
    },
    async dispose() {
      const at = openRuns.indexOf(run);
      if (at >= 0) openRuns.splice(at, 1);
      await session.dispose().catch((err: unknown) => {
        timeline.add("teardown", `dispose threw: ${String(err)}`);
      });
      const survivors = run.pids.filter(isProcessAlive);
      timeline.add(
        "teardown",
        `pids ${run.pids.join(",")} survivors=[${survivors.join(",")}] relayLog=${JSON.stringify(
          session.relayLog().slice(0, 400)
        )}`
      );
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  openRuns.push(run);
  return run;
}

export { isInputBoundary, isRealUserMessage, isTerminalBoundary, messageText };
export type { StoreRecord };
