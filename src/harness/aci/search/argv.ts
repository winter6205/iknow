/**
 * rg argv 构造 + 语言类型校验（SC12「argv 构造」；契约 D4；SC10）。
 *
 * 出法与 flag 的对应是契约的一部分，不是实现细节：
 *   - `paths`  → `-l`          （rg 每个唯一文件一条）
 *   - `count`  → `--count`     （`path:条数`）
 *   - `content`→ `--line-number --no-heading`（`path:line:text`）
 *   - `--null` 常开：路径以 NUL 收尾，把「路径含冒号」从分列问题里移除。
 *   - `-C N` 只在 content 出法带上（其它出法没有「附近几行」的概念）。
 *
 * 未知 `type` 在这里 typed 拒绝（**不是**非法正则）—— 两种错误文案互不
 * 包含对方的关键词，SC10 由 `argv.test.ts` 直接断言。
 */

import { ToolExecutionError } from "../../errors.js";
import type { QuerySpec } from "./types.js";
import { KNOWN_TYPES, TYPE_GLOBS } from "./type-table.js";

/** 词表里常被用到的样例（测试锁形状用；真值仍在 TYPE_GLOBS）。 */
export const KNOWN_TYPE_SAMPLE: ReadonlyArray<string> = [
  "ts",
  "js",
  "py",
  "rust",
  "go",
  "md",
  "json",
];

export function buildRgArgs(
  spec: QuerySpec,
  searchPath: string,
  maxColumns: number
): string[] {
  const args: string[] = [];
  pushOutputMode(args, spec);
  // `--engine=auto`：默认走 Rust 正则引擎，只在模式用到 look-around /
  // backreference 这类它不支持的构造时才切 PCRE2。Node 引擎用 JS `RegExp`，
  // 它**支持**那些构造；不切引擎的话 `(?=hit)` 在 rg 路径是 rc=2 失败、在
  // Node 路径却正常命中 —— 同一个 pattern 的含义取决于哪条引擎在跑，正是
  // D6 禁止的静默改语义。auto 让两条引擎的接受集对齐，且普通模式零开销
  //（对比 `--pcre2` 强制全量换引擎）。
  args.push("--engine=auto");
  // `--no-messages` 收掉**文件级**告警（不可读文件的 Permission denied、坏
  // 符号链接），但**不收**正则 / 用法错误。于是 rc=2 且 stderr 空 = 只是某个
  // 文件没读到（stdout 里的命中照常有效）；rc=2 且 stderr 非空 = 查询本身被
  // 拒。少了这道开关，一个不可读的邻居文件会让整次查询失败，而 Node 引擎
  // 只是跳过该文件 —— 两边对同一目录给出不同答案（SC9）。
  // `-H` 常开：`path` 指向单个文件时 rg 默认省掉文件名（只剩 `行号:内容`），
  // 与 paths / count 出法及 Node 引擎的 `path:line:text` 形状都不兼容。
  args.push("--null", "--color", "never", "--no-messages", "-H");
  if (spec.output === "content") {
    // 超长匹配行的两道闸：先让 rg 自己收口（`--max-columns-preview` 会写自己的
    // 省略标记），再由投影层按 code point 收到 MAX_MATCH_LINE_COLUMNS。少了第一
    // 道，rg 会把整行原样吐回来，缓冲一整行 1MB 文本才发现要截断。`paths` /
    // `count` 不吐行内容，因此不带。
    args.push(`--max-columns=${String(maxColumns)}`, "--max-columns-preview");
    if (spec.context > 0) args.push("-C", String(spec.context));
  }
  if (spec.ignoreCase) args.push("--ignore-case");
  if (spec.glob !== undefined) args.push("--glob", spec.glob);
  if (spec.type !== undefined) args.push("--type", resolveTypeName(spec.type));
  // 搜索路径**相对 cwd**（cwd = workspace 根，见 rg-engine）：rg 把路径原样
  // 回显，喂绝对路径就会把绝对路径吐给模型（SC4 要求相对）；且 `--glob` 的
  // 锚定是相对 cwd 判的，喂绝对路径会让 `sub/*.ts` 这类模式在 cwd 不是
  // workspace 根时判错（Node 引擎按 workspace 相对判段，两边必须同口径）。
  args.push("--", spec.pattern, searchPath);
  return args;
}

function pushOutputMode(args: string[], spec: QuerySpec): void {
  if (spec.output === "paths") {
    args.push("-l");
    return;
  }
  if (spec.output === "count") {
    args.push("--count");
    return;
  }
  args.push("--line-number", "--no-heading");
}

/**
 * 校验 `type` 是否在 rg 词表内。
 *
 * 未知类型是**输入**类 typed 错误（与坏正则同属 ToolExecutionError，但文案
 * 点名 `type` 与类型名、不含 `pattern` —— SC10 要求两类不可混为「illegal
 * regex」一种）。rg 自己也会以 rc=2 报同类错误，这道前置校验让两条引擎路径
 * （rg / Node）给出同一文案，也避免「先花一次进程启动才发现名字错」。
 */
export function resolveTypeName(type: string): string {
  if (!KNOWN_TYPES.has(type)) {
    throw new ToolExecutionError(
      `grep: unknown type: ${type} (the type filter takes a ripgrep language name such as ts / py / rust; check the spelling)`
    );
  }
  return type;
}

/**
 * 某文件名是否命中 `type` 词表（Node 引擎的收窄实现）。
 *
 * 支持 rg 词表里出现的两种形状：`*.ext` 与 `Name.*` / `[Mm]akefile` 一类
 * 带字符类的字面名。大小写按 rg 语义：`*.[chH]` 这类字符类区分大小写，
 * 因此用不敏感的字符类展开而非全局 `i` flag。
 */
export function fileNameMatchesType(fileName: string, type: string): boolean {
  const globs = TYPE_GLOBS[type];
  if (globs === undefined) return false;
  return globs.some((glob) => globToRegExp(glob).test(fileName));
}

/** 把 rg 类型词表里的单段 glob 编译为正则（`*` / `?` / `[...]`）。 */
function globToRegExp(glob: string): RegExp {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end !== -1) {
        source += glob.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    source += escapeRegExp(ch);
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
