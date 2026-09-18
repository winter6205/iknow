/**
 * LSP warmup 预热层 — lsp-optimization plan T4。
 *
 * **职责**：**首次** language server 工具调用时 fire-and-forget 预热——按
 * `ctx.directory`（≡ sandboxRoot，SSOT 见 build-engine.ts 装配注释）内的文件
 * 扩展名探测首个命中的 LSP server 并预 spawn，消掉后续 `lsp_*` 同族调用的
 * spawn + initialize 冷启动（tsserver 可达数秒）。
 *
 * **触发时机（Locked sentence 5）**：装配期不 warmup / 不 spawn；触发缝是
 * `withLazyLspWarmup` 包的 `LoopEngineDeps.registry` 视图 —— 装配期只消费
 * `list()`，而每个模型工具调用必按名走一次 `registry.get(name)`（engine 侧
 * `loop-engine.ts` 的 wave 分类 + executor 侧 `validateCall`）。取「第一次
 * 命中 language server 工具名」为准，命中即 arm（一次性 latch，同一装配
 * 只触发一次），fire-and-forget 不阻塞该次调用。
 *
 * **设计约束**：
 *   - **fire-and-forget**：`startLspWarmup` 同步返回，预热在后台串行进行；
 *     全量 try/catch 吞错（stderr 留痕），绝不阻塞 / 破坏 build 主路径。
 *   - **串行逐个、不早退**：按 `SERVERS` 声明序（TS 保底在前）遍历**所有**
 *     扩展名命中样本的 server 逐个预热——混合语言项目（ts+py 等）里每个
 *     server 都可能承担首次冷启动；单个 server 失败（undefined / throw）
 *     只留痕并继续下一个。
 *   - **ensureOpen 样本（二期 B4）**：getClient 成功后对样本文件 ensureOpen
 *     ——预热 server 侧 project 加载（tsserver 对未打开文件不建 project），
 *     首次 lsp_* 调用连 project 加载也免了。ensureOpen 读的是 warmup 扫描
 *     出的样本文件（磁盘现状即最新），单文件失败 try/catch 留痕继续。
 *   - 找不到任何候选文件（空目录 / 全是跳过目录）→ 不报错，但结局记为
 *     `skipped`（T1；人读的 stderr 一行不写，机器可读快照必可查）。
 *   - **结局可观测（T1）**：settle 后 `getWarmupOutcome()` 给出只读快照 ——
 *     人读的 stderr trace 原地保留，快照是给调用方（根因调查 / 诊断）的
 *     机器可读增量，「失败看起来像成功」在此终结。
 *
 * **取消语义（Q2/A9）**：本模块只经 `getClient` 建连接，不终止任何
 * server 子进程。
 */
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { LspCtx, LspServerInfo } from "./types.js";
import type { RegistryImpl } from "../tools/registry.js";
import { SERVERS } from "./server.js";
import { getClient } from "./client.js";
import { SYMBOL_QUERY_TOOL_NAMES } from "../aci/tools/symbol.js";
import { SYMBOL_MUTATE_TOOL_NAMES } from "../aci/tools/symbol-mutate.js";

/** 预热扫描跳过的目录名（依赖 / 构建产物 / 元数据，不可能承载项目源码样本）。 */
const WARMUP_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".iknow",
]);

/** 递归深度上限：2 层足够命中典型项目顶层源码（src/<file>），控制扫描成本。 */
const WARMUP_MAX_DEPTH = 2;

/**
 * 最近一次 warmup 的结局（T1，plans/lsp-silent-degradation.md）。
 *
 * 语义：
 *   - `ok`：有扩展名样本的 server 全部 `getClient` 成功且样本 `ensureOpen`
 *     完成——`pinnedSamples` 非空，`failures` 恒为空。
 *   - `partial`：至少一个 server 预热失败（spawn 失败归一 undefined / 抛错），
 *     但整体流程走完——`failures` 非空，`pinnedSamples` 列出成功的那些。
 *   - `skipped`：没有可预热的对象或预热整体没走完——无样本目录、readdir
 *     失败降级成空扫描、整轮抛错。`pinnedSamples` 恒为空，`failures` 非空。
 */
export type WarmupOutcome = {
  readonly status: "ok" | "partial" | "skipped";
  /** 真的拿到活 client 并 ensureOpen 成功的 (server, 样本文件) 对。 */
  readonly pinnedSamples: ReadonlyArray<{
    readonly serverId: string;
    readonly file: string;
  }>;
  /** 失败原因（server id / 扫描 + 整体失败的原文）。非 `ok` 时必非空。 */
  readonly failures: ReadonlyArray<string>;
};

/**
 * 最近一次 warmup 的结局快照；`undefined` = 尚未 settle 或本进程从未跑过
 * warmup。只读、永不抛——settle 的判定就是本字段首次非 `undefined`。
 */
let warmupOutcome: WarmupOutcome | undefined;

/** 读最近一次 warmup 结局（T1）。永不抛；未 settle → `undefined`。 */
export function getWarmupOutcome(): WarmupOutcome | undefined {
  return warmupOutcome;
}

/**
 * 启动 LSP warmup（fire-and-forget）。由 `withLazyLspWarmup` 在第一次
 * language server 工具名解析时 arm，不在装配期调用；同步返回，内部异步
 * 执行且全量 catch。
 */
export function startLspWarmup(ctx: LspCtx): void {
  void warmup(ctx);
}

/**
 * language server 工具名族：直接取工具层 SSOT（10 件符号查询 + 5 件符号改），
 * 不再本地重列 —— 名字清单多一处副本就是一处漂移点（新增第 16 件符号工具
 * 时，本地副本会静默漏掉，arm 永不触发而调用照常走冷启动）。
 *
 * 无循环依赖（实测，非推断）：本模块的运行时出边只有 `./server.js` 与
 * `./client.js`（`./types.js` / `../tools/registry.js` 都是 `import type`，
 * 不进运行时图）；`symbol.ts` / `symbol-mutate.ts` 的运行时闭包只到
 * `aci/tools/lsp.js` / `symbol-resolver.js` / `lsp/client.js` / `lsp/server.js`
 * / `errors.js` / `lsp/language.js`，**不含本模块**。两个方向都无环，故本
 * import 不引入循环。`lsp_` 前缀族（坐标面 `lsp.ts`，`probe:lsp` 的仪器）
 * 由 `isLanguageServerToolName` 另行前缀命中，不在这两份数组里。
 */
const LANGUAGE_SERVER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SYMBOL_QUERY_TOOL_NAMES,
  ...SYMBOL_MUTATE_TOOL_NAMES,
]);

/**
 * 名字是否属于 language server 工具族：15 件模型面符号工具（精确名）+
 * `lsp_*` 前缀（坐标面已从模型面退役，`lsp.ts` 仍是 `probe:lsp` 的真实栈
 * 仪器 —— 前缀命中即 arm，多覆盖零风险）。
 */
function isLanguageServerToolName(name: string): boolean {
  return LANGUAGE_SERVER_TOOL_NAMES.has(name) || name.startsWith("lsp_");
}

/**
 * 惰性 warmup 触发缝（Locked sentence 5）：包一层 Registry 视图交给
 * `LoopEngineDeps.registry`，**第一次** `get(name)` 命中 language server
 * 工具族时 arm 一次 warmup。
 *
 * 为什么是这里（最小缝）：
 *   - 装配期只消费 `list()`（prompt 工具表 / knownToolNames），不经过本
 *     函数的 `get` —— 装配完成不 arm；
 *   - 每个模型工具调用必按名解析一次（`loop-engine.ts` wave 分类 +
 *     `executor.ts` `validateCall`），`get` 是「这类工具调用真的发生了」的
 *     唯一必经点，且天然带工具名，无需从 handler / 注册表反推可达集；
 *   - 不放在 `client.ts` 的 `getClientDetailed`：warmup 自身就经 `getClient`
 *     走该入口（递归），且 notifier 的 `invalidate` 也走 `getClient` ——
 *     普通 `edit_file` 写盘会误 arm，那不是 language server 工具调用。
 *
 * `get` 每个调用会被解析多次（分类 + 校验），故 latch 一次性：同一装配
 * 只 arm 一次。`getValidator` 照原样透传（`RegistryImpl` 结构兼容）。
 */
export function withLazyLspWarmup(
  inner: RegistryImpl,
  ctx: LspCtx
): RegistryImpl {
  let armed = false;
  return Object.freeze({
    list: () => inner.list(),
    get: (name: string) => {
      if (!armed && isLanguageServerToolName(name)) {
        armed = true;
        startLspWarmup(ctx);
      }
      return inner.get(name);
    },
    // 结构兼容：`RegistryImpl` 的第三方法照原样透传（本缝只关心 `get`）。
    getValidator: (name: string) => inner.getValidator(name),
  });
}

async function warmup(ctx: LspCtx): Promise<void> {
  // 两类失败分开持有而非合流后按位置相减：server 级失败要进 [lsp-warmup]
  // partial trace，扫描降级自己已经在 collectSampleFiles 里写过 readdir 行，
  // 合流会让同一句文本在 stderr 出现两次（扫描失败被 partial 行再 join 一遍）。
  const serverFailures: string[] = [];
  // 扫描降级在 collectSampleFiles 内已写过 stderr；声明在 try 外，好让外层
  // catch 的整体失败快照也能带上它（否则两类失败的合流只在成功路径成立）。
  let scanFailures: string[] = [];
  const pinnedSamples: Array<{ serverId: string; file: string }> = [];
  try {
    // 扫描失败经 collectSampleFiles 归一成空样本 + 一条 failure（stderr 同源
    // 留痕）——readdir 降级不再只活在人读 trace 里，非 ok 快照必有 failures。
    const scan = await collectSampleFiles(ctx.directory, WARMUP_MAX_DEPTH);
    scanFailures = scan.failures;
    const samples = scan.samples;
    for (const server of SERVERS) {
      const sample = samples.find((file) => matchesServer(server, file));
      if (!sample) continue; // 该 server 的扩展名在本项目无样本 → 跳过
      try {
        // 逐个预热所有命中 server（不早退）：混合语言项目（ts+py 等）里
        // 每个 server 都可能承担首次 lsp_* 调用的冷启动。getClient 成功后
        // 对样本 ensureOpen（二期 B4）——预热 server 侧 project 加载；样本
        // 是 warmup 自己扫描出的磁盘文件，didOpen 读到的即磁盘现状。
        const client = await getClient(ctx, sample, { server });
        // EXIT: getClient 把 spawn 失败归一成 undefined（不抛）。此前该分支
        // 静默 continue，正是「warmup 看起来成功、实际没 pin 住」的根因候选；
        // 现记一条 failure 后才继续。
        if (!client) {
          serverFailures.push(`${server.id}: no client available`);
          continue;
        }
        await client.ensureOpen(sample);
        pinnedSamples.push({ serverId: server.id, file: sample });
      } catch (err) {
        // EXIT: 单个 server spawn/ensureOpen 抛错 → 记入 failures 后继续下一
        // server；getClient 已把 spawn 失败归一为 undefined，此处兜底预料外 throw。
        serverFailures.push(
          `${server.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    settleOutcome(serverFailures, scanFailures, pinnedSamples, ctx.directory);
  } catch (err) {
    // EXIT: 预热整体失败（目录不可读等）→ stderr 一行 + 快照，不抛；首次 lsp_*
    // 走正常 getClient 自愈。
    const msg = err instanceof Error ? err.message : String(err);
    settle({
      status: "skipped",
      pinnedSamples,
      failures: [...serverFailures, ...scanFailures, msg],
    });
    process.stderr.write(`[lsp-warmup] skipped: ${msg}\n`);
  }
}

/** 写入结局快照：settle 点唯一（settle 判定 = 首次非 undefined）。 */
function settle(outcome: WarmupOutcome): void {
  warmupOutcome = outcome;
}

/**
 * 结算结局：派生 status、补「目录里没有任何样本」这一条 failure（快照契约：
 * 非 ok 必有 failures），并写人读的 partial trace 行。从 warmup 主体抽出是
 * 为了压住分支密度（S5 硬门）。
 *
 * 两类失败分参传入（而非合流后相减）：快照要全量，partial trace 只该含
 * server 级失败 —— 扫描降级已在 collectSampleFiles 写过自己的 stderr 行，
 * 再被 partial 行 join 一遍就是同一句文本重复出现。
 */
function settleOutcome(
  serverFailures: string[],
  scanFailures: string[],
  pinnedSamples: WarmupOutcome["pinnedSamples"],
  directory: string
): void {
  const failures = [...serverFailures, ...scanFailures];
  if (pinnedSamples.length === 0 && failures.length === 0) {
    failures.push(
      `no sample files matched any configured server under ${directory}`
    );
  }
  settle({
    // ok = 无失败且有 pin 住的样本；有失败但仍有样本 pin 住 = partial（部分
    // server 没起来）；其余（无样本 / 全失败）= skipped。
    status:
      failures.length === 0 && pinnedSamples.length > 0
        ? "ok"
        : pinnedSamples.length > 0
          ? "partial"
          : "skipped",
    pinnedSamples,
    failures,
  });
  // 人读 trace：有 server 尝试失败就写（改动前的语义，含全失败那一支）；
  // 扫描降级 / 无样本的 failure 只进快照，不重复写 stderr。
  if (serverFailures.length > 0) {
    process.stderr.write(
      `[lsp-warmup] partial: ${serverFailures.join("; ")}\n`
    );
  }
}

/**
 * 收集候选样本文件：readdir withFileTypes，递归至多 `depth` 层，跳过
 * WARMUP_SKIP_DIRS 与隐藏目录。readdir 失败按空目录处理（降级，不抛）——
 * 降级原因随样本一起返回，供 outcome 快照点名（stderr 仍然照写）。
 */
async function collectSampleFiles(
  dir: string,
  depth: number
): Promise<{ samples: string[]; failures: string[] }> {
  // 显式 Dirent（默认文件名泛型 string）：ReturnType<typeof readdir> 会取到
  // readdir 的 Buffer 重载，与这里 `{ withFileTypes: true }` 的实参类型不符。
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // EXIT: readdir 失败（目录不可读/已删除）→ 按"无候选样本"降级（不抛），
    // 但降级原因作为 failure 上报，快照据此给出非 ok 结局；[lsp-warmup]
    // readdir failed 行同时写给读日志的人。首次 lsp_* 调用走 getClient 正常自愈。
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[lsp-warmup] readdir failed for ${dir}: ${msg}\n`);
    return { samples: [], failures: [`readdir failed for ${dir}: ${msg}`] };
  }
  const samples: string[] = [];
  const failures: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WARMUP_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      if (depth > 0) {
        const nested = await collectSampleFiles(full, depth - 1);
        samples.push(...nested.samples);
        failures.push(...nested.failures);
      }
    } else if (entry.isFile()) {
      samples.push(full);
    }
  }
  return { samples, failures };
}

/** file 的扩展名（无扩展名回退全文件名，与 server.ts resolveServer 同语义）。 */
function matchesServer(server: LspServerInfo, file: string): boolean {
  const ext = path.extname(file) || path.basename(file);
  return server.extensions.includes(ext);
}
