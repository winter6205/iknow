/**
 * IKNOW-196 identity assembly smoke (#196 SC 37)。
 * 对齐 i9 / i10 / i11 命名惯例（scripts/i<N>-<feature>-smoke.ts）。
 * 6 条断言:identity 注入 / soul 注入 / user.md 存在 / BOOTSTRAP 首启 /
 * state.json 写入 / 二次启动跳过 BOOTSTRAP。
 *
 * 运行: `npx tsx scripts/i12-identity-assembly-smoke.ts`
 * 退出码: 0 = 全过, 1 = 失败。
 */
import {
  initializeIknowWorkspace,
  readIknowState,
  writeIknowState,
  iknowWorkspaceRoot,
} from "../src/harness/identity/index.js";
import { buildHarnessEngine } from "../src/harness/build-engine.js";
import { createNoAskUser } from "../src/harness/permission/ask-user.js";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    fails.push(label + (detail ? `: ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  // 用临时 HOME 隔离 ~/.iknow 测试,避免污染真实 home。
  const workDir = await mkdtemp(join(tmpdir(), "i12-smoke-"));
  const origHome = process.env.HOME;
  process.env.HOME = workDir;
  const fakeHome = workDir;
  // 让 buildHarnessEngine 用 fakeHome 装配 system(用 sandboxRoot 隔离 cwd)。
  const fakeCwd = workDir;

  function makeEnv(apiKey: string) {
    return {
      llm: {
        baseUrl: "http://127.0.0.1:9999",
        model: "test-model",
        apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
        apiKey,
        maxOutputTokens: 1024,
        timeoutMs: 60_000,
        temperature: 0,
        thinking: "off" as const,
        thinkingEffort: "" as const,
        stream: "on" as const,
      },
      chat: { showThinking: false },
      web: { searchUrl: undefined },
    };
  }

  try {
    console.log("[i12-smoke] workspace:", fakeHome);
    // ── 1. 首次 buildHarnessEngine(surface=chat) → init + 装配 ───────────
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-smoke-1"),
      askUser: createNoAskUser(),
      sandboxRoot: fakeCwd,
      surface: "chat",
    });

    // ── 2. 6 条断言 ────────────────────────────────────────────────────
    const sys = await deps.system!();
    assert("identity 段注入", sys!.includes("iknow Identity"));
    assert("soul 段注入", sys!.includes("iknow Soul"));

    const userPath = join(iknowWorkspaceRoot(), "user.md");
    let userExists = false;
    try {
      const s = await stat(userPath);
      userExists = s.isFile();
    } catch {
      userExists = false;
    }
    assert("user.md 存在", userExists);

    assert(
      "BOOTSTRAP 首启触发",
      sys!.toLowerCase().includes("bootstrap"),
      "expected bootstrap segment on first launch"
    );

    const statePath = join(iknowWorkspaceRoot(), "state.json");
    const state = await readIknowState();
    assert(
      "state.json 写入 (bootstrap_seeded: false)",
      state.bootstrap_seeded === false && state.schema_version === 1,
      `actual=${JSON.stringify(state)}`
    );

    // ── 3. 二次启动：write bootstrap_seeded=true → BOOTSTRAP 跳过 ──────────
    await writeIknowState({ bootstrap_seeded: true });
    // 重建 engine 让 system resolver 用新 state
    const { deps: deps2 } = await buildHarnessEngine({
      env: makeEnv("sk-smoke-2"),
      askUser: createNoAskUser(),
      sandboxRoot: fakeCwd,
      surface: "chat",
    });
    const sys2 = await deps2.system!();
    assert(
      "二次启动跳过 BOOTSTRAP",
      !sys2!.toLowerCase().includes("bootstrap"),
      "expected bootstrap segment to be skipped after bootstrap_seeded=true"
    );

    // ── 4. 报告 ────────────────────────────────────────────────────────
    console.log(`\n[i12-smoke] ${pass}/${pass + fail} 断言通过`);
    if (fail > 0) {
      console.error(`[i12-smoke] 失败:`);
      for (const f of fails) console.error(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log(`[i12-smoke] ✓ smoke 全过`);
    }
  } catch (err) {
    console.error(`[i12-smoke] uncaught error:`, err);
    process.exitCode = 1;
  } finally {
    process.env.HOME = origHome;
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
