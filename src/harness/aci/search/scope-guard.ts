/**
 * 搜面范围闸（`specs/grep-wave-survive.md` SC5）：`path` 指向过大树、且调用方
 * 没有用**肯定 `glob`** 收窄时，在档位钟烧完之前就返回一条短 typed 错误，
 * 而不是把 default 档的 30s 一路空转到超时。
 *
 * 为什么闸取**文件数**而不是墙钟：实测（rg 15.1.0）同一棵 54,318 文件的树
 * `rg -l --max-filesize=1MiB` 用 17.8s（default 档的 60%），1,200 文件只要
 * 0.021s；墙钟阈值在快 / 慢主机上两头都会误判（17.8s 已经很接近 30s，慢一点
 * 的机器就穿档）。文件数与匹配成本在本工具的量级上近似线性（≈0.33ms/文件），
 * 所以闸用文件数：确定性、可测、与主机速度解耦；真撞上档位钟只是后盾。
 *
 * 上限 `GREP_SCOPE_FILE_LIMIT` = 10,000：按上面的实测外推
 * `17.8s × 10,000 / 54,318 ≈ 3.3s`，约 default 档的 11%，留出近 9 倍主机速度
 * 余量；计数本身走到 cap+1 即停（早停），10,000 文件的 Node 遍历实测 < 1s。
 *
 * 豁免 / 不豁免（两条引擎共用本模块，D6/SC9 要求同一个 `path` 同判）：
 *   - **显式单文件 `path`** 豁免：与 `node-scan.ts` 的体积闸豁免同源，点名一个
 *     文件只有一个候选，永远不会溢出。
 *   - **肯定 `glob`** 豁免：SC5 点名的「缩小 `glob`」是唯一收窄维度。
 *   - **否定 `glob`（如 `!node_modules`）不豁免**：它不缩小纳入集（`glob-match`
 *     的集合语义里只有肯定模式收窄），因此不降低遍历 / 匹配成本。
 *   - **`type` 不豁免**：按文件名筛命中的是**匹配**集，遍历范围不变（rg 的
 *     `--type` 仍要走完整棵树的 readdir），SC5 也只点名 `glob`。
 *   - **`head_limit` / `offset` / `output` 不豁免**：只切输出 / 改出法，不减
 *     搜索成本。
 *   - **宽放肯定 `glob`（`**` 一类）** 视为调用方的显式选择而放行；档位钟仍是
 *     后盾。区分「宽放」与「收窄」的正则需要语义启发式，收益不抵复杂度。
 *
 * 代价（call-time）：闸走 `walkFiles` 一次（命中 cap+1 即早停）作为引擎前的
 * 前置判定，**每个目录 `grep` 都付这一遍**，自带 rg 在场也照走 —— 两条引擎
 * 共用本模块是 D6/SC9「同一个 `path` 同判」的要求，无法按引擎跳过。裸 `path`
 * 也无法靠闸回退：一次只算文件数不算体积，目录多文件少的树仍可穿过闸门到
 * 档位钟去烧。所以档位钟仍是真实后盾，闸只是提前一拍。
 */

import { ToolExecutionError } from "../../errors.js";
import { isNegation } from "./glob-match.js";
import { toWorkspaceRelative, walkFiles } from "./node-scan.js";
import { isPathRepresentable } from "./path-representable.js";

/**
 * 搜索范围的文件数上限（SSOT：错误文案与测试都引用它，不在别处硬编码）。
 * 取值理由见文件头（由 54,318 文件的 17.8s rg 实测外推）。
 */
export const GREP_SCOPE_FILE_LIMIT = 10_000;

export interface ScopeGuardInput {
  readonly workspaceRoot: string;
  readonly searchRoot: string;
  /** 搜索根是显式点名的单个文件（与 `node-scan` 的体积闸豁免同判据）。 */
  readonly explicitFile: boolean;
  /** 调用方传入的 `glob`；肯定是收窄（豁免），否定不算。 */
  readonly glob: string | undefined;
  /** 测试接缝；缺席 → `GREP_SCOPE_FILE_LIMIT`。 */
  readonly limit?: number;
}

/**
 * 计数候选文件，超过上限即抛 typed 错误。
 *
 * 「候选文件」与 `node-scan.walkFiles` 同口径：跳过 `node_modules` / `.git`，
 * 跳过行协议不可表示的路径（含 `\n` / `\0`，rg 侧由 `NEWLINE_PATH_EXCLUDES`
 * 同样剔除）。不套用 `glob` / `type` 过滤 —— 遍历成本在过滤之前就付掉了，
 * 计数的是**范围**大小而非命中集大小。
 */
export async function assertScopeWithinLimit(
  input: ScopeGuardInput
): Promise<void> {
  if (input.explicitFile) return;
  if (input.glob !== undefined && !isNegation(input.glob)) return;
  const limit = input.limit ?? GREP_SCOPE_FILE_LIMIT;
  let count = 0;
  // 早停：超过上限立刻抛，不把整棵树走完再决定。
  for await (const absPath of walkFiles(input.searchRoot)) {
    const relPath = toWorkspaceRelative(input.workspaceRoot, absPath);
    if (!isPathRepresentable(relPath)) continue;
    count += 1;
    if (count > limit) throw tooLarge(limit);
  }
}

function tooLarge(limit: number): ToolExecutionError {
  return new ToolExecutionError(
    `grep: search scope is too large (more than ${String(limit)} files under the given path); add a narrowing glob (for example glob: "**/*.ts") or search a subdirectory`
  );
}
