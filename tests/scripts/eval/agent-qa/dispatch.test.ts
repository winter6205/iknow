/**
 * Dispatch witnesses the production engine running one real attempt offline: the
 * scripted provider answers at the wire, and everything behind it — assembly, loop,
 * permission executor, ACI tools, trace writer — is the shipped code.
 *
 * Nothing here can reach a real endpoint: the env is built in code with a synthetic
 * key and a loopback baseUrl, and settings are injected rather than loaded.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { dispatchAttempt } from "../../../../scripts/eval/agent-qa/dispatch.ts";
import type { DispatchInput } from "../../../../scripts/eval/agent-qa/dispatch.ts";
import { createJsonlTraceReader } from "../../../../src/traceserver/reader.ts";
import { LIMIT_NAMES } from "../../../../scripts/eval/agent-qa/types.ts";
import type { ScriptedStep } from "../../../../scripts/eval/agent-qa/types.ts";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-dispatch-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function input(
  root: string,
  overrides: Partial<DispatchInput> = {}
): DispatchInput {
  return {
    workspaceRoot: join(root, "workspace"),
    dataDir: join(root, "state"),
    traceDir: join(root, "trace"),
    conversationId: randomUUID(),
    turns: ["write the note"],
    scripted: [{ kind: "text", text: "done" }],
    budget: { maxTurns: 4, wallMs: 20_000, inputTokens: null, outputTokens: null },
    ...overrides,
  };
}

function seedWorkspace(root: string): string {
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "seed.txt"), "seed\n", "utf8");
  return workspace;
}

/** One scripted write_file step, so the effect is a real production tool result. */
const WRITE_STEP: ScriptedStep = {
  kind: "tool",
  toolCallId: "dispatch-write-1",
  toolName: "write_file",
  input: { path: "notes.md", content: "status: verified\n" },
};

describe("dispatchAttempt — the real engine, offline", () => {
  it(
    "runs a scripted tool call through production tools and writes real bytes",
    async () => {
      const root = scratch();
      const workspace = seedWorkspace(root);
      const caseInput = input(root, {
        turns: ["write notes.md with the verified status line"],
        scripted: [WRITE_STEP, { kind: "text", text: "wrote notes.md" }],
      });

      const dispatched = await dispatchAttempt(caseInput);

      assert.equal(
        readFileSync(join(workspace, "notes.md"), "utf8"),
        "status: verified\n"
      );
      assert.equal(dispatched.validity, "valid");
      assert.equal(dispatched.turnsRun, 2);
      assert.equal(dispatched.providerRequests, 2);
      assert.equal(dispatched.cleanup.status, "confirmed");
      assert.equal(dispatched.failure, null);
      // The attempt's cost is the sum over the model calls it retained, not the last
      // call's reading: this run made two calls and the scripted provider states 11 in
      // and 7 out for each.
      assert.equal(dispatched.usage.inputTokens, 22);
      assert.equal(dispatched.usage.outputTokens, 14);
      assert.equal(dispatched.usage.usageComplete, true);
      // Dimension 4 states every limit the frozen budget names, applied or not.
      assert.deepEqual(dispatched.limits.map((limit) => limit.name), [...LIMIT_NAMES]);
      // A cap the budget froze as unbounded still appears, states no number, and cannot
      // be passed — its absence would read as if no such limit had ever been considered.
      for (const name of ["inputTokens", "outputTokens"] as const) {
        const limit = dispatched.limits.find((entry) => entry.name === name);
        assert.equal(limit?.declared, null);
        assert.equal(limit?.overrun, false);
      }

      const reader = createJsonlTraceReader({ filePath: dispatched.tracePath });
      assert.equal(reader.query({ recordType: "llm_call" }).total, 2);
      assert.equal(reader.query({ recordType: "tool_call" }).total, 1);
      const toolRow = reader.query({ recordType: "tool_call" }).records[0];
      assert.equal(toolRow?.["tool_name"], "write_file");
      assert.equal(toolRow?.["status"], "ok");
      assert.equal(
        reader.query({ conversationId: caseInput.conversationId }).total > 0,
        true
      );
    },
    60_000
  );

  it("keeps unknown usage unknown when the provider states none", async () => {
    const root = scratch();
    const dispatched = await dispatchAttempt(
      input(root, { providerUsage: "absent" })
    );
    assert.equal(dispatched.usage.usageComplete, false);
    // Externally provable: the provider really served a usage-less response, so the
    // unknown below is "never stated", not "we never asked".
    assert.equal(dispatched.providerRequests, 1);
    // null is the only honest reading of "the response never said": 0 would be a
    // measured cost of nothing.
    assert.equal(dispatched.usage.inputTokens, null);
    assert.equal(dispatched.usage.outputTokens, null);
    assert.notEqual(dispatched.usage.inputTokens, 0);
  });

  it("states a token cap as observed and overrun, never as applied", async () => {
    const root = scratch();
    const steps: ScriptedStep[] = [0, 1].map((index) => ({
      kind: "tool",
      toolCallId: `cap-${index}`,
      toolName: "write_file",
      input: { path: `notes-cap-${index}.md`, content: `line ${index}\n` },
    }));
    const dispatched = await dispatchAttempt(
      input(root, {
        scripted: [...steps, { kind: "text", text: "both written" }],
        budget: { maxTurns: 8, wallMs: 30_000, inputTokens: 20, outputTokens: 500 },
      })
    );

    // The cap is a fact about the run, not a switch the loop holds: nothing here stops a
    // run for spending tokens, so the state says what was spent and that it went past the
    // frozen number, and leaves the reading of that to the reviewer.
    const rows = createJsonlTraceReader({ filePath: dispatched.tracePath }).query({
      recordType: "llm_call",
      limit: 200,
    }).total;
    const spent = dispatched.limits.find((limit) => limit.name === "inputTokens");
    assert.equal(spent?.declared, 20);
    assert.equal(spent?.observed, 11 * rows);
    assert.equal(spent?.applied, false);
    assert.equal(spent?.overrun, true);
    const kept = dispatched.limits.find((limit) => limit.name === "outputTokens");
    assert.equal(kept?.observed, 7 * rows);
    assert.equal(kept?.overrun, false);
  });

  it("applies maxTurns at the loop boundary rather than annotating the report", async () => {
    const root = scratch();
    const workspace = seedWorkspace(root);
    const steps: ScriptedStep[] = [0, 1, 2, 3].map((index) => ({
      kind: "tool",
      toolCallId: `mt-${index}`,
      toolName: "write_file",
      input: { path: `notes-${index}.md`, content: `line ${index}\n` },
    }));
    const dispatched = await dispatchAttempt(
      input(root, {
        scripted: steps,
        budget: { maxTurns: 2, wallMs: 30_000, inputTokens: null, outputTokens: null },
      })
    );

    assert.equal(dispatched.stopReason, "maxTurns");
    const limit = dispatched.limits.find((row) => row.name === "maxTurns");
    assert.equal(limit?.applied, true);
    assert.equal(limit?.declared, 2);
    assert.equal(limit?.observed, 2);
    assert.equal(limit?.overrun, false);
    // The cap stopped the loop mid-script: two declared steps dispatched, the third
    // and fourth never did.
    assert.equal(dispatched.providerRequests >= 2, true);
    assert.equal(readFileSync(join(workspace, "notes-1.md"), "utf8"), "line 1\n");
    assert.throws(() => readFileSync(join(workspace, "notes-3.md"), "utf8"));
  });

  it("aborts on the wall clock and reports the limit as applied", async () => {
    const root = scratch();
    const dispatched = await dispatchAttempt(
      input(root, {
        scripted: [
          WRITE_STEP,
          { kind: "text", text: "should never be reached" },
        ],
        budget: { maxTurns: 4, wallMs: 1, inputTokens: null, outputTokens: null },
      })
    );
    const limit = dispatched.limits.find((row) => row.name === "wallMs");
    assert.equal(limit?.applied, true);
    assert.equal(limit?.overrun, true);
    assert.equal(dispatched.turnsRun, 0);
    assert.equal(dispatched.stopReason, "cancelled");
  });

  it("reports a provider fault as provider-error, never as a silent success", async () => {
    const root = scratch();
    const dispatched = await dispatchAttempt(
      input(root, { scripted: [], turns: ["a turn nobody scripted"] })
    );
    assert.equal(dispatched.validity, "provider-error");
    assert.equal(dispatched.failure?.kind, "provider-failure");
    assert.equal(dispatched.usage.inputTokens, null);
    assert.notEqual(dispatched.stopReason, "completed");
    // The owned server is gone even though the run faulted.
    assert.equal(dispatched.cleanup.status, "confirmed");
  });

  it("types a dispatch-side filesystem fault instead of blaming the provider", async () => {
    const root = scratch();
    const dataDir = join(root, "state");
    mkdirSync(dataDir, { recursive: true });
    chmodSync(dataDir, 0o500);
    try {
      const dispatched = await dispatchAttempt(input(root, { dataDir }));
      assert.equal(dispatched.validity, "invalid");
      assert.deepEqual(dispatched.failure, {
        kind: "io-failure",
        phase: "dispatch",
      });
      // The endpoint the fault would be blamed on was never asked for anything:
      // naming it here would be a guess the bytes contradict.
      assert.equal(dispatched.providerRequests, 0);
      assert.equal(dispatched.cleanup.status, "confirmed");
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });

  it("states a fault no boundary claims as unattributed measurement", async () => {
    const root = scratch();
    // A turn the outbound projection cannot represent: the production adapter faults
    // before the wire, so neither the provider, the wall clock, nor the turn cap can
    // be named as the cause, and "we do not know whose fault this is" is the fact.
    const dispatched = await dispatchAttempt(
      input(root, { turns: [undefined as unknown as string] })
    );
    assert.equal(dispatched.validity, "unknown");
    assert.equal(dispatched.stopReason, "unattributed");
    assert.deepEqual(dispatched.failure, {
      kind: "unattributed",
      phase: "dispatch",
    });
    assert.equal(dispatched.providerRequests, 0);
    assert.equal(dispatched.cleanup.status, "confirmed");
  });

  it("refuses a completed run whose declared script was not consumed", async () => {
    const root = scratch();
    const dispatched = await dispatchAttempt(
      input(root, {
        turns: ["one turn the loop finishes"],
        scripted: [
          { kind: "text", text: "the answer the loop stopped on" },
          { kind: "text", text: "a declared step this run never asked for" },
        ],
      })
    );
    // The run itself looks finished; only the served count proves the script did not run.
    assert.equal(dispatched.stopReason, "completed");
    assert.equal(dispatched.providerRequests, 1);
    assert.equal(dispatched.validity, "invalid");
    assert.deepEqual(dispatched.failure, {
      kind: "provider-failure",
      phase: "dispatch",
    });
  });
});
