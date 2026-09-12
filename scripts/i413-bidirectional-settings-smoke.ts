/**
 * i413 bidirectional-settings smoke — settings.json 双向持久化真值验证（T6）。
 *
 * 目的：在真实链路下验证「运行时 /thinking /effort 面板 Esc → 写回 settings.json」
 * 的反向通道（T1 persist-settings + T2 env-loader self-write 哨兵）端到端成立：
 *   写回正确 → 其它字段原样保留 → 自写不回环 → 外部改动仍热更新。
 *
 * 四组（每组独立 tmp，隔离互不串扰）：
 *   A. 写回正确性（ADR-0084 写回落对层）：user 级 settings.json（apiKey /
 *      model / fallback / secrets）→ persistThinkingChanges(thinking=adaptive,
 *      effort=high) → 读盘断言 thinking / thinkingEffort 写入 user 文件 +
 *      其它字段原样 + mode 0600 + 无 .tmp 残留；并断言 project 文件即便在场也
 *      不被创建 / 不被修改（用户层键只写用户文件）。
 *   B. self-write 不回环：起 EnvLoader（注入 tmp home/cwd）→ 写回 →
 *      markSelfWrite(path, bytes) → 真实文件写 + 哨兵命中路径 → 断言 subscriber
 *      不被调（env 引用不变，写回不回环）。
 *   C. 外部改动仍热更新：同 B 装配但不 markSelfWrite → 外部写不同内容 →
 *      等 debounce（100ms）+ fs 事件 settling → 断言 subscriber 被调（env 更新）。
 *   D. auto → thinkingEffort 键删除：user 级 {llm:{thinking:"off",
 *      thinkingEffort:"high"}} → persistThinkingChanges(thinking=adaptive,
 *      thinkingEffort=null) → 读盘断言 thinking=adaptive 且 thinkingEffort 键
 *      完全不存在。
 *
 * 纪律（对齐 i384）：
 *   - host-layer guard：读自身源码扫禁词 `src/interaction` / `src/agent-loop`
 *     / `web/` / `src/cli`，命中即 throw + exit 1。
 *   - 不 import host 层（src/cli / src/interaction / src/agent-loop / web/）；
 *     合法 import src/config（persist-settings / env-loader）。
 *   - 临时 tmp HOME / tmp CWD（隔离，绝不读/写真实 ~/.iknow settings）；
 *     mkdtempSync(join(tmpdir(), "iknow-bidir-"))；每组 finally rmSync。
 *   - 输出：每行 `[PASS]/[FAIL] <断言名>: <细节>`；末尾 `i413 result=...`；
 *     exit 0 = 全过，exit 1 = 任一失败。
 *   - 缺 key / 环境异常 → 显式记录 FAIL + 退出码 1（不静默）。
 *
 * 运行：`npm run probe:settings-bidir`（或 `tsx scripts/i413-bidirectional-settings-smoke.ts`）。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvLoader } from "../src/config/env-loader.js";
import {
  persistThinkingChanges,
  resolveThinkingSettingsPath,
} from "../src/config/persist-settings.js";

const __filename = fileURLToPath(import.meta.url);

/** host-layer guard：smoke 自身不得引用 host 层（interaction / agent-loop / web / cli）。 */
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
            `i413 smoke must stay in config layer only.`
        );
      }
    }
  }
}

/** 断言清单。 */
const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function record(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? "[PASS]" : "[FAIL]"} ${name}${detail ? `: ${detail}` : ""}`
  );
}

/** 等待 predicate 成立（轮询，超时兜底 —— 与测试 waitForEvents 同纪律）。 */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 5000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

interface Dirs {
  base: string;
  cwd: string;
  home: string;
}

/** 隔离 tmp HOME / tmp CWD（对齐 i384 makeDirs 纪律；调用方 finally rmSync）。 */
function makeDirs(): Dirs {
  const base = mkdtempSync(join(tmpdir(), "iknow-bidir-"));
  const home = join(base, "home");
  const cwd = join(base, "cwd");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(join(cwd, ".iknow"), { recursive: true });
  return { base, cwd, home };
}

/**
 * A 组：写回正确性 —— user 级含 apiKey/model/fallback/secrets 的 settings
 * 写回后 thinking 两键在 + 其它字段原样 + mode 0600 + 无 .tmp 残留；项目文件
 * 在场也不被触碰（ADR-0084：用户层键只写用户文件）。
 */
async function groupA(): Promise<void> {
  const dirs = makeDirs();
  try {
    const homeSettings = join(dirs.home, ".iknow", "settings.json");
    const projectSettings = join(dirs.cwd, ".iknow", "settings.json");
    writeFileSync(
      homeSettings,
      JSON.stringify({
        llm: {
          model: "claude-sonnet",
          apiKey: "sk-test-not-real",
          fallback: ["claude-haiku"],
          thinking: "off",
        },
        secrets: { enabled: true, patterns: ["token"] },
      }) + "\n",
      "utf8"
    );
    // 项目文件在场（含一个允许名单内段）—— 写回必须无视它。
    writeFileSync(
      projectSettings,
      JSON.stringify({ verify: { command: "npm test" } }) + "\n",
      "utf8"
    );
    const projectBefore = readFileSync(projectSettings, "utf8");
    // ADR-0084：thinking 是用户层键 → 目标恒为 user 级（project 在场不改变层）。
    const target = resolveThinkingSettingsPath({
      cwd: dirs.cwd,
      home: dirs.home,
    });
    record(
      "A1 目标 = user 级 settings（project 在场亦然）",
      target === homeSettings,
      target
    );
    await persistThinkingChanges(target, {
      thinking: "adaptive",
      thinkingEffort: "high",
    });

    const parsed = JSON.parse(readFileSync(target, "utf8")) as {
      llm: Record<string, unknown>;
      secrets: unknown;
    };
    record(
      "A2 llm.thinking 已写入",
      parsed.llm.thinking === "adaptive",
      `thinking=${JSON.stringify(parsed.llm.thinking)}`
    );
    record(
      "A3 llm.thinkingEffort 已写入",
      parsed.llm.thinkingEffort === "high",
      `thinkingEffort=${JSON.stringify(parsed.llm.thinkingEffort)}`
    );
    record(
      "A4 apiKey 原样保留",
      parsed.llm.apiKey === "sk-test-not-real",
      `apiKey=${JSON.stringify(parsed.llm.apiKey)}`
    );
    record(
      "A5 model 原样保留",
      parsed.llm.model === "claude-sonnet",
      `model=${JSON.stringify(parsed.llm.model)}`
    );
    record(
      "A6 fallback 原样保留",
      JSON.stringify(parsed.llm.fallback) === '["claude-haiku"]',
      `fallback=${JSON.stringify(parsed.llm.fallback)}`
    );
    record(
      "A7 secrets 原样保留",
      JSON.stringify(parsed.secrets) ===
        JSON.stringify({ enabled: true, patterns: ["token"] }),
      `secrets=${JSON.stringify(parsed.secrets)}`
    );

    const stat = statSync(target);
    const mode0600 =
      process.platform === "win32" || (stat.mode & 0o777) === 0o600;
    record(
      "A8 文件 mode 0600",
      mode0600,
      `mode=0o${(stat.mode & 0o777).toString(8)}`
    );
    const residual = readdirSync(dirname(target)).filter((e) =>
      e.endsWith(".tmp")
    );
    record(
      "A9 无 .tmp 残留",
      residual.length === 0,
      `residual=${JSON.stringify(residual)}`
    );
    // project 文件不因写回而改变（用户层键不落共享仓库）。
    const projectAfter = existsSync(projectSettings)
      ? readFileSync(projectSettings, "utf8")
      : "";
    record(
      "A10 project 级 settings 逐字节不变",
      projectAfter === projectBefore,
      `projectSettings=${projectSettings}`
    );
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
}

/**
 * B 组：self-write 不回环 —— 写回 + markSelfWrite → 哨兵命中 → subscriber 不被调。
 */
async function groupB(): Promise<void> {
  const dirs = makeDirs();
  try {
    // ADR-0084：llm 是用户层键 → 模型放 user 文件（project 文件的 llm 被丢弃）。
    const homeSettings = join(dirs.home, ".iknow", "settings.json");
    writeFileSync(
      homeSettings,
      JSON.stringify({ llm: { model: "m-b", apiKey: "k-b" } }) + "\n",
      "utf8"
    );
    const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
    let subscriberCalls = 0;
    loader.subscribe(() => {
      subscriberCalls++;
    });
    try {
      const before = loader.get();
      record(
        "B0 初始 env model === m-b",
        before.llm.model === "m-b",
        `model=${before.llm.model}`
      );
      // 生产路径：persist 写回 → markSelfWrite 登记 → watcher onChange 读到同
      // 内容 → 哨兵命中 → skip reload（subscriber 不动）。真实文件写 + 哨兵竞态同款。
      const { path, bytes } = await persistThinkingChanges(homeSettings, {
        thinking: "adaptive",
      });
      loader.markSelfWrite(path, bytes);
      const changed = await waitFor(() => subscriberCalls > 0, 2500);
      record(
        "B1 自写后 subscriber 未被调（不回环）",
        !changed,
        `subscriberCalls=${subscriberCalls}`
      );
      record(
        "B2 env 引用不变（无 reload）",
        loader.get() === before,
        `sameRef=${loader.get() === before}`
      );
    } finally {
      loader.stop();
    }
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
}

/**
 * C 组：外部改动仍热更新 —— 不 markSelfWrite → 外部写不同内容 → subscriber 被调。
 */
async function groupC(): Promise<void> {
  const dirs = makeDirs();
  try {
    // ADR-0084：llm 用户层键 → 外部改动也落在 user 文件（watcher 两文件都 watch）。
    const homeSettings = join(dirs.home, ".iknow", "settings.json");
    writeFileSync(
      homeSettings,
      JSON.stringify({ llm: { model: "m-c1", apiKey: "k-c" } }) + "\n",
      "utf8"
    );
    const loader = createEnvLoader({ cwd: dirs.cwd, home: dirs.home });
    let subscriberCalls = 0;
    loader.subscribe(() => {
      subscriberCalls++;
    });
    try {
      const before = loader.get();
      record(
        "C0 初始 env model === m-c1",
        before.llm.model === "m-c1",
        `model=${before.llm.model}`
      );
      // 外部改动：写不同内容，不登记 self-write → watcher 照常 reload。
      writeFileSync(
        homeSettings,
        JSON.stringify({ llm: { model: "m-c2", apiKey: "k-c" } }) + "\n",
        "utf8"
      );
      // settings-watch debounce 100ms + fs 事件 settling → 等 subscriber 被调且
      // env 引用变化（轮询，超时兜底 —— 与测试 waitForEvents 同纪律）。
      const changed = await waitFor(() => subscriberCalls > 0, 5000);
      record(
        "C1 外部改动后 subscriber 被调",
        changed,
        `subscriberCalls=${subscriberCalls}`
      );
      const now = loader.get();
      record(
        "C2 env 引用变化 + model 更新",
        now !== before && now.llm.model === "m-c2",
        `sameRef=${now === before} model=${now.llm.model}`
      );
    } finally {
      loader.stop();
    }
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
}

/**
 * D 组：auto → thinkingEffort 键删除 —— thinkingEffort:null 写回后键完全不存在。
 */
async function groupD(): Promise<void> {
  const dirs = makeDirs();
  try {
    const homeSettings = join(dirs.home, ".iknow", "settings.json");
    writeFileSync(
      homeSettings,
      JSON.stringify({ llm: { thinking: "off", thinkingEffort: "high" } }) +
        "\n",
      "utf8"
    );
    // ADR-0084：目标恒为 user 级 settings。
    const target = resolveThinkingSettingsPath({
      cwd: dirs.cwd,
      home: dirs.home,
    });
    record("D0 目标 = user 级 settings", target === homeSettings, target);
    await persistThinkingChanges(target, {
      thinking: "adaptive",
      thinkingEffort: null,
    });
    const parsed = JSON.parse(readFileSync(target, "utf8")) as {
      llm: Record<string, unknown>;
    };
    record(
      "D1 llm.thinking === adaptive",
      parsed.llm.thinking === "adaptive",
      `thinking=${JSON.stringify(parsed.llm.thinking)}`
    );
    const absent =
      !Object.prototype.hasOwnProperty.call(parsed.llm, "thinkingEffort") &&
      parsed.llm.thinkingEffort === undefined;
    record(
      "D2 thinkingEffort 键不存在（非 undefined 残留）",
      absent,
      `hasKey=${Object.prototype.hasOwnProperty.call(parsed.llm, "thinkingEffort")} value=${JSON.stringify(parsed.llm.thinkingEffort)}`
    );
  } finally {
    rmSync(dirs.base, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  assertHostLayerGuard();
  await groupA();
  await groupB();
  await groupC();
  await groupD();
  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const allPass = passed === total;
  console.error(
    `i413 result=${allPass ? "pass" : "fail"} checks=${passed}/${total}`
  );
  // 显式 exit：watcher / fs 句柄在进程自然退出前不释放，smoke 完成后直接以
  // 结果码退出，避免挂起（对齐 i384 main 同款纪律）。
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
