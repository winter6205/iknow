/**
 * Spec SC4 / ADR-0132: the identity-scratch cleanup exception must be LIVE on
 * the `ask` route, not only on the interactive entries.
 *
 * `scratch-cleanup-host-wiring.test.ts` proves the exception is wired on TUI,
 * serve and chat. It cannot reach `ask`, and the gap is not academic: `runOneShot`
 * assembled its engine with neither `todoDir` nor `sessionConversationId`, so
 * `mainSessionCleanupRoots` never resolved a `scratchRoot` and the wall's
 * `$TMPDIR` arm was dead on the one route the spec's SC12 also names. Every
 * `rm -f $TMPDIR/<file>` on `ask` was a hard-wall deny.
 *
 * The shape of the evidence is deliberately the observed outcome of a REAL
 * `iknow ask` child process — real CLI parse, real assembly, real permission
 * wall, real fence — with only the model transport stubbed at its network
 * boundary. The claim under test is a claim about deletion, so the file's
 * survival is observed from inside the same run, through the run's own
 * `$TMPDIR`, rather than predicted from outside it: the scratch pad's path is
 * not something a test may assume, and predicting it would let a passing
 * result point both the copy and the check at a directory the run never used.
 *
 * The negatives are asserted through the SAME assembly that admits the
 * positives. An over-broad root, a scratch that leaked into the workspace arm,
 * or a containment check that stopped resolving would all show up as one of
 * these turning into an allow.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
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

/** One `bash` tool_call row's observable outcome, as the trace recorded it. */
type ToolCallRow = {
  readonly command: string;
  readonly kind: string;
  readonly status: string;
  readonly error?: string;
};

/**
 * Run one real `iknow ask` and return what each scripted bash call was told.
 *
 * `mode` is the ask entry's static permission mode (`IKNOW_PERMISSION_MODE`),
 * because the two halves of SC4 differ there: `default` must ASK and
 * `full_auto` may allow. A declining inlet is not available on this route —
 * `runOneShot` installs a fail-closed `askUser` — so in `default` the ordinary
 * ask resolves to a deny, and the distinction that matters is which gate
 * produced it: a `[hard_wall]` message is the wall answering, a
 * `[user_denied]` message is the wall having stayed silent.
 */
/**
 * The observable outcome of one `iknow ask` run: what the permission wall and
 * the executor decided about each bash call (`rows`), and the contents of a
 * marker file the run's own last command wrote into the workspace it ran in
 * (`marker`).
 *
 * The marker is the observation channel for claims about the filesystem. A
 * `tool_call` row deliberately carries no result payload, and the scratch pad's
 * path is not something this test may assume — but a file the run itself wrote,
 * read here after the run finished, is both observable and self-locating.
 */
type AskOutcome = {
  readonly rows: readonly ToolCallRow[];
  readonly code: number;
  readonly marker: string;
};

async function runAsk(
  script: ReadonlyArray<{
    text?: string;
    tool?: { name: string; input: unknown };
    bashCommandFrom?: (observed: readonly string[]) => string;
  }>,
  mode: "default" | "full_auto"
): Promise<AskOutcome> {
  const model = await startLoopbackModel(script);
  const root = mkdtempSync(join(tmpdir(), "iknow-ask-scratch-"));
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

    let code = 0;
    try {
      await run(
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
            IKNOW_PERMISSION_MODE: mode,
          },
          maxBuffer: 32 * 1024 * 1024,
          timeout: 120_000,
        }
      );
    } catch (err) {
      const e = err as { code?: unknown };
      code = typeof e.code === "number" ? e.code : 1;
    }

    const rows = readRows(traceDir);
    // The run's last bash call writes this marker. It is the observation
    // channel for filesystem claims: a `tool_call` row carries no result, and
    // the scratch pad's path is not something this test may assume — but a
    // file the run itself wrote, read after the run finished, is observable and
    // self-locating.
    const markerPath = join(workspace, "marker.txt");
    const marker = existsSync(markerPath)
      ? readFileSync(markerPath, "utf8")
      : "";
    return { rows, code, marker };
  } finally {
    await model.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Every `bash` call the run actually issued, in order, with the outcome the
 * permission wall and the executor produced. Read from the JSONL the run wrote
 * rather than from stdout: the point is what the gates decided, and the trace
 * is the artifact SC12 makes the contract.
 */
function readRows(traceDir: string): ToolCallRow[] {
  const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return [];
  const lines = readFileSync(join(traceDir, files[0]!), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return lines
    .filter((r) => r["record_type"] === "tool_call" && r["tool_name"] === "bash")
    .map((r) => {
      const error = r["error"] as { message?: string } | undefined;
      return {
        command: (r["arguments"] as { command?: string }).command ?? "",
        kind: (r["tool_kind"] as string) ?? "",
        status: (r["status"] as string) ?? "",
        ...(error?.message !== undefined ? { error: error.message } : {}),
      };
    });
}

/** The nth bash call's observable outcome, failing the test if it is absent. */
function call(rows: readonly ToolCallRow[], index: number): ToolCallRow {
  const found = rows[index];
  if (found === undefined) {
    throw new Error(
      `the run issued ${rows.length} bash call(s); expected at least ${index + 1}`
    );
  }
  return found;
}

/** Whether the call was refused by the hard wall rather than by the ask gate. */
function deniedByHardWall(row: ToolCallRow): boolean {
  return row.error?.includes("[hard_wall]") === true;
}

/**
 * The `$TMPDIR` this run actually injected, read out of what the run itself
 * reported.
 *
 * The run cannot be asked for its scratch path by the fixture: the ask entry
 * mints its `conversationId` internally, so the pad path is a fact this process
 * does not know until a command inside the run prints it. A bash ok payload is
 * `{code, stdout, stderr}` JSON in its first text block, so `printf` of the
 * pad is the honest channel — the value comes from the fence's own env, not
 * from any formula re-derived here.
 */
function readReportedTmpdir(observed: readonly string[]): string | undefined {
  for (const raw of observed) {
    let payload: { stdout?: unknown };
    try {
      payload = JSON.parse(raw) as { stdout?: unknown };
    } catch {
      continue;
    }
    if (typeof payload.stdout !== "string") continue;
    const match = /^IKNOW_SCRATCH=(.+)$/m.exec(payload.stdout);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return undefined;
}

describe("ask route — SC4: the identity-scratch exception is live", () => {
  it("full_auto: `rm -f $TMPDIR/a.cjs` is admitted and REALLY deletes the file", async () => {
    const { rows, marker } = await runAsk(
      [
        { tool: { name: "bash", input: { command: "echo seed > $TMPDIR/a.cjs" } } },
        { tool: { name: "bash", input: { command: "rm -f $TMPDIR/a.cjs" } } },
        {
          tool: {
            name: "bash",
            // The run observes its OWN $TMPDIR, so the check cannot point at a
            // path this test invented; and it writes the answer into the
            // workspace, where the test can read it back.
            input: {
              command:
                "if [ -e $TMPDIR/a.cjs ]; then echo STILL_THERE > marker.txt; else echo GONE > marker.txt; fi",
            },
          },
        },
        { text: "done" },
      ],
      "full_auto"
    );

    // Seed first: a deletion of a file that was never there would satisfy the
    // `rm` arm of the story without ever proving the exception admitted it.
    const seed = call(rows, 0);
    expect(deniedByHardWall(seed), `seeding must not hit the wall: ${seed.error}`).toBe(false);
    expect(seed.status).toBe("ok", seed.error ?? "");

    const rm = call(rows, 1);
    expect(
      deniedByHardWall(rm),
      `ask must not hard-wall-deny its own scratch cleanup: ${rm.error ?? rm.status}`
    ).toBe(false);
    expect(rm.status, `the admitted cleanup must actually execute: ${rm.error ?? ""}`).toBe(
      "ok"
    );

    // The strongest form: the file the run itself seeded is gone, observed by
    // the run itself through the same `$TMPDIR` both calls used.
    expect(marker).toContain("GONE");
    expect(marker).not.toContain("STILL_THERE");
  }, 180_000);

  it("full_auto: the EQUIVALENT ABSOLUTE path is admitted and REALLY deletes the file", async () => {
    // ADR-0132's second named form: `$TMPDIR/a.cjs` and `<sessionScratch>/a.cjs`
    // are the same target spelled two ways, and BOTH must be answered by one
    // root. This case exists because the `$TMPDIR` case above cannot tell two
    // gates that disagree apart: bash injects `$TMPDIR` itself, so a run whose
    // handler never learned its session pad still has seed, rm and check all
    // pointing at the handler's own fallback pad, and the two gates can disagree
    // about which directory the file lives in without anything going red.
    //
    // Here the fixture never spells the path. It asks the run for its own
    // `$TMPDIR` and then rewrites that literal into an absolute path, so the
    // only way the rm can be admitted AND actually delete the seeded file is
    // for the two gates to be measuring the SAME directory the file is in.
    const { rows, marker } = await runAsk(
      [
        {
          // The seed both plants the file AND reports the pad the fence
          // injected, in one call: the absolute spelling the next turn uses is
          // this run's own value, not a path the fixture could have guessed.
          tool: {
            name: "bash",
            input: {
              command: "echo seed > $TMPDIR/a.cjs && printf 'IKNOW_SCRATCH=%s\\n' \"$TMPDIR\"",
            },
          },
        },
        {
          bashCommandFrom: (observed) => {
            const pad = readReportedTmpdir(observed);
            if (pad === undefined) return "echo NO_PAD_REPORTED";
            return `rm -f ${pad}/a.cjs`;
          },
        },
        {
          bashCommandFrom: (observed) => {
            const pad = readReportedTmpdir(observed);
            if (pad === undefined) return "echo NO_PAD_REPORTED";
            // Observe by the SAME absolute spelling the rm used, so a deletion
            // that worked is read back through the path the wall judged.
            return `if [ -e ${pad}/a.cjs ]; then echo STILL_THERE > marker.txt; else echo GONE > marker.txt; fi`;
          },
        },
        { text: "done" },
      ],
      "full_auto"
    );

    const seed = call(rows, 0);
    expect(deniedByHardWall(seed), `seeding must not hit the wall: ${seed.error}`).toBe(false);
    expect(seed.status).toBe("ok", seed.error ?? "");

    // The rm was named by an absolute path this fixture did not choose; if the
    // two gates resolve different directories, this is where it shows.
    const rm = call(rows, 1);
    expect(
      deniedByHardWall(rm),
      `the equivalent ABSOLUTE spelling of the scratch must not hard-wall-deny: ${
        rm.error ?? rm.status
      } (command: ${rm.command})`
    ).toBe(false);
    expect(rm.status, `the admitted cleanup must actually execute: ${rm.error ?? ""}`).toBe(
      "ok"
    );

    expect(marker).toContain("GONE");
    expect(marker).not.toContain("STILL_THERE");
  }, 180_000);

  it("default: the wall stays silent and the ordinary ask gate answers", async () => {
    const { rows } = await runAsk(
      [
        { tool: { name: "bash", input: { command: "echo seed > $TMPDIR/a.cjs" } } },
        { tool: { name: "bash", input: { command: "rm -f $TMPDIR/a.cjs" } } },
        { text: "done" },
      ],
      "default"
    );

    const rm = call(rows, 1);
    expect(
      deniedByHardWall(rm),
      `default mode must reach the ask gate, not the wall: ${rm.error ?? rm.status}`
    ).toBe(false);
    // The ask entry installs a fail-closed askUser, so the ordinary ask
    // resolves to a user denial. That outcome is only meaningful if the wall
    // declined to answer — which is exactly what SC4 claims for `default`.
    expect(rm.error).toContain("[user_denied]");
  }, 180_000);
});

/**
 * The refusals that a wrong or over-broad scratch would break. Each is asserted
 * through the SAME assembly that now admits `$TMPDIR` cleanup, so a leak
 * cannot hide behind a differently-assembled positive.
 */
describe("ask route — SC4: the wiring widened nothing", () => {
  const denied: ReadonlyArray<readonly [string, string]> = [
    ["the scratch root itself", "rm -f $TMPDIR"],
    ["recursive inside the scratch", "rm -rf $TMPDIR/a.cjs"],
    ["a glob in the scratch", "rm -f $TMPDIR/*.cjs"],
    ["an unresolved variable", "rm -f $NAME.cjs"],
    ["escaping the scratch through `..`", "rm -f $TMPDIR/../../escape.txt"],
    ["a wrapper around the rm", "sudo rm -f $TMPDIR/a.cjs"],
    ["a nested shell", "bash -c 'rm -f $TMPDIR/a.cjs'"],
    ["a protected target in the workspace", "rm -f .env"],
    ["a recursive workspace delete", "rm -rf /"],
  ];

  for (const [why, command] of denied) {
    it(`still denies: ${why}`, async () => {
      const { rows } = await runAsk(
        [
          { tool: { name: "bash", input: { command: "echo seed > $TMPDIR/a.cjs" } } },
          { tool: { name: "bash", input: { command } } },
          { text: "done" },
        ],
        "full_auto"
      );
      const observed = call(rows, 1);
      expect(
        deniedByHardWall(observed),
        `${command} must keep a hard-wall deny through the ask assembly, got: ${
          observed.status
        } ${observed.error ?? ""}`
      ).toBe(true);
    });
  }
}, 300_000);
