/**
 * tests/cli/cli-eval-state-bare-run.test.ts
 *
 * ADR-0130 eval state at the **production entry**, physically. The bug class this
 * pins is "seam present, production wiring broken": the holder combination and
 * the parse face are certified elsewhere, so deleting the ask-entry wiring line
 * would leave every other file green.
 *
 * Method: run the real CLI (`src/cli.ts`) as a child process, with
 *   - `$HOME` / cwd redirected to scratch (no operator pool, no operator settings),
 *   - the model endpoint pointed at a local scripted HTTP server speaking the
 *     Anthropic Messages shape (`IKNOW_LLM_STREAM=off` keeps the adapter on its
 *     non-streaming arm, so a scripted JSON body is the whole wire),
 *   - `bwrap` on the child's PATH replaced by a recording shim that appends every
 *     argv it receives to a log (bwrap is outside the workspace and is not the
 *     system under test; the shim is the outermost observable point of the fenced
 *     route — same technique as `tests/subagent/fs-mode-propagation-entry.test.ts`).
 *
 * Arms (same scripted model, same bash command, only the entry flag differs):
 *   - **eval state**: the shim is never invoked (neither the assembly-time probe
 *     nor the spawn), the command really executes, and the JSON artifact names
 *     its own state (ADR-0130 §5).
 *   - **control, `full_auto` alone** — ADR-0130 §4's rejected option: approvals
 *     fixed, fence still up, `--unshare-net` still in the argv. This is also the
 *     "the fence was not quietly turned off for everyone" evidence.
 *   - **entry-raised permission** — same eval arm with IKNOW_PERMISSION_MODE
 *     deleted from the child env, so the passing bash call can only be the
 *     entry's own full_auto flip (the two arms above both let the env supply it).
 *   - **the surviving hard-wall** — ADR-0130 §2's central claim, end to end: a
 *     walled command is denied with a `[hard_wall]` reason, the fence shim log
 *     stays empty (denial with no fence), and the target directory survives.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const PROBE_COMMAND = "echo eval-state-probe";
const INVOCATION_MARKER = "#BWRAP-INVOCATION";

/**
 * The bash command the scripted model will issue on its next turn.
 *
 * The server is created once in `beforeAll`, so an arm picks its command by
 * setting this binding immediately before its `runCli` call. Arms within a
 * file run sequentially (no `it.concurrent` below), so the read is
 * deterministic; an arm that does not set it gets the probe command.
 */
let scriptedCommand = PROBE_COMMAND;

function toolUseReply(): unknown {
  return {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    model: "model",
    content: [
      {
        type: "tool_use",
        id: "toolu_probe",
        name: "bash",
        input: { command: scriptedCommand },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const FINAL_REPLY: unknown = {
  id: "msg_final",
  type: "message",
  role: "assistant",
  model: "model",
  content: [{ type: "text", text: "probe finished" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

let scratch: string;
let home: string;
let cwd: string;
let shimDir: string;
let shimLog: string;
let server: http.Server;

function writeShim(): void {
  const script = [
    "#!/usr/bin/env bash",
    // One marker line per invocation, then each argv element wrapped in <>, so
    // tokens with spaces / flags survive the log.
    `{ printf '%s\\n' '${INVOCATION_MARKER}'; for a in "$@"; do printf '<%s>\\n' "$a"; done; } >> '${shimLog}'`,
    'if [ "$1" = "--version" ]; then echo "bubblewrap 0.11.1"; fi',
    "exit 0",
    "",
  ].join("\n");
  const path = join(shimDir, "bwrap");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-eval-state-run-"));
  home = join(scratch, "home");
  cwd = join(scratch, "cwd");
  shimDir = join(scratch, "bin");
  shimLog = join(scratch, "bwrap-argv.log");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  writeShim();

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(Buffer.from(d)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.endsWith("/count_tokens")) {
        // The budget seam asks for a count on every turn; it is not a model
        // turn and must not consume one.
        res.end(JSON.stringify({ input_tokens: 128 }));
        return;
      }
      // Decided by request content, not by a request counter: iknow makes
      // auxiliary calls before the first turn, so a counter would hand the
      // scripted tool call to a non-turn request and the run would end silently
      // without ever executing bash.
      const toolResultReported = body.includes('"tool_result"');
      res.end(
        JSON.stringify(toolResultReported ? FINAL_REPLY : toolUseReply())
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // User-layer settings carry a **workspace** isolation tier: eval state has to
  // flip the holder to global without rewriting this file (ADR-0084 discipline),
  // and the control arm must keep reading it exactly as before.
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify({
      llm: {
        model: "test/model",
        providers: [
          {
            id: "test",
            baseUrl: origin,
            apiKeyEnv: "IKNOW_TEST_API_KEY",
            // The SDK refuses a non-streaming request whose output budget would
            // take it past 10 minutes (max_tokens > 21333), and this arm runs with
            // IKNOW_LLM_STREAM=off, so the scripted model has to carry a budget
            // under that ceiling instead of inheriting the 32,000 default.
            models: [{ id: "model", maxTokens: 1024 }],
          },
        ],
      },
      isolation: { fsMode: "workspace" },
    }),
    "utf8"
  );
});

afterAll(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface CliRun {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/**
 * One real CLI child process; resets the recording shim's log.
 *
 * `permissionMode` decides the env arm only. The first two arms pass
 * `"full_auto"` so the permission axis is constant across them and the entry
 * flag is the single difference; the third arm passes `"unset"` so the entry has
 * to raise permission ITSELF — see that arm's rationale below.
 *
 * `"unset"` deletes the key from the inherited environment rather than setting
 * it to an empty string, because the CLI reads it as `env.X ?? "default"` and an
 * empty string would land as an unparseable mode rather than as absent.
 */
function runCli(
  args: string[],
  permissionMode: "full_auto" | "unset" = "full_auto"
): Promise<CliRun> {
  writeFileSync(shimLog, "", "utf8");
  const inherited = { ...process.env };
  if (permissionMode === "unset") {
    delete inherited.IKNOW_PERMISSION_MODE;
  }
  const child = spawn(
    process.execPath,
    [tsxCli, join(repoRoot, "src", "cli.ts"), ...args],
    {
      cwd,
      env: {
        ...inherited,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        IKNOW_TEST_API_KEY: "test-key",
        IKNOW_LLM_STREAM: "off",
        ...(permissionMode === "full_auto"
          ? { IKNOW_PERMISSION_MODE: "full_auto" }
          : {}),
      },
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

/** Recorded bwrap invocations, each an argv list. Empty = bwrap never ran. */
function shimInvocations(): string[][] {
  if (!existsSync(shimLog)) return [];
  const lines = readFileSync(shimLog, "utf8").split("\n");
  const argvs: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line === INVOCATION_MARKER) {
      current = [];
      argvs.push(current);
    } else if (
      current !== undefined &&
      line.startsWith("<") &&
      line.endsWith(">")
    ) {
      current.push(line.slice(1, -1));
    }
  }
  return argvs;
}

interface AskJson {
  readonly finalText?: string | null;
  readonly stopReason?: string;
  readonly runState?: string;
  readonly trace?: {
    readonly turns?: ReadonlyArray<{
      readonly toolCalls?: ReadonlyArray<{
        readonly toolName?: string;
        readonly kind?: string;
        /** Emitted by the executor for a failed call; the deny reason rides here. */
        readonly message?: string;
      }>;
    }>;
  };
}

describe("eval state at the production ask entry — the fence really retires", () => {
  it("ask --eval-state runs bash bare and names its state in the JSON artifact", async () => {
    const { code, out, err } = await runCli([
      "ask",
      "run the probe command",
      "--eval-state",
    ]);
    assert.equal(code, 0, `expected exit 0, stderr=${err}`);
    const parsed = JSON.parse(out) as AskJson;
    // ADR-0130 §5: any number this run produces must be published with the
    // state named in the same artifact.
    assert.equal(parsed.runState, "eval_state");
    assert.equal(parsed.stopReason, "completed");
    assert.equal(parsed.finalText, "probe finished");
    const calls = (parsed.trace?.turns ?? []).flatMap((t) => t.toolCalls ?? []);
    assert.deepEqual(
      calls.map((c) => [c.toolName, c.kind]),
      [["bash", "ok"]],
      "the bash tool must have executed successfully"
    );
    // Outermost observable point of the fenced route: never called — not by
    // the assembly-time probe, not by the spawn.
    assert.deepEqual(
      shimInvocations(),
      [],
      "eval state retires bwrap on every route (ADR-0119 §ruling 2)"
    );
    // Headless has no chrome, so the posture is announced on stderr as well.
    assert.match(err, /^eval_state:/m);
    assert.equal(err.includes("yolo mode ON"), false);
  }, 180_000);

  it("control: the same command without the entry keeps the fence up (full_auto alone does not retire it)", async () => {
    const { code, out, err } = await runCli(["ask", "run the probe command"]);
    assert.equal(code, 0, `expected exit 0, stderr=${err}`);
    const parsed = JSON.parse(out) as AskJson;
    // The published contract widened additively only: a non-eval run keeps
    // its exact key set.
    assert.equal("runState" in parsed, false);
    assert.equal(parsed.stopReason, "completed");

    const invocations = shimInvocations();
    assert.ok(
      invocations.length > 0,
      "the non-eval path must still probe and spawn through bwrap"
    );
    const spawnArgv = invocations.find((argv) =>
      argv.includes("--unshare-net")
    );
    assert.ok(
      spawnArgv !== undefined,
      `--unshare-net must still be in effect, saw ${JSON.stringify(invocations).slice(0, 800)}`
    );
    assert.equal(err.includes("eval_state"), false);
  }, 180_000);

  it("the settings file survives both arms untouched (holders only, nothing persisted)", async () => {
    await runCli(["ask", "run the probe command", "--eval-state"]);
    const settings = readFileSync(
      join(home, ".iknow", "settings.json"),
      "utf8"
    );
    assert.match(settings, /"fsMode":"workspace"/);
    assert.equal(settings.includes("global"), false);
  });

  // The first half of the entry combination — permission → full_auto — has no
  // end-to-end evidence while the env supplies full_auto: the two arms above
  // both set it, so if `enterEvalStateForAsk` stopped mutating the permission
  // holder, or `permissionMode` stopped reaching `buildHarnessEngine`, both
  // would still pass. The real-world failure they would miss is permission
  // falling back to `default`, every `execute` landing on the category default
  // "ask", the headless fail-closed askUser denying everything, and every
  // benchmark task failing for a reason unrelated to the model — with this
  // suite green.
  //
  // This arm therefore deletes IKNOW_PERMISSION_MODE from the child env. Same
  // scripted model, same bash command, same `--eval-state`; only the
  // environment differs, so the passing assertion is attributable to the entry
  // and nothing else.
  it("entry-raised permission: --eval-state executes bash with IKNOW_PERMISSION_MODE unset", async () => {
    const { code, out, err } = await runCli(
      ["ask", "run the probe command", "--eval-state"],
      "unset"
    );
    assert.equal(code, 0, `expected exit 0, stderr=${err}`);
    const parsed = JSON.parse(out) as AskJson;
    assert.equal(parsed.runState, "eval_state");
    assert.equal(parsed.stopReason, "completed");
    const calls = (parsed.trace?.turns ?? []).flatMap((t) => t.toolCalls ?? []);
    assert.deepEqual(
      calls.map((c) => [c.toolName, c.kind]),
      [["bash", "ok"]],
      "with no env permission mode, only the entry's own full_auto flip can " +
        "let `execute` through the fail-closed askUser"
    );
    assert.deepEqual(shimInvocations(), [], "and the fence stays retired");
  }, 180_000);

  // ADR-0130 §2's central survival claim, at the entry: "eval state is not 'no
  // guardrails' — the hard-wall stays armed, and expect it to fire on
  // legitimate benchmark commands." The claim is only meaningful as the
  // conjunction the ADR states: the wall denies the command AND no fence exists
  // to have mediated it. Either half alone is satisfiable by accident (a denial
  // could be the fence refusing; an empty shim log could be a run that never
  // reached bash), so both are asserted, plus the filesystem state that proves
  // the command never ran.
  it("a walled command is denied with a [hard_wall] reason and no fence — and the victim survives", async () => {
    const victim = join(scratch, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "still here", "utf8");
    // The scripted model issues the destructive command instead of the probe.
    // The server branches on request CONTENT, never on a request counter —
    // see the count_tokens note in `beforeAll`.
    scriptedCommand = `rm -rf ${victim}`;
    try {
      const { code, out, err } = await runCli(
        ["ask", "delete the victim directory", "--eval-state"],
        "full_auto"
      );
      assert.equal(code, 0, `expected exit 0, stderr=${err}`);
      const parsed = JSON.parse(out) as AskJson;
      assert.equal(parsed.runState, "eval_state");

      const calls = (parsed.trace?.turns ?? []).flatMap(
        (t) => t.toolCalls ?? []
      );
      assert.equal(
        calls.length,
        1,
        `expected one tool call, saw ${JSON.stringify(calls)}`
      );
      assert.equal(calls[0]?.toolName, "bash");
      assert.equal(
        calls[0]?.kind,
        "execution_failed",
        "the executor reports a hard-wall denial as a failed call"
      );
      assert.ok(
        calls[0]?.message?.includes("[hard_wall]"),
        `deny must carry the hard-wall prefix, got: ${calls[0]?.message}`
      );
      // Denial with NO fence: the shim is the outermost observable point of
      // the fenced route, so an empty log means nothing mediated this call.
      assert.deepEqual(
        shimInvocations(),
        [],
        "the hard-wall denied the command with the fence retired"
      );
      // The filesystem consequence: never executed, not merely refused.
      assert.equal(
        existsSync(join(victim, "keep.txt")),
        true,
        "the walled command must not have run"
      );
    } finally {
      scriptedCommand = PROBE_COMMAND;
    }
  }, 180_000);
});
