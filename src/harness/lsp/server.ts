/**
 * LSP server 声明层 — spec 251-lsp-tool + spec 302-lsp-multilang（§ server.ts）。
 *
 * 本文件只做两件事：
 *   1. 声明 `NearestRoot`（从 file 向上找含 include 标记的最近祖先当 LSP root，#247 Q6）；
 *   2. 并排声明多语言 `LspServerInfo`（`Typescript`/`Pyright`/`YamlLS`/`JsonLS`/`DockerfileLS`）
 *      + `SERVERS` 数组 + `resolveServer(file)` 按扩展名单命中 dispatch（#304 决策1/3）。
 *
 * 保持扁平结构（#247 Q2 REJECT 不拆 registry/spawn/client 三文件）：
 * client.ts（T3）从本文件读 `Typescript` 启动句柄，handler 层（aci/tools/lsp.ts）
 * 只经 client.ts 的 `getClient(file, ctx)` 间接消费 `LspCtx`。
 */
import path from "node:path";
import { createRequire } from "node:module";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

import type { LspCtx, LspServerInfo } from "./types.js";

/**
 * NearestRoot(include, exclude?) — 返回一个 `(file, ctx) => Promise<string|undefined>`
 * 的查找函数：从 `path.dirname(file)` 向上找第一个含任意 include 标记的祖先当 root。
 *
 * - `exclude` 可选：省略时无排除（每个祖先只要含 include 标记即命中）。
 * - 每个祖先先检查是否含 exclude 文件：含则跳过该祖先（视为被排除）。
 * - 上界 stop = `ctx.directory`：不允许跨出工作目录（spec #247 Q6）。
 * - 找到 → 返回该祖先路径；走到 stop 仍未找到 → 返回 `undefined`。
 */
export function NearestRoot(
  includePatterns: readonly string[],
  excludePatterns?: readonly string[]
): (file: string, ctx: LspCtx) => Promise<string | undefined> {
  return async (file: string, ctx: LspCtx): Promise<string | undefined> => {
    const exclude = excludePatterns ?? [];
    // 上界 stop = ctx.directory：file 必须在 ctx.directory 之内(spec #247 Q6
    // security-boundary)。入口先拒绝跨出工作目录的 file,避免 walk 越过
    // 上界之后才 break(那样会读 ctx.directory 之外的祖先并可能在外部 spawn)。
    const stop = path.resolve(ctx.directory);
    const startDir = path.resolve(path.dirname(file));
    if (!isInsideOrEqual(startDir, stop)) return undefined;

    let dir = startDir;
    while (true) {
      const entries = await readdir(dir).catch(() => [] as string[]);
      const hasExclude = exclude.some((name) => entries.includes(name));
      if (!hasExclude) {
        const hasMarker = includePatterns.some((name) =>
          entries.includes(name)
        );
        if (hasMarker) return dir;
      }
      if (dir === stop) break; // 触到上界 stop,不再向上
      const parent = path.dirname(dir);
      if (parent === dir) break; // 文件系统根兜底
      dir = parent;
    }
    return undefined;
  };
}

/**
 * `child` 是否等于或在 `stop` 之下(prefix 关系,处理 path.sep 与边界)。
 * 路径字面相等视为 inside(允许停在 stop 本身);
 * `stop` 是 `child` 的祖先目录才视为 inside;其他视为 outside。
 */
function isInsideOrEqual(child: string, stop: string): boolean {
  if (child === stop) return true;
  const rel = path.relative(stop, child);
  // path.relative 不以 `..` 起头(且非空) ⇒ child 在 stop 之下或其内。
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 解析 npm wrapper 语言 server 的可执行文件（#306 事实表 + 混合供给决议 (c)）。
 *
 * 复用现有 `resolveLanguageServerBin`（spec 251）的 createRequire 同源解析 + which
 * 兜底的模式，但参数化为 `(pkgName, binName)`：
 *   1) 读 `pkgName/package.json` 的 `bin` 字段拿到 bin 的入口文件相对路径，
 *      用 `createRequire(import.meta.url).resolve(pkgName/<binRel>)` 解析绝对路径；
 *   2) 解析失败 / 文件不存在 → 回退 PATH `which` 语义（spawnSync binName 探活）。
 *
 * 返回 bin 可执行入口；不可用 → `undefined`（spawn 据此走 broken，不抛错）。
 */
async function resolveNpmBin(
  pkgName: string,
  binName: string
): Promise<string | undefined> {
  // 1) node_modules 同源解析该包 bin 入口。
  try {
    const pkgJson = createRequire(import.meta.url).resolve(
      `${pkgName}/package.json`
    );
    const binField = JSON.parse(readFileSync(pkgJson, "utf8")).bin;
    const binRel: string | undefined =
      typeof binField === "string" ? binField : binField?.[binName];
    if (typeof binRel === "string") {
      const bin = createRequire(import.meta.url).resolve(
        `${pkgName}/${binRel}`
      );
      if (existsSync(bin)) return bin;
    }
  } catch {
    // package.json 或 bin 入口解析失败 → 回退 PATH which 语义。
  }

  // 2) which 语义：直接在 PATH 找 binName。
  // spawnSync 抛 ENOENT（命令不存在）或返回非零退出码都视为不可用。
  try {
    const probe = spawnSync(binName, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return binName;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 探测当前 Python 解释器路径（pyright 的 `pythonPath` initialization）。
 *
 * 按优先级取第一个存在者：
 *   1. `VIRTUAL_ENV` 环境变量指向的虚拟环境；
 *   2. `<root>/.venv/bin/python`；
 *   3. `<root>/venv/bin/python`。
 * 都找不到 → `undefined`（pyright 无 pythonPath 仍可 spawn，由系统 python 兜底）。
 */
async function detectVenvPython(root: string): Promise<string | undefined> {
  const candidates: string[] = [];
  if (process.env.VIRTUAL_ENV) {
    candidates.push(
      path.join(process.env.VIRTUAL_ENV, "bin", "python"),
      path.join(process.env.VIRTUAL_ENV, "Scripts", "python.exe")
    );
  }
  candidates.push(
    path.join(root, ".venv", "bin", "python"),
    path.join(root, ".venv", "Scripts", "python.exe"),
    path.join(root, "venv", "bin", "python"),
    path.join(root, "venv", "Scripts", "python.exe")
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * TS 项目根标记文件集（opencode Typescript.spawn 同源）。
 * 某个目录含其中任一文件即视为该目录是 TS 项目根。
 * 就近局部常量（#305 决策2：不导出顶层）。
 */
const TS_LOCKFILES: readonly string[] = [
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/**
 * TS 排除标记：祖先目录含这些文件时，不被当作 TS 项目根
 * （deno.json 存在说明该目录大概率是 Deno 项目而非 node TS 项目）。
 * 就近局部常量（#305 决策2：不导出顶层）。
 */
const TS_EXCLUDE: readonly string[] = ["deno.json", "deno.jsonc"];

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
 * TS 单语言 LSP server 声明（保底）。client.ts 只认这一个 server。
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

/**
 * Python LSP server（pyright）— spec 302-lsp-multilang 首期 4 门 npm wrapper 之一。
 *
 * root 无 YAML/JSON 那类「无 root 概念」问题：pyright 按 pyproject.toml / setup.py /
 * setup.cfg / requirements.txt / Pipfile / pyrightconfig.json 找项目根。exclude 省略
 * （#305 决策2：exclude 可选，Python 无 Deno 那类冲突标记）。
 *
 * spawn：`resolveNpmBin("pyright", "pyright-langserver")` 探测 bin；`detectVenvPython`
 * 探测 VIRTUAL_ENV → .venv → venv，找到则透传 `{ pythonPath }`，否则 initialization
 * 省略（合法，pyright 用系统 python 兜底）。
 */
export const Pyright: LspServerInfo = {
  id: "pyright",
  root: NearestRoot([
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "Pipfile",
    "pyrightconfig.json",
  ]),
  extensions: [".py", ".pyi"],
  async spawn(root, _ctx) {
    const bin = await resolveNpmBin("pyright", "pyright-langserver");
    if (!bin) return undefined;
    const pythonPath = await detectVenvPython(root);
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      process: child,
      initialization: pythonPath ? { pythonPath } : undefined,
    };
  },
};

/**
 * YAML LSP server（yaml-language-server）— spec 302-lsp-multilang 首期 4 门之一。
 *
 * root：无 YAML 专属 root 标记（spec Open Question），沿用 opencode 现状用
 * `_file => ctx.directory`（vscode-json-languageserver 同源行为）。
 * spawn：`resolveNpmBin("yaml-language-server", "yaml-language-server")`；init 无。
 */
export const YamlLS: LspServerInfo = {
  id: "yaml-language-server",
  root: (_file, ctx) => Promise.resolve(ctx.directory),
  extensions: [".yaml", ".yml"],
  async spawn(root, _ctx) {
    const bin = await resolveNpmBin(
      "yaml-language-server",
      "yaml-language-server"
    );
    if (!bin) return undefined;
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: undefined };
  },
};

/**
 * JSON LSP server（vscode-json-languageserver）— spec 302-lsp-multilang 首期 4 门之一。
 *
 * root：JSON 无 project root 概念（spec Open Question），`_file => ctx.directory`。
 * spawn：`resolveNpmBin("vscode-json-languageserver", "vscode-json-languageserver")`；
 * init 无必需（schemas 走 workspace/config）。
 */
export const JsonLS: LspServerInfo = {
  id: "json-language-server",
  root: (_file, ctx) => Promise.resolve(ctx.directory),
  extensions: [".json"],
  async spawn(root, _ctx) {
    const bin = await resolveNpmBin(
      "vscode-json-languageserver",
      "vscode-json-languageserver"
    );
    if (!bin) return undefined;
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: undefined };
  },
};

/**
 * Dockerfile LSP server（dockerfile-language-server-nodejs）— spec 302-lsp-multilang
 * 首期 4 门之一。
 *
 * root：`_file => ctx.directory`（dockerfile 无项目根概念，spec Open Question）。
 * spawn：`resolveNpmBin("dockerfile-language-server-nodejs", "docker-langserver")`；init 无。
 *
 * extensions 含无扩展名的 `"Dockerfile"`（全文件名）：`path.extname("Dockerfile")` 为
 * 空串，resolveServer 回退用全文件名命中，使根目录 `Dockerfile` 路由到本 server。
 */
export const DockerfileLS: LspServerInfo = {
  id: "dockerfile-language-server-nodejs",
  root: (_file, ctx) => Promise.resolve(ctx.directory),
  extensions: [".dockerfile", "Dockerfile"],
  async spawn(root, _ctx) {
    const bin = await resolveNpmBin(
      "dockerfile-language-server-nodejs",
      "docker-langserver"
    );
    if (!bin) return undefined;
    const child = spawnProcess(bin, ["--stdio"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { process: child, initialization: undefined };
  },
};

/**
 * 全部已声明语言 server 的数组（#304 决策3）。client.ts 经 `resolveServer(file)`
 * 消费；probe（#307）遍历本数组 × PROBE_TARGETS 夹具跑 9-op 烟测。
 */
export const SERVERS = [
  Typescript,
  Pyright,
  YamlLS,
  JsonLS,
  DockerfileLS,
] as const;

/**
 * resolveServer(file) — 从 file 扩展名选择 LSP server（#304 决策1/2）。
 *
 * `const ext = path.extname(file) || path.basename(file);`：无扩展名（如根目录
 * `Dockerfile`）用 basename 匹配——handler 层传 `params.file` 是完整路径，回退
 * 若用全路径则 `"/proj/Dockerfile"` 永不命中 `Dockerfile`（#302 修复）。在
 * `SERVERS` 里按声明序找第一个 `extensions.includes(ext)` 的 server
 * （单命中，无并集）；空数组或无匹配 → `undefined`（不 throw）。
 */
export function resolveServer(file: string): LspServerInfo | undefined {
  const ext = path.extname(file) || path.basename(file);
  return SERVERS.find((s) => s.extensions.includes(ext));
}
