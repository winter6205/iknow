/**
 * grep 工具（T8，#141 工具层重写）：在 workspace 内按正则搜索文件内容。
 *
 * 契约真值：ADR-0004 L15 + ADR-0005 L14 + T1-7 裁定。
 *
 * 行为概要：
 *   - 入口先 resolve+containment 校验搜索根（symlink 越界拒绝）。
 *   - 优先 ripgrep：`rg --line-number --no-heading --color never
 *     [--ignore-case] -- <pattern> <搜索根>`，通过 spawnWithStopSignal
 *     启动并把 ctx.signal 透传，abort 时按 detached 进程树 SIGTERM→2s→SIGKILL。
 *   - ripgrep 不可用（ENOENT）→ Node fallback：递归遍历文本文件，
 *     用 new RegExp(pattern, ignoreCase ? "i" : "") 匹配；跳过 NUL（二进制）
 *     与超大文件（>1MB，二进制/超大文件策略注释说明）。
 *   - 输出纯字符串，每行 `相对路径:行号:行内容`，\n 连接；limit 截断（上限 2000）。
 *   - 默认大小写敏感；ignoreCase=true 才不敏感。
 *   - 非法正则 → ToolExecutionError（消息含 pattern）。
 *   - 无匹配 → 空字符串。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { join, relative } from "node:path";
import { realpath } from "node:fs/promises";

import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { resolveWithinRoot, spawnWithStopSignal } from "./helpers.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const FALLBACK_SCAN_LIMIT_BYTES = 1_048_576; // 与 read_file 对齐：1MB
const FALLBACK_BINARY_PROBE_BYTES = 8_192; // 探测 NUL 的窗口大小
const RG_BINARY = "rg";
const MAX_MATCH_LINE_COLUMNS = 2_000;
const TRUNCATION_MARKER = "...[truncated]";

/** 测试 seam：生产 = node:child_process.spawn；测试可注入 stub（ENOENT 模拟 rg 缺失）。 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawn>[2]
) => ChildProcess;

/**
 * 依赖注入：覆盖点（默认 = 生产值）。
 *
 * - `spawn` 覆盖点：替换 ripgrep 调用为别的 spawn（最常见的用法：抛 ENOENT
 *   以强制 Node fallback 路径）。
 */
export interface GrepToolDeps {
  readonly spawn?: SpawnFn;
}

interface HandlerInput {
  readonly pattern: unknown;
  readonly path?: unknown;
  readonly ignoreCase?: unknown;
  readonly limit?: unknown;
}

interface CompiledInput {
  readonly pattern: string;
  readonly searchRoot: string;
  readonly ignoreCase: boolean;
  readonly limit: number;
  /** Workspace root (resolved). Used to make output paths root-relative. */
  readonly workspaceRoot: string;
}

/**
 * 工厂：createGrepTool(root, deps?) — 内容搜索工具。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "grep"
 *   - inputSchema: { pattern 必填 + path? + ignoreCase?(默认 false) + limit?(默认 200, 上限 2000) }
 *   - aci 元数据：category=read-only / isConcurrencySafe=true / interruptBehavior=cancel
 */
export function createGrepTool(root: string, deps?: GrepToolDeps): AciToolDef {
  // When the test seam (deps.spawn) is provided we use it directly so
  // ENOENT-style stubs can drive the fallback branch. Production goes
  // through spawnWithStopSignal which handles detached process-group kill.
  const testSpawn = deps?.spawn;

  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    // Resolve per call (matches sibling tools) so a missing/unreachable
    // root surfaces at the point of use instead of from a cached promise.
    const resolvedRoot = await realpath(root);
    const compiled = await compileInput(input, resolvedRoot);
    const matches = await runRipgrepOrFallback(
      testSpawn,
      compiled,
      ctx?.signal
    );
    return matches.slice(0, compiled.limit).join("\n");
  };

  return Object.freeze({
    name: "grep",
    description:
      "Search file contents under a workspace directory using a regular expression; prefer this over reading whole files when the search root or query isn't pinpointed. Returns `relative_path:line:content` lines (relative to the workspace root), capped at `limit` (default 200, hard cap 2000); case-sensitive by default — set ignoreCase=true to disable. Falls back to a Node scan if ripgrep is unavailable. Pair with read_file offset/limit on the matched region, or with glob first to pick a tighter search root.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        ignoreCase: { type: "boolean", default: false },
        limit: {
          type: "integer",
          default: DEFAULT_LIMIT,
          minimum: 0,
          maximum: MAX_LIMIT,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

async function compileInput(
  input: unknown,
  workspaceRoot: string
): Promise<CompiledInput> {
  const obj = (input ?? {}) as HandlerInput;
  if (typeof obj.pattern !== "string" || obj.pattern.length === 0) {
    throw new ToolExecutionError("grep: pattern must be a non-empty string");
  }
  const rawSub = typeof obj.path === "string" ? obj.path : ".";
  const searchRoot = await resolveWithinRoot(workspaceRoot, rawSub);
  const ignoreCase = obj.ignoreCase === true;
  const limit = clampLimit(obj.limit);
  return {
    pattern: obj.pattern,
    searchRoot,
    ignoreCase,
    limit,
    workspaceRoot,
  };
}

function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const floored = Math.floor(raw);
  if (floored <= 0) return DEFAULT_LIMIT;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

async function runRipgrepOrFallback(
  spawn: SpawnFn | undefined,
  compiled: CompiledInput,
  signal: AbortSignal | undefined
): Promise<string[]> {
  try {
    return await runRipgrep(spawn, compiled, signal);
  } catch (error) {
    if (isMissingRipgrep(error)) {
      return runNodeFallback(compiled);
    }
    throw error;
  }
}

function isMissingRipgrep(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function runRipgrep(
  spawn: SpawnFn | undefined,
  compiled: CompiledInput,
  signal: AbortSignal | undefined
): Promise<string[]> {
  const args: string[] = ["--line-number", "--no-heading", "--color", "never"];
  args.push(`--max-columns=${MAX_MATCH_LINE_COLUMNS}`, "--max-columns-preview");
  if (compiled.ignoreCase) args.push("--ignore-case");
  args.push("--", compiled.pattern, compiled.searchRoot);

  // Production: use spawnWithStopSignal for SIGTERM→2s→SIGKILL detached
  // process-group kill. Test seam: when deps.spawn is injected (e.g. to
  // simulate rg missing via ENOENT), we run it directly with a manual
  // signal listener — adequate for tests that only check exit code or
  // immediate throw behaviour.
  if (!spawn) {
    const { done } = spawnWithStopSignal(RG_BINARY, args, {
      cwd: compiled.searchRoot,
      signal,
    });
    const result = await done;
    return interpretRipgrepResult(result, compiled, signal);
  }

  // Test seam branch: invoke the injected spawn directly. We collect
  // stdout/stderr into the standard SpawnResult shape so the rest of the
  // pipeline is identical to the production path.
  //
  // NOTE: This seam is scoped to ENOENT simulation + parse-logic tests.
  // The kill semantics intentionally differ from the production path
  // (which uses `spawnWithStopSignal` and escalates SIGTERM→2s→SIGKILL
  // across the detached process group). Tests that need full abort/kill
  // coverage go through the production path; tests that just need to
  // force ENOENT or a known output use this branch.
  const child = spawn(RG_BINARY, args, {
    cwd: compiled.searchRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const abortHandler = (): void => {
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  };
  if (signal?.aborted) abortHandler();
  else signal?.addEventListener("abort", abortHandler, { once: true });

  // Single cleanup point used by both the "error" and "close" paths so the
  // AbortSignal listener is always detached — no listener leak regardless
  // of which path settles the promise.
  const cleanupAbort = (): void => {
    signal?.removeEventListener("abort", abortHandler);
  };

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveDone, rejectDone) => {
    child.once("error", (error) => {
      cleanupAbort();
      rejectDone(error);
    });
    child.once("close", (code, sig) => {
      cleanupAbort();
      resolveDone({ code, signal: sig, stdout, stderr });
    });
  });
  return interpretRipgrepResult(result, compiled, signal);
}

function interpretRipgrepResult(
  result: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  },
  compiled: CompiledInput,
  signal: AbortSignal | undefined
): string[] {
  // ripgrep 退出码：
  //   0 = 至少一处匹配；1 = 无匹配；2 = 正则/使用错误（非法正则）。
  if (result.code === 0 || result.code === 1) {
    return parseRipgrepOutput(
      result.stdout,
      compiled.searchRoot,
      compiled.workspaceRoot
    );
  }
  if (result.code === 2) {
    throw new ToolExecutionError(`grep: invalid pattern: ${compiled.pattern}`);
  }
  if (signal?.aborted || result.signal !== null) {
    throw new ToolExecutionError(
      `grep: aborted before completion${result.signal ? ` (signal=${result.signal})` : ""}`
    );
  }
  throw new ToolExecutionError(
    `grep: ripgrep exited with code ${String(result.code)}: ${result.stderr}`
  );
}

function parseRipgrepOutput(
  stdout: string,
  searchRoot: string,
  workspaceRoot: string
): string[] {
  if (stdout.length === 0) return [];
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => normalizeRipgrepLine(line, searchRoot, workspaceRoot));
}

function normalizeRipgrepLine(
  line: string,
  searchRoot: string,
  workspaceRoot: string
): string {
  // rg line shape: `<path>:<lineno>:<content>` (rg --no-heading --line-number).
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return line;
  const pathPart = line.slice(0, colonIdx);
  const rest = line.slice(colonIdx + 1);
  // rg reports paths relative to the cwd we gave it (the search root).
  const abs = pathPart.startsWith("/") ? pathPart : join(searchRoot, pathPart);
  const rel = relative(workspaceRoot, abs);
  // Strip a leading "./" so the output matches the T1-7 contract exactly.
  const cleaned = rel.startsWith("./") ? rel.slice(2) : rel;
  const lineNumberEnd = rest.indexOf(":");
  if (lineNumberEnd === -1) return `${cleaned}:${rest}`;
  const lineNumber = rest.slice(0, lineNumberEnd);
  const content = rest.slice(lineNumberEnd + 1);
  return `${cleaned}:${lineNumber}:${truncateMatchContent(content)}`;
}

async function runNodeFallback(compiled: CompiledInput): Promise<string[]> {
  const regexp = compileRegExp(compiled);
  const out: string[] = [];
  const root = compiled.searchRoot;
  const ws = compiled.workspaceRoot;
  await walk(root, async (filePath) => {
    const statInfo = await stat(filePath).catch(() => null);
    if (!statInfo || !statInfo.isFile()) return;
    if (statInfo.size > FALLBACK_SCAN_LIMIT_BYTES) return; // 超大文件跳过
    const text = await readFile(filePath).catch(() => null);
    if (text === null) return;
    if (containsNul(text, FALLBACK_BINARY_PROBE_BYTES)) return; // 二进制跳过
    scanLines(text, (line, lineNo) => {
      if (regexp.test(line)) {
        const rel = relative(ws, filePath);
        const cleaned = rel.startsWith("./") ? rel.slice(2) : rel;
        out.push(
          `${cleaned}:${String(lineNo)}:${truncateMatchContent(line)}`
        );
      }
    });
  });
  return out;
}

function truncateMatchContent(content: string): string {
  if (content.length <= MAX_MATCH_LINE_COLUMNS) return content;
  return `${content.slice(0, MAX_MATCH_LINE_COLUMNS)}${TRUNCATION_MARKER}`;
}

function compileRegExp(compiled: CompiledInput): RegExp {
  try {
    return new RegExp(compiled.pattern, compiled.ignoreCase ? "i" : "");
  } catch (error) {
    throw new ToolExecutionError(`grep: invalid pattern: ${compiled.pattern}`);
  }
}

function containsNul(buffer: Buffer, probeBytes: number): boolean {
  const end = Math.min(buffer.length, probeBytes);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function scanLines(
  buffer: Buffer,
  visit: (line: string, lineNo: number) => void
): void {
  const text = buffer.toString("utf8");
  let start = 0;
  let lineNo = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      const raw = text.slice(start, i);
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      visit(line, lineNo);
      lineNo++;
      start = i + 1;
    }
  }
  if (start < text.length) {
    const raw = text.slice(start);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    visit(line, lineNo);
  }
}

async function walk(
  dir: string,
  visit: (filePath: string) => Promise<void>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, visit);
    } else if (entry.isFile()) {
      await visit(full);
    }
  }
}
