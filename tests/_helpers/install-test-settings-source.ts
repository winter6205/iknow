/**
 * Phase 1 settings-model-extension：为 serve-path 测试提供隔离 settings.json 来源。
 *
 * 背景（#164 第二阶段）：
 *  `IKNOW_LLM_MODEL` 已退役，模型唯一来源 = `settings.llm.model`。serve 组合根
 *  （`startSessionServe` → `loadIknowEnv` / `hub.ensureDeps` → `buildHarnessEngine`）
 *  在不注入 settings 时走 settings 文件解析，cwd 为 vitest 进程 cwd（worktree
 *  根），且 worktree `.iknow/` 不含 settings.json —— 会触发 fail-fast。
 *
 *  本 helper 把 HOME 重定向到 fork-local tmp，并在 `.iknow/settings.json` 写
 *  `{ llm: { model, apiKey: "${VAR}" } }` + 设置 `process.env[VAR] = "test-key"`，让
 *  serve-path 测试：
 *  - 有 model 来源（settings 链），不再依赖已退役 env var；
 *  - 有 apiKey 来源（占位符解析），与生产 settings.json（`${ANTHROPIC_AUTH_TOKEN}`）
 *    同一形态；
 *  - 不污染真实 `~/.iknow`，不依赖真实 `ANTHROPIC_AUTH_TOKEN` 是否存在。
 *
 * 每个 vitest fork 进程各建独立 tmp home（pool: forks，每文件一 fork）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestSettingsSource {
  readonly home: string;
  /** settings.llm.apiKey 占位符指向的变量名（已被设值 "test-key"）。 */
  readonly apiKeyVar: string;
  readonly model: string;
  /** 恢复 process.env.HOME / apiKeyVar 原值，并删除 tmp。 */
  restore(): void;
}

export interface InstallTestSettingsOpts {
  /** settings.llm.model 字面值（默认 "test-model"）。 */
  model?: string;
  /** settings.llm.apiKey `${VAR}` 指向的变量名（默认 "IKNOW_TEST_API_KEY"）。 */
  apiKeyVar?: string;
  /** 注入 apiKeyVar 的值（默认 "test-key"）。 */
  apiKeyValue?: string;
}

export function installTestSettingsSource(
  opts: InstallTestSettingsOpts = {}
): TestSettingsSource {
  const apiKeyVar = opts.apiKeyVar ?? "IKNOW_TEST_API_KEY";
  const apiKeyValue = opts.apiKeyValue ?? "test-key";
  const model = opts.model ?? "test-model";

  const prevHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "iknow-settings-source-"));
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify({
      llm: { model, apiKey: "${" + apiKeyVar + "}" },
    }) + "\n",
    "utf8"
  );
  const prevKey = process.env[apiKeyVar];
  process.env[apiKeyVar] = apiKeyValue;
  process.env.HOME = home;
  return {
    home,
    apiKeyVar,
    model,
    restore() {
      if (prevKey === undefined) delete process.env[apiKeyVar];
      else process.env[apiKeyVar] = prevKey;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
