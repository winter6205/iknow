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
 * 未知 `type` 的 typed 拒绝**不在这里**：它在 `options.ts` 的 `parseQuerySpec`
 * 就挡下（见该处注释）—— 校验若只挂在本函数上，就只在「自带引擎在场」时才
 * 生效，Node 全会话会静默回空（SC10 在一条引擎上失效）。
 */

import type { QuerySpec } from "./types.js";
import { TYPE_GLOBS } from "./type-table.js";
import { MAX_TEXT_FILE_BYTES } from "./file-lines.js";
import { NEWLINE_PATH_EXCLUDES } from "./path-representable.js";
import { keepsUnicodeMode } from "./pattern.js";
import { rgTransportBudgetBytes } from "./rg-output.js";

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
  // `--engine=auto`：默认走 Rust 正则引擎，默认引擎编不过时退 PCRE2
  // （实测不限于 look-around / backreference：`\Z` / `\h` 这类 Rust 不认而
  // PCRE2 认的转义同样被它接住）。Node 侧是 JS `RegExp`，接受集与 PCRE2 相近，
  // 所以 `(?=hit)` 在 rg 路径不再 rc=2 失败、在 Node 路径正常命中 —— 少了这
  // 一行，同一个 pattern 的含义就取决于哪条引擎在跑，正是 D6 禁止的静默改
  // 语义。普通模式零开销（对比 `--pcre2` 强制全量换引擎）。
  //
  // 这不是「接受集完全对齐」：Rust / PCRE2 都编不过的（`\q`、`a{2,1}`）在 rg
  // 侧仍是 rc=2 typed 失败、Node 侧当字面量静默命中（见 `pattern.ts` 文件头
  // 的残留清单）。auto 只保证「rg 会接受的，Node 也接受」这一半。
  args.push("--engine=auto");
  // `--no-unicode`：判据是 `keepsUnicodeMode`（**唯一**模式判据，见
  // `pattern.ts`），此处是它的 rg 侧投影 —— Node 侧按同一判据决定要不要加
  // `u` flag。不加 `--no-unicode`（= 判据为 true）时 rg 留在 Unicode 模式：
  // `.` / 计数 quantifier 按 code point，`\s` 认 NBSP；Node 加 `u` 后同口径。
  // 加 `--no-unicode`（= 判据为 false）时 rg 切字节语义，把 `\d` / `\w` /
  // `\D` / `\W` / `\b` / `\B` 对齐到 JS 的 ASCII 类（实测 rg 默认 `\d` 吃
  // ٣٤、`\w` 吃 CJK、`\b` 把 `é` 当词字符），Node 侧则**不加** `u`。
  // 常开会打坏 `.` / `\s` / `\S`（实测 `--no-unicode` 下 `.` 退化成「一个
  // 字节」，`a.c` 反而不匹配 `aéc`），所以必须按 pattern 判。
  if (!keepsUnicodeMode(spec.pattern)) args.push("--no-unicode");
  // `--no-messages` 收掉**文件级**告警（不可读文件的 Permission denied、坏
  // 符号链接），但**不收**正则 / 用法错误。于是 rc=2 且 stderr 空 = 只是某个
  // 文件没读到（stdout 里的命中照常有效）；rc=2 且 stderr 非空 = 查询本身被
  // 拒。少了这道开关，一个不可读的邻居文件会让整次查询失败，而 Node 引擎
  // 只是跳过该文件 —— 两边对同一目录给出不同答案（SC9）。
  // `-H` 常开：`path` 指向单个文件时 rg 默认省掉文件名（只剩 `行号:内容`），
  // 与 paths / count 出法及 Node 引擎的 `path:line:text` 形状都不兼容。
  args.push("--null", "--color", "never", "--no-messages", "-H");
  // 遍历纪律：Node 扫（`walkFiles`）只看这两个目录名，不认 `.gitignore` /
  // `.ignore` / 隐藏文件。rg 默认相反（尊重 ignore、跳过隐藏）。两边不等价
  // 就是 SC9 失败 —— 且同一次查询「换台引擎就少半仓」是最坏的一种静默改
  // 语义。取「跟 Node 已有行为对齐」而不是「教 Node 读 ignore 规则」：
  // 后者要复刻 rg 的 gitignore 语法（取反 / 目录限定 / 层级作用域），是另
  // 一件工具的体量；`--no-ignore --hidden` 是一行且与既有语义一致。旧
  // Node 回退（ADR-0004 修订）本来就不跳过隐藏文件，因此这不是新放宽。
  args.push(
    "--no-ignore",
    "--hidden",
    "--glob",
    "!**/node_modules",
    "--glob",
    "!**/.git",
    ...NEWLINE_PATH_EXCLUDES.flatMap((glob) => ["--glob", glob])
  );
  // 遍历期的体积闸；显式点名的文件不受它约束（rg 语义），Node 侧同口径。
  args.push(`--max-filesize=${String(MAX_TEXT_FILE_BYTES)}`);
  // CRLF 对齐：Node 扫按 `\n` 切行后剥掉尾随 `\r`（`file-lines.splitLines`，
  // 旧 Node 回退亦然），于是 `foo$` 能命中 CRLF 行。rg 默认把 `\r` 当行内容，
  // 同一个 `foo$` 在 CRLF 文件上**一个都不中** —— 验收口径随引擎变。`--crlf`
  // 让 rg 把 CRLF 当行终止符，`$` / `.` 的边界与 Node 一致。行内容里的 `\r`
  // 由解析层剥掉（rg 仍原样回显），见 `rg-output.ts`。
  args.push("--crlf");
  if (spec.output === "content") {
    // 超长匹配行的两道闸：先让 rg 自己收口，再由投影层按 code point 收到
    // MAX_MATCH_LINE_COLUMNS（唯一权威）。第一道只为**传输量**存在 —— 少了
    // 它，rg 会把整行原样吐回来，缓冲一整行 1MB 文本才发现要截断。因此它的
    // 字节预算取 `rgTransportBudgetBytes`（= 4 倍 code point 上限，即 UTF-8
    // 单字符最大宽度）：rg 的触发按**字节**、切片按 **code point**，预算取满
    // 4 倍才让「rg 加了标记」不会伴随内容被切（见 `rg-output` 的实测说明）。
    // 预算若更小，`hit + 漢×1000`（3003 字节 / 1003 个 code point）会在 2000
    // 字节的线上触发，标记落进正文而 Node 侧原样保留 —— 同一行的字节数、
    // 正文、可复制内容全不同（D6/SC9）。投影层再把 rg 的标记剥掉后统一收口，
    // 两条引擎的最终形状因此只由权威口径决定。
    args.push(
      `--max-columns=${String(rgTransportBudgetBytes(maxColumns))}`,
      "--max-columns-preview"
    );
    if (spec.context > 0) args.push("-C", String(spec.context));
  }
  if (spec.ignoreCase) args.push("--ignore-case");
  if (spec.glob !== undefined) args.push("--glob", spec.glob);
  if (spec.type !== undefined) args.push("--type", spec.type);
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
