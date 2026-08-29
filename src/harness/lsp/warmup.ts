/**
 * LSP warmup 预热层 — lsp-optimization plan T4。
 *
 * **职责**：build-engine 装配完成后 fire-and-forget 预热——按 `ctx.directory`
 * （≡ sandboxRoot，SSOT 见 build-engine.ts 装配注释）内的文件扩展名探测首个
 * 命中的 LSP server 并预 spawn，消掉首次 `lsp_*` 工具调用的 spawn + initialize
 * 冷启动（tsserver 可达数秒）。
 *
 * **设计约束**：
 *   - **fire-and-forget**：`startLspWarmup` 同步返回，预热在后台串行进行；
 *     全量 try/catch 吞错（stderr 留痕），绝不阻塞 / 破坏 build 主路径。
 *   - **串行逐个、不早退**：按 `SERVERS` 声明序（TS 保底在前）遍历**所有**
 *     扩展名命中样本的 server 逐个预热——混合语言项目（ts+py 等）里每个
 *     server 都可能承担首次冷启动；单个 server 失败（undefined / throw）
 *     只留痕并继续下一个。
 *   - **不 ensureOpen**：预打开无关文件会污染 server 侧 project 状态。
 *   - 找不到任何候选文件（空目录 / 全是跳过目录）→ 静默放弃，不报错。
 *
 * **取消语义（Q2/A9）**：本模块只经 `getClient` 建连接，不终止任何
 * server 子进程。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { LspCtx, LspServerInfo } from "./types.js";
import { SERVERS } from "./server.js";
import { getClient } from "./client.js";

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
 * 启动 LSP warmup（fire-and-forget）。装配层（build-engine.ts）在创建
 * lspNotifier 后调用；同步返回，内部异步执行且全量 catch。
 */
export function startLspWarmup(ctx: LspCtx): void {
  void warmup(ctx);
}

async function warmup(ctx: LspCtx): Promise<void> {
  try {
    const samples = await collectSampleFiles(ctx.directory, WARMUP_MAX_DEPTH);
    const failures: string[] = [];
    for (const server of SERVERS) {
      const sample = samples.find((file) => matchesServer(server, file));
      if (!sample) continue; // 该 server 的扩展名在本项目无样本 → 跳过
      try {
        // 逐个预热所有命中 server（不早退）：混合语言项目（ts+py 等）里
        // 每个 server 都可能承担首次 lsp_* 调用的冷启动。不 ensureOpen，
        // 避免预打开无关文件污染 server 侧 project。
        await getClient(ctx, sample, { server });
      } catch (err) {
        // 单个 server 失败（如 bin 缺失 / spawn 抛错）只记录，继续下一个；
        // getClient 自身已把 spawn 失败归一为 undefined，此处 catch 兜底
        // 预料外的 throw。S3 禁空 catch：失败统一 stderr 留痕。
        failures.push(
          `${server.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (failures.length > 0) {
      process.stderr.write(`[lsp-warmup] partial: ${failures.join("; ")}\n`);
    }
  } catch (err) {
    // 预热是纯优化：任何失败（目录不可读等）都只留痕一行，首次 lsp_*
    // 调用会走正常 getClient 路径自愈。
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[lsp-warmup] skipped: ${msg}\n`);
  }
}

/**
 * 收集候选样本文件：readdir withFileTypes，递归至多 `depth` 层，跳过
 * WARMUP_SKIP_DIRS 与隐藏目录。readdir 失败按空目录处理（降级，不抛）。
 */
async function collectSampleFiles(
  dir: string,
  depth: number
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (err: unknown) => {
      // EXIT: readdir 失败（目录不可读/已删除）→ 按"无候选样本"降级，
      // 预热放弃；顶层 warmup 的 [lsp-warmup] skipped 不触发（未抛），
      // 故在此留痕区分"失败"与"空目录"。首次 lsp_* 调用走 getClient 正常自愈。
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[lsp-warmup] readdir failed for ${dir}: ${msg}\n`);
      return [];
    }
  );
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WARMUP_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      if (depth > 0) {
        files.push(...(await collectSampleFiles(full, depth - 1)));
      }
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** file 的扩展名（无扩展名回退全文件名，与 server.ts resolveServer 同语义）。 */
function matchesServer(server: LspServerInfo, file: string): boolean {
  const ext = path.extname(file) || path.basename(file);
  return server.extensions.includes(ext);
}
