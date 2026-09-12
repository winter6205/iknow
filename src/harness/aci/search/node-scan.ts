/**
 * Node 扫引擎（D6 / SC9 / ADR-0089）。
 *
 * 自带引擎起不来（安装根二进制不存在，或 spawn 得 ENOENT / 无法执行）时
 * 启用：Node 遍历文件 + 用 `RegExp` 跑 `compilePattern` 编得过的 pattern，
 * 调用仍成功。**不**少功能成功（直接拒绝），**不**许 exec PATH 上的 `rg`。
 * 命中集允许与 rg 不同 —— Node 不模仿 rg 的默认引擎拒绝集（lookaround /
 * `\d` 类等在无 rg 机器上可能更宽，文档与测试视为特性，不是漏测）。
 *
 * 单点职责：**产出与 rg 引擎同形的原始命中**（`LineHit[]` 已按 (path,line)
 * 稳定排序）。分页 / 投影 / 行窗过滤是共用层的事，本模块不重复实现 ——
 * 两条引擎的下游共用因此来自「喂进同一条流水线」而不是两套镜像逻辑。
 *
 * 收窄（D4）走共享层：`type` 用 `type-table.ts` 的 rg 原词表（按文件名判），
 * `glob` 用 `glob-match.ts` 的 rg 同口径匹配。二者与 rg 引擎的 `--type` /
 * `--glob` 是同一语义的两条实现。
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { fileNameMatchesType } from "./argv.js";
import { isNegation, matchesGlobSet } from "./glob-match.js";
import { readWorkspaceLines } from "./file-lines.js";
import { isPathRepresentable } from "./path-representable.js";
import { truncateMatchContent } from "./rg-output.js";
import type { LineHit, QuerySpec } from "./types.js";

export interface NodeScanInput {
  readonly spec: QuerySpec;
  readonly workspaceRoot: string;
  readonly searchRoot: string;
  /** 已编译的主 pattern（坏正则在 `pattern.ts` 已 typed 拒绝）。 */
  readonly regex: RegExp;
}

/** 全量命中（未排序；调用方走 sort → paginate → project）。 */
export async function nodeScan(input: NodeScanInput): Promise<LineHit[]> {
  const hits: LineHit[] = [];
  // 搜索根是**显式点名的单个文件**时，体积闸与 `glob` / `type` 都让路 ——
  // rg 的 `--max-filesize` 只在递归遍历期生效、用户 glob/type 也不作用于
  // 显式文件参数（均实测）。Node 侧若照旧拦，同一个 `path` 的答案就随引擎变。
  const explicitFile = await isFile(input.searchRoot);
  for await (const absPath of walkCandidates(input, explicitFile)) {
    // 路径必须是 **workspace 相对**：SC4 要求模型可见行皆相对路径，且 D4 的
    // `glob` 锚定匹配（`src/*.ts`）按相对路径判段。
    //
    // `..` 前缀**不剔除**：identity root 是 workspace 之外那条经
    // `resolveWithinRoot` 放行的只读根，它的命中天然长成 `../<identity>/x`。
    // 在这里按前缀剔除会让改绑后的 grep 读面静默回空（而 rg 路径照常返回）
    // —— 同一个 path 参数的答案取决于哪条引擎在跑。越界已由 resolveSearchRoot
    // 的 containment 校验挡在入口，遍历本身只走 searchRoot 之下。
    const relPath = toWorkspaceRelative(input.workspaceRoot, absPath);
    // 行协议不可表示的路径直接跳过：含 `\n` 的路径会把自己的记录拆成两条
    // （见 `path-representable.ts`）。跳过而不是报错 —— rg 侧遍历期用排除
    // glob 静默跳过，两边必须同样「看不见」，否则同一个目录的条数、`total:`
    // 与命中集又会随引擎变（D6/SC9）。
    if (!isPathRepresentable(relPath)) continue;
    if (!explicitFile && !passesFilters(relPath, input.spec)) continue;
    const lines = await readWorkspaceLines(input.workspaceRoot, relPath, {
      allowOversize: explicitFile,
    });
    if (lines === null) continue;
    collectHits(relPath, lines, input.regex, hits);
  }
  return hits;
}

/** 搜索根是否指向一个存在的文件（决定「显式文件」豁免是否适用）。 */
async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info !== null && info.isFile();
}

/**
 * 候选文件：`path` 指向文件时就是它本身，指向目录时递归展开。
 *
 * 只递归目录会让 `path: "a.ts"` 静默回空 —— rg 那边是命中的，两条引擎对同
 * 一个参数给出不同答案（SC9）。所以先 stat 判型，是文件就直接作为唯一候选。
 */
async function* walkCandidates(
  input: NodeScanInput,
  explicitFile: boolean
): AsyncGenerator<string> {
  if (explicitFile) {
    yield input.searchRoot;
    return;
  }
  yield* walkFiles(input.searchRoot);
}

/**
 * 收窄：`glob` 与 `type` 并列（D4、D3）。
 *
 * rg 的真实规则（逐条实测，不是文档推断）：**只要给了一个肯定 glob，`--type`
 * 就完全不参与判定** —— glob 决定纳入集，type 被静默忽略。原 Node 侧实现是
 * AND（两者都要满足），同一查询 `{type:"ts", glob:"sub/*"}` 在 rg 侧回
 * `sub/a.ts` + `sub/b.js`（`sub/b.js` 不是 `.ts` 也进来，因为 glob 说了算），
 * Node 侧只回 `sub/a.ts`（D3）。
 *
 * 只有**否定** glob 时 type 仍然生效：`--type ts --glob` 加一条排除
 * node_modules 的否定 glob，实测 = `sub/a.ts,top.ts`（type 先筛，否定 glob
 * 再排除），与「只给那条否定 glob」的 4 条不同。
 *
 * 本函数按 rg 的实测规则实现，两条引擎因此同判。语义上这意味着「`type` 与
 * `glob` 不是可以叠加的收窄维度」：要表达交集请写成一条 `sub/*.ts`。
 * 注意这与 D2 的顺序契约是同一套机制的两面 —— D2 让工具的排除 glob 成为
 * 最终胜负，D3 让用户 glob 对 type 的覆盖与 rg 一致。
 */
function passesFilters(relPath: string, spec: QuerySpec): boolean {
  const { type, glob } = spec;
  if (type === undefined && glob === undefined) return true;
  if (glob === undefined) return fileNameMatchesType(baseName(relPath), type!);
  if (type === undefined) return matchesGlobSet(relPath, [glob]);
  // 并列：肯定 glob 在场 → type 让位（rg 实测）；只有否定 glob → type 仍生效。
  if (!isNegation(glob)) return matchesGlobSet(relPath, [glob]);
  return (
    fileNameMatchesType(baseName(relPath), type) &&
    matchesGlobSet(relPath, [glob])
  );
}

function collectHits(
  relPath: string,
  lines: ReadonlyArray<string>,
  regex: RegExp,
  out: LineHit[]
): void {
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) {
      out.push({
        path: relPath,
        line: i + 1,
        text: truncateMatchContent(lines[i]!),
      });
    }
  }
}

/** 递归产出 workspace 相对路径（posix 分隔符），跳过 node_modules / .git。 */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** `searchRoot` 之外 → 保持 `../` 前缀（与 `relative()` 语义一致）。 */
export function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** 供调用方把绝对路径折成 workspace 相对（posix 形态）。 */
export function toWorkspaceRelative(
  workspaceRoot: string,
  absPath: string
): string {
  const rel = relative(workspaceRoot, absPath);
  return rel.split("\\").join("/");
}
