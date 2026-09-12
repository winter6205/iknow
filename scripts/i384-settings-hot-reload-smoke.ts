/**
 * i384 settings-hot-reload smoke — 文件级热更新真值验证（T5）。
 *
 * 目的：在真实链路下验证「修改 settings.json → 运行中进程下一轮以新 env 调 LLM」。
 * 三组：
 *   A. chat 形态（SessionHub + EnvLoader，stub adapter 换成 capture-server 真值）：
 *      改 settings.json 的 `model` → 下一轮 postMessage 的 wire `model` 变化断言。
 *   B. serve HTTP 形态：`startSessionServe({ hubOptions: { envProvider } })` →
 *      改 settings.json → 下一条 POST /messages 的 wire `model` 字段变化断言
 *      （serve 路径经 hubOptions 注入 envProvider，T3 铺路；不改 serve.ts）。
 *   C. reload 失败（坏 JSON）→ 旧 env 保留断言（缓存引用不变，进程不崩）。
 *
 * 纪律（对齐 i11 / i135）：
 *   - host-layer guard：读自身源码扫禁词 `src/interaction` / `src/agent-loop`
 *     / `web/`，命中即 throw + exit 1。
 *   - 不 import host 层（src/cli）；合法 import src/config + src/session-api +
 *     src/harness。
 *   - LLM 端点 = 本地 capture HTTP server（`startLlmCapture` 同款），不改真实
 *     网络；`IKNOW_LLM_BASE_URL` 指向 capture，settings.json 写 capture 可
 *     返回的 model（wire 模型名由 capture 响应 model 字段决定，走 adapter 解释）。
 *   - 临时 tmp HOME / tmp CWD（隔离，不读真实 ~/.iknow）；finally rm。
 *   - 输出：每行 `[PASS]/[FAIL] <断言名>: <细节>`；末尾 `i384 result=...`；
 *     exit 0 = 全过，exit 1 = 任一失败。
 *
 * 运行：`bun run scripts/i384-settings-hot-reload-smoke.ts`。
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvLoader } from "../src/config/env-loader.js";
import { SessionHub } from "../src/session-api/hub.js";
import { SessionStore } from "../src/session-api/store/index.js";
import { startSessionServe } from "../src/session-api/serve.js";
import { createNoAskUser } from "../src/harness/permission/ask-user.js";
import { deriveProjectIdentityRoot } from "../src/harness/session-roots.js";

const __filename = fileURLToPath(import.meta.url);

/** host-layer guard：smoke 自身不得引用 host 层（interaction / agent-loop / web）。 */
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/interaction", "src/agent-loop", "web/", "src/cli"];
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
            `i384 smoke must stay in config + session-api + harness layers only.`
        );
      }
    }
  }
}

/** 本地 capture HTTP server：捕获出站 LLM 请求体的 model，回 MINIMAL_SDK_MESSAGE。 */
function startCapture(): Promise<{
  origin: string;
  bodies: unknown[];
  close: () => Promise<void>;
}> {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_capture",
          type: "message",
          role: "assistant",
          model: "test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      let closed = false;
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        bodies,
        close: () =>
          new Promise((r, j) => {
            if (closed) return r();
            closed = true;
            server.close((e) => (e ? j(e) : r()));
          }),
      });
    });
  });
}

/** 断言清单。 */
const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function record(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? "[PASS]" : "[FAIL]"} ${name}${detail ? `: ${detail}` : ""}`
  );
}

/** 等待 settings 文件 watcher 触发 reload（轮询 env 模型名变化）。 */
async function waitForModel(
  loader: ReturnType<typeof createEnvLoader>,
  expected: string,
  timeoutMs = 3000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (loader.get().llm.model === expected) return true;
    } catch {
      // reload 中间态（坏 JSON）忽略
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

interface Dirs {
  base: string;
  cwd: string;
  home: string;
  settingsFile: string;
}

/**
 * fixture 写 **user 层**（`<home>/.iknow/settings.json`）：ADR-0084 起
 * `llm` 是 user 层键 —— project 文件 `<cwd>/.iknow/settings.json` 只采纳
 * `hooks` / `verify` / `secrets` / `permissions`，写 project 层会被丢弃 +
 * 告警，`loadIknowEnv` 随即因 model 缺失 fail-fast。cwd 只作空项目根。
 */
function makeDirs(): Dirs {
  const base = mkdtempSync(join(tmpdir(), "iknow-i384-"));
  const home = join(base, "home");
  const cwd = join(base, "cwd");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(join(cwd, ".iknow"), { recursive: true });
  return {
    base,
    cwd,
    home,
    settingsFile: join(home, ".iknow", "settings.json"),
  };
}

function writeSettings(dirs: Dirs, model: string, apiKey: string): void {
  // baseUrl 不写进 settings（parseLlm 会丢弃非 llm 合法字段）—— 经 env
  // IKNOW_LLM_BASE_URL 注入（env.ts SSOT：baseUrl 仍走 env 链路）。
  writeFileSync(
    dirs.settingsFile,
    JSON.stringify({ llm: { model, apiKey } }) + "\n",
    "utf8"
  );
}

/** 设置 IKNOW_LLM_BASE_URL → capture origin（loadIknowEnv 读取）。返回 restore。 */
function withBaseUrl(origin: string): () => void {
  const prev = process.env.IKNOW_LLM_BASE_URL;
  process.env.IKNOW_LLM_BASE_URL = origin;
  return () => {
    if (prev === undefined) delete process.env.IKNOW_LLM_BASE_URL;
    else process.env.IKNOW_LLM_BASE_URL = prev;
  };
}

/**
 * 固定 IKNOW_LLM_STREAM=off：capture server 回单 JSON（非 SSE），流式臂
 * （client.messages.stream）会因「无 chunk」报 request ended；非流式臂
 * （messages.create）正常解释单 JSON。hot-reload 语义与 stream 臂无关，
 * 故 smoke 统一走非流式臂（与测试 capture 同款）。
 */
function forceNonStreaming(): () => void {
  const prev = process.env.IKNOW_LLM_STREAM;
  process.env.IKNOW_LLM_STREAM = "off";
  return () => {
    if (prev === undefined) delete process.env.IKNOW_LLM_STREAM;
    else process.env.IKNOW_LLM_STREAM = prev;
  };
}

/** A 组：chat 形态 SessionHub + EnvLoader → 改 model → 下一轮 wire model 变化。 */
async function groupA(dirs: Dirs): Promise<void> {
  const cap = await startCapture();
  const restoreBase = withBaseUrl(cap.origin);
  try {
    writeSettings(dirs, "model-a", "test-key");
    const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
    // T1 (session-folder-consolidation):store 命名空间按 projectIdentityRoot
    // 分组,不是 cwd。身份根取本组自己的项目根 dirs.cwd(makeDirs 造的「空项目
    // 根」,与 createEnvLoader 的 cwd 同源),不用 process.cwd()。
    const store = new SessionStore(
      dirs.base,
      deriveProjectIdentityRoot({ cwd: dirs.cwd })
    );
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      envProvider: () => loader.get(),
    });
    try {
      // 订阅 EnvLoader → hub 热重建（与 run.tsx T4 同链路：env 变化 →
      // reload env → hub.reloadFromEnv 换 adapter）。
      loader.subscribe(() => {
        void hub.reloadFromEnv().catch(() => {
          // 兜底：adapter 保持旧引用（reload 失败降级）。
        });
      });
      const id = (await hub.createSession()).session.conversation_id;
      // 首轮：envProvider（model-a）→ capture wire model-a。
      await hub.postMessage({ conversationId: id, text: "hi" });
      record(
        "A1 首轮 wire model === model-a",
        cap.bodies.length === 1,
        `bodies=${cap.bodies.length}`
      );
      if (cap.bodies[0]) {
        const m = (cap.bodies[0] as { model?: string }).model;
        record(
          "A2 首轮 wire model 值",
          m === "model-a",
          `wire=${JSON.stringify(m)}`
        );
      }
      // 改 settings.json → EnvLoader watcher 自动 reload。
      writeSettings(dirs, "model-b", "test-key");
      const reloaded = await waitForModel(loader, "model-b");
      record(
        "A3 watcher reload 生效",
        reloaded,
        `loader.model=${loader.get().llm.model}`
      );
      // 下一轮 postMessage → 新 adapter（model-b）→ wire model-b。
      await hub.postMessage({ conversationId: id, text: "hi again" });
      const m2 = (cap.bodies.at(-1) as { model?: string } | undefined)?.model;
      record(
        "A4 下一轮 wire model === model-b",
        m2 === "model-b",
        `wire=${JSON.stringify(m2)} bodies=${cap.bodies.length}`
      );
    } finally {
      loader.stop();
    }
  } finally {
    restoreBase();
    await cap.close();
  }
}

/** B 组：serve HTTP 形态 → 改 settings.json → 下一条 POST /messages wire model 变化。 */
async function groupB(dirs: Dirs): Promise<void> {
  const cap = await startCapture();
  const restoreBase = withBaseUrl(cap.origin);
  try {
    writeSettings(dirs, "model-serve-a", "test-key");
    const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
    // serve 路径：envProvider 经 hubOptions 注入（T3 铺路；不改 serve.ts）。
    // askUser 必须注入（SessionHub 构造守卫；serve 测试同款 createNoAskUser）。
    const { listening, hub } = await startSessionServe({
      dataDir: dirs.base,
      hubOptions: {
        askUser: createNoAskUser(),
        envProvider: () => loader.get(),
      },
    });
    // 订阅 EnvLoader → hub 热重建（与 A 组同链路）。
    loader.subscribe(() => {
      void hub.reloadFromEnv().catch(() => {
        // 兜底：adapter 保持旧引用。
      });
    });
    try {
      const origin = `http://127.0.0.1:${(listening.server.address() as AddressInfo).port}`;
      // 建会话 + 首轮 POST /messages（serve HTTP 前缀 /api/v1）。
      const createResp = await fetch(`${origin}/api/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      record("B0 建会话 200", createResp.ok, `status=${createResp.status}`);
      const sessionId = (
        (await createResp.json()) as { session: { conversation_id: string } }
      ).session.conversation_id;
      const post1 = await fetch(
        `${origin}/api/v1/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        }
      );
      record("B1 首轮 POST /messages 200", post1.ok, `status=${post1.status}`);
      if (cap.bodies[0]) {
        const m = (cap.bodies[0] as { model?: string }).model;
        record(
          "B2 首轮 wire model === model-serve-a",
          m === "model-serve-a",
          `wire=${JSON.stringify(m)}`
        );
      }
      // 改 settings.json → reload → 下一条 POST /messages wire model 变化。
      writeSettings(dirs, "model-serve-b", "test-key");
      const reloaded = await waitForModel(loader, "model-serve-b");
      record(
        "B3 serve watcher reload 生效",
        reloaded,
        `loader.model=${loader.get().llm.model}`
      );
      await hub.reloadFromEnv();
      const post2 = await fetch(
        `${origin}/api/v1/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi again" }),
        }
      );
      record(
        "B4 下一条 POST /messages 200",
        post2.ok,
        `status=${post2.status}`
      );
      const m2 = (cap.bodies.at(-1) as { model?: string } | undefined)?.model;
      record(
        "B5 下一条 wire model === model-serve-b",
        m2 === "model-serve-b",
        `wire=${JSON.stringify(m2)} bodies=${cap.bodies.length}`
      );
    } finally {
      await listening.close();
      loader.stop();
    }
  } finally {
    restoreBase();
    await cap.close();
  }
}

/** C 组：坏 JSON → 旧 env 保留（缓存引用不变，进程不崩）。 */
async function groupC(dirs: Dirs): Promise<void> {
  const cap = await startCapture();
  const restoreBase = withBaseUrl(cap.origin);
  try {
    writeSettings(dirs, "model-c1", "test-key");
    const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
    // 同 A 组：身份根 = dirs.cwd（本组自己的空项目根）。
    const store = new SessionStore(
      dirs.base,
      deriveProjectIdentityRoot({ cwd: dirs.cwd })
    );
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      envProvider: () => loader.get(),
    });
    try {
      loader.subscribe(() => {
        void hub.reloadFromEnv().catch(() => {
          // 兜底：adapter 保持旧引用。
        });
      });
      const id = (await hub.createSession()).session.conversation_id;
      await hub.postMessage({ conversationId: id, text: "hi" });
      const before = loader.get();
      record(
        "C1 初始 env model === model-c1",
        before.llm.model === "model-c1",
        `model=${before.llm.model}`
      );
      // 坏 JSON → EnvLoader reload 抛错 → 旧 env 保留。
      writeFileSync(dirs.settingsFile, "{ not-json", "utf8");
      await new Promise((r) => setTimeout(r, 1200));
      const after = loader.get();
      record(
        "C2 坏 JSON 后 env 引用不变（旧值保留）",
        after === before && after.llm.model === "model-c1",
        `sameRef=${after === before} model=${after.llm.model}`
      );
      // reloadFromEnv 不动 cachedDeps（process 不崩）。
      let reloadOk = true;
      try {
        await hub.reloadFromEnv();
      } catch {
        reloadOk = false;
      }
      record("C3 hub.reloadFromEnv 不抛错（cachedDeps 不动）", reloadOk);
      // 修复 JSON → reload 恢复。
      writeSettings(dirs, "model-c2", "test-key");
      const fixed = await waitForModel(loader, "model-c2");
      record(
        "C4 修复后 reload 恢复新 env",
        fixed,
        `model=${loader.get().llm.model}`
      );
    } finally {
      loader.stop();
    }
  } finally {
    restoreBase();
    await cap.close();
  }
}

async function main(): Promise<void> {
  assertHostLayerGuard();
  const restoreStream = forceNonStreaming();
  const dirs = makeDirs();
  try {
    await groupA(dirs);
    await groupB(dirs);
    await groupC(dirs);
  } finally {
    restoreStream();
    rmSync(dirs.base, { recursive: true, force: true });
  }
  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const allPass = passed === total;
  console.error(
    `i384 result=${allPass ? "pass" : "fail"} checks=${passed}/${total}`
  );
  // 显式 exit：serve / watcher 句柄在进程自然退出前不释放（MCP stdio 等），
  // smoke 完成后直接以结果码退出，避免挂起。
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
