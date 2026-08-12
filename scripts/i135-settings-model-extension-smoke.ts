/**
 * i135 probe — settings.llm.model 真实影响模型调用（TDD smoke）。
 *
 * 目的:验证 #353 第二阶段(plans/settings-model-extension.md)的模型配置链
 * `env > settings.json(project > user)`(无任何代码默认,未配 → fail-fast)在
 * **真实模型**下生效 —— 写 `.iknow/settings.json` 到临时 cwd → `loadIknowEnv(cwd)`
 * → 真实 Anthropic-format 请求 → 请求 wire 上的 model == settings.llm.model。
 *
 * 断言设计(与 9router 实测行为对齐):
 *   - 9router 会把响应体 `model` 字段改写成实际路由到的上游 ID
 *     (实测:`hy3-combo` → `deepseek-v4-flash`),
 *     故 `response.model === settings.llm.model` 在真实流量下**不可能成立**。
 *     本探针改为权威证据链:
 *       A1 `env.llm.model === settings.llm.model`(env loader 链生效)
 *       A2 SDK fetch-hook 捕获的**出站请求体** model === settings.llm.model
 *          (wire 真值 —— 9router 收到什么就是什么)
 *       A3 adapter 回合成功(text 非空,真实响应可用)
 *       B1 无 settings 的 cwd → `loadIknowEnv` 抛「no LLM model configured」
 *          (fail-fast,不再有硬编码兜底)
 *       B2 / B3 对照请求路径已取消(无兜底 model 可发);原对照改为断言抛错
 *   - `hy3-combo` 经 9router /v1/messages 实测可用。
 *
 * 前置条件:`IKNOW_LLM_MODEL` 必须 UNSET(env 仍最高,设了会压过 settings)。
 * 缺 key 守卫走 `getApiKey`(不触发 model fail-fast)。
 *
 * 边界 / 纪律(对齐 i9 / i132 / t4):
 *   - host-layer guard:读自身源码扫禁词 src/cli / src/session-api /
 *     src/interaction / web/,命中即 throw + exit 1。
 *   - 不 import host 层(src/cli / src/session-api / src/interaction / web/)。
 *   - 缺 key:`key absent, exit 1` 一行到 stderr + process.exit(1),不抛异常。
 *   - 不打印 ANTHROPIC_AUTH_TOKEN 任何部分,只打 len + sha256_12 指纹。
 *   - baseURL 只截到 host。
 *   - 临时 tmp cwd 用完 rm -rf 清理,不污染仓库。
 *   - 输出约定:一行结果到 stderr;exit 0 = 全断言过,exit 1 = 任何失败。
 *
 * 运行:npm run probe:settings-model(= tsx scripts/i135-settings-model-extension-smoke.ts)
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadIknowEnv, getApiKey } from "../src/config/env.js";
import {
  createRealAnthropicAdapter,
  encodeUserText,
} from "../src/harness/model-adapter/anthropic-adapter.js";

const __filename = fileURLToPath(import.meta.url);

/** settings.json 写入的模型路由 ID —— 经 9router /v1/messages 实测可用。 */
const SETTINGS_MODEL = "hy3-combo";
/** 简单 prompt,模型应回 "OK"(max_tokens 足够小,省时省 token)。 */
const USER_PROMPT = "respond with the literal string OK";

/**
 * host-layer guard:smoke 自身不得引用 host 层(src/cli / src/session-api /
 * src/interaction / web/)。读自身源码扫禁词,命中即 throw(参考 i9 同款)。
 */
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/cli", "src/session-api", "src/interaction", "web/"];
  const lines = self.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 跳过 guard 声明行与注释(它们是断言对象,不是 import)。
    if (
      line.includes("const forbidden =") ||
      line.trim().startsWith("//") ||
      line.trim().startsWith("*")
    ) {
      continue;
    }
    for (const kw of forbidden) {
      if (line.includes(kw)) {
        throw new Error(
          `host-layer guard violated at line ${i + 1}: contains '${kw}'. ` +
            `i135 smoke must stay in harness/config layer only.`
        );
      }
    }
  }
}

/** 截断 baseURL 到 host(不带 path),避免日志泄露完整端点。 */
function hostOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

/** 密钥指纹:只输出 len + sha256 前 12 位,永不打印 key 内容。 */
function fp(v: string | undefined): string {
  if (!v?.trim()) return "absent";
  return (
    "len=" +
    v.trim().length +
    " sha256_12=" +
    createHash("sha256").update(v.trim()).digest("hex").slice(0, 12)
  );
}

/** 断言清单:全 pass → exit 0。 */
const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function record(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? "[PASS]" : "[FAIL]"} ${name}${detail ? `: ${detail}` : ""}`
  );
}

/**
 * 构造带 wire 捕获的 Anthropic client:
 *   - 捕获每个**出站请求体**的 model(SDK 序列化为 string body);
 *   - 捕获每个 2xx JSON 响应体的 model(9router 会改写成上游 ID,留档用)。
 * 捕获值不是 secret,可安全打印。
 */
function makeCapturingClient(
  apiKey: string,
  baseURL: string
): {
  readonly client: Anthropic;
  readonly captured: Array<{ model?: string }>;
  readonly respModels: string[];
} {
  const captured: Array<{ model?: string }> = [];
  const respModels: string[] = [];
  const client = new Anthropic({
    apiKey,
    baseURL,
    maxRetries: 0,
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        try {
          captured.push(JSON.parse(init.body) as { model?: string });
        } catch {
          /* 非 JSON body,忽略 */
        }
      }
      const res = await globalThis.fetch(input, init);
      const ct = res.headers.get("content-type") ?? "";
      if (res.ok && ct.includes("application/json")) {
        try {
          const text = await res.clone().text();
          const j = JSON.parse(text) as { model?: string };
          if (typeof j.model === "string") respModels.push(j.model);
        } catch {
          /* 忽略 */
        }
      }
      return res;
    },
  });
  return { client, captured, respModels };
}

/** 一次真实 adapter step:单 user turn,无工具。 */
async function runOneTurn(
  env: { llm: { model: string; baseUrl: string; apiKey: string | undefined } },
  key: string
): Promise<{
  sentModel: string | undefined;
  respModel: string | undefined;
  text: string;
  supplierStop: string | undefined;
}> {
  const { client, captured, respModels } = makeCapturingClient(
    key,
    env.llm.baseUrl
  );
  const adapter = createRealAnthropicAdapter({
    client,
    model: env.llm.model,
    maxTokens: 64,
    temperature: 0,
  });
  const turn = await adapter.step(
    { messages: [encodeUserText(USER_PROMPT)], turnCount: 0 },
    { tools: undefined },
    undefined
  );
  return {
    sentModel: captured.at(-1)?.model,
    respModel: respModels.at(-1),
    text: turn.projection.texts.join("").slice(0, 60),
    supplierStop: turn.supplierStop,
  };
}

async function main(): Promise<void> {
  assertHostLayerGuard();

  // ── 缺 key 守卫:无 key 一行 stderr + exit 1,不抛异常(TDD 先写失败路径)──
  // 走 getApiKey 直读 env key(不经 loadIknowEnv,避免触发 model fail-fast)。
  const llmKeyEnv = process.env.IKNOW_LLM_API_KEY_ENV || "ANTHROPIC_AUTH_TOKEN";
  const apiKey = getApiKey({ envVarName: llmKeyEnv, fileMap: {} });
  if (!apiKey || apiKey.length === 0) {
    console.error(
      "key absent, exit 1 — set ANTHROPIC_AUTH_TOKEN (or via IKNOW_LLM_API_KEY_ENV)"
    );
    process.exit(1);
  }
  const key: string = apiKey;

  // ── A. settings 生效路径:tmp cwd + .iknow/settings.json ──────────────
  // 前置条件:IKNOW_LLM_MODEL 必须 UNSET(env 仍最高,设了会压过 settings)。
  // 此处临时隔离,保证 A 组证明「settings 是唯一 model 来源时生效」,断言后恢复。
  const withSettings = await mkdtemp(join(tmpdir(), "iknow-i135-settings-"));
  await mkdir(join(withSettings, ".iknow"), { recursive: true });
  await writeFile(
    join(withSettings, ".iknow", "settings.json"),
    JSON.stringify({ llm: { model: SETTINGS_MODEL } }) + "\n",
    "utf8"
  );

  const prevModelEnvA = process.env.IKNOW_LLM_MODEL;
  delete process.env.IKNOW_LLM_MODEL;
  let envWithSettings: ReturnType<typeof loadIknowEnv>;
  try {
    envWithSettings = loadIknowEnv(withSettings);
  } finally {
    if (prevModelEnvA === undefined) delete process.env.IKNOW_LLM_MODEL;
    else process.env.IKNOW_LLM_MODEL = prevModelEnvA;
  }
  const a1 = envWithSettings.llm.model === SETTINGS_MODEL;
  record(
    "A1 settings 生效: env.llm.model === settings.llm.model",
    a1,
    `env.llm.model=${envWithSettings.llm.model} settings=${SETTINGS_MODEL}`
  );

  const turnA = await runOneTurn(envWithSettings, key);
  const a2 = turnA.sentModel === SETTINGS_MODEL;
  record(
    "A2 wire 请求 model === settings.llm.model",
    a2,
    `wire=${JSON.stringify(turnA.sentModel)} settings=${SETTINGS_MODEL}`
  );
  record(
    "A3 adapter 回合成功(text 非空)",
    turnA.text.length > 0,
    `text=${JSON.stringify(turnA.text)} stop=${turnA.supplierStop}`
  );

  // ── B. 对照路径:无 settings 的 tmp cwd → fail-fast 抛错(不再有兜底)──
  // 临时隔离 IKNOW_LLM_MODEL + HOME(即使调用方设了 env / 真实 ~/.iknow 配了
  // model,也要证明「无 settings + 无 env model」组合抛错),断言后恢复。
  const noSettings = await mkdtemp(join(tmpdir(), "iknow-i135-nosettings-"));
  const emptyHome = await mkdtemp(join(tmpdir(), "iknow-i135-emptyhome-"));
  const prevModelEnv = process.env.IKNOW_LLM_MODEL;
  const prevHome = process.env.HOME;
  delete process.env.IKNOW_LLM_MODEL;
  process.env.HOME = emptyHome;
  let bErr: Error | undefined;
  try {
    loadIknowEnv(noSettings);
  } catch (err) {
    bErr = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (prevModelEnv === undefined) delete process.env.IKNOW_LLM_MODEL;
    else process.env.IKNOW_LLM_MODEL = prevModelEnv;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
  const b1 = bErr !== undefined && /no LLM model configured/.test(bErr.message);
  record(
    "B1 无 settings → loadIknowEnv 抛「no LLM model configured」(fail-fast)",
    b1,
    bErr ? `err=${bErr.message}` : "no error thrown (expected fail-fast)"
  );

  // ── 清理临时 cwd,不污染仓库 ─────────────────────────────────────────
  await Promise.all([
    rm(withSettings, { recursive: true, force: true }),
    rm(noSettings, { recursive: true, force: true }),
    rm(emptyHome, { recursive: true, force: true }),
  ]);

  // ── 一行结果到 stderr + exit 码 ──────────────────────────────────────
  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const allPass = passed === total;
  console.error(
    `i135 result=${allPass ? "pass" : "fail"} checks=${passed}/${total} ` +
      `settings_model=${SETTINGS_MODEL} ` +
      `key_env=${llmKeyEnv} key_fp=${fp(key)} ` +
      `baseUrl_host=${hostOf(envWithSettings.llm.baseUrl)} ` +
      `a_wire=${JSON.stringify(turnA.sentModel)} a_resp=${JSON.stringify(turnA.respModel)} ` +
      `a_text=${JSON.stringify(turnA.text)}`
  );

  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
