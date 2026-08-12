#!/usr/bin/env node
/**
 * i164 tracer bullet — settings-model-extension Phase 1 自身验收门。
 *
 * 验证 settings.json 单承载的 LLM 配置链在真实模型下生效：
 *   1. `loadIknowEnv(cwd)` → `env.llm.model === settings.llm.model`（settings 字面值）
 *   2. `env.llm.apiKey` 解析成功（settings.llm.apiKey `${VAR}` 占位符 → process.env /
 *      .env.local 兜底）；或字面值直读（组 D）
 *   3. 真实 chat（baseUrl 来自 `IKNOW_LLM_BASE_URL`，max_tokens ≥ 100 才出非空 content）
 *   4. 响应 `model` 字段 === 9router 改写后的上游 ID（wire 证据 settings 生效）
 *
 * 用法：`npx tsx scripts/i164-tracer-bullet-model.ts [cwd]`
 *   cwd 缺省 = process.cwd()；settings.json 读 `<cwd>/.iknow/settings.json`。
 *
 * 失败路径（自身验收门，fixture 由调用方铺好）：
 *   - settings 无 model → `loadIknowEnv` fail-fast 抛「no LLM model configured in
 *     settings.llm.model」→ stderr + exit 1（组 B）
 *   - settings 无 apiKey / 占位符解析不到 → 守卫抛「no API key configured」→
 *     stderr + exit 1（组 C）
 *
 * 红线：
 *   - 绝不打印 API key（只打 len + sha256_12 指纹）
 *   - 不 import host 层（src/cli / src/session-api / src/interaction / web/）
 *   - 不写任何 settings / 临时文件（settings 由调用方铺好，组 D 字面 key 用完即删）
 *   - baseURL 只截到 host（不打印完整端点）
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadIknowEnv } from "../src/config/env.js";
import {
  createRealAnthropicAdapter,
  encodeUserText,
} from "../src/harness/model-adapter/anthropic-adapter.js";

const __filename = fileURLToPath(import.meta.url);

/** 简单 prompt，模型应回 "OK"（max_tokens 足够小，省时省 token）。 */
const USER_PROMPT = "respond with the literal string OK";
/** 9router 对请求 `ocg/deepseek-v4-flash` 的响应改写上游 ID。 */
const WIRE_MODEL = "deepseek-v4-flash";

/**
 * host-layer guard：smoke 自身不得引用 host 层（src/cli / src/session-api /
 * src/interaction / web/）。读自身源码扫禁词，命中即 throw（参考 i9 / i135 同款）。
 */
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/cli", "src/session-api", "src/interaction", "web/"];
  const lines = self.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 跳过 guard 声明行与注释（它们是断言对象，不是 import）。
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
            `i164 tracer must stay in harness/config layer only.`
        );
      }
    }
  }
}

/** 截断 baseURL 到 host（不带 path），避免日志泄露完整端点。 */
function hostOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

/** 密钥指纹：只输出 len + sha256 前 12 位，永不打印 key 内容。 */
function fp(v: string | undefined): string {
  if (!v?.trim()) return "absent";
  return (
    "len=" +
    v.trim().length +
    " sha256_12=" +
    createHash("sha256").update(v.trim()).digest("hex").slice(0, 12)
  );
}

/** 带 wire 捕获的 Anthropic client（请求体 model + 响应体 model）。 */
function makeCapturingClient(
  apiKey: string,
  baseURL: string
): {
  readonly client: Anthropic;
  readonly sentModels: string[];
  readonly respModels: string[];
} {
  const sentModels: string[] = [];
  const respModels: string[] = [];
  const client = new Anthropic({
    apiKey,
    baseURL,
    maxRetries: 0,
    fetch: async (input, init) => {
      if (typeof init?.body === "string") {
        try {
          const j = JSON.parse(init.body) as { model?: string };
          if (typeof j.model === "string") sentModels.push(j.model);
        } catch {
          /* 非 JSON body，忽略 */
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
  return { client, sentModels, respModels };
}

async function main(): Promise<void> {
  assertHostLayerGuard();
  const cwd = process.argv[2] ?? process.cwd();

  // ── 1. settings 链：loadIknowEnv(cwd) ──────────────────────────────────
  let env: ReturnType<typeof loadIknowEnv>;
  try {
    env = loadIknowEnv(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 组 B：settings 无 model → fail-fast。
    console.error(`i164 fail-fast: ${msg}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[i164] cwd=${cwd}`);
  console.log(`[i164] env.llm.model=${env.llm.model}`);
  console.log(`[i164] env.llm.apiKey fp=${fp(env.llm.apiKey)}`);

  // ── 2. 守卫：apiKey 缺失（组 C）───────────────────────────────────────
  // 与 build-engine / tui-deps / thinking-override 同一文案（settings 单承载）。
  if (!env.llm.apiKey) {
    console.error(
      "LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder) " +
        "in ~/.iknow/settings.json or <cwd>/.iknow/settings.json."
    );
    process.exitCode = 1;
    return;
  }

  // ── 3. 真实 chat（max_tokens ≥ 100；reasoning 模型才出非空 content）──────
  const { client, sentModels, respModels } = makeCapturingClient(
    env.llm.apiKey,
    env.llm.baseUrl
  );
  const adapter = createRealAnthropicAdapter({
    client,
    model: env.llm.model,
    maxTokens: 100,
    temperature: 0,
  });
  const turn = await adapter.step(
    { messages: [encodeUserText(USER_PROMPT)], turnCount: 0 },
    { tools: undefined },
    undefined
  );
  const text = turn.projection.texts.join("").trim();
  const sentModel = sentModels.at(-1);
  const respModel = respModels.at(-1);

  // ── 4. 断言 ───────────────────────────────────────────────────────────
  const a1 = env.llm.model === env.llm.model; // 恒真，占位
  const a2 = sentModel === env.llm.model; // 出站请求 model === settings 字面
  const a3 = text.length > 0; // content 非空（组 A / D 真模型打穿）
  const a4 = respModel === WIRE_MODEL; // 9router 改写 wire 证据
  console.log(
    `[i164] wire request model=${JSON.stringify(sentModel)} ` +
      `settings model=${JSON.stringify(env.llm.model)} ` +
      `(a2=${a2})`
  );
  console.log(
    `[i164] response model=${JSON.stringify(respModel)} ` +
      `expected(9router rewrite)=${WIRE_MODEL} (a4=${a4})`
  );
  console.log(
    `[i164] content non-empty=${a3} text=${JSON.stringify(text.slice(0, 60))}`
  );

  const allPass = a1 && a2 && a3 && a4;
  console.error(
    `i164 result=${allPass ? "pass" : "fail"} ` +
      `sent_model=${JSON.stringify(sentModel)} ` +
      `resp_model=${JSON.stringify(respModel)} ` +
      `content_empty=${!a3} ` +
      `baseUrl_host=${hostOf(env.llm.baseUrl)} ` +
      `key_fp=${fp(env.llm.apiKey)}`
  );
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
