#!/usr/bin/env node
/**
 * 旧 trace 迁移脚本 — 把写侧升级前留下的单文件 `./trace.jsonl` 按行内
 * `conversation_id` 分文件到 `./trace/<convId>.jsonl`（v2 每会话独立文件语义）。
 *
 * 行为契约（spec T4）：
 *   - 读旧单文件（每行一个 JSON 对象）。
 *   - 按行的 `conversation_id` 字段分文件，写到 `<outputDir>/<convId>.jsonl`。
 *   - 保留原行 —— 逐行原样写入，不 re-serialize、不修改内容。
 *   - 坏行（JSON 解析失败 / 非对象 / 无 conversation_id）跳过，计入报告。
 *   - 输出迁移报告（处理的会话数、总行数、跳过行数）。
 *
 * 可执行：`npx tsx scripts/trace-migrate.ts`。默认从 `./trace.jsonl` 迁到
 * `./trace/`；可用 `--input` / `--output` 覆盖（见 CLI main）。
 *
 * 独立可测：导出纯函数 `migrateTraceFile(inputPath, outputDir)`，无副作用
 * 依赖；CLI main 只做 argv 解析 + 报告打印。与 reader.ts parseOneLine 的
 * 坏行判据对齐（无效 JSON / 标量 / 数组 / null 均跳过）。
 */
import { readFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 迁移结果报告。 */
export interface TraceMigrateReport {
  /** 迁移到的不同 conversation_id 数（不含坏行）。 */
  readonly sessions: number;
  /** 输入文件总行数（含坏行）。 */
  readonly totalLines: number;
  /** 跳过的坏行数（JSON 解析失败 / 非对象 / 无 conversation_id）。 */
  readonly skippedLines: number;
  /** 迁移到的会话 id 列表（按其首次出现顺序）。 */
  readonly conversationIds: ReadonlyArray<string>;
  /** 是否在迁移成功后删除了旧单文件（干净迁移才删除，见 migrateTraceFile）。 */
  readonly removedInput: boolean;
}

/** conversation_id 字段名（写侧 ADR-0003 D4 蛇形键）。 */
const CONVERSATION_ID_KEY = "conversation_id";

/**
 * 解析单行 JSON。失败或非普通对象 → undefined（与 reader.ts parseOneLine
 * 判据一致：数组也算坏行，因为数组不是每会话记录对象）。
 */
function parseOneLine(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * 把单文件 trace.jsonl 迁移到按 conversation_id 分文件。
 *
 * 保留原行：appendFileSync 写入与输入完全一致的原始行（含原有换行缺失时
 * 由调用方补充），不修改内容。坏行跳过并计数。输出目录不存在时创建。
 *
 * 删除输入：干净迁移（skippedLines === 0）后 unlink 旧单文件，保证 CLI 的
 * fail-fast 检测（./trace.jsonl 存在即提示迁移）在迁移完成后不再触发 ——
 * 否则跑完迁移仍被挡。存在坏行时保留输入文件，供人工核对/重试后再删。
 *
 * 一次迁移以 inputPath 不存在视为空输入（0 行 0 会话），不抛错 —— 与
 * reader 对 ENOENT 的静默处理一致，便于在无旧文件的仓库里安全执行。
 */
export function migrateTraceFile(
  inputPath: string,
  outputDir: string
): TraceMigrateReport {
  let content: string;
  try {
    content = readFileSync(inputPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return {
        sessions: 0,
        totalLines: 0,
        skippedLines: 0,
        conversationIds: [],
        removedInput: false,
      };
    }
    throw err;
  }

  mkdirSync(outputDir, { recursive: true });

  const lines = content.split("\n");
  let totalLines = 0;
  let skippedLines = 0;
  const conversationIds: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // 空行（含末尾换行产生的尾随 ""）不计入总行数。
    if (line.length === 0) continue;
    totalLines += 1;

    const row = parseOneLine(line);
    const convId = row?.[CONVERSATION_ID_KEY];
    if (typeof convId !== "string" || convId.length === 0) {
      skippedLines += 1;
      continue;
    }

    if (!seen.has(convId)) {
      seen.add(convId);
      conversationIds.push(convId);
    }
    // 保留原行：精确写回原始文本 + 换行，不 re-serialize。
    appendFileSync(join(outputDir, `${convId}.jsonl`), line + "\n", "utf8");
  }

  // 干净迁移后删除旧单文件，避免 CLI fail-fast 在迁移完成后仍被旧文件挡住。
  // 有坏行时保留输入（数据可能未完整迁移，删了无法恢复），返回 removedInput: false。
  // 空文件也算干净（无数据可丢）：删除它同样解除 fail-fast 的残留触发。
  let removedInput = false;
  if (skippedLines === 0) {
    try {
      rmSync(inputPath, { force: true });
      removedInput = true;
    } catch (err) {
      // 删除失败不阻断迁移结果：文件留着，fail-fast 会继续提示，下次再删。
      // 删除失败时静默（坏行路径保留文件是契约，unlink 失败保留文件也安全）。
      void err;
    }
  }

  return {
    sessions: conversationIds.length,
    totalLines,
    skippedLines,
    conversationIds,
    removedInput,
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// -- CLI main -----------------------------------------------------------------

/** 默认输入：仓库根下的旧单文件。 */
const DEFAULT_INPUT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "trace.jsonl"
);
/** 默认输出：仓库根下的每会话目录。 */
const DEFAULT_OUTPUT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "trace"
);

/** 纯函数参数形式，便于测试直接调用（不触发 CLI）。 */
function parseArgs(argv: ReadonlyArray<string>): {
  input: string;
  output: string;
} {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input" || a === "--output") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`missing value for ${a}`);
      }
      if (a === "--input") input = resolve(value);
      else output = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { input, output };
}

function printReport(report: TraceMigrateReport, outputDir: string): void {
  console.log("trace-migrate");
  console.log(`  输出目录: ${outputDir}`);
  console.log(`  处理会话数: ${report.sessions}`);
  console.log(`  总行数: ${report.totalLines}`);
  console.log(`  跳过坏行: ${report.skippedLines}`);
  if (report.removedInput) {
    console.log("  已删除旧单文件（干净迁移完成）。");
  }
  if (report.sessions === 0) {
    console.log("  无旧 trace 可迁移（输入为空或不存在）。");
  }
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const report = migrateTraceFile(input, output);
  printReport(report, output);
  process.exit(report.skippedLines > 0 ? 1 : 0);
}

/**
 * 直接执行（`npx tsx scripts/trace-migrate.ts`）时运行 CLI main；
 * 被测试 import 作为模块时不触发。
 */
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  main();
}
