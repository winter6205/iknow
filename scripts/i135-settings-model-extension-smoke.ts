/**
 * i135 settings-model-extension smoke — Phase 2 整脚本重写。
 *
 * 目的：在真实 9router 模型下验证 LLM 配置已收敛到 `settings.json` 单承载
 * （`#353` 第二阶段 / `#164`）。四组验证：
 *   A. user 层 settings.json 写 `${ANTHROPIC_AUTH_TOKEN}` 占位符 → env loader 解析 →
 *      真实 chat 走通（响应 model 字段被 9router 改写成上游 ID `deepseek-v4-flash`）；
 *   B. user / project 两层皆无 llm（隔离空 home + 无 project settings）→
 *      `loadIknowEnv` fail-fast 抛「no LLM model configured in settings.llm.model」
 *      （不再有硬编码兜底）；
 *   C. user 层 settings.json 有 model 但无 apiKey + `ANTHROPIC_AUTH_TOKEN=""` →
 *      `env.llm.apiKey === undefined` → 守卫抛「no API key configured」；
 *   D. user 层 settings.json 字面写 `"apiKey": "<real>"`（**脚本运行时经 Node fs
 *      写入 tmp HOME，断言后 `finally rm`，绝不落 bash 命令行 / git / 日志 /
 *      仓库内 fixtures**）→ 删除 env key 后 `loadIknowEnv` 仍走通（不依赖 env）。
 *
 * ADR-0084 分层（`docs/adr/0084-project-settings-allowlist-and-permissions.md`）：
 * `llm` 是 **user 层键** —— project 文件 `<cwd>/.iknow/settings.json` 只采纳
 * `hooks` / `verify` / `secrets` / `permissions`，出现 `llm` 即丢弃 + 告警。
 * 故 A / C / D 三组的 fixture 一律写 tmp HOME（`<home>/.iknow/settings.json`）；
 * 写 project 层会让 `llm` 段被丢弃，`loadIknowEnv` 随即因 `settings.llm.model`
 * 缺失而 fail-fast。
 *
 * 纪律（对齐 i9 / i132 / t4 / i164）：
 *   - host-layer guard：读自身源码扫禁词 `src/cli` / `src/session-api` /
 *     `src/interaction` / `web/`，命中即 throw + exit 1。
 *   - 不 import host 层。
 *   - key 仅打 `len` + `sha256_12` 指纹，绝不打印全文 / 写入仓库内 fixtures /
 *     源码 / git / 日志。
 *   - baseUrl 常量 = `http://172.31.128.1:20128/v1`（9router 内网入口）。
 *   - 4 组共享一个 tmp HOME + 每组独立 tmp CWD（fork-local 隔离，不读真实
 *     `~/.iknow`）。共享 HOME 意味着每组必须清掉自己的 user 层 fixture —— 否则
 *     残留的 `llm` 会污染后续组（尤以 B 组「两层皆无 llm」前提为甚）。
 *   - 临时 tmp 文件 / 目录 `finally rm`，不污染仓库。
 *   - 输出约定：每行 `[PASS]/[FAIL] <断言名>: <细节>` 到 stdout；
 *     末尾一行 `i135 result=...` 到 stderr；exit 0 = 全断言过，
 *     exit 1 = 任何失败。
 *
 * 运行：`npm run probe:settings-model`（= `tsx scripts/i135-settings-model-extension-smoke.ts`）。
 * 前置：`process.env.ANTHROPIC_AUTH_TOKEN` 必须 set（A / C / D 依赖）；
 * `process.env.IKNOW_LLM_BASE_URL` 未设则脚本强制设为 `http://172.31.128.1:20128/v1`。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadIknowEnv } from "../src/config/env.js";
import {
  createRealAnthropicAdapter,
  encodeUserText,
} from "../src/harness/model-adapter/anthropic-adapter.js";
import { buildHarnessEngine } from "../src/harness/build-engine.js";
import { createNoAskUser } from "../src/harness/permission/ask-user.js";

const __filename = fileURLToPath(import.meta.url);

/** 9router 入口 baseUrl 常量（A / D 组共享；脚本强制覆写 IKNOW_LLM_BASE_URL）。 */
const BASE_URL = "http://172.31.128.1:20128/v1";
/** settings.json 写入的模型路由 ID（9router 收到后改写响应 model = `deepseek-v4-flash`）。 */
const SETTINGS_MODEL = "ocg/deepseek-v4-flash";
/** 9router 对 `ocg/deepseek-v4-flash` 的响应 model 改写（wire 证据）。 */
const WIRE_MODEL = "deepseek-v4-flash";
/** 简单 prompt —— reasoning 模型需要 max_tokens ≥ 100 才出非空 content。 */
const USER_PROMPT = "respond with the literal string OK";

/**
 * host-layer guard：smoke 自身不得引用 host 层（src/cli / src/session-api /
 * src/interaction / web/）。读自身源码扫禁词，命中即 throw（参考 i9 / i132 /
 * i164 同款）。导入的 harness/ 模块不在禁词中。
 */
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/cli", "src/session-api", "src/interaction", "web/"];
  const lines = self.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
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
  const t = v.trim();
  return (
    "len=" +
    t.length +
    " sha256_12=" +
    createHash("sha256").update(t).digest("hex").slice(0, 12)
  );
}

/** 断言清单。 */
const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function record(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? "[PASS]" : "[FAIL]"} ${name}${detail ? `: ${detail}` : ""}`
  );
}

/**
 * 构造带 wire 捕获的 Anthropic client：
 *   - 捕获每个出站请求体的 model；
 *   - 捕获每个 2xx JSON 响应体的 model（9router 会改写成上游 ID）。
 */
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

/** 一次真实 adapter step（max_tokens ≥ 100；reasoning 模型才出非空 content）。 */
async function runOneTurn(env: {
  llm: { model: string; baseUrl: string; apiKey: string | undefined };
}): Promise<{
  sentModel: string | undefined;
  respModel: string | undefined;
  text: string;
  stop: string | undefined;
}> {
  if (!env.llm.apiKey)
    throw new Error("runOneTurn called with apiKey=undefined");
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
  return {
    sentModel: sentModels.at(-1),
    respModel: respModels.at(-1),
    text: turn.projection.texts.join("").slice(0, 60),
    stop: turn.supplierStop,
  };
}

/**
 * 隔离 HOME：创建 tmp home 并把 process.env.HOME 指向它（避免读真实
 * `~/.iknow/settings.json`），断言后恢复原 HOME 并删除 tmp。
 */
async function withIsolatedHome<T>(
  fn: (home: string) => Promise<T>
): Promise<{ value: T; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "iknow-i135-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const value = await fn(home);
    return { value, home };
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * A 组：user 层 settings `${ANTHROPIC_AUTH_TOKEN}` 占位符 → loader 解析 → 真实 chat。
 *
 * fixture 写 user 层（`<home>/.iknow/settings.json`，ADR-0084：llm 是 user 层键）；
 * cwd 只作为「无 project settings」的空项目根（不写 `<cwd>/.iknow`）。
 */
async function groupA(home: string): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "iknow-i135-A-"));
  const settingsPath = join(home, ".iknow", "settings.json");
  await mkdir(join(home, ".iknow"), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({
      llm: { model: SETTINGS_MODEL, apiKey: "${ANTHROPIC_AUTH_TOKEN}" },
    }) + "\n",
    "utf8"
  );
  try {
    const env = loadIknowEnv(cwd, undefined, home);
    record(
      "A1 loader: env.llm.model === settings.llm.model",
      env.llm.model === SETTINGS_MODEL,
      `env.llm.model=${env.llm.model} settings=${SETTINGS_MODEL}`
    );
    record(
      "A2 apiKey 占位符解析成功（来自 process.env.ANTHROPIC_AUTH_TOKEN）",
      Boolean(env.llm.apiKey?.trim()),
      `apiKey fp=${fp(env.llm.apiKey)}`
    );
    const turn = await runOneTurn(env);
    record(
      "A3 出站请求 model === settings 字面（wire 真值）",
      turn.sentModel === SETTINGS_MODEL,
      `wire=${JSON.stringify(turn.sentModel)} settings=${SETTINGS_MODEL}`
    );
    record(
      "A4 响应 model === 'deepseek-v4-flash'（9router 改写证据）",
      turn.respModel === WIRE_MODEL,
      `resp=${JSON.stringify(turn.respModel)} expected=${WIRE_MODEL}`
    );
    record(
      "A5 content 非空（真实响应可用）",
      turn.text.length > 0,
      `text=${JSON.stringify(turn.text)} stop=${turn.stop}`
    );
  } finally {
    // 只删本组 fixture 文件：tmp HOME 目录本身归 withIsolatedHome 所有，不在此 rm。
    // 必须删——4 组共享同一个 HOME，残留的 llm 会让 B 组「两层皆无 llm」前提失效。
    await rm(settingsPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * B 组：user / project 两层皆无 llm（隔离空 HOME + 无 project settings）→
 * loadIknowEnv fail-fast 抛「no LLM model configured」。
 *
 * 前提依赖「隔离 HOME 此刻为空」：前序组（A）的 fixture 已在自身 finally 清除。
 * home 显式注入（而非依赖 os.homedir() 读 process.env.HOME）：本组断言的正是
 * 这个 home 的缺席，且 env.ts 对 home 的契约本身就是「须显式注入」。
 */
async function groupB(home: string): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "iknow-i135-B-"));
  try {
    let err: Error | undefined;
    try {
      loadIknowEnv(cwd, undefined, home);
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    record(
      "B1 settings={} → loadIknowEnv fail-fast 抛「no LLM model configured in settings.llm.model」",
      err !== undefined &&
        /no LLM model configured in settings\.llm\.model/.test(err.message),
      err ? `err=${err.message}` : "no error thrown (expected fail-fast)"
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * C 组：user 层 settings 有 model 无 apiKey + ANTHROPIC_AUTH_TOKEN="" → 守卫抛。
 *
 * fixture 写 user 层（`<home>/.iknow/settings.json`，ADR-0084：llm 是 user 层键）。
 */
async function groupC(home: string): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "iknow-i135-C-"));
  const settingsPath = join(home, ".iknow", "settings.json");
  await mkdir(join(home, ".iknow"), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({ llm: { model: SETTINGS_MODEL } }) + "\n",
    "utf8"
  );
  const prevKey = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "";
  try {
    const env = loadIknowEnv(cwd, undefined, home);
    record(
      "C1 loader: apiKey 解析为 undefined（settings 无 apiKey + env key 空）",
      env.llm.apiKey === undefined,
      `apiKey=${JSON.stringify(env.llm.apiKey)}`
    );
    // 用 buildHarnessEngine 触发真实守卫（与生产同源；harness 层，不违反 host-layer guard）。
    let guardErr: Error | undefined;
    try {
      await buildHarnessEngine({
        env,
        askUser: createNoAskUser(),
        sandboxRoot: cwd,
        surface: "chat",
      });
    } catch (e) {
      guardErr = e instanceof Error ? e : new Error(String(e));
    }
    record(
      "C2 buildHarnessEngine 守卫抛「no API key configured」（与 settings 单承载文案一致）",
      guardErr !== undefined && /LLM mode needs API key/.test(guardErr.message),
      guardErr ? `err=${guardErr.message}` : "no error thrown (expected guard)"
    );
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevKey;
    // 只删本组 fixture 文件（tmp HOME 目录归 withIsolatedHome 所有，不在此 rm）。
    await rm(settingsPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * D 组：user 层 settings 字面写 `"apiKey": "<real>"` → 删 env key → 真实 chat 走通。
 *
 * key 来源：`process.env.ANTHROPIC_AUTH_TOKEN`（脚本运行时内存；不落 bash 命令行
 * / 仓库 fixtures / 源码 / git / 日志；只进 tmp HOME 的 settings.json，写入后
 * `finally rm`）。ADR-0084：llm 是 user 层键，project 文件会丢弃该段。
 */
async function groupD(home: string, realKey: string): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "iknow-i135-D-"));
  const settingsPath = join(home, ".iknow", "settings.json");
  await mkdir(join(home, ".iknow"), { recursive: true });
  // 字面 apiKey 写入 tmp HOME settings.json（脚本内 Node fs，断言后立即删）。
  await writeFile(
    settingsPath,
    JSON.stringify({
      llm: { model: SETTINGS_MODEL, apiKey: realKey },
    }) + "\n",
    "utf8"
  );
  // 删除 env key 以证明 D 组不依赖 env（loader 不读 process.env）。
  const prevKey = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const env = loadIknowEnv(cwd, undefined, home);
    record(
      "D1 loader: apiKey 字面解析 === settings 字面（不依赖 env）",
      env.llm.apiKey === realKey,
      `env.llm.apiKey fp=${fp(env.llm.apiKey)} expected=${fp(realKey)}`
    );
    const turn = await runOneTurn(env);
    record(
      "D2 出站请求 model === settings 字面（wire 真值）",
      turn.sentModel === SETTINGS_MODEL,
      `wire=${JSON.stringify(turn.sentModel)} settings=${SETTINGS_MODEL}`
    );
    record(
      "D3 响应 model === 'deepseek-v4-flash'（9router 改写证据）",
      turn.respModel === WIRE_MODEL,
      `resp=${JSON.stringify(turn.respModel)} expected=${WIRE_MODEL}`
    );
    record(
      "D4 content 非空（字面 key 走通）",
      turn.text.length > 0,
      `text=${JSON.stringify(turn.text)} stop=${turn.stop}`
    );
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevKey;
    // 只删本组 fixture 文件（tmp HOME 目录归 withIsolatedHome 所有，不在此 rm）。
    await rm(settingsPath, { force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  assertHostLayerGuard();

  // 强制 baseUrl 常量（脚本全程一致；不依赖调用方 env）。
  const prevBase = process.env.IKNOW_LLM_BASE_URL;
  process.env.IKNOW_LLM_BASE_URL = BASE_URL;

  // 真实 key 读自 process.env（仅 D 组需要写入 settings；A 组走占位符解析）。
  const realKey = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!realKey?.trim()) {
    console.error(
      "key absent, exit 1 — set ANTHROPIC_AUTH_TOKEN in environment (real 9router key)."
    );
    process.exit(1);
  }

  try {
    // 所有 4 组共享一个隔离 HOME（避免读真实 ~/.iknow/settings.json 干扰）。
    const { home } = await withIsolatedHome(async (h) => {
      await groupA(h);
      await groupB(h);
      await groupC(h);
      await groupD(h, realKey);
      return h;
    });
    void home;
  } finally {
    if (prevBase === undefined) delete process.env.IKNOW_LLM_BASE_URL;
    else process.env.IKNOW_LLM_BASE_URL = prevBase;
  }

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const allPass = passed === total;
  console.error(
    `i135 result=${allPass ? "pass" : "fail"} checks=${passed}/${total} ` +
      `settings_model=${SETTINGS_MODEL} ` +
      `key_fp=${fp(realKey)} ` +
      `baseUrl_host=${hostOf(BASE_URL)}`
  );
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
