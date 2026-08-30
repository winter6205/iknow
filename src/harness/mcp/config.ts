/**
 * T3 (plans/worktree-mcp-rebind-lifecycle.md) — MCP 两级 config 解析器。
 *
 * 加载顺序:用户级 `~/.iknow/mcp.json` → 项目级 `<mcpConfigRoot>/.iknow/mcp.json`,
 * 同名 server 项目级 **条目级整体覆盖** 用户级(无字段级深合并,
 * SC1 — 整段对象替换)。每条 server 通过 `{type:"stdio"|"remote"}` 判别
 * 联合校验;`disabled:true` 或 `enabled:false` → status=disabled。
 * 坏条目跳过 + warn 恰好一行,reason **绝不包含 env/command 字段值**
 * (SC7)。
 *
 * 项目级路径**只**由调用方注入的 `mcpConfigRoot`(稳定 product/main checkout)
 * 派生,绝不读 task worktree / `process.cwd()`。
 *
 * Never 区:不读 `~/.claude.json` / `.kiro/settings/mcp.json`(G2 D1 决议)。
 *
 * 设计要点:
 *  - 路径参数化(`{ home, mcpConfigRoot }`),不读真实 ~/.iknow,测试用 tmp fixture。
 *  - 顶层形态兼容:既认 `mcpServers` 包裹,也认顶层直接是 server map。
 *  - 文件缺失 → 该级空集,继续。
 *  - 非缺失 IO / JSON 损坏 / 顶层非对象 → 抛 `McpLifecycleError`
 *    kind `config_load_failed`(启动边界可 catch 后降级为无 MCP)。
 *  - 缺 type 时按 `url` 字段存在判 remote,否则 stdio(容错策略)。
 *  - 输出数组按 server 名字母序,便于上层做差分 / diff 稳定。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { McpLifecycleError } from "../errors.js";

/**
 * 单个 MCP server 的源(user 级 / project 级)。
 *
 * 两级覆盖方向固定:project 覆盖 user。`source` 标记结果来源,
 * 上层(manager / 装配层)可以据此做策略(如 project-only server
 * 在不同 cwd 不可见时不入装配)。
 */
export type McpServerSource = "user" | "project";

/**
 * 判别联合:`kind` 决定 `entry` 形态。
 *
 * `kind:"stdio"` → `entry.command` 必填,`entry.url` 不存在。
 * `kind:"remote"` → `entry.url` 必填,`entry.command` 不存在。
 *
 * 保留 `env` / `args` 等可选字段透传(交给 adapter / manager 解释),
 * 本模块只校验"形态正确",不深查 env/args 的具体值。
 */
export type McpServerConfig = McpStdioServer | McpRemoteServer;

export interface McpStdioServer {
  readonly name: string;
  readonly kind: "stdio";
  readonly source: McpServerSource;
  readonly status: "enabled" | "disabled";
  readonly entry: McpStdioEntry;
}

export interface McpRemoteServer {
  readonly name: string;
  readonly kind: "remote";
  readonly source: McpServerSource;
  readonly status: "enabled" | "disabled";
  readonly entry: McpRemoteEntry;
}

export interface McpStdioEntry {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpRemoteEntry {
  readonly url: string;
}

/** loadMcpConfig 顶层结果。 */
export interface McpConfigResult {
  /** 按 name 字母序合并后的所有 server(坏条目已剔除)。 */
  readonly servers: readonly McpServerConfig[];
}

/**
 * 加载器入参。
 *
 * - `home` ≡ `~`(用户级读 `<home>/.iknow/mcp.json`)
 * - `mcpConfigRoot` ≡ 稳定 product/main checkout(项目级读
 *   `<mcpConfigRoot>/.iknow/mcp.json`);**不是** task worktree / process.cwd()
 *
 * 两个字段都强制必填,避免运行时隐式读 process.env / process.cwd() 造成
 * 跨机器不可重现。调用方按 resolver 返回的 `mcpConfigRoot` 注入。
 */
export interface LoadMcpConfigOpts {
  readonly home: string;
  readonly mcpConfigRoot: string;
}

/**
 * 主入口。读两级 mcp.json,合并 + 校验 + 坏条目隔离 + warn 一行。
 *
 * 失败模式:
 *  - 任一文件缺失 → 该级为空,继续。
 *  - 非缺失 IO / JSON 损坏 / 顶层非对象 / server map 非对象 →
 *    抛 `McpLifecycleError`(`config_load_failed`)。
 *    // EXIT: config load failed → no MCP manager, preserve harness startup
 *  - 单个 server 条目坏 → warn 一行,该条目跳过,其他继续。
 */
export async function loadMcpConfig(
  opts: LoadMcpConfigOpts
): Promise<McpConfigResult> {
  const userPath = path.join(opts.home, ".iknow", "mcp.json");
  const projectPath = path.join(opts.mcpConfigRoot, ".iknow", "mcp.json");

  const userEntries = await readLevelConfig(userPath, "user");
  const projectEntries = await readLevelConfig(projectPath, "project");

  // 条目级整体覆盖:project 的同名条目**整段替换** user。
  // 关键:不做字段级深合并(SC1)。
  // `source` 也必须随覆盖重写,反映"最终来自哪一级",而不是首次出现的级。
  const merged = new Map<
    string,
    { entry: RawServerEntry; source: McpServerSource }
  >();
  for (const [name, entry] of userEntries) {
    merged.set(name, { entry, source: "user" });
  }
  for (const [name, entry] of projectEntries) {
    merged.set(name, { entry, source: "project" }); // 整段替换,不去 merge
  }

  const servers: McpServerConfig[] = [];
  // 按 name 字母序输出,跨进程稳定(便于上层 diff / 日志 / 装配顺序稳定)。
  const names = [...merged.keys()].sort();
  for (const name of names) {
    const slot = merged.get(name);
    if (!slot) continue;
    const parsed = parseServerEntry(name, slot.entry, slot.source);
    if (parsed) servers.push(parsed);
  }

  return { servers };
}

// ---------------------------------------------------------------------------
// 内部 — 单级读取 + 形态校验
// ---------------------------------------------------------------------------

interface RawServerEntry {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly url?: unknown;
  readonly disabled?: unknown;
  readonly enabled?: unknown;
}

async function readLevelConfig(
  filePath: string,
  level: McpServerSource
): Promise<ReadonlyMap<string, RawServerEntry>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return new Map(); // 缺失 → 空级,降级
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level io error reading config file: ${e.code ?? "unknown"}`,
      { cause: err }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = err as Error;
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level invalid JSON in config file: ${e.message.slice(0, 80)}`,
      { cause: err }
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level top-level is not an object in config file`
    );
  }

  // 顶层形态:优先 `mcpServers` 包裹;若不存在,回退到"顶层直接是 server map"。
  const obj = parsed as Record<string, unknown>;
  const inner = obj["mcpServers"];
  const mapSource = inner !== undefined ? inner : obj; // 兼容形态
  if (
    typeof mapSource !== "object" ||
    mapSource === null ||
    Array.isArray(mapSource)
  ) {
    // EXIT: config load failed → no MCP manager, preserve harness startup
    throw new McpLifecycleError(
      "config_load_failed",
      `${level} level server map is not an object in config file`
    );
  }

  const out = new Map<string, RawServerEntry>();
  for (const [name, value] of Object.entries(
    mapSource as Record<string, unknown>
  )) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      warnEntry(name, "entry is not an object");
      continue;
    }
    out.set(name, value as RawServerEntry);
  }
  return out;
}

function parseServerEntry(
  name: string,
  raw: RawServerEntry,
  source: McpServerSource
): McpServerConfig | null {
  // status:`enabled` / `disabled` 由 disabled / enabled 字段决定。
  // 优先级:enabled 优先(spec 没有明说但惯例如此,单测断言此契约)。
  let status: "enabled" | "disabled" = "enabled";
  if (raw.disabled === true) status = "disabled";
  if (raw.enabled === false) status = "disabled";
  if (raw.enabled === true) status = "enabled";

  // 形态推断:type 缺省时按 url 存在与否推断(测试断言 SC 兼容形态)。
  const typeRaw = raw.type;
  const hasUrl = typeof raw.url === "string" && raw.url.length > 0;
  const hasCommand = typeof raw.command === "string" && raw.command.length > 0;

  let kind: "stdio" | "remote";
  if (typeRaw === "stdio") {
    if (!hasCommand) {
      warnEntry(name, "stdio entry missing command");
      return null;
    }
    kind = "stdio";
  } else if (typeRaw === "remote") {
    if (!hasUrl) {
      warnEntry(name, "remote entry missing url");
      return null;
    }
    kind = "remote";
  } else if (typeRaw === undefined) {
    if (hasUrl) kind = "remote";
    else kind = "stdio"; // 缺 type + 无 url → 当 stdio,继续校验 command
  } else {
    warnEntry(name, `unknown type "${String(typeRaw)}"`);
    return null;
  }

  if (kind === "stdio") {
    if (!hasCommand) {
      // 缺 type 走 stdio 推断但仍缺 command → 坏条目
      warnEntry(name, "stdio entry missing command");
      return null;
    }
    return {
      name,
      kind: "stdio",
      source,
      status,
      entry: {
        command: raw.command as string,
        args: normalizeStringArray(raw.args, name),
        env: normalizeStringRecord(raw.env, name),
      },
    };
  }

  // kind === "remote"
  return {
    name,
    kind: "remote",
    source,
    status,
    entry: {
      url: raw.url as string,
    },
  };
}

// ---------------------------------------------------------------------------
// 内部 — 归一化
// ---------------------------------------------------------------------------

function normalizeStringArray(
  v: unknown,
  _name: string
): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") out.push(x);
  }
  return out;
}

function normalizeStringRecord(
  v: unknown,
  _name: string
): Readonly<Record<string, string>> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 内部 — warn(SC7:reason 不含 env / command 字段值)
// ---------------------------------------------------------------------------

/**
 * 单条目坏掉时 warn。reason 模板只放字段名/类型描述,
 * 绝不拼 env[k]=v 或 command="..." 等敏感字段值。
 */
function warnEntry(name: string, reason: string): void {
  console.warn(`[mcp/config] server '${name}' skipped: ${reason}`);
}
