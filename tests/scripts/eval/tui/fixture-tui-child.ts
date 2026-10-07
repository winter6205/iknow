/**
 * A deterministic fake TUI child for the real-PTY fixture (#1219).
 *
 * WHY a fake and not the product: the calibration surface must be exercised
 * WITHOUT model calls and without credentials, and the properties under test are
 * properties of the DRIVER (does it verify from persisted events, does it
 * distinguish a clean quit from a forced stop, does it reap everything it
 * started) — not of the model behind it. This child reproduces exactly the four
 * product behaviours the driver has to survive, and nothing else:
 *
 *   1. CONTINUOUS terminal redraw (a frame counter), so terminal silence never
 *      occurs and a silence-based idle rule provably cannot fire. The measured
 *      TUI redraws ~26 KB per 30 s; the historical run3 had ZERO
 *      `idle_threshold_reached` records for exactly this reason.
 *   2. It starts with an EXISTING conversation. When the store file is absent it
 *      creates one (header + seeded user message + head); when it is already
 *      there it appends to it. So "a new session file appeared" is never a
 *      signal the driver could be cheating on — including for the resume probe.
 *   3. DELAYED acceptance: an Enter writes nothing immediately, then persists the
 *      accepted user message + trailing head + `native_state boundary:"input"`,
 *      then the reply + head + `boundary:"terminal"` + `outcome`. An Enter while
 *      a round is running prints the product's refusal notice and writes NOTHING
 *      to the store — the same shape as `src/tui/app.tsx` returning before
 *      `ensureSession`.
 *   4. `/quit` exits 0 cleanly.
 *
 * Store records are built with the PRODUCTION serializer and record shapes from
 * `src/session-api/store/jsonl.ts`, so a fixture run cannot be "valid" against a
 * shape the product never writes.
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
import { SUBAGENT_TRACE_DIR_NAME } from "../../../../src/shared/session-tree-names.js";

/** What the parent passes the child. */
export interface FixtureArgs {
  readonly dataDir: string;
  readonly cwd: string;
  readonly conversationId: string;
  readonly seedText: string;
  readonly acceptDelayMs: number;
  readonly roundMs: number;
  readonly redrawMs: number;
  /** When to create a sub-agent transcript (the historical false positive). */
  readonly subagentAtMs: number;
}

function readArgs(argv: readonly string[]): FixtureArgs {
  const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(name);
    return at < 0 ? fallback : (argv[at + 1] ?? fallback);
  };
  const number = (name: string, fallback: number): number => {
    const raw = flag(name, String(fallback));
    return Number.isFinite(Number(raw)) ? Number(raw) : fallback;
  };
  return {
    dataDir: flag("--data-dir", process.cwd()),
    cwd: flag("--cwd", process.cwd()),
    conversationId: flag("--conversation", "conv-fixture"),
    seedText: flag("--seed", "seed turn"),
    acceptDelayMs: number("--accept-delay-ms", 120),
    roundMs: number("--round-ms", 150),
    redrawMs: number("--redraw-ms", 60),
    subagentAtMs: number("--subagent-at-ms", -1),
  };
}

function storePath(args: FixtureArgs): string {
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

/** Create the conversation when it is absent; otherwise reuse it verbatim. */
function ensureStore(args: FixtureArgs, path: string): number {
  if (existsSync(path)) return nextIndex(path);
  const now = new Date().toISOString();
  appendLine(
    path,
    sessionFileToJsonl({
      schemaVersion: 5,
      conversation_id: args.conversationId,
      messages: [message(args.seedText, "user")],
      jsonMode: false,
      turnCount: 1,
      updatedAt: now,
      title: "fixture",
      cwd: args.cwd,
      sanitized_at: now,
      workspaceRoot: args.cwd,
      nativeStateFormat: 1,
      messageCreatedAt: [now],
    })
  );
  return nextIndex(path);
}

/** The historical false-positive shape: real files under the measured
 *  conversation that carry NO acceptance for the measured stimulus. */
function writeSubagentTranscript(args: FixtureArgs, uuid: string): void {
  const now = new Date().toISOString();
  appendLine(
    join(
      args.dataDir,
      "projects",
      computeProjectSlug(args.cwd),
      args.conversationId,
      SUBAGENT_TRACE_DIR_NAME,
      uuid,
      `${uuid}.jsonl`
    ),
    sessionFileToJsonl({
      schemaVersion: 5,
      conversation_id: uuid,
      messages: [message("sub-agent review", "assistant")],
      jsonMode: false,
      turnCount: 1,
      updatedAt: now,
      title: "sub",
      cwd: args.cwd,
      sanitized_at: now,
      nativeStateFormat: 1,
    })
  );
}

const REFUSAL = "当前会话正在运行；导航命令仍可用，消息请等本轮结束。";

class FixtureTui {
  private readonly args: FixtureArgs;
  private readonly path: string;
  private index: number;
  private composer = "";
  private busy = false;
  private frames = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(args: FixtureArgs) {
    this.args = args;
    this.path = storePath(args);
    mkdirSync(dirname(this.path), { recursive: true });
    this.index = ensureStore(args, this.path);
    if (args.subagentAtMs >= 0)
      this.later(args.subagentAtMs, () =>
        writeSubagentTranscript(args, "55a91052-0000-4000-8000-000000000001")
      );
  }

  start(): void {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) =>
      this.onInput(chunk.toString("utf8"))
    );
    process.stdin.on("end", () => this.exit(0));
    this.timer = setInterval(() => this.render(), this.args.redrawMs);
    this.render();
  }

  private render(): void {
    this.frames += 1;
    const screen = [
      "IKNOW-FIXTURE-TUI  (deterministic, no model calls)",
      `frames=${this.frames}  index=${this.index}`,
      `state=${this.busy ? "running" : "idle"}`,
      "",
      `> ${this.composer}`,
    ].join("\n");
    process.stdout.write(`\u001b[H\u001b[2J${screen}\n`);
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private onInput(text: string): void {
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        this.submit();
        continue;
      }
      if (char === "\u007f" || char === "\b") {
        this.composer = this.composer.slice(0, -1);
        this.render();
        continue;
      }
      if (char === "\u0003") {
        this.exit(130);
        continue;
      }
      this.composer += char;
    }
    this.render();
  }

  private submit(): void {
    const text = this.composer.trim();
    this.composer = "";
    if (text === "") return;
    if (text === "/quit") {
      process.stdout.write("\u001b[2Jfixture: bye\n");
      this.exit(0);
      return;
    }
    if (this.busy) {
      // The product's own refusal: nothing is persisted, so a retried stimulus
      // would be unprovable work.
      process.stdout.write(`${REFUSAL}\n`);
      return;
    }
    this.busy = true;
    this.later(this.args.acceptDelayMs, () => this.accept(text));
  }

  private accept(text: string): void {
    const id = messageEventId(this.index);
    const parent = this.index === 0 ? null : messageEventId(this.index - 1);
    this.index += 1;
    const now = new Date().toISOString();
    appendLine(
      this.path,
      JSON.stringify({
        type: "message",
        id,
        parent,
        message: message(text, "user"),
        createdAt: now,
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
        createdAt: new Date().toISOString(),
      })
    );
    this.render();
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
        createdAt: new Date().toISOString(),
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
        createdAt: new Date().toISOString(),
      })
    );
    appendLine(
      this.path,
      JSON.stringify({ type: "outcome", turnId: id, stopReason: "completed" })
    );
    this.busy = false;
    this.render();
  }

  private exit(code: number): void {
    if (this.timer !== null) clearInterval(this.timer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    process.exit(code);
  }
}

const args = readArgs(process.argv.slice(2));
new FixtureTui(args).start();
