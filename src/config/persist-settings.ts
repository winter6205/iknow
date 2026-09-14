/**
 * settings.json 反向持久化 —— 运行时 /thinking /effort /memory 面板 Esc
 * 保存退出时把改动写回 settings.json（纯函数 + 原子写）。
 *
 * 与 settings.ts 的单向读取（文件 → 运行时）相反，本模块是反向通道
 * （运行时 → 文件）。设计约束（plans/settings-bidirectional-persist.md）：
 *   - **merge 基于原始 raw JSON，不是解析后的 IknowSettings**：IknowSettings
 *     深 frozen 且丢弃非法字段，写回必须保留用户文件里的一切字段。thinking
 *     只改 `llm.thinking` / `llm.thinkingEffort`；memory 只改 `memory.autoExtract`
 *     / `memory.dream`；model 只改 `llm.model`。
 *   - **字段语义**：`llm.thinking` 仅 `"off" | "adaptive"`；
 *     `llm.thinkingEffort` 仅五档或 `null`（null = auto → 删除键，缺省 =
 *     自适应，与 env 缺省语义一致）。`memory.autoExtract` / `dream` 仅
 *     boolean；关 autoExtract 时 dream 强制 false。其它字段一律原样保留。
 *   - **原子写**：tmp 文件写入**同目录**后 rename 替换（原子）；tmp 在 rename
 *     前 chmod 0600（settings 含 apiKey，敏感）；父目录缺失 → mkdir -p。
 *     tmp 文件名 per-invocation 唯一（randomUUID 后缀）—— 并行双写同一文件
 *     时两个调用各写各自 tmp，rename 原子交换保证无双写踩踏（
 *     plans/workspace-root-launch.md T3 acceptance #2 concurrent 边界类）。
 *   - **self-write 哨兵**：返回写入的完整 bytes 字符串（非解析对象），由
 *     EnvLoader（T2）按 sha256 内容哈希登记，watcher 命中时跳过 reload 防止
 *     写回回环。
 *   - **坏 JSON 起步**：对齐 settings.ts `readSettingsFile` 惯例 —— 文件
 *     不存在 / 坏 JSON → 从空对象合并后写回（不覆盖用户文件本身）。
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  THINKING_EFFORT_LEVELS,
  isFsIsolationMode,
  type FsIsolationMode,
  type IknowSettingsThinking,
  type IknowSettingsThinkingEffort,
} from "./settings.js";

/**
 * settings.json 文件名。仅与 `<home>/.iknow/` 拼接（见
 * `resolveThinkingSettingsPath`）：ADR-0084 起写回恒落用户层，不写项目层。
 */
const SETTINGS_FILENAME = "settings.json";

/**
 * thinking 面板可持久化 patch 值域。thinkingEffort 为 `null` 表示 auto 语义
 * （删除该键，不残留空串——空串在 settings schema 中无意义）。
 */
export interface ThinkingPersistPatch {
  thinking?: IknowSettingsThinking;
  thinkingEffort?: IknowSettingsThinkingEffort | null;
}

/** /memory 面板可持久化 patch。关 autoExtract 时 merge 层强制 dream=false。 */
export interface MemoryPersistPatch {
  autoExtract: boolean;
  dream: boolean;
}

/**
 * /model picker 可持久化 patch：只改 `llm.model`（模型路由 ID 形如
 * `"<provider>/<model>"`）。provider 段门禁（SC6：未知 provider 抛 TypeError）
 * 见 `mergeModelPatch`。
 */
export interface ModelPersistPatch {
  model: string;
}

/**
 * resolveThinkingSettingsPath 的注入选项（ADR-0084 写回落对层）。
 *
 * ADR-0084：thinking / memory 是**用户层键**（`llm` / `memory` 段），项目文件
 * 不再采纳这两段（项目允许名单 = hooks / verify / secrets / permissions）。
 * 因此写回目标恒为用户层文件 `<home>/.iknow/settings.json`，与「项目文件是否
 * 存在」解耦 —— 旧 ADR-0019 D1.3 的「project 存在写 project」在允许名单下会把
 * 用户层键写进一个不再被读取的项目文件（静默无效 + 污染共享仓库），故退役。
 */
export interface ResolveSettingsPathOptions {
  /**
   * 用户 home（global config anchor，ADR-0015/0019）。写回目标 =
   * `<home>/.iknow/settings.json`；缺省 `homedir()`（与 `loadIknowSettings`
   * 的 user 层解析同一 SSOT，读侧写侧同源）。测试注入 tmp home 隔离真实
   * 用户目录。
   */
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

export function mergeMemoryPatch(
  raw: Record<string, unknown>,
  patch: MemoryPersistPatch
): Record<string, unknown> {
  if (typeof patch.autoExtract !== "boolean") {
    throw new TypeError(
      `illegal autoExtract patch value: ${JSON.stringify(patch.autoExtract)} (expected boolean)`
    );
  }
  if (typeof patch.dream !== "boolean") {
    throw new TypeError(
      `illegal dream patch value: ${JSON.stringify(patch.dream)} (expected boolean)`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextMem: Record<string, unknown> = isPlainObject(next.memory)
    ? { ...next.memory }
    : {};
  nextMem.autoExtract = patch.autoExtract;
  nextMem.dream = patch.autoExtract ? patch.dream : false;
  next.memory = nextMem;
  return next;
}

/**
 * ADR-0092 / SC13：fsMode 反向持久化 patch。值域 `"global" | "workspace"`，
 * 与 `settings.isolation.fsMode` 解析端共用 `isFsIsolationMode` 闭集。
 */
export interface FsModePersistPatch {
  fsMode: FsIsolationMode;
}

/**
 * 合并 fsMode patch 到 raw JSON（纯函数，无 fs）。
 *  - `isolation` 缺失 → 创建；
 *  - `isolation` 非普通对象 → 以新对象覆盖（原非法 `isolation` 值整体丢弃，
 *    仍只保留 patch 字段与已知 user-isolation 子键；但本函数**只**写
 *    `fsMode`，其它 isolation 子键不复刻——这是 drop-not-throw 形态的
 *    简化：以对象覆盖 isolation 段会丢掉 worktreeOnMutate 等并发键，故
 *    本实现走 `{ ...raw.isolation }` 浅拷贝再覆盖 fsMode 的形态）；
 *  - 非法 patch 值（fsMode 不在 `"global" | "workspace"` 闭集）→ 抛
 *    `TypeError`（调用方边界，不静默丢弃；与 `mergeThinkingPatch` 纪律一致）；
 *  - 其它顶层键（llm / memory / secrets 等）一律原样保留。
 *
 * 已知低效（不修，Spec 轴 review Low #3 已记录）：值未变时仍重写整个文件。
 * 收口点在调用方（TUI persist 闭包先比对 holder 现值再决定是否落盘），不在
 * 本纯函数 —— 本函数的返回 `bytes` 是 self-write 哨兵的哈希来源，短路返回
 * 未合并的 raw 会让该哨兵读到与实际落盘不符的内容。
 */
export function mergeFsModePatch(
  raw: Record<string, unknown>,
  patch: FsModePersistPatch
): Record<string, unknown> {
  if (!isFsIsolationMode(patch.fsMode)) {
    throw new TypeError(
      `illegal fsMode patch value: ${JSON.stringify(patch.fsMode)} (expected "global" | "workspace")`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextIso: Record<string, unknown> = isPlainObject(next.isolation)
    ? { ...next.isolation }
    : {};
  nextIso.fsMode = patch.fsMode;
  next.isolation = nextIso;
  return next;
}

/**
 * 读取 raw `llm.providers` 登记的 provider id 集合（SC6 门禁数据源）。
 * 沿 settings.ts `parseLlmProvider` 同款纪律：仅「普通对象且 `.id` 为 trim 后
 * 非空字符串」的项计入；`providers` 缺失 / 非数组 / 项非法 → 不计入（该
 * provider 视为未知，由调用方抛错，不静默放行）。
 */
function collectProviderIds(rawLlm: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isPlainObject(rawLlm)) return ids;
  const providers = rawLlm.providers;
  if (!Array.isArray(providers)) return ids;
  for (const p of providers) {
    if (
      isPlainObject(p) &&
      typeof p.id === "string" &&
      p.id.trim().length > 0
    ) {
      ids.add(p.id.trim());
    }
  }
  return ids;
}

/**
 * 合并 model patch 到 raw JSON（纯函数，无 fs），只改 `llm.model`。
 *
 * 值域门禁（SC6：任一不满足 → 抛带具体非法值与期望形态的 TypeError，由调用方
 * 边界 catch 后走 notice；不静默丢弃、不静默写入）：
 *   - `patch.model` 非字符串 / trim 后为空；
 *   - 不含 "/"（模型路由 ID 形如 `"<provider>/<model>"`）；
 *   - 按**第一个** "/" 拆出的 provider / model 段 trim 后任一为空
 *     （如 `"/foo"`、`"foo/"`）；
 *   - provider 段不在 **raw** `llm.providers`（数组，逐项 `.id`）里 —— 未知
 *     provider 不落盘：写进去只会落到 env 层 fallback 路径，与用户所选不符。
 *
 * 通过后：`llm` 非普通对象 → 以新对象覆盖（同 mergeThinkingPatch）；`llm` 其余
 * 字段与其它顶层段（apiKey / thinking / memory / isolation / permissions /
 * providers …）一律原样保留。写回值 = patch.model 的 trim 结果（与 settings.ts
 * `parseLlm` 对 model 的 trim 纪律一致）。
 */
export function mergeModelPatch(
  raw: Record<string, unknown>,
  patch: ModelPersistPatch
): Record<string, unknown> {
  const rawValue = patch.model;
  const expected = 'expected "<provider>/<model>"';
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new TypeError(
      `illegal model patch value: ${JSON.stringify(rawValue)} (${expected})`
    );
  }
  const model = rawValue.trim();
  const slash = model.indexOf("/");
  const providerId = slash < 0 ? "" : model.slice(0, slash).trim();
  const modelId = slash < 0 ? "" : model.slice(slash + 1).trim();
  if (slash < 0 || providerId.length === 0 || modelId.length === 0) {
    throw new TypeError(
      `illegal model patch value: ${JSON.stringify(rawValue)} (${expected}, with non-empty provider and model segments)`
    );
  }
  if (!collectProviderIds(raw.llm).has(providerId)) {
    throw new TypeError(
      `unknown provider in model patch value: ${JSON.stringify(rawValue)} (provider ${JSON.stringify(providerId)} not in llm.providers)`
    );
  }
  const next: Record<string, unknown> = { ...raw };
  const nextLlm: Record<string, unknown> = isPlainObject(next.llm)
    ? { ...next.llm }
    : {};
  nextLlm.model = model;
  next.llm = nextLlm;
  return next;
}

/**
 * 选择写回目标 settings 文件路径（ADR-0084 写回落对层）：
 *  - thinking / memory 是**用户层键**（`llm` / `memory` 段）→ 目标恒为
 *    `<home>/.iknow/settings.json`；`home` 缺省 `homedir()`（与
 *    `loadIknowSettings` 同一解析）。
 *  - **不看** project 文件是否存在 —— 项目文件已不采纳 `llm` / `memory`
 *    （ADR-0084 允许名单），写进去等于静默无效并污染共享仓库。旧 ADR-0019
 *    D1.3 的「project 存在 → project 路径 / 否则 workspaceRoot 路径」两档
 *    （含 `existsSync` 探测）整体退役。
 *  - 目标目录不存在时由 `persistThinkingChanges` 内部 `mkdir -p` 兜底。
 */
export function resolveThinkingSettingsPath(
  opts?: ResolveSettingsPathOptions
): string {
  const home = opts?.home ?? homedir();
  return join(home, ".iknow", SETTINGS_FILENAME);
}

async function persistMergedSettings(
  filePath: string,
  merged: Record<string, unknown>
): Promise<{ path: string; bytes: string }> {
  const bytes = `${JSON.stringify(merged, null, 2)}\n`;
  const tmpPath = join(
    dirname(filePath),
    `.${SETTINGS_FILENAME}.${randomUUID()}.tmp`
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, bytes, { encoding: "utf8", flag: "w" });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, filePath);
  return { path: filePath, bytes };
}

/**
 * 把 thinking patch 持久化到指定 settings 文件（原子写）。
 * 读 raw JSON（文件不存在 / 坏 JSON → 空对象起步）→ 合并 patch → 写 tmp
 * （同目录，rename 前 chmod 0600）→ rename 原子替换。tmp 文件名 per-
 * invocation 唯一（`.settings.json.<uuid>.tmp`），并行双写同一文件时
 * 两个调用各自写各自 tmp，rename 原子替换目标文件，最终状态 = 某次完整
 * 写入的快照（无 half-written / 无 torn）。返回完整 bytes 字符串供
 * self-write 哨兵登记（T2 按内容哈希比对，不解析对象）。
 */
export async function persistThinkingChanges(
  filePath: string,
  patch: ThinkingPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeThinkingPatch(raw, patch));
}

export async function persistMemoryChanges(
  filePath: string,
  patch: MemoryPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeMemoryPatch(raw, patch));
}

/**
 * ADR-0092 / SC13：把 fsMode patch 持久化到 settings.json（原子写）。
 * 镜像 `persistMemoryChanges` 形态：读 raw JSON（坏 JSON / 文件缺失 → 空对象
 * 起步）→ 合并 patch → 写 tmp（同目录、rename 前 chmod 0600）→ rename 原子
 * 替换。返回完整 bytes 字符串供 self-write 哨兵登记（EnvLoader 按内容哈希
 * 比对，watcher 命中时跳过 reload 防回环）。
 *
 * 非法 fsMode 值由 `mergeFsModePatch` 抛 `TypeError`，写回未发生，原文件
 * 原样保留（不静默吞、不双写）。
 */
export async function persistFsModeChanges(
  filePath: string,
  patch: FsModePersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeFsModePatch(raw, patch));
}

/**
 * 把 model patch 持久化到指定 settings 文件（原子写，复用 persistMergedSettings）。
 * 读 raw JSON（文件不存在 / 坏 JSON → 空对象起步）→ mergeModelPatch → 同目录
 * tmp + chmod 0600 + rename。非法 model / 未知 provider → merge 抛 TypeError，
 * 文件不被触碰。返回完整 bytes 字符串供 self-write 哨兵登记（与 thinking /
 * memory 同款内容哈希契约）。
 */
export async function persistModelChanges(
  filePath: string,
  patch: ModelPersistPatch
): Promise<{ path: string; bytes: string }> {
  const raw = await readSettingsRaw(filePath);
  return persistMergedSettings(filePath, mergeModelPatch(raw, patch));
}

/** sha256 hex —— self-write 哨兵的内容哈希（T2 markSelfWrite 比对用）。 */
export function hashSettingsContent(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
