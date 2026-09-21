/**
 * ADR-0111 — exit-code semantics of the real `iknow __subagent_worker__` subprocess.
 *
 * Observation method = a real CLI subprocess (launched via tsx; same conclusion
 * as tests/cli/llm-provider-error.test.ts: cli.ts runs main() at top level, so
 * only a black box can prove the load-bearing catch routing).
 *
 * Pinned invariant (ADR-0111 invariant (b), codifying assumption 16 / SC13):
 *   1. exit 2 = envelope protocol errors **only** (stdin JSON parse failure /
 *      missing WorkerEnvelope fields → no envelope writable) → stderr
 *      `[subagent-worker] fatal`;
 *   2. an escape in the run phase after parse (here: loadIknowEnv throws a
 *      typed plain object) → best-effort failed envelope on stdout + exit 1,
 *      **no longer reusing 2**, and no `[subagent-worker] fatal` false alarm on stderr.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Same tsx resolution as tests/cli/llm-provider-error.test.ts (worktree node_modules). */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep climbing
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();

const UNSET_KEY = "IKNOW_T4_PROCESS_UNSET_KEY";

let scratch: string;
let home: string;
let sandboxRoot: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-worker-exit-"));
  home = join(scratch, "home");
  sandboxRoot = join(scratch, "task");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(sandboxRoot, { recursive: true });
  mkdirSync(join(scratch, "cwd"), { recursive: true });
  // provider `acme`'s apiKeyEnv is deliberately unset → after a legal envelope parses,
  // loadIknowEnv must throw (the run-phase escape surface). Envelope protocol errors
  // throw before settings loading, so the two states never interfere.
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify({
      llm: {
        model: "acme/foo",
        providers: [
          {
            id: "acme",
            baseUrl: "http://127.0.0.1:41999/v1",
            apiKeyEnv: UNSET_KEY,
            models: [{ id: "foo" }],
          },
        ],
      },
    })
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs the real worker subprocess once: feeds one line on stdin, collects stdout/stderr/exit code. */
function runWorkerProcess(
  stdinLine: string
): Promise<{ code: number | null; out: string; err: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete childEnv[UNSET_KEY];
  const child = spawn(
    process.execPath,
    [tsxCli, join(repoRoot, "src", "cli.ts"), "--subagent-worker"],
    {
      cwd: join(scratch, "cwd"),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  child.stdin.write(stdinLine);
  child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", () => resolve({ code: null, out, err }));
  });
}

describe("iknow --subagent-worker exit-code 语义（ADR-0111 不变式 (b)）", () => {
  it("stdin 非法 JSON → 仍 exit 2 + [subagent-worker] fatal + stdout 无信封（SC13 回归护栏）", async () => {
    const { code, out, err } = await runWorkerProcess("not-json\n");
    assert.equal(code, 2, `expected exit 2, stderr=${err}`);
    assert.match(err, /\[subagent-worker\] fatal/);
    assert.equal(out.trim(), "", `stdout must stay envelope-only; got=${out}`);
  }, 90_000);

  it("信封缺必填 task → 仍 exit 2（WorkerEnvelope 字段缺失 = 协议层崩溃）", async () => {
    const { code, err } = await runWorkerProcess(
      JSON.stringify({ sandboxRoot }) + "\n"
    );
    assert.equal(code, 2, `expected exit 2, stderr=${err}`);
    assert.match(err, /\[subagent-worker\] fatal/);
  }, 90_000);

  it("合法信封 + run 阶段装配逃逸 → exit 1 + stdout best-effort failed envelope（reason=crashed）+ stderr 无 fatal 误报", async () => {
    const { code, out, err } = await runWorkerProcess(
      JSON.stringify({ task: "any", sandboxRoot }) + "\n"
    );
    assert.equal(code, 1, `expected exit 1, stderr=${err}, stdout=${out}`);
    const envelope = JSON.parse(out.trim()) as {
      status: string;
      reason?: string;
      summary: string;
    };
    assert.equal(envelope.status, "failed");
    assert.equal(envelope.reason, "crashed");
    // A typed plain-object escape renders by fields (never collapses to [object Object]); the reserved exit code 2 is restored.
    assert.equal(envelope.summary.includes("[object Object]"), false);
    assert.match(envelope.summary, /acme/);
    assert.equal(
      err.includes("[subagent-worker] fatal"),
      false,
      `run-phase escape must not reuse fatal; stderr=${err}`
    );
  }, 90_000);
});
