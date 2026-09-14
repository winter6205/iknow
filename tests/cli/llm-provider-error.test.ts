/**
 * ADR-0093 / spec SC4 —— CLI 侧 `LlmProviderConfigError` 渲染（typed-error
 * catch 契约，`.claude/rules/code-quality.md`）。
 *
 * `loadIknowEnv` 在 provider 命中但 `apiKeyEnv` 未设时抛的是**plain object**
 * （判别联合，不是 Error 实例）。CLI 两个 catch 点必须走
 * `isLlmProviderConfigError` 守卫 + `formatLlmProviderConfigError`，否则
 * `String(err)` 会打成 `[object Object]`，providerId / env 名全部不可见 ——
 * 与 `src/tui/run.tsx` 同 PR 已修的形态对齐。
 *
 * 观测手段（为什么走真实子进程）：`printCliError` / `printChatError` 是
 * cli.ts 的模块私有函数，而 cli.ts 顶层会自跑 `main()`（无法 import 单测，
 * 同 tests/cli/trace-default-mode.test.ts 的结论）。端到端跑真实 CLI 才是
 * 「用户实际看到的 stderr」这一承重面的黑盒证明：oneshot 走 `main().catch`
 * → `printCliError`，chat 的 `prepareRuntime` 抛出 → `printChatError`。
 *
 * 隔离：HOME 指向 scratch（settings.llm.model 命中 `acme` provider，其
 * apiKeyEnv 显式从子进程环境里删掉）→ `loadIknowEnv` 必抛；cwd 为空目录，
 * 不读真实项目 settings。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 与 tests/cli/trace-default-mode.test.ts 同款 tsx 定位（worktree node_modules）。 */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续向上
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();

const PROVIDER_ID = "acme";
const API_KEY_ENV = "IKNOW_PROVIDER_REVIEW_TEST_KEY";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-provider-error-"));
  const home = join(scratch, "home");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(join(scratch, "cwd"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify({
      llm: {
        // provider/model 形态命中注册表 → baseUrl/apiKey 走 provider 三元组。
        model: `${PROVIDER_ID}/foo`,
        providers: [
          {
            id: PROVIDER_ID,
            baseUrl: "http://127.0.0.1:41999/v1",
            apiKeyEnv: API_KEY_ENV,
            models: [{ id: "foo" }],
          },
        ],
      },
    })
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** 跑一次真实 CLI 子进程，返回 exit code + stderr。 */
function runCli(args: string[]): Promise<{ code: number | null; err: string }> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(scratch, "home"),
  };
  // 显式删掉 provider 的 env var —— 断言的就是「未设」这一档。
  delete childEnv[API_KEY_ENV];
  const child = spawn(
    process.execPath,
    [tsxCli, join(repoRoot, "src", "cli.ts"), ...args],
    {
      cwd: join(scratch, "cwd"),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let err = "";
  child.stderr.on("data", (d) => (err += String(d)));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, err }));
    child.on("error", () => resolve({ code: null, err }));
  });
}

describe("CLI 渲染 LlmProviderConfigError（SC4 / typed-error catch 契约）", () => {
  it("ask（printCliError 路径）→ stderr 含 providerId + env 名，不含 [object Object]", async () => {
    const { code, err } = await runCli(["ask", "hi"]);
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    // 修复前：String(plain object) → "[object Object]"，provider/env 全不可见。
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    assert.match(err, new RegExp(PROVIDER_ID));
    assert.match(err, new RegExp(API_KEY_ENV));
  });

  it("chat（printChatError 路径）→ stderr 含 providerId + env 名，不含 [object Object]", async () => {
    const { code, err } = await runCli(["chat"]);
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    assert.match(err, new RegExp(PROVIDER_ID));
    assert.match(err, new RegExp(API_KEY_ENV));
  });
});
