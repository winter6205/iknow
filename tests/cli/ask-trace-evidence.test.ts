/**
 * T8 / SC12: the `ask` entry's runtime evidence, from a real process.
 *
 * `hub-trace-evidence.test.ts` covers the Serve route in-process. This file
 * covers the other in-scope route the spec names: a real `iknow ask` child
 * process, real CLI parse, real permission wall, real trace writer, reading
 * the JSONL the run actually produced.
 *
 * Only the model transport is stubbed (a loopback Anthropic-compatible server
 * on 127.0.0.1) — that is the external boundary, and everything under it stays
 * real. The scripted model issues a genuinely hard-wall-denied command three
 * times, so the interruption the spec asks about is reached by production code
 * paths rather than by an injected result.
 *
 * The CLI is run through `node --import tsx` on `src/cli.ts` rather than
 * `dist/`, so the test observes the sources under review and needs no build
 * step (same child-spawn discipline as register-shutdown.test.ts).
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startLoopbackModel } from "./_ask-loopback-model.ts";

const run = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** tsx's ESM register entry, walking up for a hoisted node_modules. */
function resolveTsxEsm(): string {
  let dir = repoRoot;
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep climbing
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/esm/index.mjs");
    dir = parent;
  }
}

const tsxEsm = resolveTsxEsm();

interface AskOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly traceFile: string | undefined;
  readonly rows: Array<Record<string, unknown>>;
}

/**
 * Run one real `iknow ask` against a loopback model and read back the trace it
 * wrote. `HOME`, `--data-dir` and `--workspace-root` all point into a fresh
 * temp tree, so nothing reaches the developer's own data/ or settings.
 */
async function runAsk(
  script: ReadonlyArray<{
    text?: string;
    tool?: { name: string; input: unknown };
  }>
): Promise<AskOutcome> {
  const model = await startLoopbackModel(script);
  const root = mkdtempSync(join(tmpdir(), "iknow-ask-evidence-"));
  try {
    const home = join(root, "home");
    const dataDir = join(root, "data");
    const workspace = join(root, "ws");
    const traceDir = join(root, "trace");
    for (const d of [home, dataDir, workspace, traceDir]) {
      mkdirSync(d, { recursive: true });
    }
    mkdirSync(join(home, ".iknow"), { recursive: true });
    writeFileSync(
      join(home, ".iknow", "settings.json"),
      JSON.stringify({
        llm: {
          model: "loopback/stub-model",
          providers: [
            {
              id: "loopback",
              baseUrl: model.baseUrl,
              apiKeyEnv: "IKNOW_TEST_KEY",
              models: [
                {
                  id: "stub-model",
                  name: "stub-model",
                  contextWindow: 200_000,
                  maxTokens: 8_000,
                },
              ],
            },
          ],
        },
      }),
      "utf8"
    );

    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      const res = await run(
        process.execPath,
        [
          "--import",
          tsxEsm,
          join(repoRoot, "src/cli.ts"),
          "ask",
          "clean up",
          "--json",
          "--trace-out",
          traceDir,
          "--data-dir",
          dataDir,
          "--workspace-root",
          workspace,
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            HOME: home,
            IKNOW_TEST_KEY: "test-key",
            IKNOW_PERMISSION_MODE: "full_auto",
          },
          maxBuffer: 32 * 1024 * 1024,
          timeout: 120_000,
        }
      );
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      code = typeof e.code === "number" ? e.code : 1;
    }

    const files = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
    const traceFile = files[0] === undefined ? undefined : join(traceDir, files[0]);
    const rows =
      traceFile === undefined
        ? []
        : readFileSync(traceFile, "utf8")
            .trim()
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code, stdout, stderr, traceFile, rows };
  } finally {
    await model.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ask entry: a real run emits parseable shared-schema evidence", () => {
  let outcome: AskOutcome;

  beforeAll(async () => {
    outcome = await runAsk([
      { tool: { name: "bash", input: { command: "rm -rf /" } } },
      { tool: { name: "bash", input: { command: "rm -rf /" } } },
      { tool: { name: "bash", input: { command: "rm -rf /" } } },
      { text: "unreachable if the turn was interrupted" },
    ]);
  }, 180_000);

  it("writes a trace file through the shared JSONL service", () => {
    expect(outcome.traceFile).toBeDefined();
    // Every line is a JSON object carrying the shared schema's discriminator
    // and the instance-bound conversation id.
    expect(outcome.rows.length).toBeGreaterThan(0);
    for (const row of outcome.rows) {
      expect(typeof row["record_type"]).toBe("string");
      expect(typeof row["conversation_id"]).toBe("string");
    }
    const convIds = new Set(outcome.rows.map((r) => r["conversation_id"]));
    expect(convIds.size).toBe(1);
  });

  it("records the permission verdict, the command, and the turn identity", () => {
    const denials = outcome.rows.filter(
      (r) =>
        r["record_type"] === "tool_call" &&
        (r["error"] as { message?: string } | undefined)?.message?.includes(
          "hard_wall"
        )
    );
    // Three real denials by the real permission wall — no injected result.
    expect(denials.length).toBe(3);
    for (const d of denials) {
      expect(d["tool_name"]).toBe("bash");
      expect(d["tool_kind"]).toBe("execution_failed");
      expect(d["status"]).toBe("error");
      // The exact offending command is on the row, which is what the pilot
      // report said was missing: a hard-wall deny whose command text was
      // never captured cannot be classified afterwards.
      expect((d["arguments"] as { command: string }).command).toBe("rm -rf /");
      // A gate verdict is a fact, not a cause: nothing here claims the wall
      // was right or wrong.
      expect("cause" in d).toBe(false);
      expect("cleanup" in d).toBe(false);
    }

    // Each denial is bound to a concrete turn through the id chain.
    const turns = outcome.rows.filter((r) => r["record_type"] === "turn");
    expect(turns.length).toBeGreaterThan(0);
    const toolCallIds = new Set(
      denials.map((d) => d["tool_call_id"] as string)
    );
    const linked = turns.filter((t) =>
      (t["tool_call_ids"] as string[]).some((id) => toolCallIds.has(id))
    );
    expect(linked.length).toBe(3);
  });

  it("records the security interruption that stopped the turn", () => {
    // The gap this task exists to close: `ask` reached the escalation (it
    // printed the operator notice and exited non-zero) but wrote no
    // `violation` row, so the interrupted turn was unreconstructable from the
    // evidence a trial retains.
    expect(outcome.stderr).toContain("session killed");
    expect(outcome.code).not.toBe(0);

    const violations = outcome.rows.filter(
      (r) => r["record_type"] === "violation"
    );
    expect(violations.length).toBeGreaterThan(0);
    // The escalation notification and the structured report are two rows;
    // select the report by the evidence it carries, not by ordering.
    const report = violations.find(
      (v) => v["confirmed_violations"] !== undefined && "cleanup" in v
    );
    expect(report).toBeDefined();
    expect(report!["tier"]).toBe("mid");
    expect(report!["tool"]).toBe("bash");
    expect(report!["message"]).toContain("hard_wall");
    expect(report!["confirmed_violations"]).toBe(3);
    // Bound to a turn that exists in the same file, not to file order.
    const turnId = report!["turn_id"] as string;
    expect(
      outcome.rows.some(
        (r) => r["record_type"] === "turn" && r["turn_id"] === turnId
      )
    ).toBe(true);
  });

  it("leaves the raw run outcome untouched", () => {
    // Attribution is supplementary: whatever the trial's own score says, the
    // trace does not rewrite it. The ask JSON still reports its own stop.
    const parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(parsed["stopReason"]).toBeDefined();
    expect(parsed["turnCount"]).toBeGreaterThan(0);
  });
});
