/**
 * A REAL-PTY child whose composer repaints CHUNK BY CHUNK AT THE CURSOR.
 *
 * WHY THIS CHILD EXISTS (and why `fixture-tui-child.ts` cannot stand in for it).
 * The measured #1221 root cause is a paint shape, and `fixture-tui-child.ts`
 * paints the WRONG one: it repaints the whole screen every frame
 * (`\u001b[H\u001b[2J` + the entire status block + `> <composer>`), so a paced
 * multi-chunk token turns up CONTIGUOUS in the raw stream and the contiguous
 * `waitForToken` search happens to succeed. The real product renderer instead
 * repaints only the cell it changed, so each paced chunk lands at its own
 * cursor position and the concatenated token is never contiguous. That is the
 * exact difference `probeReadiness` got wrong, and a fixture that cannot
 * reproduce it cannot regression-test the repair.
 *
 * So this child reproduces the measured shape and nothing else:
 *
 *   1. PER-BURST CURSOR REPAINT. A run of characters arriving in one write is
 *      emitted as `\u001b[<row>;<col>H<run>` — a cursor move immediately
 *      followed by the new glyphs. The probe paces its token, so each chunk
 *      arrives as its own write and is painted as its own run: the chunks land
 *      in different bursts separated by escapes and the concatenated token is
 *      NEVER contiguous. No whole-line repaint of a non-empty composer exists
 *      here, by construction: one would re-emit the token verbatim and make a
 *      contiguous search succeed, which is the shape this child exists to make
 *      FAIL.
 *   2. The composer line is repainted in full only when it is EMPTY (which is
 *      when the placeholder legitimately comes back). The residue logic's hard
 *      case — a repainting surface that re-renders the SHRINKING composer while
 *      backspaces are still being processed — needs whole-frame repaints and is
 *      covered on the real product surface instead, in
 *      `readiness-probe-real-surface.test.ts`.
 *   3. DELAYED ACCEPTANCE, exactly as `fixture-tui-child.ts`: a CR persists the
 *      accepted user message + head + `native_state boundary:"input"`, then the
 *      reply + head + `boundary:"terminal"` + `outcome`, and refuses (persists
 *      nothing) while a round runs.
 *
 * Store records go through the PRODUCTION serializer and record shapes from
 * `src/session-api/store/jsonl.ts`, so a fixture run cannot be "valid" against a
 * shape the product never writes (`.claude/rules/test.md`).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  messageEventId,
  parseSessionJsonl,
  sessionFileToJsonl,
} from "../../../../src/session-api/store/jsonl.js";
import type { NativeStateMessage } from "../../../../src/shared/native-state-port.js";
import { computeProjectSlug } from "../../../../src/shared/project-slug.js";

/** The composer's row. The status line is row 1, so row 5 is unambiguous. */
const COMPOSER_ROW = 5;
/** Column of the first composer character, after the `> ` prompt. */
const COMPOSER_COL = 3;
/** The product's own placeholder, painted once so readiness is observable. */
const PLACEHOLDER = "输入消息或 /help";
const REFUSAL = "当前会话正在运行；导航命令仍可用，消息请等本轮结束。";

interface Args {
  readonly dataDir: string;
  readonly cwd: string;
  readonly conversationId: string;
  readonly seedText: string;
  readonly acceptDelayMs: number;
  readonly roundMs: number;
  readonly statusMs: number;
}

function readArgs(argv: readonly string[]): Args {
  const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(name);
    return at < 0 ? fallback : (argv.at(at + 1) ?? fallback);
  };
  const number = (name: string, fallback: number): number => {
    const raw = Number(flag(name, String(fallback)));
    return Number.isFinite(raw) ? raw : fallback;
  };
  return {
    dataDir: flag("--data-dir", process.cwd()),
    cwd: flag("--cwd", process.cwd()),
    conversationId: flag("--conversation", "conv-repaint"),
    seedText: flag("--seed", "seed turn"),
    acceptDelayMs: number("--accept-delay-ms", 80),
    roundMs: number("--round-ms", 80),
    statusMs: number("--status-ms", 50),
  };
}

function storePath(args: Args): string {
  return join(
    args.dataDir,
    "projects",
    computeProjectSlug(args.cwd),
    args.conversationId,
    `${args.conversationId}.jsonl`
  );
}

function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, "utf8");
}

function message(text: string, role: "user" | "assistant"): NativeStateMessage {
  return { role, content: [{ type: "text", text }] };
}

/** Index of the next `e<N>` in the store, so ids stay append-only. */
function nextIndex(path: string): number {
  try {
    return parseSessionJsonl(readFileSync(path, "utf8")).maxEventIndex + 1;
  } catch {
    return 0;
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Create the conversation on first use: header + one seeded user message. */
function ensureStore(args: Args): void {
  const path = storePath(args);
  if (existsSync(path)) return;
  appendLine(
    path,
    sessionFileToJsonl({
      schemaVersion: 5,
      conversation_id: args.conversationId,
      messages: [message(args.seedText, "user")],
      jsonMode: false,
      turnCount: 1,
      updatedAt: now(),
      title: "repaint fixture",
      cwd: args.cwd,
      sanitized_at: now(),
      workspaceRoot: args.cwd,
      nativeStateFormat: 1,
      messageCreatedAt: [now()],
    })
  );
}

class RepaintingComposerChild {
  private composer = "";
  private busy = false;
  private index = 0;
  private ticks = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly args: Args,
    private readonly path: string
  ) {
    this.index = nextIndex(path);
  }

  start(): void {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) =>
      this.onInput(chunk.toString("utf8"))
    );
    process.stdin.on("end", () => this.exit(0));
    // The placeholder, painted once. A readiness probe can therefore see the
    // surface come up without the probe itself having to prove it.
    this.write(`\u001b[${COMPOSER_ROW};1H\u001b[2K> ${PLACEHOLDER}`);
    this.paint();
    setInterval(() => this.paint(), this.args.statusMs);
  }

  /** The status line. The composer is NEVER repainted from here. */
  private paint(): void {
    this.ticks += 1;
    this.write(
      `\u001b[1;1H\u001b[2KIKNOW-REPAINT-CHILD ticks=${this.ticks} state=${this.busy ? "running" : "idle"}`
    );
  }

  /**
   * Repaint the composer line in full.
   *
   * ONLY ever called with an empty composer: once the last character is erased
   * the placeholder legitimately comes back. A non-empty composer is painted
   * cell by cell (see `paintCursorGlyph`), which is what keeps a paced token
   * from ever appearing contiguously in the raw stream.
   */
  private paintComposerLine(): void {
    if (this.composer !== "") return;
    this.write(`\u001b[${COMPOSER_ROW};1H\u001b[2K> ${PLACEHOLDER}`);
  }

  /** ONE changed run: the glyphs just typed, at their own column. */
  private paintBurst(typed: string): void {
    this.write(
      `\u001b[${COMPOSER_ROW};${COMPOSER_COL + (this.composer.length - typed.length)}H${typed}`
    );
  }

  /** ONE changed cell: the column just vacated by a backspace. */
  private eraseCursorGlyph(): void {
    this.write(
      `\u001b[${COMPOSER_ROW};${COMPOSER_COL + this.composer.length}H `
    );
  }

  private write(text: string): void {
    process.stdout.write(text);
  }

  private onInput(text: string): void {
    // Paint per BURST, not per character: the probe paces its chunks, so each
    // arrives as its own write and is repainted as its own cell run. That is
    // the measured shape — chunk by chunk, at the cursor.
    let typed = "";
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        this.flushTyped(typed);
        typed = "";
        this.submit();
        continue;
      }
      if (char === "\u007f" || char === "\b") {
        this.flushTyped(typed);
        typed = "";
        this.backspace();
        continue;
      }
      if (char === "\u0003") {
        this.flushTyped(typed);
        typed = "";
        this.exit(130);
        continue;
      }
      typed += char;
    }
    this.flushTyped(typed);
  }

  private flushTyped(typed: string): void {
    if (typed === "") return;
    this.composer += typed;
    this.paintBurst(typed);
  }

  private backspace(): void {
    if (this.composer.length === 0) return;
    this.composer = this.composer.slice(0, -1);
    this.eraseCursorGlyph();
    if (this.composer.length === 0) this.paintComposerLine();
  }

  private submit(): void {
    const text = this.composer.trim();
    this.composer = "";
    this.paintComposerLine();
    if (text === "") return;
    if (text === "/quit") {
      this.write("\u001b[2Jrepaint fixture: bye\n");
      this.exit(0);
      return;
    }
    if (this.busy) {
      this.write(`${REFUSAL}\n`);
      return;
    }
    this.busy = true;
    this.later(this.args.acceptDelayMs, () => this.accept(text));
  }

  private accept(text: string): void {
    const id = messageEventId(this.index);
    const parent = this.index === 0 ? null : messageEventId(this.index - 1);
    this.index += 1;
    appendLine(
      this.path,
      JSON.stringify({
        type: "message",
        id,
        parent,
        message: message(text, "user"),
        createdAt: now(),
      })
    );
    appendLine(this.path, JSON.stringify({ type: "head", id }));
    appendLine(
      this.path,
      JSON.stringify({
        type: "native_state",
        anchorEventId: id,
        bodySha: "a".repeat(64),
        boundary: "input",
        messageCount: this.index,
        createdAt: now(),
      })
    );
    this.later(this.args.roundMs, () => this.settle(id));
  }

  private settle(userId: string): void {
    const id = messageEventId(this.index);
    this.index += 1;
    appendLine(
      this.path,
      JSON.stringify({
        type: "message",
        id,
        parent: userId,
        message: message("ack", "assistant"),
        createdAt: now(),
      })
    );
    appendLine(this.path, JSON.stringify({ type: "head", id }));
    appendLine(
      this.path,
      JSON.stringify({
        type: "native_state",
        anchorEventId: id,
        bodySha: "b".repeat(64),
        boundary: "terminal",
        messageCount: this.index,
        createdAt: now(),
      })
    );
    appendLine(
      this.path,
      JSON.stringify({ type: "outcome", turnId: id, stopReason: "completed" })
    );
    this.busy = false;
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private exit(code: number): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    process.exit(code);
  }
}

const args = readArgs(process.argv.slice(2));
ensureStore(args);
new RepaintingComposerChild(args, storePath(args)).start();
