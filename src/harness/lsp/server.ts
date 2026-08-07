/**
 * LSP server 声明层 — spec 251-lsp-tool（§ server.ts）。
 *
 * 本文件只做两件事：
 *   1. 声明 `NearestRoot`（从 file 向上找含 lockfile 的最近祖先当 LSP root，#247 Q6）；
 *   2. 声明 `Typescript` 单语言 `LspServerInfo`（id / extensions / root / spawn）。
 *
 * 保持扁平结构（#247 Q2 REJECT 不拆 registry/spawn/client 三文件）：
 * client.ts（T3）从本文件读 `Typescript` 启动句柄，handler 层（aci/tools/lsp.ts）
 * 只经 client.ts 的 `getClient(file, ctx)` 间接消费 `LspCtx`。
 */
import path from "node:path";
import { createRequire } from "node:module";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

import type { LspCtx, LspServerInfo } from "./types.js";

/**
 * TS 项目根标记文件集（opencode Typescript.spawn 同源）。
 * 某个目录含其中任一文件即视为该目录是 TS 项目根。
 */
export const TS_LOCKFILES: readonly string[] = [
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/**
 * 排除标记：祖先目录含这些文件时，不被当作 TS 项目根
 * （deno.json 存在说明该目录大概率是 Deno 项目而非 node TS 项目）。
 */
export const TS_EXCLUDE: readonly string[] = ["deno.json", "deno.jsonc"];

/**
 * NearestRoot(lockfiles, exclude) — 返回一个 `(file, ctx) => Promise<string|undefined>`
 * 的查找函数：从 `path.dirname(file)` 向上找第一个含任意 lockfile 的祖先当 root。
 *
 * - 每个祖先先检查是否含 exclude 文件：含则跳过该祖先（视为被排除）。
 * - 上界 stop = `ctx.directory`：不允许跨出工作目录（spec #247 Q6）。
 * - 找到 → 返回该祖先路径；走到 stop 仍未找到 → 返回 `undefined`。
 */
export function NearestRoot(
  lockfiles: readonly string[],
  exclude: readonly string[]
): (file: string, ctx: LspCtx) => Promise<string | undefined> {
  return async (file: string, ctx: LspCtx): Promise<string | undefined> => {
    // 从 file 所在目录开始向上爬；stop 边界（ctx.directory）本身查一次但不再向上。
    let dir = path.dirname(file);
    while (true) {
      const entries = await readdir(dir).catch(() => [] as string[]);
      const hasExclude = exclude.some((name) => entries.includes(name));
      if (!hasExclude) {
        const hasLockfile = lockfiles.some((name) => entries.includes(name));
        if (hasLockfile) return dir;
      }
      if (dir === ctx.directory) break; // 触到上界 stop，不再向上
      const parent = path.dirname(dir);
      if (parent === dir) break; // 文件系统根兜底
      dir = parent;
    }
    return undefined;
  };
}

/** 解析 typescript-language-server 可执行文件（未安装 / 解析失败 → undefined）。 */
async function resolveLanguageServerBin(): Promise<string | undefined> {
  // 1) node_modules 同源解析 typescript-language-server 的 bin（lib/cli.mjs）。
  try {
    const bin = createRequire(import.meta.url).resolve(
      "typescript-language-server"
    );
    if (existsSync(bin)) return bin;
  } catch {
    // 未安装 → 回退 PATH which 语义。
  }

  // 2) which 语义：直接在 PATH 找 typescript-language-server。
  // spawnSync 抛 ENOENT（命令不存在）或返回非零退出码都视为不可用。
  try {
    const probe = spawnSync("typescript-language-server", ["--version"], {
      stdio: "ignore",
    });
    if (probe.status === 0) return "typescript-language-server";
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * TS 单语言 LSP server 声明（首期）。client.ts 只认这一个 server。
 *
 * `spawn` 返回 `undefined` 表示该 server 在当前环境下不可用
 * （tsserver bin 缺失 / typescript-language-server 二进制缺失）；
 * client.ts 据此走 broken 记忆，不抛错，handler 层转纯字符串
 * `"(no LSP server available for file)"`。
 */
export const Typescript: LspServerInfo = {
  id: "typescript",
  root: NearestRoot(TS_LOCKFILES, TS_EXCLUDE),
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  async spawn(root, _ctx) {
    // tsserver 内核路径：项目依赖 typescript@5.9.3，node_modules 同源解析
    // typescript/lib/tsserver.js。解析失败 → 该环境无 tsserver，server 不可用。
    let tsserver: string | undefined;
    try {
      tsserver = createRequire(import.meta.url).resolve(
        "typescript/lib/tsserver.js"
      );
    } catch {
      return undefined;
    }

    // typescript-language-server 翻译层二进制缺失 → server 不可用（graceful）。
    const bin = await resolveLanguageServerBin();
    if (!bin) return undefined;

    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: { tsserver: { path: tsserver } } };
  },
};
