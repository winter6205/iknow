/**
 * tests/cli/cli-eval-state-non-entry-reject.test.ts
 *
 * ADR-0130 §1 / eval-state EXIT face: `--eval-state` is a **named** opt-in on the
 * headless one-shot entries only. Every other entry that carries it must
 * **exit non-zero with nothing started**, rendering the typed discriminated
 * union as `eval_state_unsupported_entry: ...` on stderr — never `[object
 * Object]`, never a silent ignore (the `--auto-mode` silent-ignore precedent
 * that ADR-0119 §ruling 7 explicitly refuses to adopt).
 *
 * Why a real child process: `src/cli.ts` runs `main()` at module top level, so
 * the dispatch path cannot be imported (same conclusion as
 * `tests/cli/cli-yolo-non-tui-reject.test.ts`). Isolation: HOME / cwd point at a
 * scratch directory, and the cases assert that scratch gained no new file — the
 * physical evidence for "nothing started".
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-eval-state-reject-"));
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

function listFiles(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...listFiles(full, base));
    else found.push(full.slice(base.length + 1));
  }
  return found;
}

const NON_EVAL_ENTRIES: ReadonlyArray<{
  readonly command: string;
  readonly argv: string[];
}> = [
  { command: "chat", argv: ["chat"] },
  { command: "serve", argv: ["serve"] },
  { command: "trace", argv: ["trace"] },
];

describe("CLI dispatch: --eval-state on a non-eval entry -> typed refusal + exit 1", () => {
  it.each(NON_EVAL_ENTRIES)(
    "iknow $command --eval-state -> exit 1, stderr rendered as eval_state_unsupported_entry",
    async ({ command, argv }) => {
      const { code, out, err } = await runCli([...argv, "--eval-state"]);
      assert.equal(code, 1, `expected exit 1, stderr=${err}`);
      assert.match(err, /^eval_state_unsupported_entry: /);
      assert.ok(
        err.includes(`'${command}'`),
        `stderr must name the command: ${err}`
      );
      assert.equal(err.includes("[object Object]"), false);
      assert.ok(
        err.includes("iknow ask"),
        "points at the named benchmark face"
      );
      assert.equal(out, "", "nothing started: no normal startup output");
    }
  );

  it("iknow tui --eval-state is refused too (the TUI has its own named posture)", async () => {
    const { code, err } = await runCli(["tui", "--eval-state"]);
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.match(err, /^eval_state_unsupported_entry: /);
    assert.equal(err.includes("yolo_non_tui_entry"), false);
  });

  it("chat --eval-state creates no session / settings file (physical evidence of nothing started)", async () => {
    const before = listFiles(scratch).sort();
    const { code } = await runCli(["chat", "--eval-state"]);
    assert.equal(code, 1);
    assert.deepEqual(
      listFiles(scratch).sort(),
      before,
      "the refusal path must not create settings / session / trace files"
    );
  });

  it("--eval-state + --resume on ask refuses loudly at dispatch (incoherent request)", async () => {
    const { code, err, out } = await runCli([
      "ask",
      "hi",
      "--eval-state",
      "--resume",
      "abc-123",
    ]);
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.match(err, /^eval_state_flag_conflict: /);
    assert.equal(out, "", "the run must not start");
  });

  it("--yolo on ask keeps its own typed refusal even next to --eval-state (ADR-0130 §1)", async () => {
    const { code, err } = await runCli(["ask", "hi", "--eval-state", "--yolo"]);
    assert.equal(code, 1);
    assert.match(err, /^yolo_non_tui_entry: /);
    assert.equal(err.includes("eval_state"), false);
  });
});

describe("CLI dispatch: display paths with --eval-state are the declared allowance", () => {
  it.each([["-h"], ["--help"]])(
    "iknow %s --eval-state -> exit 0, usage on stdout, no refusal",
    async (flag) => {
      const { code, out, err } = await runCli([flag, "--eval-state"]);
      assert.equal(code, 0, `expected exit 0, stderr=${err}`);
      assert.match(out, /--eval-state/);
      assert.equal(err.includes("eval_state_unsupported_entry"), false);
    }
  );

  it("iknow --eval-state (bare, no subcommand) -> exit 0, usage, no session start", async () => {
    const { code, out, err } = await runCli(["--eval-state"]);
    assert.equal(code, 0, `expected exit 0, stderr=${err}`);
    assert.match(out, /用法 \/ Usage:/);
    assert.equal(err.includes("eval_state"), false);
  });
});
