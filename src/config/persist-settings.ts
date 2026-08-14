/**
 * settings.json 反向持久化 —— 运行时 /thinking /effort 面板 Esc 保存退出时
 * 把改动写回 settings.json（T1，纯函数 + 原子写）。
 *
 * 与 settings.ts 的单向读取（文件 → 运行时）相反，本模块是反向通道
 * （运行时 → 文件）。设计约束（plans/settings-bidirectional-persist.md）：
 *   - **merge 基于原始 raw JSON，不是解析后的 IknowSettings**：IknowSettings
 *     深 frozen 且丢弃非法字段，写回必须保留用户文件里的一切字段，只改
 *     `llm.thinking` / `llm.thinkingEffort` 两键（决策 4）。
 *   - **字段语义**：`llm.thinking` 仅 `"off" | "adaptive"`；
 *     `llm.thinkingEffort` 仅五档或 `null`（null = auto → 删除键，缺省 =
 *     自适应，与 env 缺省语义一致）。其它字段一律原样保留（决策 5/6）。
 *   - **原子写**：tmp 文件写入**同目录**后 rename 替换（原子）；tmp 在 rename
 *     前 chmod 0600（settings 含 apiKey，敏感）；父目录缺失 → mkdir -p。
 *   - **self-write 哨兵**：返回写入的完整 bytes 字符串（非解析对象），由
 *     EnvLoader（T2）按 sha256 内容哈希登记，watcher 命中时跳过 reload 防止
 *     写回回环。
 *   - **坏 JSON 起步**：对齐 settings.ts `readSettingsFile` 惯例 —— 文件
 *     不存在 / 坏 JSON → 从空对象合并后写回（不覆盖用户文件本身）。
 *
 * 只导出 plan T1 列出的四个 API，不暴露多余公共面。
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  THINKING_EFFORT_LEVELS,
  type IknowSettingsThinking,
  type IknowSettingsThinkingEffort,
} from "./settings.js";

/** settings.json 文件名（user / project 两处共用）。 */
const SETTINGS_FILENAME = "settings.json";

/**
 * thinking 面板可持久化 patch 值域。thinkingEffort 为 `null` 表示 auto 语义
 * （删除该键，不残留空串——空串在 settings schema 中无意义）。
 */
export interface ThinkingPersistPatch {
  thinking?: IknowSettingsThinking;
  thinkingEffort?: IknowSettingsThinkingEffort | null;
}

/** resolveThinkingSettingsPath 的注入选项（对齐 settings.ts LoadSettingsOpts）。 */
export interface ResolveSettingsPathOptions {
  /** 项目根，默认 process.cwd()（project 级 `<cwd>/.iknow/settings.json`）。 */
  cwd?: string;
  /** 用户 home，默认 os.homedir()（user 级 `<home>/.iknow/settings.json`）。 */
  home?: string;
}

/** 普通对象（raw JSON 的顶层 / llm 层只可能是这种；排除 null / 数组）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 读取单个 settings 文件并解析为普通对象（对齐 settings.ts readSettingsFile）：
 * 文件不存在 / 坏 JSON（SyntaxError）→ {}；顶层非普通对象 → {}。
 * JSON.parse 抛出的非 SyntaxError 异常（实测当前运行时不可达）→ 防御性重抛，
 * 避免静默吞掉非语法类解析失败。
 */
async function readSettingsRaw(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
  return isPlainObject(parsed) ? parsed : {};
}

/** thinking 值域校验：仅小写 "off" | "adaptive"（对齐 settings.ts 语义）。 */
function isValidThinking(v: unknown): v is IknowSettingsThinking {
  return v === "off" || v === "adaptive";
}

/** thinkingEffort 值域校验：仅小写五档（null 由调用方单独处理）。 */
function isValidThinkingEffort(v: unknown): v is IknowSettingsThinkingEffort {
  return (THINKING_EFFORT_LEVELS as readonly string[]).includes(
    typeof v === "string" ? v : ""
  );
}

/**
 * 合并 thinking patch 到 raw JSON（纯函数，无 fs）。
 *  - `llm` 缺失 → 创建；
 *  - `thinkingEffort: null` → 删除该键（auto 语义），不残留空串；
 *  - `llm` 非普通对象 → 以新对象覆盖（原非法 `llm` 值整体丢弃，仍只保留
 *    用户 patch 字段）；
 *  - 其它字段一律原样保留（apiKey / model / fallback / secrets 等绝不触碰）；
 *  - 非法 patch 值（thinking 非 off/adaptive、thinkingEffort 非五档且非
 *    null）→ 抛带明确消息的 TypeError（调用方边界，不静默丢弃）。
 */
export function mergeThinkingPatch(
  raw: Record<string, unknown>,
  patch: ThinkingPersistPatch
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  const nextLlm: Record<string, unknown> = isPlainObject(next.llm)
    ? { ...next.llm }
    : {};

  if (patch.thinking !== undefined) {
    if (!isValidThinking(patch.thinking)) {
      throw new TypeError(
        `illegal thinking patch value: ${JSON.stringify(patch.thinking)} (expected "off" | "adaptive")`
      );
    }
    nextLlm.thinking = patch.thinking;
  }

  if (patch.thinkingEffort !== undefined) {
    if (patch.thinkingEffort === null) {
      // auto 语义：缺省 = 自适应，settings schema 不接受空串，直接删键。
      delete nextLlm.thinkingEffort;
    } else if (isValidThinkingEffort(patch.thinkingEffort)) {
      nextLlm.thinkingEffort = patch.thinkingEffort;
    } else {
      throw new TypeError(
        `illegal thinkingEffort patch value: ${JSON.stringify(patch.thinkingEffort)} (expected one of ${THINKING_EFFORT_LEVELS.join(", ")} or null)`
      );
    }
  }

  next.llm = nextLlm;
  return next;
}

/**
 * 选择写回目标 settings 文件路径：
 * project 级 `<cwd>/.iknow/settings.json` 存在 → 其路径（project 本就覆盖
 * user，写 user 等于无效）；否则 user 级 `<home>/.iknow/settings.json`。
 * 与 settings.ts「project over user」merge 优先级一致。
 */
export function resolveThinkingSettingsPath(
  opts?: ResolveSettingsPathOptions
): string {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const projectFile = join(cwd, ".iknow", SETTINGS_FILENAME);
  return existsSync(projectFile)
    ? projectFile
    : join(home, ".iknow", SETTINGS_FILENAME);
}

/**
 * 把 thinking patch 持久化到指定 settings 文件（原子写）。
 * 读 raw JSON（文件不存在 / 坏 JSON → 空对象起步）→ 合并 patch → 写 tmp
 * （同目录，rename 前 chmod 0600）→ rename 原子替换。返回完整 bytes 字符串
 * 供 self-write 哨兵登记（T2 按内容哈希比对，不解析对象）。
 */
export async function persistThinkingChanges(
  filePath: string,
  patch: ThinkingPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  const merged = mergeThinkingPatch(raw, patch);
  const bytes = `${JSON.stringify(merged, null, 2)}\n`;
  const tmpPath = join(dirname(filePath), `.${SETTINGS_FILENAME}.tmp`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, bytes, { encoding: "utf8", flag: "w" });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, filePath);
  return { path: filePath, bytes };
}

/** sha256 hex —— self-write 哨兵的内容哈希（T2 markSelfWrite 比对用）。 */
export function hashSettingsContent(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
