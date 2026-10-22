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
 * times, so the denial is reached by production code paths rather than by an
 * injected result.
 *
 * WHAT A HARD-WALL DENIAL DOES (ADR-0135's 2026-10-10 amendment, commit
 * 265f8866 / PR #1242, acceptance in specs/hard-wall-denial-alignment.md
 * sections 8 and 11): a `[hard_wall]` denial is the command's non-overridable
 * per-call protection. It fails that tool call and is NOT a confirmed security
 * violation: it neither increments nor resets the streak, and it does not
 * interrupt the turn. The confirmed mid-tier violations that still interrupt
 * at three are `[network_denied]`, `[fs_denied]`, and a dangerous
 * `[permission_denied]` that is not a hard-wall denial. The old classifier
 * mapped "[hard_wall] dangerous ..." to the mid tier, so before that
 * amendment three hard-wall denials DID stop the turn; the first suite below
 * now asserts the policy the amendment defines, and the second suite covers
 * the interruption evidence.
 *
 * The CLI is run through `node --import tsx` on `src/cli.ts` rather than
 * `dist/`, so the test observes the sources under review and needs no build
 * step (same child-spawn discipline as register-shutdown.test.ts).
 */
import { describe, it, beforeAll, expect } from "vitest";
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
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startLoopbackModel } from "./_ask-loopback-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import { buildViolationWiring } from "../../src/harness/sandbox/violation-executor.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { violationRecordFromReason } from "../../src/harness/trace/violation-record.ts";
import { safeTrace } from "../../src/harness/trace/safe-trace.ts";

const run = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** tsx's ESM register entry, walking up for a hoisted node_modules. */
function resolveTsxEsm(): string {
  let dir = repoRoot;
  for (;;) {
    const candidate = join(
      dir,
      "node_modules",
      "tsx",
      "dist",
      "esm",
      "index.mjs"
    );
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
    const traceFile =
      files[0] === undefined ? undefined : join(traceDir, files[0]);
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
      { text: "the turn ran to its end" },
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

  it("a hard-wall denial fails its call without stopping the turn", () => {
    // ADR-0135's 2026-10-10 amendment (commit 265f8866, PR #1242; acceptance
    // in specs/hard-wall-denial-alignment.md sections 8 and 11) made a
    // `[hard_wall]` denial the command's per-call protection: it fails that
    // tool call and is NOT a confirmed security violation, so it neither
    // increments nor resets the streak and it does not interrupt the turn.
    // Before that amendment the classifier mapped "[hard_wall] dangerous ..."
    // to the mid tier, so three of these denials DID stop the turn - which is
    // what this case used to assert, and what made it red on master. The
    // guarantee it protects now is the opposite one, and it is the same
    // guarantee the two sibling suites assert for the same input
    // (tests/cli/chat-violation.test.ts and
    // tests/session-api/hub-trace-evidence.test.ts, both updated by that same
    // commit).
    expect(outcome.stderr).not.toContain("session killed");
    // The run finished on its own terms: the exit code is the run's, not an
    // interruption's.
    expect(outcome.code).toBe(0);
    // A denial the policy calls a per-call protection leaves no violation row.
    const violations = outcome.rows.filter(
      (r) => r["record_type"] === "violation"
    );
    expect(violations).toEqual([]);
    // The turn ran to its end: the scripted text turn after the three denials
    // was reached, so nothing stopped the run.
    const parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(parsed["turnCount"]).toBe(4);
    expect(String(parsed["finalText"])).toContain("the turn ran to its end");
  });

  it("leaves the raw run outcome untouched", () => {
    // Attribution is supplementary: whatever the trial's own score says, the
    // trace does not rewrite it. The ask JSON still reports its own stop.
    const parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(parsed["stopReason"]).toBeDefined();
    expect(parsed["turnCount"]).toBeGreaterThan(0);
  });
});

describe("ask entry: an interrupted turn leaves its cause on the trace", () => {
  it("writes the violation record the ask entry writes when a confirmed mid-tier violation stops the turn", async () => {
    // The composition the `ask` entry runs (src/cli.ts): the executor wrapped
    // by the violation wiring, whose onInterrupt writes the interruption
    // report through the same shared JSONL service the turn and tool rows use.
    //
    // Why this is not a second real child process: after ADR-0135's
    // 2026-10-10 amendment the only CONFIRMED mid-tier violation a
    // model-driven tool call can still produce is the egress seam's
    // `[network_denied]` - the `[fs_denied]` boundary guidance deliberately
    // rides the ok-envelope stderr channel and is NOT counted (see
    // src/harness/aci/tools/bash.ts) - and that seam needs the bundled relay
    // plus a live network, so it is not reachable in a hermetic run. The
    // escalating denial below is therefore synthetic, exactly as the
    // Serve-route sibling does it
    // (tests/session-api/hub-trace-evidence.test.ts); the wiring, the
    // classifier, the record builder and the JSONL service under test are all
    // production.
    const root = mkdtempSync(join(tmpdir(), "iknow-ask-interrupt-"));
    // The trace lands under a fresh temp directory: nothing reaches the
    // developer's own data/ or ~/.iknow.
    expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    const conversationId = "conversation-ask-interrupt";
    const turnId = "turn-ask-interrupt";
    const originalExitCode = process.exitCode;
    try {
      const traceService = createJsonlTraceService({
        filePath: root,
        conversationId,
      });
      const denied = createStubTool({
        name: "denied_tool",
        next: () => {
          throw new ToolExecutionError(
            "[network_denied] evil.com: not in allowlist"
          );
        },
      });
      const { executor } = buildViolationWiring(
        createExecutor(createRegistry([denied])),
        {
          onInterrupt: (reason: string) => {
            const record = violationRecordFromReason(
              reason,
              new Date().toISOString()
            );
            if (record === undefined) return;
            void safeTrace(() => traceService.recordViolation(record));
          },
        }
      );

      // The operator notice goes to the process's stderr through the
      // production default sink; capture it instead of letting it pollute the
      // test output.
      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8")
        );
        return true;
      }) as typeof process.stderr.write;
      try {
        await executor.executeAll(
          [
            { id: "call_1", name: "denied_tool", input: {} },
            { id: "call_2", name: "denied_tool", input: {} },
            { id: "call_3", name: "denied_tool", input: {} },
          ],
          undefined,
          undefined,
          conversationId,
          undefined,
          turnId
        );
      } finally {
        process.stderr.write = originalWrite;
      }
      const notice = stderrChunks.join("");
      expect(notice).toContain("[violation] session killed:");
      expect(notice).toContain("tier=mid");
      expect(notice).toContain("tool=denied_tool");
      // The interrupted run exits non-zero.
      expect(process.exitCode).toBe(1);

      const traceFile = join(root, `${conversationId}.jsonl`);
      const rows = readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const violations = rows.filter((r) => r["record_type"] === "violation");
      expect(violations.length).toBeGreaterThan(0);
      // Select the report by the evidence it carries, not by ordering.
      const report = violations.find(
        (v) => v["confirmed_violations"] !== undefined && "cleanup" in v
      );
      expect(report).toBeDefined();
      expect(report!["tier"]).toBe("mid");
      expect(report!["tool"]).toBe("denied_tool");
      expect(String(report!["message"])).toContain("network_denied");
      expect(report!["confirmed_violations"]).toBe(3);
      // Bound to the turn that was interrupted, not to file order.
      expect(report!["turn_id"]).toBe(turnId);
      expect(report!["cleanup"]).toBeDefined();
    } finally {
      process.exitCode = originalExitCode;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
