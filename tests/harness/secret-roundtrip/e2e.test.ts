/**
 * e2e.test.ts — #406 T5 端到端矩阵验收（4 surface × 2 mode → 8 cases）。
 *
 * 两个断言面：
 *   A) 装配面（8 个矩阵 case）—— 对每个 surface（chat / ask / tui / serve）在
 *      roundtrip 与 block 两种 mode 下断言机器状态：
 *        roundtrip → deps.secretRegistry 在场 + secretsMode 非 "block"
 *                    （识别 + 占位符 + 还原链路装配）
 *        block     → deps.secretsMode === "block" + secretRegistry 缺席
 *                    （legacy deny-only guard 兼容路径）
 *   B) 全流面（bonus）—— 经独立 run() + stub model/registry/executor 驱动
 *      「识别层占位符化 → bash 还原层真值」闭环；block 下断言 run() 明文原样
 *      进消息（roundtrip 识别关闭）。bash 还原层用真实 createBashTool 验证
 *      （bwrap 可用，与 bash.test.ts 同款真实 spawn）。
 *
 * 测试缝（对齐 build-engine.test.ts）：opts.settings 注入隔离 settings +
 * tmp userHome/cwd fixture（#337 T8）——不读真实 ~/.iknow、不污染 process.env。
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
    // #358 T2: subagent 配置臂 (build-engine 读取 taskTimeoutMs)。
    subagent: { taskTimeoutMs: undefined },
  };
}

/** 每个 case 独立 tmp fixture 隔离 skill scanner / mcp config / 真实 home。 */
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

/** 全流面 stub rig：确定性 stub model + noop tool + 空 secret registry。
 *  mirror tests/cli/_fixtures.ts makeDeps——block 模式不传 secretRegistry，
 *  roundtrip 传 secretRegistry（供识别层 + 断言共享）。 */
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
// A) 装配面：4 surface × 2 mode 矩阵（A1：8 case 至少 6 绿）
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
            // 构造期空表（未跑任何 run() 前不注册任何值）
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
// B) 全流面：识别层占位符化 + bash 还原（模型上下文只见占位符，bash 拿真值）
// ---------------------------------------------------------------------------
describe("secret-roundtrip e2e — roundtrip 全流（识别 → bash 还原 → 输出 mask 兜底）", () => {
  // 测试密钥：形态只需命中 DEFAULT sk- pattern 并映射到单个占位符；具体值无关紧要。
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

    // (1) 识别层：run() 首条 user 消息 = 占位符，明文绝不出现在任何消息中。
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

    // (2) 还原层 + 输出 mask（#357 T3）：bash 工具拿到同一 registry → spawn 前
    // restore（命令拿真值）→ echo 回来后 stdout 经 output-mask 洗涤：真值不外泄到
    // tool_result。restore 命中证据 = 占位符缺席；mask 命中证据 = 真值缺席 + *** 在场。
    // #693 T4 D4:handler 自 T4 起返回 envelope `{ output, meta? }`,output 字段里
    // 仍是 JSON 化的 code/stdout/stderr,parse 一下拿到原 BashResult 形态。
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
    // block 模式：deps.secretsMode="block" + secretRegistry 缺席 → 识别层跳过。
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
    // prior 消息原样保留占位符；新消息文本 verbatim（占位符不触发任何 pattern）。
    const priorUserText = (
      secondRun.result.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    assert.equal(priorUserText, "用 <<<SECRET_1>>> 处理");
    // registry 不重复注册（size 仍 1，去重验证）。
    assert.equal(secretRegistry.size, 1);
    assert.equal(secretRegistry.resolve("<<<SECRET_1>>>"), SECRET);
  });

  it("roundtrip：session 重启（registry 重建）后历史占位符无法还原 — restore 原样透传不抛", async () => {
    // 模拟旧 session 的 registry：新 session 的空 registry 不认识历史占位符。
    // restore 是纯函数：空 registry 下原样返回，不抛（session-restart limitation）。
    const freshRegistry = createSecretRegistry();
    const restored = restore("echo <<<SECRET_1>>>", freshRegistry);
    assert.equal(restored, "echo <<<SECRET_1>>>", "占位符原样透传（不抛）");
    assert.equal(freshRegistry.size, 0);
  });
});
