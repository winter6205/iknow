/**
 * src/tui/subagent-message-lines.ts
 *
 * specs/tui-subagent-transcript-live.md（实施源；计划 = plans/tui-subagent-
 * transcript-live.md，完成态修订 = plans/strategy-window-and-subagent-card.md
 * T3）—— **卡级两行投影**：把一个子代理 join 回会话 transcript 里派它的那张
 * `spawn_subagent` 卡。live 第 1 行 `{role} running...`、第 2 行 dim
 * `taskPreview`；该 worker **completed** 后概述留下、第 1 行去 running 只作
 * 身份、其下加逐字绿 `✓ Done`（锁句 2 reopen）。join 键 =
 * `SubagentInfo.toolUseId`（= 那次 spawn 的 tool_use id，与卡侧同一 id 空间）。
 *
 * 取代 = Slice D / SC14 的「live 列表整体铺开」投影（`projectSubagentMessageLines`
 * / `subagentMessageRowCount`）与 prompt 上方身份条 —— 位置改判给会话卡后，
 * 「每个 live 子代理恒占两行」不再是投影的输出形状，卡只认自己的关联键。
 *
 * 本文件是 **React-free 纯 TS**（不 touch React / OpenTUI）：投影可单测直驱，
 * 渲染由宿主的单一渲染面（`subagent-card-view.tsx`）承担 —— live tail 与
 * 历史卡两宿主不得各写一套模板。
 *
 * 边界（spec「Input-contract classes」前两行）：
 *   - empty：空数组 / `toolUseId` 缺省或空串或纯空白 → `null`（无关联键，
 *     不借用别的 worker 的预览 —— 锁句 6 的 `// EXIT:` 面）；
 *   - negative：无匹配 / 匹配到 `failed` → `null`（锁句 5：failed 走该卡既有
 *     failure overlay，不走绿 `✓ Done`）；role 缺省 / 空串 / 纯空白 →
 *     catalog fallback（永不输出「子代理」字面值）；
 *   - overflow：live 两行各自按 cols 视觉宽度截断（CJK-safe），永不换行；
 *     `cols <= 0` → 1 列预算。completed 的概述行同样受列宽收口（概述回到
 *     页面上就必须和 live 一样不越列）；完成标记 `✓ Done` 是逐字固定面
 *     （锁句 2 reopen），不做宽度收口 —— 字面文本优先于列宽美学，宿主
 *     `wrapMode="none"` 裁边；
 *   - concurrent：纯函数，每次投影取调用时刻入参，无历史残留；两个 live
 *     worker 各取自己 join 的 `taskPreview`，互不串；重复 `toolUseId` 时
 *     列表序首个胜（确定性）；
 *   - exception：不读 `startedAt` / `endedAt` / `summary`（非法 ISO 不影响
 *     投影）；缺 / 空 `taskPreview` → 概述行以空串占位，行账不塌陷。
 */
import type { SubagentInfo } from "../harness/subagent/manager.js";
import { clipOneLineVisual } from "./tool-summary.js";
import { SUBAGENT_ROLE_FALLBACK } from "../shared/tool-line.js";

/**
 * 缺 role 时的 catalog fallback。与 `resolveSubagentRoleFromInput`
 * （`src/shared/tool-line.ts:119`）的 `SUBAGENT_ROLE_FALLBACK` 同值同源 ——
 * 工具卡与两行投影对同一子代理不得各印一个角色名。
 */
export const IDENTITY_FALLBACK_ROLE = SUBAGENT_ROLE_FALLBACK;

/** live 第 1 行固定后缀（spec 原文 `running...`，三个点）。completed 不带
 *  该后缀 —— 锁句 2 reopen 后第 1 行只作身份。join 不上的 spawn 卡不走本
 *  后缀 —— 它落 `formatToolStatusLine` 的无点形态（`explore running`）。 */
const RUNNING_SUFFIX = " running...";

/** completed 的完成标记（锁句 2 reopen：概述保留、其下逐字绿 `✓ Done`）。
 *  与面板 `●` / `✓` 同为几何字形（spec #146:86 纪律），不用 emoji。 */
const DONE_MARKER = "✓ Done";

/**
 * live 子代理的**唯一判据**：`starting` + `running`（SC14 / SC15 行序合同）。
 *
 * 面板的 live 行序（`projectSubagentLines`）、Ctrl+X 强杀分派
 * （`subagent-kill.ts`）与 app 的 focus 计数共用本谓词 —— 判据在多处各写
 * 一遍字面量时，任何一处漂移都会让「聚焦行 ↔ 杀谁」错位。终态
 * （completed / failed）不算 live：终态窗口语义归面板。
 *
 * 放在本模块（React / OpenTUI 无关的纯函数层）而不是面板 .tsx：kill 分派与
 * 投影都能 import 它而不把 OpenTUI 拖进各自的依赖图。
 *
 * 注：卡级投影不看本谓词 —— 它按 `state` 三分类（live / completed / failed），
 * 因为 completed 的卡仍要画概述 + 绿 `✓ Done`（锁句 2 reopen）。
 */
export function isLiveSubagent(info: SubagentInfo): boolean {
  return info.state === "starting" || info.state === "running";
}

/**
 * 单活子代理的 role 投影（钉死 negative 决策）：
 *   - role 存在且非空（trim 后长度 > 0）→ role.trim()；
 *   - role 缺席 / 空串 / 纯空白 → `IDENTITY_FALLBACK_ROLE`；永不输出
 *     「子代理」字面值。
 */
export function resolveIdentityRole(info: SubagentInfo): string {
  const role = info.role;
  if (role === undefined) return IDENTITY_FALLBACK_ROLE;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : IDENTITY_FALLBACK_ROLE;
}

/** 卡级投影（spec「Card contract」的单一形状）。 */
export interface SubagentCardLines {
  /** 第 1 行：live → `{role} running...`；completed → 仅身份，不含
   *  `running...`（锁句 2 reopen）。 */
  readonly roleLine: string;
  /** 第 2 行：live 与 completed 均为按 cols 截断的 `taskPreview`
   *  （空串 = 空行占位）。completed 不得用它顶替概述。 */
  readonly detailLine: string;
  /** 第 3 行（仅 completed）：逐字 `✓ Done`；live 缺席（undefined）。 */
  readonly doneLine?: string;
  /** 完成态标志：true → `doneLine` 在场，宿主以 `tuiPalette.add`（绿）画它。 */
  readonly done: boolean;
}

/**
 * join 键归一化：缺省 / 空串 / 纯空白都不是合法关联键 → `null`。
 * 两侧（入参 `toolUseId` 与条目字段）同口径 —— 空白差异不制造假 join。
 */
function normalizeCorrelator(toolUseId: string | undefined): string | null {
  if (toolUseId === undefined) return null;
  const trimmed = toolUseId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 单卡拼装（live / completed）。调用方保证 `state !== "failed"`。 */
function buildCard(info: SubagentInfo, budget: number): SubagentCardLines {
  const role = resolveIdentityRole(info);
  if (info.state === "completed") {
    // 锁句 2 reopen：概述留下（与 live 同口径按 cols 截断），第 1 行去
    // running 只作身份，其下追加逐字 `✓ Done`（不做宽度收口）。
    return {
      roleLine: clipOneLineVisual(role, budget),
      detailLine: clipOneLineVisual(info.taskPreview, budget),
      doneLine: DONE_MARKER,
      done: true,
    };
  }
  return {
    roleLine: clipOneLineVisual(`${role}${RUNNING_SUFFIX}`, budget),
    detailLine: clipOneLineVisual(info.taskPreview, budget),
    done: false,
  };
}

/**
 * 单卡投影：join 到 `toolUseId` 的那个子代理的卡级两行。
 *
 * 返回 `null` 的所有情形（宿主据此回落既有单行标题 / failure overlay）：
 *   - `toolUseId` 缺省 / 空串 / 纯空白 —— EXIT: 无关联键，不借用别的 worker
 *     的预览（锁句 6）；
 *   - 无条目对上该键；
 *   - 对上该键的条目全是 `failed` —— 锁句 5：failed 不进 join，归该卡
 *     failure overlay。
 *
 * 实现直接查 `subagentCardLinesMap`：两函数共用「缺键 / failed 整条跳过、
 * 重复键取列表序首个」这一条规则，不各写一遍 —— 两份实现一旦漂移，live 宿主
 * （逐卡投影）与历史宿主（map）会对同一 worker 画出不同行。
 */
export function projectSubagentCardLines(
  subagents: ReadonlyArray<SubagentInfo>,
  toolUseId: string | undefined,
  cols: number
): SubagentCardLines | null {
  const key = normalizeCorrelator(toolUseId);
  if (key === null) return null; // EXIT: 无关联键，不借流（锁句 6）
  return subagentCardLinesMap(subagents, cols).get(key) ?? null;
}

/**
 * 投影输入的**内容签名**（`useMemo` 依赖用）。app 层 1Hz 轮询每次都
 * `setSubagents` 一个新数组 —— 以数组引用做依赖会让 `subagentCardLinesMap`
 * 每秒产新 Map，下游 memo 化的历史消息块（`MessageBlocks`）随之每秒全量
 * 重建元素树（history-rerender-cost 同类回归）。签名字段 = 投影实际读取的
 * 全部字段（`toolUseId` / `state` / `role` / `taskPreview`），漏一个就会
 * 让缓存返回过期卡片。
 *
 * 编码走 `JSON.stringify` 的嵌套数组：字段内的任意字符（含引号 / 逗号 /
 * 控制符）都被转义，元组到签名是单射。手拼分隔符做不到这点 —— role
 * （`subagent_type` 入参）与 taskPreview（`def.task`）都是模型给的任意
 * 字符串，含分隔符时会撞成同一签名，memo 返回过期卡片。JSON 同时保证源码
 * 里不出现字面控制字节（字面 NUL 会让 git 把本文件当二进制，diff 与 rg
 * 双双失明）。
 */
export function subagentCardsKey(
  subagents: ReadonlyArray<SubagentInfo>
): string {
  return JSON.stringify(
    subagents.map((info) => [
      info.toolUseId ?? "",
      info.state,
      info.role ?? "",
      info.taskPreview,
    ])
  );
}

/**
 * 逐卡 map（key = `toolUseId`）：历史卡宿主一次取全，按卡自己的 id 查表 ——
 * 避免每卡一次线性扫描。
 *
 * 跳过规则与单卡投影同源：缺 / 空 `toolUseId` 的条目整体跳过（不入 map，
 * 不占任何 key），`failed` 条目整体跳过（锁句 5），重复键列表序首个胜
 * （确定性 —— 后到者不覆盖）。live 与 completed 都入 map（completed 的卡
 * 仍要画概述 + 绿 `✓ Done`）。
 */
export function subagentCardLinesMap(
  subagents: ReadonlyArray<SubagentInfo>,
  cols: number
): ReadonlyMap<string, SubagentCardLines> {
  const budget = Math.max(1, cols);
  const out = new Map<string, SubagentCardLines>();
  for (const info of subagents) {
    const key = normalizeCorrelator(info.toolUseId);
    if (key === null) continue; // EXIT: 无关联键的条目不入 map
    if (info.state === "failed") continue; // 锁句 5
    if (out.has(key)) continue; // 列表序首个胜
    out.set(key, buildCard(info, budget));
  }
  return out;
}
