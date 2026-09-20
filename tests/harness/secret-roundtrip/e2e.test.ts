/**
 * e2e.test.ts — end-to-end matrix acceptance (4 surfaces × 2 modes -> 8 cases).
 *
 * Two assertion surfaces:
 *   A) Assembly surface (8 matrix cases) — for each surface (chat / ask / tui / serve)
 *      under roundtrip and block modes, assert machine state:
 *        roundtrip -> deps.secretRegistry present + secretsMode not "block"
 *                     (recognize + placeholder + restore chain wired)
 *        block     -> deps.secretsMode === "block" + secretRegistry absent
 *                     (legacy deny-only guard compatibility path)
 *   B) Full-flow surface (bonus) — a standalone run() + stub model/registry/executor
 *      drives the "recognize-layer placeholderization -> bash restore-layer real value"
 *      closed loop; under block, assert run() puts user plaintext verbatim into
 *      messages (roundtrip recognition off). The bash restore layer uses the real
 *      createBashTool (bwrap available, real spawn as in bash.test.ts).
 *
 * Test seam (aligned with build-engine.test.ts): opts.settings injects isolated
 * settings + tmp userHome/cwd fixture — never reads the real ~/.iknow, never pollutes process.env.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import {
  createSecretRegistry,
  restore,
} from "../../../src/harness/secret-roundtrip/index.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type { IknowSettings } from "../../../src/config/settings.ts";
import type { ToolDef } from "../../../src/harness/tools/types.ts";

/** Deterministic env — never reads process.env / .env files (env.ts SSOT). */
function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
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
    // subagent config arm (build-engine reads taskTimeoutMs).
    subagent: { taskTimeoutMs: undefined },
  };
}

/** Per-case tmp fixture isolating skill scanner / mcp config / the real home. */
const roots: string[] = [];
async function makeFixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "iknow-406-e2e-"));
  roots.push(root);
  return { root, home: join(root, "home") };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
  );
});

/** Full-flow stub rig: deterministic stub model + noop tool + empty secret registry.
 *  Mirrors tests/cli/_fixtures.ts makeDeps — block mode passes no secretRegistry,
 *  roundtrip passes one (shared by the recognition layer + the assertions). */
function makeRunDeps(opts: {
  readonly responses: ReadonlyArray<
    import("../../../src/harness/index.ts").AssistantTurnResult
  >;
  readonly secretRegistry?: import("../../../src/harness/secret-roundtrip/index.ts").SecretRegistry;
  readonly secretsMode?: "roundtrip" | "block";
}): {
  adapter: ReturnType<typeof createStubModel>;
  executor: ReturnType<typeof createExecutor>;
  registry: ReturnType<typeof createRegistry>;
  secretRegistry?: import("../../../src/harness/secret-roundtrip/index.ts").SecretRegistry;
} {
  const tool: ToolDef = createStubTool({ name: "noop", next: () => ({}) });
  const reg = createRegistry([tool]);
  const exec = createExecutor(reg);
  const adapter = createStubModel({ responses: opts.responses });
  return {
    adapter,
    executor: exec,
    registry: reg,
    ...(opts.secretRegistry ? { secretRegistry: opts.secretRegistry } : {}),
    ...(opts.secretsMode ? { secretsMode: opts.secretsMode } : {}),
  };
}

// ---------------------------------------------------------------------------
// A) Assembly surface: 4 surfaces × 2 modes matrix (8 cases)
// ---------------------------------------------------------------------------
describe("secret-roundtrip e2e — 4 surface × 2 mode 装配矩阵 (#406)", () => {
  const SURFACES = ["chat", "ask", "tui", "serve"] as const;
  const MODES: ReadonlyArray<"roundtrip" | "block"> = ["roundtrip", "block"];

  for (const surface of SURFACES) {
    for (const mode of MODES) {
      it(`${surface} × ${mode}: ${mode === "roundtrip" ? "registry 在场 + secretsMode 非 block" : "secretsMode=block + registry 缺席"}`, async () => {
        const { root, home } = await makeFixture();
        const settings: IknowSettings = {
          llm: { model: "test-model", apiKey: "sk-e2e-matrix-sentinel" },
          ...(mode === "roundtrip"
            ? { secrets: { mode: "roundtrip" as const } }
            : { secrets: { mode: "block" as const } }),
        };
        const built = await buildHarnessEngine({
          env: makeEnv("sk-e2e-matrix-sentinel"),
          askUser: createNoAskUser(),
          surface,
          settings,
          userHome: home,
          cwd: root,
          sandboxRoot: root,
          // This file verifies the secrets assembly matrix, not overflow retirement /
          // index demotion (covered by build-engine-tool-overflow.test.ts and
          // disclosure-index-align/). Bypassing assembly-time countTokens; see the
          // BuildEngineOpts.skipCountTokens comment for seam semantics.
          skipCountTokens: true,
        });
        try {
          if (mode === "roundtrip") {
            assert.ok(
              built.deps.secretRegistry,
              `${surface}/${mode}: registry should exist`
            );
            assert.notEqual(
              built.deps.secretsMode,
              "block",
              `${surface}/${mode}: secretsMode must not be "block"`
            );
            // empty table at construction time (no value registered before any run())
            assert.equal(built.deps.secretRegistry!.size, 0);
          } else {
            assert.equal(
              built.deps.secretsMode,
              "block",
              `${surface}/${mode}: block mode`
            );
            assert.equal(
              built.deps.secretRegistry,
              undefined,
              `${surface}/${mode}: no registry in block mode`
            );
          }
        } finally {
          if (built.shutdown) await built.shutdown();
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// B) Full-flow surface: recognize-layer placeholderization + bash restore (model context sees only placeholders, bash gets real values)
// ---------------------------------------------------------------------------
describe("secret-roundtrip e2e — roundtrip 全流（识别 → bash 还原 → 输出 mask 兜底）", () => {
  // Test secret: the shape only needs to hit the DEFAULT sk- pattern and map to a single placeholder; the concrete value is irrelevant.
  const SECRET = "sk-aaaaaaaaaaaaaaaaaaaa";

  it("chat × roundtrip：run() 消息全树占位符；bash 还原层 spawn 前回填真值，输出 mask 兜底", async () => {
    const secretRegistry = createSecretRegistry();
    const deps = makeRunDeps({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      secretRegistry,
    });

    // (1) Recognition layer: run()'s first user message = placeholder; plaintext must never appear in any message.
    const { result } = await run(`这是 ${SECRET}，帮我测`, {
      adapter: deps.adapter,
      executor: deps.executor,
      registry: deps.registry,
      maxTurns: 5,
      secretRegistry,
    });
    assert.equal(result.stopReason, "completed");
    const firstUserText = (
      result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(firstUserText, "这是 <<<SECRET_1>>>，帮我测");
    for (const m of result.messages) {
      assert.ok(
        !JSON.stringify(m).includes(SECRET),
        "raw secret must not appear in any encoded message"
      );
    }
    assert.equal(secretRegistry.resolve("<<<SECRET_1>>>"), SECRET);

    // (2) Restore layer + output mask: the bash tool gets the same registry -> restore
    // before spawn (command receives the real value) -> after echo, stdout passes the output mask:
    // the real value must not leak into tool_result. Restore-hit evidence = placeholder absent;
    // mask-hit evidence = real value absent + *** present.
    // The handler returns the envelope `{ output, meta? }`; output still holds the JSON-ized
    // code/stdout/stderr, so parse to get the original BashResult shape.
    const { root } = await makeFixture();
    const bashTool = createBashTool(root, { secretRegistry });
    const bashEnvelope = (await bashTool.handler({
      command: 'echo "<<<SECRET_1>>>"',
    })) as { output: string };
    const bashResult = JSON.parse(bashEnvelope.output) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.equal(bashResult.code, 0);
    assert.ok(
      !bashResult.stdout.includes("<<<SECRET_1>>>"),
      "restore 命中：占位符已被真值替换（否则原样透传）"
    );
    assert.ok(
      !bashResult.stdout.includes(SECRET),
      `mask 命中：真值不得外泄到 tool_result（实际=${JSON.stringify(bashResult.stdout)}）`
    );
    assert.equal(bashResult.stdout, "***\n");
  });

  it("chat × block：run() 用户明文原样进消息（roundtrip 识别关闭），registry 缺席", async () => {
    // block mode: deps.secretsMode="block" + secretRegistry absent -> recognition layer skipped.
    const deps = makeRunDeps({
      responses: [
        assistantResult({
          texts: ["ok"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      secretsMode: "block",
    });
    const { result } = await run(`这是 ${SECRET}，帮我测`, {
      adapter: deps.adapter,
      executor: deps.executor,
      registry: deps.registry,
      maxTurns: 5,
      secretsMode: "block",
    });
    assert.equal(result.stopReason, "completed");
    const firstUserText = (
      result.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.equal(firstUserText, `这是 ${SECRET}，帮我测`);
  });

  it("roundtrip：同 registry 跨 turn 续传占位符原样保留，不重复注册（去重）", async () => {
    const secretRegistry = createSecretRegistry();
    const firstDeps = makeRunDeps({
      responses: [
        assistantResult({
          texts: ["first"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      secretRegistry,
    });
    const firstRun = await run(`用 ${SECRET} 处理`, {
      adapter: firstDeps.adapter,
      executor: firstDeps.executor,
      registry: firstDeps.registry,
      maxTurns: 5,
      secretRegistry,
    });
    assert.equal(secretRegistry.size, 1);
    const firstUserText = (
      firstRun.result.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    assert.equal(firstUserText, "用 <<<SECRET_1>>> 处理");

    const secondDeps = makeRunDeps({
      responses: [
        assistantResult({
          texts: ["second"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
      secretRegistry,
    });
    const secondRun = await run(
      "再用 <<<SECRET_1>>> 调用一次",
      {
        adapter: secondDeps.adapter,
        executor: secondDeps.executor,
        registry: secondDeps.registry,
        maxTurns: 5,
        secretRegistry,
      },
      undefined,
      { priorMessages: firstRun.result.messages }
    );
    // prior messages keep placeholders verbatim; new message text verbatim (placeholders trigger no pattern).
    const priorUserText = (
      secondRun.result.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    assert.equal(priorUserText, "用 <<<SECRET_1>>> 处理");
    // registry does not re-register (size still 1, dedup check).
    assert.equal(secretRegistry.size, 1);
    assert.equal(secretRegistry.resolve("<<<SECRET_1>>>"), SECRET);
  });

  it("roundtrip：session 重启（registry 重建）后历史占位符无法还原 — restore 原样透传不抛", async () => {
    // Simulate the old session's registry: a new session's empty registry does not recognize historical placeholders.
    // restore is a pure function: with an empty registry it returns the input verbatim, no throw (session-restart limitation).
    const freshRegistry = createSecretRegistry();
    const restored = restore("echo <<<SECRET_1>>>", freshRegistry);
    assert.equal(restored, "echo <<<SECRET_1>>>", "占位符原样透传（不抛）");
    assert.equal(freshRegistry.size, 0);
  });
});
