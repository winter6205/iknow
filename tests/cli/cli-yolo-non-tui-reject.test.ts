/**
 * tests/cli/cli-yolo-non-tui-reject.test.ts
 *
 * ADR-0119 ruling 7 / `specs/yolo-mode.md` EXIT: a non-TUI entry point carrying
 * `--yolo` must **exit non-zero without starting the service or a session**, and
 * the refusal renders through the typed discriminated union as
 * `yolo_non_tui_entry: ...` on stderr.
 *
 * Why a real child process: `cli.ts` runs `main()` at module top level, so it
 * cannot be imported for a unit test (same conclusion as
 * `tests/cli/llm-provider-error.test.ts`). Only a black-box run of the real CLI
 * can prove both facts — the `process.exit(1)` at dispatch and "nothing started".
 *
 * Isolation: HOME / cwd point at a scratch directory. The refusal happens before
 * any settings / store read, so the cases below also assert that scratch gains no
 * new file — the physical evidence for "nothing started".
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Same tsx lookup as tests/cli/llm-provider-error.test.ts. */
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
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-yolo-reject-"));
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

/** Recursively collect non-empty relative paths under scratch (the "nothing started" evidence face). */
function listFiles(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...listFiles(full, base));
    else found.push(full.slice(base.length + 1));
  }
  return found;
}

const NON_TUI_ENTRIES: ReadonlyArray<{
  readonly command: string;
  readonly argv: string[];
}> = [
  { command: "chat", argv: ["chat"] },
  { command: "serve", argv: ["serve"] },
  { command: "ask", argv: ["ask", "hi"] },
  { command: "oneshot", argv: ["hi"] },
  { command: "trace", argv: ["trace"] },
];

describe("CLI dispatch: --yolo on a non-TUI command -> typed refusal + exit 1 + nothing started", () => {
  it.each(NON_TUI_ENTRIES)(
    "iknow $command --yolo -> exit 1, stderr rendered as yolo_non_tui_entry",
    async ({ command, argv }) => {
      const { code, out, err } = await runCli([...argv, "--yolo"]);
      assert.equal(code, 1, `expected exit 1, stderr=${err}`);
      // Typed rendering contract: `${kind}: ...` naming the command — not a bare
      // Error message.
      assert.match(err, /^yolo_non_tui_entry: /);
      assert.ok(
        err.includes(`'${command}'`),
        `stderr must name the command, got: ${err}`
      );
      // A plain object must not collapse (the discriminated union does not go
      // through the instanceof Error branch).
      assert.equal(err.includes("[object Object]"), false);
      assert.ok(
        err.includes("iknow tui --yolo"),
        "points at the only legal entry"
      );
      // Nothing started: no normal startup output at all (serve's URL line /
      // trace's panel line).
      assert.equal(out, "");
    }
  );

  it("chat --yolo creates no session / settings file (physical evidence of nothing started)", async () => {
    const before = listFiles(scratch).sort();
    const { code } = await runCli(["chat", "--yolo"]);
    assert.equal(code, 1);
    assert.deepEqual(
      listFiles(scratch).sort(),
      before,
      "the refusal path must not create settings / session / trace files"
    );
  });
});

describe("CLI dispatch: the tui entry is not refused by --yolo (the only legal face)", () => {
  it("iknow tui --yolo does not hit the dispatch-time yolo_non_tui_entry", async () => {
    // What this case certifies is that any refusal happens **elsewhere**:
    // dispatch lets `tui --yolo` through and hands the flag to the TUI assembly
    // layer, so a non-zero exit here can only come from a post-dispatch runtime
    // guard. Under tsx/Node two such guards exist and either is legitimate:
    //   - no Bun on PATH        -> usage.ts "未找到 Bun" intercept copy;
    //   - Bun present, no TTY   -> run.tsx renderer guard "未检测到交互终端".
    // Which one fires is a property of the host, not of yolo, so the assertion
    // accepts either downstream guard while still forbidding the dispatch-time
    // yolo refusal — that pairing is the invariant.
    const { err } = await runCli(["tui", "--yolo"]);
    assert.equal(err.includes("yolo_non_tui_entry"), false);
    assert.match(err, /未检测到交互终端|未找到 Bun/);
  });
});

describe("CLI dispatch: pure display paths are explicitly allowed (exit 0, no session start)", () => {
  it.each([["-h"], ["--help"]])(
    "iknow %s --yolo -> exit 0, usage on stdout, no refusal",
    async (flag) => {
      const { code, out, err } = await runCli([flag, "--yolo"]);
      assert.equal(code, 0, `expected exit 0, stderr=${err}`);
      assert.match(out, /--yolo/);
      assert.equal(err.includes("yolo_non_tui_entry"), false);
    }
  );

  it.each([["-V"], ["--version"]])(
    "iknow %s --yolo -> exit 0, version on stdout, no refusal",
    async (flag) => {
      const { code, out, err } = await runCli(["--yolo", flag]);
      assert.equal(code, 0, `expected exit 0, stderr=${err}`);
      assert.match(out.trim(), /^\d+\.\d+\.\d+/);
      assert.equal(err.includes("yolo_non_tui_entry"), false);
    }
  );

  it("iknow --yolo (bare, no subcommand) -> exit 0, usage, no session start", async () => {
    const { code, out, err } = await runCli(["--yolo"]);
    assert.equal(code, 0, `expected exit 0, stderr=${err}`);
    assert.match(out, /用法 \/ Usage:/);
    assert.equal(err.includes("yolo_non_tui_entry"), false);
  });
});
