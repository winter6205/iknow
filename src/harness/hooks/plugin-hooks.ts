/**
 * src/harness/hooks/plugin-hooks.ts
 *
 * #global-plugins T2（plans/global-plugins-loading.md §5.2-§5.6 / §12 T2）——
 * 插件 `hooks/hooks.json` 作为第二文件源，编译成挂 Step 1 / Step 5 的
 * Pre/Post 命令钩子，经既有 `HookContribution` 接缝交给装配层
 * （build-engine / worker）。
 *
 * 职责：解析 → matcher 编译 → 子进程执行。数据面（发现 / 插件名 / 根路径）
 * 归 `plugin/`；本模块不 import `plugin/` 的运行时实现 —— 文件路径与插件名
 * 由装配层经 opts 传入（§4.1 单向依赖：hooks → plugin 只经装配层）。
 *
 * 契约（逐条对齐 design 条款）：
 *  - 文件格式（§5.1）：顶层 `{description?, hooks:{PreToolUse?:[], PostToolUse?:[]}}`；
 *    group = `{matcher?, hooks:[handler]}`；handler = `{type:"command", command,
 *    timeout?}`。只消费 PreToolUse / PostToolUse；未知事件名忽略 + 每文件一次
 *    warn；非 "command" type 忽略 + warn；timeout 秒，缺省 30，上限 600（超出
 *    截断 + warn）。非法 JSON / 缺 hooks 键 / 不可读 → 跳过该文件 + plugin-init。
 *    完全相同 (file, event, matcher, command) 的处理器去重（同一 hooks.json 可
 *    经多个根可达）。
 *  - matcher 求值（§5.3）：仅含 `[A-Za-z0-9_\- ,|]` → 精确备选匹配（`|` 或 `,`
 *    分隔，大小写敏感，去首尾空白）；含其他字符 → 非锚定 `RegExp.prototype.test`；
 *    缺席 / "" / "*" → 通配；非法正则 → 剔除该组 + warn（不毒化其他组）。
 *  - 工具名候选集（§5.3 表）：bash→{bash,Bash}、write_file→{write_file,Write}、
 *    edit_file→{edit_file,Edit,MultiEdit}、read_file→{read_file,Read}、
 *    grep→{grep,Grep}、glob→{glob,Glob}、skill→{skill,Skill}、
 *    spawn_subagent→{spawn_subagent,Task,Agent}，其余仅原名。`todo_write`
 *    **不**映射到 `Write`（账本工具非文件写，误映射会让写门禁误拦）。一组
 *    matcher 命中任一候选名即命中。
 *  - stdin envelope（§5.4）：`{hook_event_name, tool_name(=候选集首个，规范
 *    iknow 名), tool_input(别名视图), tool_response(Post), cwd}`；
 *    `session_id` 在 Pre/Post 缝上不可得 → 恒缺席（不编造）。
 *  - 退出码（§5.5）：exit 0 放行 / 观测；exit 2 = Pre 拦截（reason = stderr，
 *    优先解析 JSON 的 systemMessage / permissionDecisionReason，否则原文；
 *    stderr 空 → 试 stdout 同款；都空 → 通用 reason），Post 仅观测（stderr
 *    文本走诊断通道，**不改变工具结果**）；其他退出码 / spawn 失败 / 超时 /
 *    被杀 → fail-open（放行）+ plugin-exec 告警。
 *  - 命令执行（§5.6）：异步 `spawn`（node:child_process；`spawnSync` 会在 TUI
 *    下阻塞事件循环 —— 本路径绝不使用）、`shell:true`、cwd = taskRoot、stdin
 *    写 envelope 后关闭、timeout 秒 → 毫秒、stdout / stderr 各按字节截断
 *    1 MiB。命令串原样交 shell（重写会破坏插件语义）。
 *  - 占位符（品牌中立，后缀匹配）：`${*_PLUGIN_ROOT}` → 插件根；
 *    `${*_PLUGIN_DATA}` → `<userHome>/.iknow/plugin-data/<plugin>`（首引即建）；
 *    `${*_PROJECT_DIR}` → projectIdentityRoot；其余 `${VAR}` 取 opts.env，
 *    未定义 → ""。被替换的变量按命令串中的**原样名**导出进子进程 env（与
 *    继承的 base env 的 PATH 等并存）。
 *  - 先拦先赢（§5.7 组合语义）：matcher 组按文件序、组内 handler 按声明序，
 *    首个 block 短路返回。
 *
 * 依赖方向（bounded context）：hooks → permission（type-only）。HookErrorEvent
 * 是 permission-executor 的 typed 观测载荷（phase "plugin-init" / "plugin-exec"
 * 闭集成员）；HookContribution 是 hooks 自己的接缝（./index.js）。本模块零运行时
 * import plugin/ / skill/ / subagent/。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PostToolUseHook, PreToolUseHook } from "../permission/types.js";
import type { HookErrorEvent } from "../permission/permission-executor.js";
import type { HookContribution } from "./index.js";
import type { IknowSettingsHooks } from "../../config/settings.js";

/** hooks.json 绝对路径 + 所属插件名（plugin/catalog.ts `hooksEntries` 同形）。 */
export interface PluginHookFile {
  /** `<root>/hooks/hooks.json` 绝对路径。 */
  readonly file: string;
  /** 所属插件名 —— `${*_PLUGIN_ROOT}` / `${*_PLUGIN_DATA}` 的分母。 */
  readonly plugin: string;
}

/** createPluginHookContribution 的注入缝。 */
export interface CreatePluginHookContributionOpts {
  /** hooks.json 条目（来自插件 catalog；`{file, plugin}` 配对）。 */
  readonly files: readonly PluginHookFile[];
  /** 插件名 → 插件根（占位符替换；缺席时按 `file` 路径推导兜底）。 */
  readonly roots: ReadonlyMap<string, string>;
  /** `${*_PLUGIN_DATA}` 的基准 → `<userHome>/.iknow/plugin-data/<plugin>`。 */
  readonly userHome: string;
  /** `${*_PROJECT_DIR}` 的取值 → projectIdentityRoot。 */
  readonly projectDir: string;
  /** 子进程 cwd（design §5.6：taskRoot）。 */
  readonly cwd: string;
  /** `${VAR}` 的取值来源；缺省 process.env。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 人读降级消息通道；缺省 console.warn（onError 缺席时的兜底出口）。 */
  readonly warn?: (message: string) => void;
  /** typed 降级通道（permission-executor HookErrorEvent，phase plugin-*）。 */
  readonly onError?: (e: HookErrorEvent) => void;
}

/** 输出截断上限：stdout / stderr 各 1 MiB（design §5.6）。 */
export const PLUGIN_HOOK_OUTPUT_CAP_BYTES = 1024 * 1024;

/** timeout 缺省 30s（design §5.1）。 */
export const PLUGIN_HOOK_DEFAULT_TIMEOUT_SECONDS = 30;

/** timeout 声明上限 600s（超出截断；design §5.1）。 */
export const PLUGIN_HOOK_MAX_TIMEOUT_SECONDS = 600;

/**
 * 精确类 matcher 的字符集（design §5.3）：仅这些字符 → 备选精确匹配。
 * 其余字符（`.` / `*` / `(` / `^` …）→ 走正则分支。
 */
const EXACT_MATCHER_RE = /^[A-Za-z0-9_ ,|-]*$/;

/**
 * 工具名候选集（design §5.3 表）。键 = iknow 内部工具名（PreToolUseHook ctx
 * 给的 `tool`），值 = 对外可能的名称；`[0]` 恒为规范 iknow 名（envelope 的
 * `tool_name`）。表外工具 → 仅自身（不猜别名）。
 */
const TOOL_NAME_CANDIDATES: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ["bash", Object.freeze(["bash", "Bash"])],
  ["write_file", Object.freeze(["write_file", "Write"])],
  ["edit_file", Object.freeze(["edit_file", "Edit", "MultiEdit"])],
  ["read_file", Object.freeze(["read_file", "Read"])],
  ["grep", Object.freeze(["grep", "Grep"])],
  ["glob", Object.freeze(["glob", "Glob"])],
  ["skill", Object.freeze(["skill", "Skill"])],
  ["spawn_subagent", Object.freeze(["spawn_subagent", "Task", "Agent"])],
  // todo_write 刻意缺席：绝不映射到 Write（账本工具误映射会让写门禁误拦）。
]);

/**
 * 工具名候选集（纯函数，导出供测试与 matcher 断言）。返回冻结数组，
 * `[0]` = 规范 iknow 名。
 */
export function pluginHookToolNames(tool: string): readonly string[] {
  return TOOL_NAME_CANDIDATES.get(tool) ?? Object.freeze([tool]);
}

/** 编译后的 matcher 三态。 */
type CompiledMatcher =
  | { readonly kind: "wildcard" }
  | { readonly kind: "exact"; readonly names: readonly string[] }
  | { readonly kind: "regex"; readonly re: RegExp };

/**
 * 编译 matcher（§5.3 分流）。返回 `undefined` = 非法正则（调用方剔除该组 +
 * plugin-init 告警）。
 */
function compileMatcher(
  matcher: string | undefined
): CompiledMatcher | undefined {
  if (matcher === undefined || matcher === "" || matcher === "*") {
    return { kind: "wildcard" };
  }
  if (EXACT_MATCHER_RE.test(matcher)) {
    const names = matcher
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    // 纯分隔符 / 空白串（如 "|" 或 " "）→ 无有效备选，等同通配（声明了什么
    // 都不限，与缺席同形；不视为降级）。
    if (names.length === 0) return { kind: "wildcard" };
    return { kind: "exact", names: Object.freeze(names) };
  }
  try {
    return { kind: "regex", re: new RegExp(matcher) };
  } catch {
    return undefined;
  }
}

/**
 * matcher 求值（纯函数，导出供测试）：`toolNames` 任一命中即 true。
 * 非法正则 → false（构造期已剔除该组；此处只兜底，不告警 —— 纯函数无通道）。
 */
export function evaluatePluginHookMatcher(
  matcher: string | undefined,
  toolNames: readonly string[]
): boolean {
  const compiled = compileMatcher(matcher);
  if (compiled === undefined) return false;
  return matcherMatches(compiled, toolNames);
}

function matcherMatches(
  compiled: CompiledMatcher,
  toolNames: readonly string[]
): boolean {
  switch (compiled.kind) {
    case "wildcard":
      return true;
    case "exact":
      return compiled.names.some((name) => toolNames.includes(name));
    case "regex":
      // 非锚定（RegExp.prototype.test 语义）—— design §5.3 明示。
      return toolNames.some((name) => compiled.re.test(name));
  }
}

/**
 * timeout 归一（纯函数，导出供测试与断言）：非有限数值 / ≤0 → 缺省 30s；
 * 超出 600s → 截断到 600s；返回值单位 = 毫秒。
 */
export function pluginHookTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return PLUGIN_HOOK_DEFAULT_TIMEOUT_SECONDS * 1000;
  }
  const seconds = Math.min(raw, PLUGIN_HOOK_MAX_TIMEOUT_SECONDS);
  return Math.round(seconds * 1000);
}

/** 装配缝便利函数的安装事实（结构同 plugin/roots.ts PluginInstallation 的
 *  最小子集 —— 不 import plugin/，保持 hooks → plugin 的单向依赖经装配层）。 */
export interface PluginInstallationRef {
  readonly name: string;
  readonly root: string;
}

/**
 * 装配缝便利函数（build-engine 与 subagent/worker 共用，SSOT）：从 catalog 的
 * hooksEntries + 安装列表派生贡献。两处组装逻辑字节同款，写两遍迟早漂移。
 *
 * 恒返回 HookContribution（**不**返回 undefined）：`entries` 为空 → 空贡献
 * （pre/post 双缺席 = 「本源无声明」），与 createPluginHookContribution 对
 * 空 files 的处理同形。装配层因此直接读 `.pre` / `.post`（值为 undefined 时
 * 组合器按缺席槽跳过），无需每个装配点各写一遍判空。
 */
export function createPluginHooksFromCatalog(params: {
  readonly entries: readonly PluginHookFile[];
  readonly installations: ReadonlyArray<PluginInstallationRef>;
  readonly userHome: string;
  readonly projectDir: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  readonly onError?: (e: HookErrorEvent) => void;
}): HookContribution {
  return createPluginHookContribution({
    files: params.entries,
    // roots：插件名 → 根（占位符替换的分母）。
    roots: new Map(params.installations.map((p) => [p.name, p.root] as const)),
    userHome: params.userHome,
    projectDir: params.projectDir,
    cwd: params.cwd,
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.warn !== undefined ? { warn: params.warn } : {}),
    ...(params.onError !== undefined ? { onError: params.onError } : {}),
  });
}

/**
 * 用户 `settings.hooks`（Claude PreToolUse/PostToolUse map）→ 同一套命令钩子
 * 编译器。无组 → 空贡献。占位符里没有插件根（plugin 名固定 "user"）。
 */
export function createSettingsHookContribution(params: {
  readonly hooks: IknowSettingsHooks | undefined;
  readonly userHome: string;
  readonly projectDir: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly warn?: (message: string) => void;
  readonly onError?: (e: HookErrorEvent) => void;
}): HookContribution {
  const hooksRaw = settingsHooksAsMap(params.hooks);
  if (hooksRaw === undefined) return Object.freeze({});
  const opts: CreatePluginHookContributionOpts = {
    files: [],
    roots: new Map(),
    userHome: params.userHome,
    projectDir: params.projectDir,
    cwd: params.cwd,
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.warn !== undefined ? { warn: params.warn } : {}),
    ...(params.onError !== undefined ? { onError: params.onError } : {}),
  };
  const report = makeHookReport(opts);
  const compiled = compileHooksMap(
    {
      file: join(params.userHome, ".iknow", "settings.json"),
      plugin: "user",
    },
    hooksRaw,
    report,
    new Set()
  );
  return contributionFromCompiled(compiled, opts, report);
}

function settingsHooksAsMap(
  hooks: IknowSettingsHooks | undefined
): Record<string, unknown> | undefined {
  if (hooks === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (hooks.PreToolUse !== undefined) out.PreToolUse = hooks.PreToolUse;
  if (hooks.PostToolUse !== undefined) out.PostToolUse = hooks.PostToolUse;
  if (out.PreToolUse === undefined && out.PostToolUse === undefined) {
    return undefined;
  }
  return out;
}

// ─── 编译产物 ────────────────────────────────────────────────────────────────

interface CompiledHandler {
  readonly plugin: string;
  readonly command: string;
  readonly timeoutMs: number;
}

interface CompiledGroup {
  readonly matcher: CompiledMatcher;
  readonly handlers: ReadonlyArray<CompiledHandler>;
}

interface CompiledHooks {
  readonly pre: ReadonlyArray<CompiledGroup>;
  readonly post: ReadonlyArray<CompiledGroup>;
}

type HookEventName = "PreToolUse" | "PostToolUse";

const HOOK_EVENT_NAMES: ReadonlyArray<HookEventName> = Object.freeze([
  "PreToolUse",
  "PostToolUse",
]);

/**
 * 构造插件 hooks 贡献（HookContribution 第二刀，§5.2）。
 *
 * 构造期完成全部 IO 与编译（读文件 / 解析 / matcher 编译 / 去重），运行期
 * 只读冻结产物 → 并发安全。无任何可用 handler → 返回空对象（装配层据此
 * 保持「无插件的路径字节级不变」）。
 */
export function createPluginHookContribution(
  opts: CreatePluginHookContributionOpts
): HookContribution {
  // 无文件 → 空贡献，装配层无需自己判空（`{pre?, post?}` 双缺席 = 「本源无
  // 声明」，与传空 files 逐字节同形；也免去每个装配点各写一遍守卫）。
  if (opts.files.length === 0) return Object.freeze({});
  const report = makeHookReport(opts);
  const compiled = compileAllFiles(opts.files, report);
  return contributionFromCompiled(compiled, opts, report);
}

function makeHookReport(opts: CreatePluginHookContributionOpts): ReportFn {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  return (
    phase: "plugin-init" | "plugin-exec",
    message: string,
    tool?: string
  ): void => {
    if (opts.onError !== undefined) {
      opts.onError({ phase, message, ...(tool !== undefined ? { tool } : {}) });
      return;
    }
    warn(message);
  };
}

function contributionFromCompiled(
  compiled: CompiledHooks,
  opts: CreatePluginHookContributionOpts,
  report: ReportFn
): HookContribution {
  const runner = createCommandRunner({
    opts,
    report,
    createdDataDirs: new Set<string>(),
  });

  const contribution: HookContribution = {
    ...(compiled.pre.length > 0
      ? {
          pre: Object.freeze(async ({ tool, input }) => {
            const candidates = pluginHookToolNames(tool);
            for (const group of compiled.pre) {
              if (!matcherMatches(group.matcher, candidates)) continue;
              for (const handler of group.handlers) {
                const outcome = await runner.run({
                  event: "PreToolUse",
                  handler,
                  canonicalTool: tool,
                  candidates,
                  toolInput: input,
                });
                // 先拦先赢（§5.7）：首个 block 短路，后续组 / 处理器不再评估。
                if (outcome.kind === "block") return { reason: outcome.reason };
              }
            }
            return undefined;
          }) satisfies PreToolUseHook,
        }
      : {}),
    ...(compiled.post.length > 0
      ? {
          post: Object.freeze(async (result) => {
            // Post 契约：永不抛（design §5.5 —— 观测不改变结果）。
            try {
              const candidates = pluginHookToolNames(result.name);
              const response = projectToolResponse(result);
              for (const group of compiled.post) {
                if (!matcherMatches(group.matcher, candidates)) continue;
                for (const handler of group.handlers) {
                  await runner.run({
                    event: "PostToolUse",
                    handler,
                    canonicalTool: result.name,
                    candidates,
                    toolInput: result.input,
                    toolResponse: response,
                  });
                }
              }
            } catch (err) {
              // EXIT: Post 观测异常绝不冒泡改变工具结果（runAllowed /
              // violation-executor 同判据）；有 typed 通道则落 plugin-exec。
              report(
                "plugin-exec",
                `plugin hooks: PostToolUse observation failed: ${errorMessage(err)}`
              );
            }
          }) satisfies PostToolUseHook,
        }
      : {}),
  };
  return Object.freeze(contribution);
}

function projectToolResponse(result: {
  readonly message?: string;
  readonly payload?: unknown;
}): string {
  if (typeof result.message === "string") return result.message;
  try {
    const serialized = JSON.stringify(result.payload ?? {});
    return serialized ?? "{}";
  } catch {
    // EXIT: 不可序列化的 payload 不给 Post 观测端抛错（never-throw 契约）。
    return String(result.payload ?? "");
  }
}

// ─── 解析与编译 ──────────────────────────────────────────────────────────────

type ReportFn = (
  phase: "plugin-init" | "plugin-exec",
  message: string,
  tool?: string
) => void;

/**
 * 逐文件解析 + 编译。单文件任何降级只影响该文件（跳过 / 忽略该条），
 * 不影响其他文件（与 user-hooks.ts 的「坏 pattern 不毒化其他规则」同纪律）。
 */
function compileAllFiles(
  files: readonly PluginHookFile[],
  report: ReportFn
): CompiledHooks {
  const pre: CompiledGroup[] = [];
  const post: CompiledGroup[] = [];
  // 去重键含 file：同一 hooks.json 可经多个根可达（同 file 才会命中）。
  const seenHandlers = new Set<string>();

  for (const entry of files) {
    const groups = compileFile(entry, report, seenHandlers);
    pre.push(...groups.pre);
    post.push(...groups.post);
  }
  return Object.freeze({
    pre: Object.freeze(pre),
    post: Object.freeze(post),
  });
}

/** 跳过面共用的空产物 —— 新数组字面量而非共享可变数组（调用方 push 安全）。 */
function emptyCompiled(): { pre: CompiledGroup[]; post: CompiledGroup[] } {
  return { pre: [], post: [] };
}

/**
 * 读 + JSON 解析（跳过面全部收敛于此）：任一步失败 → report + undefined
 * （调用方跳过该文件）。返回 undefined 的三条路径都在 design §5.1 降级表内。
 */
function readHooksJson(
  entry: PluginHookFile,
  report: ReportFn
): Record<string, unknown> | undefined {
  const { file, plugin } = entry;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    // EXIT: hooks.json 不可读（存在性已由 catalog 检查，此处是竞态 / 权限）
    // → 跳过该文件，其他插件不受影响。
    report(
      "plugin-init",
      `plugin '${plugin}' hooks file unreadable: ${file}: ${errorMessage(err)} — skipped`
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // EXIT: JSON 损坏 → 整个文件 skip（design §5.1 降级面）。
    report(
      "plugin-init",
      `plugin '${plugin}' hooks JSON corrupt at ${file}: ${errorMessage(err)} — skipped`
    );
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks root is not an object at ${file} — skipped`
    );
    return undefined;
  }
  const hooksRaw = (parsed as { hooks?: unknown }).hooks;
  if (!isPlainObject(hooksRaw)) {
    // EXIT: 缺 hooks 键（含 hooks 非对象）→ 跳过该文件（design §5.1）。
    report(
      "plugin-init",
      `plugin '${plugin}' hooks file missing "hooks" object at ${file} — skipped`
    );
    return undefined;
  }
  return hooksRaw;
}

function compileFile(
  entry: PluginHookFile,
  report: ReportFn,
  seenHandlers: Set<string>
): { pre: CompiledGroup[]; post: CompiledGroup[] } {
  const hooksRaw = readHooksJson(entry, report);
  if (hooksRaw === undefined) return emptyCompiled();
  return compileHooksMap(entry, hooksRaw, report, seenHandlers);
}

/** 已解析的 Claude event map → CompiledHooks（settings 与 hooks.json 共用）。 */
function compileHooksMap(
  entry: PluginHookFile,
  hooksRaw: Record<string, unknown>,
  report: ReportFn,
  seenHandlers: Set<string>
): { pre: CompiledGroup[]; post: CompiledGroup[] } {
  const { file, plugin } = entry;
  const reportedInFile = new Set<string>();
  const reportOnce = (message: string): void => {
    if (reportedInFile.has(message)) return;
    reportedInFile.add(message);
    report("plugin-init", message);
  };

  const pre: CompiledGroup[] = [];
  const post: CompiledGroup[] = [];

  for (const [eventName, groupsRaw] of Object.entries(hooksRaw)) {
    if (!isHookEventName(eventName)) {
      // EXIT: 未知事件名（PreCompact / SessionStart / Stop 等）—— iknow 没有
      // 对应时机，忽略 + 每文件一次 warn（design §2 非目标）。
      reportOnce(
        `plugin '${plugin}' unknown hook event "${eventName}" ignored (${file})`
      );
      continue;
    }
    if (!Array.isArray(groupsRaw)) {
      // EXIT: 事件值非数组 → 忽略该事件（其余事件不受影响）。
      report(
        "plugin-init",
        `plugin '${plugin}' hooks.${eventName} is not an array at ${file} — ignored`
      );
      continue;
    }
    for (const groupRaw of groupsRaw) {
      const group = compileGroup({
        groupRaw,
        eventName,
        entry,
        report,
        reportOnce,
        seenHandlers,
      });
      if (group === undefined) continue;
      if (eventName === "PreToolUse") pre.push(group);
      else post.push(group);
    }
  }

  return { pre, post };
}

interface CompileContext {
  readonly eventName: HookEventName;
  readonly entry: PluginHookFile;
  readonly report: ReportFn;
  readonly reportOnce: (message: string) => void;
  readonly seenHandlers: Set<string>;
}

/** matcher 求值面：非对象 / 非字符串 / 非法正则 → report + undefined（丢组）。 */
function compileGroupMatcher(
  groupRaw: Record<string, unknown>,
  ctx: CompileContext
): CompiledMatcher | undefined {
  const { eventName, entry, report } = ctx;
  const { file, plugin } = entry;
  const matcherRaw = groupRaw.matcher;
  if (matcherRaw !== undefined && typeof matcherRaw !== "string") {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks.${eventName} matcher is not a string at ${file} — group dropped`
    );
    return undefined;
  }
  const matcherSource = matcherRaw as string | undefined;
  const matcher = compileMatcher(matcherSource);
  if (matcher === undefined) {
    // EXIT: 非法正则 → 剔除该组（不毒化其他组；design §5.3 / user-hooks 同纪律）。
    report(
      "plugin-init",
      `plugin '${plugin}' invalid matcher regex dropped (${file}): ${JSON.stringify(matcherSource)}`
    );
  }
  return matcher;
}

/** 单条 handler 编译；降级（非对象 / 非 command / 缺 command）返回 undefined。 */
function compileHandler(
  handlerRaw: unknown,
  ctx: CompileContext,
  matcherSource: string | undefined
): CompiledHandler | undefined {
  const { eventName, entry, report, reportOnce, seenHandlers } = ctx;
  const { file, plugin } = entry;
  if (!isPlainObject(handlerRaw)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hook entry is not an object at ${file} — ignored`
    );
    return undefined;
  }
  const type = (handlerRaw as { type?: unknown }).type;
  if (type !== "command") {
    // EXIT: 非 command 类型（webhook / prompt 等）不执行 + warn（§5.1）。
    reportOnce(
      `plugin '${plugin}' non-command hook type ignored (type=${JSON.stringify(type)}, ${file})`
    );
    return undefined;
  }
  const commandRaw = (handlerRaw as { command?: unknown }).command;
  if (typeof commandRaw !== "string" || commandRaw.trim().length === 0) {
    report(
      "plugin-init",
      `plugin '${plugin}' hook entry missing a command string at ${file} — ignored`
    );
    return undefined;
  }
  const timeoutRaw = (handlerRaw as { timeout?: unknown }).timeout;
  const timeoutMs = pluginHookTimeoutMs(timeoutRaw);
  if (
    typeof timeoutRaw === "number" &&
    timeoutRaw > PLUGIN_HOOK_MAX_TIMEOUT_SECONDS
  ) {
    // EXIT: 超上限 → 截断到 600s（不拒绝整条：超时上限是本地保护，不是
    // 插件声明的语义错误）。
    reportOnce(
      `plugin '${plugin}' hook timeout ${timeoutRaw}s exceeds max ${PLUGIN_HOOK_MAX_TIMEOUT_SECONDS}s — clamped (${file})`
    );
  }
  // 去重：完全相同的 (file, event, matcher, command) 只保留首个
  // （同一 hooks.json 可经多个根可达 → 装配层可能重复列出同一文件）。
  // JSON.stringify 组键：matcher / command 是自由文本，空格拼接会让
  // (matcher="a b", command="c") 与 (matcher="a", command="b c") 撞键。
  const dedupKey = JSON.stringify([
    file,
    eventName,
    matcherSource ?? null,
    commandRaw,
  ]);
  if (seenHandlers.has(dedupKey)) return undefined;
  seenHandlers.add(dedupKey);
  return Object.freeze({ plugin, command: commandRaw, timeoutMs });
}

function compileGroup(
  params: CompileContext & { readonly groupRaw: unknown }
): CompiledGroup | undefined {
  const ctx: CompileContext = params;
  const { groupRaw, eventName, entry, report } = params;
  const { file, plugin } = entry;
  if (!isPlainObject(groupRaw)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks.${eventName} group is not an object at ${file} — ignored`
    );
    return undefined;
  }
  const matcher = compileGroupMatcher(groupRaw, ctx);
  if (matcher === undefined) return undefined;
  const matcherSource = groupRaw.matcher as string | undefined;

  const handlersRaw = groupRaw.hooks;
  if (!Array.isArray(handlersRaw)) {
    report(
      "plugin-init",
      `plugin '${plugin}' hooks.${eventName} group has no hooks array at ${file} — ignored`
    );
    return undefined;
  }

  const handlers: CompiledHandler[] = [];
  for (const handlerRaw of handlersRaw) {
    const handler = compileHandler(handlerRaw, ctx, matcherSource);
    if (handler !== undefined) handlers.push(handler);
  }

  if (handlers.length === 0) return undefined;
  return Object.freeze({ matcher, handlers: Object.freeze(handlers) });
}

function isHookEventName(name: string): name is HookEventName {
  return name === HOOK_EVENT_NAMES[0] || name === HOOK_EVENT_NAMES[1];
}

// ─── 执行 ────────────────────────────────────────────────────────────────────

interface RunParams {
  readonly event: HookEventName;
  readonly handler: CompiledHandler;
  /** iknow 工具名（`pluginHookToolNames` 的输入，envelope 里取候选首项）。 */
  readonly canonicalTool: string;
  readonly candidates: readonly string[];
  readonly toolInput: unknown;
  readonly toolResponse?: string;
}

type RunOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "block"; readonly reason: string };

interface CommandRunner {
  readonly run: (params: RunParams) => Promise<RunOutcome>;
}

interface CreateCommandRunnerParams {
  readonly opts: CreatePluginHookContributionOpts;
  readonly report: ReportFn;
  /** `${*_PLUGIN_DATA}` 首引即建的幂等记录（每插件一次）。 */
  readonly createdDataDirs: Set<string>;
}

function createCommandRunner(params: CreateCommandRunnerParams): CommandRunner {
  const { opts, report, createdDataDirs } = params;
  const baseEnv = opts.env ?? process.env;

  return Object.freeze({
    run: async (run: RunParams): Promise<RunOutcome> => {
      const { handler, event } = run;
      const substituted = substituteCommand({
        command: handler.command,
        plugin: handler.plugin,
        opts,
        report,
        createdDataDirs,
      });
      const envelope = buildEnvelope(run, opts.cwd);
      const result = await runCommand({
        command: substituted.command,
        env: { ...baseEnv, ...substituted.exported },
        cwd: opts.cwd,
        timeoutMs: handler.timeoutMs,
        stdin: envelope,
      });
      if (result.kind === "error") {
        // EXIT: spawn 失败 / 超时（fail-open，design §5.5/§5.6）——宁可漏拦
        // 不误拦；只报插件名与命令头，不回灌输出全文（§8）。
        report(
          "plugin-exec",
          `plugin '${handler.plugin}' ${event} hook fail-open (${result.reason}); command: ${commandHead(handler.command)}`,
          run.canonicalTool
        );
        return { kind: "pass" };
      }
      if (result.code === 2) {
        if (event === "PostToolUse") {
          // EXIT: Post exit 2 = 观测 + 诊断（**不改变工具结果**，§5.5）。
          report(
            "plugin-exec",
            `plugin '${handler.plugin}' PostToolUse hook exited 2 (observation only, tool result unchanged): ${blockReasonFrom(result, handler.plugin)}`,
            run.canonicalTool
          );
          return { kind: "pass" };
        }
        return {
          kind: "block",
          reason: blockReasonFrom(result, handler.plugin),
        };
      }
      if (result.code !== 0) {
        // EXIT: 其他退出码 → fail-open + plugin-exec（§5.5 表）。
        report(
          "plugin-exec",
          `plugin '${handler.plugin}' ${event} hook fail-open (exit ${String(result.code)}, signal ${String(result.signal)}); command: ${commandHead(handler.command)}`,
          run.canonicalTool
        );
        return { kind: "pass" };
      }
      return { kind: "pass" };
    },
  });
}

/**
 * exit 2 的 reason 解析（§5.5）：stderr 优先；stderr 是 JSON 则取
 * `systemMessage` / `permissionDecisionReason`（先命中者）；否则原文
 * （trimmed）。stderr 空 → stdout 同款；都空 → 通用 reason。
 */
function blockReasonFrom(
  result: { readonly stdout: string; readonly stderr: string },
  plugin: string
): string {
  const fromStderr = textOrJsonReason(result.stderr);
  if (fromStderr !== undefined) return fromStderr;
  const fromStdout = textOrJsonReason(result.stdout);
  if (fromStdout !== undefined) return fromStdout;
  return `${plugin} hook blocked the call (exit 2)`;
}

function textOrJsonReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isPlainObject(parsed)) {
      const systemMessage = (parsed as { systemMessage?: unknown })
        .systemMessage;
      if (typeof systemMessage === "string" && systemMessage.length > 0) {
        return systemMessage;
      }
      const decisionReason = (parsed as { permissionDecisionReason?: unknown })
        .permissionDecisionReason;
      if (typeof decisionReason === "string" && decisionReason.length > 0) {
        return decisionReason;
      }
    }
  } catch {
    // 非 JSON → 原文（下方）
  }
  return trimmed;
}

// ─── envelope ────────────────────────────────────────────────────────────────

/**
 * envelope JSON（§5.4）。`tool_name` = 候选集首个（规范 iknow 名 —— 如
 * `edit_file` 而非 `Edit`）。
 *
 * `session_id` 恒缺席（review C6）：Pre/Post 缝上 `run` 不携带
 * `conversationId` —— 该字段由 host 侧（permission-executor / loop-engine
 * 的 ctx）持有，hook 编译面在装配期固化 opts 时 conversationId 还
 * 未绑定；强行补传需扩 `CreatePluginHookContributionOptions` 一段
 *（`conversationId?` 闭包），超出本刀范围，单独 PR 处理。
 * 当前选择：在 envelope 里**不**编造字段（钩子作者拿不到 session_id
 * 是事实，不假装给），让钩子按缺席处理。
 */
function buildEnvelope(run: RunParams, cwd: string): string {
  const envelope: Record<string, unknown> = {
    hook_event_name: run.event,
    tool_name: run.candidates[0] ?? run.canonicalTool,
    tool_input: adaptToolInput(run.toolInput, run.canonicalTool),
    ...(run.toolResponse !== undefined
      ? { tool_response: run.toolResponse }
      : {}),
    cwd,
  };
  const serialized = JSON.stringify(envelope);
  return serialized ?? "{}";
}

/**
 * `tool_input` 适配视图（§5.4）：原生键原样保留，追加通用别名字段
 * （同名原生键优先，绝不覆盖）：
 *   file_path ← path；old_string ← old_str；new_string ← new_str；
 *   skill ← skill 工具的 name。
 * 非对象 input（字符串 / 数组 / null）原样透传（无法挂别名）。
 */
function adaptToolInput(input: unknown, tool: string): unknown {
  if (!isPlainObject(input)) return input;
  const out: Record<string, unknown> = { ...input };
  aliasField(out, "file_path", "path");
  aliasField(out, "old_string", "old_str");
  aliasField(out, "new_string", "new_str");
  if (tool === "skill") aliasField(out, "skill", "name");
  return out;
}

function aliasField(
  target: Record<string, unknown>,
  key: string,
  source: string
): void {
  if (target[key] !== undefined) return; // 原生键优先
  if (target[source] === undefined) return;
  target[key] = target[source];
}

// ─── 占位符替换（§5.6）───────────────────────────────────────────────────────

interface SubstitutedCommand {
  readonly command: string;
  /** 按命令串原样名导出进子进程 env 的变量。 */
  readonly exported: Readonly<Record<string, string>>;
}

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function substituteCommand(params: {
  command: string;
  plugin: string;
  opts: CreatePluginHookContributionOpts;
  report: ReportFn;
  createdDataDirs: Set<string>;
}): SubstitutedCommand {
  const { command, plugin, opts, report, createdDataDirs } = params;
  const env = opts.env ?? process.env;
  const exported: Record<string, string> = {};
  const replaced = command.replace(
    PLACEHOLDER_RE,
    (_whole: string, name: string): string => {
      const upper = name.toUpperCase();
      let value: string;
      if (upper.endsWith("_PLUGIN_ROOT")) {
        value = pluginRoot(opts, plugin) ?? "";
      } else if (upper.endsWith("_PLUGIN_DATA")) {
        value = ensurePluginDataDir({
          opts,
          plugin,
          report,
          createdDataDirs,
        });
      } else if (upper.endsWith("_PROJECT_DIR")) {
        value = opts.projectDir;
      } else {
        // 其余 ${VAR} 取 env；未定义 → 空串（§5.6）。
        value = env[name] ?? "";
      }
      // 原样名导出（命令串里写的 `${<NS>_PLUGIN_ROOT}` → 同名 env）—— 子进程
      // 脚本可读到与替换一致的值；不改写大小写，命名空间由插件声明决定。
      exported[name] = value;
      return value;
    }
  );
  return { command: replaced, exported: Object.freeze(exported) };
}

/** 插件根：roots 映射优先；缺席按 `file`（`<root>/hooks/hooks.json`）推导兜底。 */
function pluginRoot(
  opts: CreatePluginHookContributionOpts,
  plugin: string
): string | undefined {
  const fromMap = opts.roots.get(plugin);
  if (fromMap !== undefined) return fromMap;
  // 兜底推导：catalog 保证 file = <root>/hooks/hooks.json。
  const entry = opts.files.find((f) => f.plugin === plugin);
  return entry !== undefined ? dirname(dirname(entry.file)) : undefined;
}

/**
 * `${*_PLUGIN_DATA}` → `<userHome>/.iknow/plugin-data/<plugin>`，首引即建
 * （每插件一次；design §5.6）。mkdir 失败 → plugin-exec 告警后照常返回路径
 * （命令是否因此失败由命令自身决定 —— 这里不做二次判定）。
 */
function ensurePluginDataDir(params: {
  opts: CreatePluginHookContributionOpts;
  plugin: string;
  report: ReportFn;
  createdDataDirs: Set<string>;
}): string {
  const { opts, plugin, report, createdDataDirs } = params;
  const dir = join(opts.userHome, ".iknow", "plugin-data", plugin);
  if (createdDataDirs.has(dir)) return dir;
  createdDataDirs.add(dir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // EXIT: 建目录失败不阻断钩子执行（fail-open；写路径错误最终由命令自身
    // 的退出码体现）。
    report(
      "plugin-exec",
      `plugin '${plugin}' plugin-data dir could not be created: ${dir}: ${errorMessage(err)}`
    );
  }
  return dir;
}

// ─── 子进程执行 ──────────────────────────────────────────────────────────────

type CommandResult =
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "error"; readonly reason: string };

/**
 * 异步 spawn 执行命令（§5.6）。stdin 写 envelope 后关闭；stdout / stderr
 * 各按字节截断 1 MiB；超时 → 杀整个进程组（detached spawn 的组语义，先例
 * sandbox/runner.ts）后按 fail-open 返回。
 *
 * 绝不 spawnSync：TUI 下会阻塞事件循环。
 */
function runCommand(params: {
  command: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  timeoutMs: number;
  stdin: string;
}): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdoutSize = 0;
    let stderrSize = 0;
    let timer: NodeJS.Timeout | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const cap = PLUGIN_HOOK_OUTPUT_CAP_BYTES;

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(params.command, {
        shell: true,
        cwd: params.cwd,
        env: params.env,
        // detached：子进程自成进程组，超时可杀整棵树（含 shell 的孙进程）。
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // EXIT: spawn 同步抛（非法 cwd 等极端形态）→ fail-open（调用方告警）。
      finish({ kind: "error", reason: `spawn threw: ${errorMessage(err)}` });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, params.timeoutMs);
    // 超时计时器不占住宿主事件循环（钩子执行完就清）。
    timer.unref();

    child.on("error", (err) => {
      // EXIT: spawn 异步失败（ENOENT / EACCES / 非法 cwd）→ fail-open。
      finish({ kind: "error", reason: `spawn failed: ${errorMessage(err)}` });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        // EXIT: 超时 → fail-open（§5.6）；进程组已杀。
        finish({
          kind: "error",
          reason: `timeout after ${params.timeoutMs}ms`,
        });
        return;
      }
      finish({
        kind: "exit",
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutSize >= cap) return;
      const room = cap - stdoutSize;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      stdoutChunks.push(slice);
      stdoutSize += slice.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrSize >= cap) return;
      const room = cap - stderrSize;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      stderrChunks.push(slice);
      stderrSize += slice.length;
    });
    // 子进程提前退出（如 exit 2 不读 stdin）→ EPIPE，忽略（fail-open 面）。
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(params.stdin);
  });
}

/** 杀整个进程组（SIGKILL，超时是硬上界，不给宽限）；ESRCH 吞掉。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort：进程可能刚好已退出。
    }
  }
}

/** 命令头（≤80 字符）—— 告警只出头，不回灌命令全文（§8）。 */
function commandHead(command: string): string {
  const head = command.length <= 80 ? command : `${command.slice(0, 80)}…`;
  return JSON.stringify(head);
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
