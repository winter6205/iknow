/**
 * tests/cli/tui-launch-fallback.test.ts
 *
 * The dispatch-side half of the bare-launch contract: a chat anchor on the `tui`
 * head is refused before anything starts, and a TUI launch with Bun missing
 * answers according to how it was launched.
 *
 * Why a real child process for the refusal: `src/cli.ts` runs `main()` at module
 * load, so the dispatch path cannot be imported (same conclusion as
 * `tests/cli/cli-yolo-non-tui-reject.test.ts`). Only a black-box run proves both
 * facts at once — the `process.exit(1)` and "nothing started", the latter read as
 * an empty stdout plus a scratch directory that gained no file.
 *
 * What stays source-read, and why nothing observable can express it: the Bun-missing
 * arms are chosen by `parsed.implicitTuiLaunch`, which only a bare launch **on a TTY**
 * sets, and a piped child process never is one. Those arms — the implicit fallback to
 * the chat REPL, the loud failure for a posture or explicit `tui` launch, and the
 * `--max-turns` handoff into the TUI entry — are kept as narrow source guards here and
 * exercised for real through the PTY pass; the loud arm additionally has its
 * process-level face in `tests/cli/tui-bun-reexec.test.ts`.
 *
 * The refusal precedence is no longer a dispatch-order question: the parser emits a
 * single rejection (`baseParsed` in src/cli/parse-args.ts), pinned in
 * `tests/cli/parse-args-bare-route.test.ts` and `tests/cli/parse-args-tui.test.ts`.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** src/cli.ts as text: the dispatcher runs main() at load, so this is the only read. */
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");

/** Same tsx lookup as tests/cli/cli-yolo-non-tui-reject.test.ts. */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();

let scratch: string;
let home: string;
let cwd: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-tui-entry-reject-"));
  home = join(scratch, "home");
  cwd = join(scratch, "cwd");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface CliRun {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** Run one real CLI child process (isolated HOME / cwd); returns exit code + both streams. */
function runCli(args: string[]): Promise<CliRun> {
  const child = spawn(
    process.execPath,
    [tsxCli, join(repoRoot, "src", "cli.ts"), ...args],
    {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", () => resolve({ code: null, out, err }));
  });
}

/** Everything under scratch: a changed list means something was started or written. */
function listFiles(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...listFiles(full, base));
    else found.push(full.slice(base.length + 1));
  }
  return found;
}

/** One top-level function's body, delimited by its signature and the next column-0 brace. */
function topLevelFunction(name: string): string {
  const start = cliSource.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `src/cli.ts must define ${name}`);
  const end = cliSource.indexOf("\n}", start);
  assert.ok(end !== -1, `${name} must end at a column-0 brace`);
  return cliSource.slice(start, end);
}

const CHAT_ANCHOR_ON_TUI: ReadonlyArray<{
  readonly label: string;
  readonly argv: string[];
  readonly forms: string[];
}> = [
  { label: "--json", argv: ["tui", "--json"], forms: ["iknow chat --json"] },
  {
    label: "--resume <id>",
    argv: ["tui", "--resume", "ses_1"],
    forms: ["iknow tui ses_1", "iknow chat --resume ses_1"],
  },
];

describe("CLI dispatch: a chat anchor on the tui head -> typed refusal, nothing started", () => {
  it.each(CHAT_ANCHOR_ON_TUI)(
    "iknow $label -> exit 1, stderr rendered as tui_entry_refusal naming the supported form",
    async ({ argv, forms }) => {
      const { code, out, err } = await runCli(argv);
      assert.equal(code, 1, `expected exit 1, stderr=${err}`);
      // Typed rendering contract: `${kind}: ...` — a plain union object must not
      // collapse through the `String(err)` arm.
      assert.match(err, /^tui_entry_refusal: /);
      assert.equal(err.includes("[object Object]"), false);
      for (const form of forms) {
        assert.ok(
          err.includes(form),
          `stderr must name '${form}', got: ${err}`
        );
      }
      assert.equal(out, "");
      // The refusal precedes the TUI route: a Node child with Bun reachable or not
      // must never get as far as the missing-Bun intercept copy.
      assert.equal(err.includes("Bun"), false);
    }
  );

  it("the refusal creates no session / settings file (physical evidence of nothing started)", async () => {
    const before = listFiles(scratch).sort();
    const { code } = await runCli(["tui", "--json"]);
    assert.equal(code, 1);
    assert.deepEqual(
      listFiles(scratch).sort(),
      before,
      "the refusal path must not create settings / session / trace files"
    );
  });
});

describe("CLI dispatch: the typed refusal renders once, before any route", () => {
  it("main() calls one refusal guard, ahead of every command dispatch", () => {
    const main = topLevelFunction("main");
    const guard = main.indexOf("rejectParsedRequest(parsed)");
    const firstDispatch = main.indexOf('parsed.command === "chat"');
    assert.ok(
      guard !== -1,
      "main() must call the refusal guard, not a sub-dispatch"
    );
    assert.equal(
      main.indexOf("rejectParsedRequest(parsed)", guard + 1),
      -1,
      "one guard call: a second read point could render a different family"
    );
    assert.ok(
      guard < firstDispatch,
      "the refusal happens before any route starts"
    );
    // One read per family, all inside that guard: precedence is the parser's.
    for (const field of [
      "yoloRejection",
      "tuiEntryRejection",
      "evalStateRejection",
    ]) {
      assert.equal(
        (cliSource.match(new RegExp(`parsed\\.${field}`, "g")) ?? []).length,
        1,
        `parsed.${field} must be read at exactly one point`
      );
    }
  });
});

describe("CLI dispatch: a TUI launch without Bun (source-read: needs a real TTY)", () => {
  it("runTui uses one stderr writer, and hands an implicit bare launch to runChat", () => {
    const runTui = topLevelFunction("runTui");
    const branch = runTui.indexOf("parsed.implicitTuiLaunch");
    assert.ok(branch !== -1, "runTui must read the launch origin");
    const notice = runTui.indexOf("writeErr(", branch);
    const chatCall = runTui.indexOf("await runChat(parsed)", branch);
    assert.ok(
      chatCall !== -1,
      "the implicit branch must hand the request to runChat"
    );
    assert.ok(
      notice !== -1 && notice < chatCall,
      "the notice precedes the chat startup"
    );
    // One writer for the whole branch: both arms of the missing-Bun answer go through
    // `writeErr`, so the two cannot drift on newline handling.
    assert.equal(
      runTui.includes("process.stderr.write"),
      false,
      "runTui must not mix stderr writers"
    );
    // No duplicated chat startup anywhere: exactly the command dispatch and this
    // fallback call it.
    assert.equal(
      (cliSource.match(/await runChat\(parsed\)/g) ?? []).length,
      2,
      "the fallback must reuse runChat instead of re-implementing chat startup"
    );
  });

  it("a launch that named the TUI keeps the loud failure: intercept copy, then non-zero", () => {
    const runTui = topLevelFunction("runTui");
    const intercept = runTui.indexOf("tuiNodeInterceptMessage(cliFile)");
    assert.ok(
      intercept !== -1,
      "the Bun-missing intercept must stay in runTui"
    );
    const exit = runTui.indexOf("process.exitCode = 1", intercept);
    assert.ok(exit !== -1, "the loud path must set a non-zero exit code");
    assert.ok(
      runTui.indexOf("implicitTuiLaunch") < intercept,
      "the implicit fallback branch must be chosen before the intercept runs"
    );
    assert.ok(
      runTui.indexOf("startTui") > intercept,
      "nothing may reach the TUI renderer after a missing-Bun failure"
    );
  });

  it("runTui hands the parsed turn cap to the TUI entry, so the flag has a route", () => {
    const runTui = topLevelFunction("runTui");
    const startTui = runTui.indexOf("startTui({");
    assert.ok(
      startTui !== -1,
      "runTui must call the TUI entry with one object"
    );
    const forwarded = runTui.slice(
      startTui,
      runTui.indexOf("\n  });", startTui)
    );
    assert.match(
      forwarded,
      /maxTurns: parsed\.maxTurns/,
      "the cap must reach the TUI assembly, not stop at the parse result"
    );
  });
});
