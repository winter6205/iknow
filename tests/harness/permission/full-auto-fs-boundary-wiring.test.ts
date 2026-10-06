/**
 * ADR-0140 §2 — the fence-boundary question must reach permission admission
 * THROUGH PRODUCTION ASSEMBLY.
 *
 * `full-auto-fs-boundary.test.ts` proves the decision layer against a
 * hand-built reader; it cannot see the thing that matters most here — whether
 * the composition root ever WIRES that reader. A `fsBoundary` field no
 * production entry passes is correct in tests and dead in the product, and the
 * failure mode is silent in the exact direction ADR-0140 exists to close
 * (`full_auto` quietly allowing a write past the tier it promised to hold).
 *
 * So every case here goes through `buildHarnessEngine` and asserts on the
 * OBSERVED outcome of one real `write_file` call: how many times the operator
 * was asked, what the agent was told, and whether the file exists afterwards.
 * The tool is not stubbed — write_file's own root guard would refuse the same
 * call, so the discriminating evidence is the message envelope: a permission
 * layer that never asked produces `[write_file] cannot resolve path`, while a
 * declined boundary question produces `[user_denied]`.
 *
 * What the root must reproduce from its own inputs: the LIVE task root and this
 * identity's session pad (the same two roots the fence binds under the
 * workspace tier), plus the tier holder, read per call.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.js";
import { createPermissionModeContext } from "../../../src/harness/permission/modes.js";
import { createFsModeContext } from "../../../src/harness/sandbox/fs-mode.js";
import type { IknowEnv } from "../../../src/config/env.js";
import type { PermissionMode } from "../../../src/harness/permission/modes.js";

const ENV = {
  llm: {
    baseUrl: "http://127.0.0.1:9999",
    model: "test-model",
    fallback: [],
    apiKey: "sk-wiring-probe",
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
    temperature: 0,
    thinking: "off",
    thinkingEffort: "",
    stream: "on",
  },
  chat: { showThinking: false },
  web: { searchUrl: undefined, proxy: undefined },
  compress: { contextWindow: 200_000, thresholdTokens: undefined },
  mcp: { connectTimeoutMs: 60_000 },
  subagent: { taskTimeoutMs: undefined },
} as unknown as IknowEnv;

const root = realpathSync(mkdtempSync(join(tmpdir(), "full-auto-wiring-")));
/** The live `taskRoot` — workspace tier writable root #1. */
const taskRoot = join(root, "repo");
const projectDir = join(root, "pool");
const conversationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
/** `<projectDir>/<conversationId>/fence-tmp` — workspace tier writable root #2. */
const pad = join(projectDir, conversationId, "fence-tmp");
/** Outside both writable roots AND inside the tier's read-only home: the
 *  workspace tier `--ro-bind`s home, so the fence refuses a write here — this is
 *  the crossing ADR-0140's question is about. */
const outsideDir = join(root, "home", "outside");
/**
 * Outside the writable whitelist but on the fence's WRITABLE `/` substrate.
 *
 * The declared reachable set is a whitelist OVERLAY, not the kernel's writable
 * set: the tier emits `--bind / /` and then ro-binds over it, so a write here
 * SUCCEEDS. `root` lives under the host `/tmp`, so it reproduces that. A
 * predicate built on "outside the declaration" would ask about these — questions
 * for crossings that never happen — which is why the ask is bound to the refusal
 * geometry instead.
 */
const outOfWhitelistDir = join(root, "outside");

mkdirSync(taskRoot, { recursive: true });
mkdirSync(join(root, "home"), { recursive: true });
mkdirSync(outsideDir, { recursive: true });
mkdirSync(outOfWhitelistDir, { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const built: BuiltEngine[] = [];

type Run = {
  readonly kind: string;
  readonly message?: string;
};

/** Build the real main-session assembly under the WORKSPACE tier. */
async function buildUnderWorkspaceTier(input: {
  readonly mode: PermissionMode;
  readonly askUser: () => Promise<boolean>;
  readonly fsMode?: ReturnType<typeof createFsModeContext>;
}): Promise<{
  readonly engine: BuiltEngine;
  readonly fsMode: ReturnType<typeof createFsModeContext>;
}> {
  const fsMode = input.fsMode ?? createFsModeContext("workspace");
  const engine = await buildHarnessEngine({
    env: ENV,
    askUser: async () => input.askUser(),
    surface: "chat",
    cwd: taskRoot,
    sandboxRoot: taskRoot,
    userHome: join(root, "home"),
    todoDir: projectDir,
    projectDir,
    permissionMode: createPermissionModeContext(input.mode),
    fsMode,
    sessionConversationId: () => conversationId,
  });
  built.push(engine);
  return { engine, fsMode };
}

async function writeWith(engine: BuiltEngine, path: string): Promise<Run> {
  const [result] = await engine.deps.executor.executeAll(
    [{ id: "call-1", name: "write_file", input: { path, content: "x" } }],
    undefined,
    undefined,
    conversationId
  );
  return result as Run;
}

describe("ADR-0140 §2 — the workspace tier's boundary reaches full_auto via buildHarnessEngine", () => {
  it("a write INSIDE the tier's reach is admitted, unasked, and lands on disk", async () => {
    let asked = 0;
    const { engine } = await buildUnderWorkspaceTier({
      mode: "full_auto",
      askUser: async () => {
        asked += 1;
        return true;
      },
    });
    const target = join(taskRoot, "inside", "note.md");

    const result = await writeWith(engine, target);

    assert.equal(asked, 0, "inside the tier the mode must stay unasked");
    assert.equal(result.kind, "ok", result.message ?? "");
    assert.equal(
      existsSync(target),
      true,
      "the admitted write must really land"
    );
  });

  it("a write into the session pad is inside too (the pad is a reachable root)", async () => {
    let asked = 0;
    const { engine } = await buildUnderWorkspaceTier({
      mode: "full_auto",
      askUser: async () => {
        asked += 1;
        return true;
      },
    });
    const target = join(pad, "scratch.md");

    const result = await writeWith(engine, target);

    assert.equal(asked, 0);
    assert.equal(result.kind, "ok", result.message ?? "");
    assert.equal(existsSync(target), true);
  });

  it("a write OUTSIDE the tier asks exactly once; declining refuses and never writes", async () => {
    let asked = 0;
    const { engine, fsMode } = await buildUnderWorkspaceTier({
      mode: "full_auto",
      askUser: async () => {
        asked += 1;
        return false;
      },
    });
    const target = join(outsideDir, "note.md");

    const result = await writeWith(engine, target);

    assert.equal(asked, 1, "exactly one question at the edge");
    assert.equal(
      result.message,
      "[user_denied] user declined tool call: write_file",
      "the refusal is the ask gate's, not write_file's own root guard"
    );
    assert.equal(
      existsSync(target),
      false,
      "a declined crossing must not write"
    );
    assert.equal(
      fsMode.get(),
      "workspace",
      "the answer decides the call; the operator's tier is untouched"
    );
  });

  it("answering yes carries the call PAST the permission layer — and does not license the next", async () => {
    // The gate admitted it: the operator was asked exactly once and the answer
    // was not a deny (no `[user_denied]`). What refuses afterwards is
    // `write_file`'s OWN root guard, which is narrower than the fence boundary —
    // every built-in write tool resolves inside `{taskRoot, own pad}`, a subset of
    // the tier's writable set. So on today's tool surface the approved crossing
    // is still refused downstream; the observable claim here is about the GATE
    // (one question, answer honoured, not remembered), and that the tool-side
    // refusal stays a separate source, which is ADR-0140 §2's "additional, not a
    // substitute". A tool without such a guard reaches the tool body — that half
    // is proved in `full-auto-fs-boundary.test.ts`.
    let asked = 0;
    const target = join(outsideDir, "permitted-once.md");
    const { engine } = await buildUnderWorkspaceTier({
      mode: "full_auto",
      askUser: async () => {
        asked += 1;
        // First crossing approved, second declined: the second must be a
        // question, not a replay of the first answer.
        return asked === 1;
      },
    });

    const permitted = await writeWith(engine, target);

    assert.equal(asked, 1, "one question, and it was answered yes");
    assert.ok(
      !permitted.message?.startsWith("[user_denied]"),
      `the gate must not have refused: ${permitted.message ?? ""}`
    );
    assert.match(
      permitted.message ?? "",
      /path outside workspace/,
      `the downstream refusal is the tool's own root guard: ${permitted.message ?? ""}`
    );

    const second = join(outsideDir, "still-asks.md");
    const refused = await writeWith(engine, second);

    assert.equal(
      asked,
      2,
      "the second crossing asks again — no session memory"
    );
    assert.equal(
      refused.message,
      "[user_denied] user declined tool call: write_file"
    );
    assert.equal(existsSync(second), false);
  });

  it("the global tier has no edge, so full_auto is unasked at any path", async () => {
    let asked = 0;
    const { engine } = await buildUnderWorkspaceTier({
      mode: "full_auto",
      askUser: async () => {
        asked += 1;
        return false;
      },
      fsMode: createFsModeContext("global"),
    });
    const target = join(taskRoot, "global-tier.md");

    const result = await writeWith(engine, target);

    assert.equal(asked, 0, "unbounded reach cannot be crossed");
    assert.equal(result.kind, "ok", result.message ?? "");
  });

  it("plan is refused without a question, even across the boundary", async () => {
    let asked = 0;
    const { engine } = await buildUnderWorkspaceTier({
      mode: "plan",
      askUser: async () => {
        asked += 1;
        return true;
      },
    });
    const target = join(outsideDir, "plan.md");

    const result = await writeWith(engine, target);

    assert.equal(
      asked,
      0,
      "the boundary question must not reach a plan session"
    );
    assert.equal(
      result.message,
      "[permission_denied] mode: plan blocks mutating tools (write)"
    );
    assert.equal(existsSync(target), false);
  });

  it("default asks at the boundary for its own pre-existing reason", async () => {
    let asked = 0;
    const { engine } = await buildUnderWorkspaceTier({
      mode: "default",
      askUser: async () => {
        asked += 1;
        return false;
      },
    });
    const target = join(outsideDir, "default.md");

    const result = await writeWith(engine, target);

    assert.equal(asked, 1, "default already asks every mutating call");
    assert.equal(
      result.message,
      "[user_denied] user declined tool call: write_file"
    );
    assert.equal(existsSync(target), false);
  });

  it("a fixture file outside the tier is not silently adopted by a permissive answer", async () => {
    // Guards the direction, not the file: the root's mounts are the two fence
    // roots, so a sibling directory under the same tmpdir is NOT reachable.
    writeFileSync(join(outsideDir, "pre-existing.txt"), "seed");
    let asked = 0;
    const { engine } = await buildUnderWorkspaceTier({
      mode: "full_auto",
      askUser: async () => {
        asked += 1;
        return true;
      },
    });

    await writeWith(engine, join(outsideDir, "pre-existing.txt"));

    assert.equal(
      asked,
      1,
      "a pre-existing file outside the tier still crosses"
    );
  });

  it("an out-of-whitelist write the fence PERMITS is not asked about", async () => {
    // The direction that makes the question honest. `outOfWhitelistDir` is
    // outside both declared writable roots, so the whitelist-only predicate
    // called it a crossing — but the tier binds `/` writable underneath, so the
    // fence writes it happily. Asking here would prompt the operator about a
    // refusal that was never going to happen.
    let asked = 0;
    const { engine } = await buildUnderWorkspaceTier({
      mode: "full_auto",
      askUser: async () => {
        asked += 1;
        return true;
      },
    });
    const target = join(outOfWhitelistDir, "scratch.md");

    await writeWith(engine, target);

    // Only the gate's behaviour is claimed here: the fence would permit this
    // write, so ADR-0140 has nothing to ask about. What happens next is NOT this
    // mechanism's doing — `write_file`'s own root guard is narrower than the
    // fence (taskRoot ∪ pad), so it refuses on its own account. That is the
    // divergence recorded in ADR-0140 and covered by the "answering yes carries
    // the call PAST the permission layer" case above; asserting the tool
    // succeeded here would assert a product change that was not made.
    assert.equal(
      asked,
      0,
      "the fence permits this write; there is nothing to ask"
    );
  });
});
