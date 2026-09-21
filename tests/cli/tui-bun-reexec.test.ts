/**
 * #1076: under Node, `iknow tui` automatically re-runs the same CLI file with
 * the Bun found on PATH, in the same cwd.
 *
 * Black-box subprocess test: cli.ts runs main() at top level, so the spawn
 * wiring is only provable end-to-end (same conclusion as
 * tests/cli/subagent-worker-exit.test.ts).
 * Pinned invariants:
 *   1. bun on PATH → the child starts as `bun <this CLI file> tui <orig argv...>`,
 *      argv passed through as discrete array elements (spaced args not split),
 *      cwd unchanged, child exit code propagated verbatim;
 *   2. child killed by a signal → exit with 128+signum per shell convention
 *      (distinct from plain failure code 1);
 *   3. no bun on PATH → never enter the TUI, emit the intercept message on
 *      stderr (including a copy-pasteable `bun <file> tui`), exit 1.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliTs = join(repoRoot, "src", "cli.ts");

/** Same tsx lookup strategy as tests/cli/subagent-worker-exit.test.ts. */
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
let workCwd: string;
let binWithBun: string;
let binEmpty: string;
let binSuicide: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-1076-"));
  workCwd = join(scratch, "other-project");
  mkdirSync(workCwd, { recursive: true });
  binWithBun = join(scratch, "bin-bun");
  binEmpty = join(scratch, "bin-empty");
  binSuicide = join(scratch, "bin-suicide");
  mkdirSync(binWithBun, { recursive: true });
  mkdirSync(binEmpty, { recursive: true });
  mkdirSync(binSuicide, { recursive: true });
  // fake bun: print each argv element and the cwd, then exit 7 — verifies discrete pass-through and code propagation.
  const fakeBun = join(binWithBun, "bun");
  writeFileSync(
    fakeBun,
    [
      "#!/bin/sh",
      'for a in "$@"; do echo "ARG:$a"; done',
      'echo "FAKEBUNCWD $PWD"',
      "exit 7",
      "",
    ].join("\n")
  );
  chmodSync(fakeBun, 0o755);
  // fake bun: SIGTERM itself — verifies the parent propagates signal death as 128+15.
  const suicideBun = join(binSuicide, "bun");
  writeFileSync(suicideBun, "#!/bin/sh\nkill -TERM $$\n");
  chmodSync(suicideBun, 0o755);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runCliTui(
  pathDir: string,
  tuiArgs: string[] = []
): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [tsxCli, cliTs, "tui", ...tuiArgs], {
    cwd: workCwd,
    env: { ...process.env, PATH: pathDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", () => resolve({ code: null, out, err }));
  });
}

describe("iknow tui Node→Bun re-exec (#1076)", () => {
  it("bun 在 PATH：用 bun 重跑同一 CLI 文件 + argv 离散透传（含空格参数不拆分），cwd 不变，exit code 传播", async () => {
    const { code, out, err } = await runCliTui(binWithBun, [
      "session with space",
      "--auto-mode",
    ]);
    assert.equal(code, 7, `child exit code must propagate; stderr=${err}`);
    const argLines = out.split("\n").filter((l) => l.startsWith("ARG:"));
    assert.deepEqual(argLines, [
      `ARG:${cliTs}`,
      "ARG:tui",
      "ARG:session with space",
      "ARG:--auto-mode",
    ]);
    assert.match(
      out,
      new RegExp(`FAKEBUNCWD ${workCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.equal(
      err.includes("TUI 需用 Bun"),
      false,
      "with bun on PATH the intercept copy must not appear"
    );
  }, 90_000);

  it("bun 子进程死于 SIGTERM：父进程按 shell 约定以 128+15=143 退出", async () => {
    const { code, err } = await runCliTui(binSuicide, ["--auto-mode"]);
    assert.equal(
      code,
      143,
      `signal death must map to 128+signum; stderr=${err}`
    );
  }, 90_000);

  it("bun 不在 PATH：拦截文案到 stderr + exit 1，且不进入 TUI", async () => {
    const { code, out, err } = await runCliTui(binEmpty);
    assert.equal(code, 1, `expected exit 1; stderr=${err}`);
    assert.match(err, /Bun/);
    assert.match(
      err,
      new RegExp(`bun .*cli\\.ts.* tui|bun "[^"]*cli\\.ts" tui`)
    );
    assert.equal(err.includes("请改用：npm run dev:tui"), false);
    assert.equal(out.includes("FAKEBUN"), false);
  }, 90_000);
});
