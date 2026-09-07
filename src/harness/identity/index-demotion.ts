/**
 * T5 / ADR-0046 Decision 2 + spec disclosure-index-align Does #6 — 索引降档
 * 判定层(纯逻辑)。
 *
 * 治理对象**只有两类索引条目**:`<mcp_name_directory>` 的工具行与
 * `<available_skills>` 的 skill 行。闸门 = 这两段**合计** countTokens 实测
 * 超过端点 contextWindow 的 10%(阈值由调用方算好传入;禁 chars/4 估算)。
 * 超阈时按条目渲染体积**从大到小**剥描述、只留名字 —— 名字永不删、段永不
 * 缺席(降档后的仅名字条目由模型经 `tool_search` / `skill({name})` 补描述,
 * 见 spec ASSUMPTIONS #4)。
 *
 * 不参与本降档的面:
 *   - `<deferred_internal_tools>`(schema 退场内建件,T4 的名+描述形态)——
 *     ADR-0046 Decision 2 钉死「退场内建不参与剥描述」,故本模块的入参里
 *     根本没有这一类,不存在误剥的路径。
 *   - 内建 schema 退场梯子本身(`aci/tool-overflow.ts`)—— 那是另一档治理,
 *     调用方先跑退场、再跑本降档。
 *
 * 为什么与 `runOverflowJudge` 分两次实测:退场梯子的判定量是**整个首轮
 * 请求面**(tools schema + system),而本闸门的判定量按 spec 是**索引两段
 * 合计**。同一次实测拿不出「索引合计」这个量,合并会把闸门语义换成
 * 「整个 prompt 超阈」—— 与 operator 终锁的闸门定义不同。故复用同一
 * countTokens 来源与同一时点(装配期首轮一次)、但各测各自的量。
 *
 * 失败合同(与 `tool-overflow.ts` 同款 skip 语义):countTokens 抛错 / 返回
 * 非有限数或负数 → **整体跳过本会话**(数据原样返回,不留半剥态),由调用方
 * `console.warn` 一行,不抛错、不重试。
 *
 * 纯逻辑:不绑 build-engine / 不读 env。输入 = 两类索引快照 + 阈值 +
 * countTokens 闭包;输出 = 降档后的两类快照 + 被降档名单 + reason。
 */

import {
  mcpNameDirectorySegment,
  shortToolDescription,
  skillsSegment,
  type McpServiceSummary,
  type SkillSummary,
} from "./assemble.js";

/** 索引闸门的实测闭包:入参 = 当前两段渲染文本,返回实测 token 数或抛错。
 *  调用方负责把它接到端点 countTokens(SDK `messages.countTokens`)。 */
export type CountIndexTokensFn = (indexText: string) => Promise<number>;

export interface IndexDemotionInput {
  /** MCP 名字目录快照(firstTurnReady 后冻结的那一份)。非 connected 服务
   *  由渲染层过滤,本模块的候选 derivation 用同一过滤规则。 */
  readonly mcp: ReadonlyArray<McpServiceSummary>;
  /** `<available_skills>` 快照。disabled 项由渲染层过滤,候选 derivation 同。 */
  readonly skills: ReadonlyArray<SkillSummary>;
  /** 阈值 = contextWindow * 0.1(调用方算好传入,本模块不读 env)。 */
  readonly threshold: number;
  readonly countTokens: CountIndexTokensFn;
}

export type IndexDemotionReason =
  /** 无可剥条目(两段皆空 / 全部本就裸名)→ 零实测、零动作。 */
  "no_index" | "no_overflow" | "demoted" | "countTokens_failed";

export interface IndexDemotionResult {
  readonly reason: IndexDemotionReason;
  readonly mcp: ReadonlyArray<McpServiceSummary>;
  readonly skills: ReadonlyArray<SkillSummary>;
  /** 被剥成仅名字的条目名(MCP 工具名 / skill 名)。 */
  readonly demoted: ReadonlyArray<string>;
  readonly cause?: unknown;
}

/** 索引两段的渲染 SSOT 拼接 —— 实测面 = 模型真正看到的这两段文本。
 *  `<deferred_internal_tools>` 刻意不在内(不参与本闸门,也不参与剥描述)。 */
export function renderIndexText(
  mcp: ReadonlyArray<McpServiceSummary>,
  skills: ReadonlyArray<SkillSummary>
): string {
  const parts: string[] = [];
  const directory = mcpNameDirectorySegment(mcp);
  if (directory !== undefined) parts.push(directory);
  // 空清单时段文本是固定的 "No skills installed" —— 不承载任何可剥描述,
  // 计入实测只是噪声,故与渲染层的"有 skill 才有内容"对齐后再计入。
  if (skills.some((s) => !s.disabled)) parts.push(skillsSegment(skills));
  return parts.join("\n\n");
}

/** 候选条目:剥描述能真正减面积的那些(渲染后带描述的行)。 */
interface Candidate {
  readonly name: string;
  /** 渲染体积 = 该条目在段里那一行的字符数(MCP 走 120 字短描述截断后的
   *  实际形态,skill 走完整 description)—— "从大到小"的排序键。 */
  readonly size: number;
}

export async function runIndexDemotion(
  input: IndexDemotionInput
): Promise<IndexDemotionResult> {
  const unchanged = { mcp: input.mcp, skills: input.skills } as const;
  const candidates = deriveCandidates(input);
  if (candidates.length === 0) {
    return { reason: "no_index", ...unchanged, demoted: [] };
  }
  const first = await measure(input.countTokens, input.mcp, input.skills);
  if (!first.ok) {
    return {
      reason: "countTokens_failed",
      ...unchanged,
      demoted: [],
      cause: first.cause,
    };
  }
  if (first.value <= input.threshold) {
    return { reason: "no_overflow", ...unchanged, demoted: [] };
  }
  // 从大到小逐件剥,每剥 1 件重测 1 次。
  const stripped = new Set<string>();
  const demoted: string[] = [];
  for (const candidate of candidates) {
    stripped.add(candidate.name);
    demoted.push(candidate.name);
    const mcp = stripMcp(input.mcp, stripped);
    const skills = stripSkills(input.skills, stripped);
    const next = await measure(input.countTokens, mcp, skills);
    if (!next.ok) {
      // 失败 = 跳过本会话:半剥态不落地(数据原样),与 tool-overflow skip
      // 语义一致 —— 会话内索引形态要么全带描述、要么是一次判定的定稿。
      return {
        reason: "countTokens_failed",
        ...unchanged,
        demoted: [],
        cause: next.cause,
      };
    }
    if (next.value <= input.threshold) {
      return { reason: "demoted", mcp, skills, demoted };
    }
  }
  // 剥光仍超阈 → 接受超阈(ASSUMPTIONS #10):不删名、不剥内建描述。
  return {
    reason: "demoted",
    mcp: stripMcp(input.mcp, stripped),
    skills: stripSkills(input.skills, stripped),
    demoted,
  };
}

type Measured =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly cause: unknown };

async function measure(
  countTokens: CountIndexTokensFn,
  mcp: ReadonlyArray<McpServiceSummary>,
  skills: ReadonlyArray<SkillSummary>
): Promise<Measured> {
  let value: number;
  try {
    value = await countTokens(renderIndexText(mcp, skills));
  } catch (cause) {
    return { ok: false, cause };
  }
  if (!Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      cause: new Error(`countTokens returned non-finite: ${value}`),
    };
  }
  return { ok: true, value };
}

/**
 * 候选 derivation:两类条目同池排序(spec Does #6「从大到小」是对**这两类
 * 条目合计**的一个次序,不是各类内部各排一轮)。
 *   - MCP:仅 connected 服务(与 `mcpNameDirectorySegment` 过滤同源)、
 *     短描述非空的工具行;
 *   - skill:非 disabled(与 `skillsSegment` 过滤同源)、description 非空。
 * 体积相同 → 按名字字母序(降档结果字节确定,守 KV 缓存稳定契约)。
 */
function deriveCandidates(input: IndexDemotionInput): ReadonlyArray<Candidate> {
  const out: Candidate[] = [];
  for (const service of input.mcp) {
    if (service.state !== "connected") continue;
    for (const tool of service.tools) {
      const short = shortToolDescription(tool.description);
      if (short === undefined) continue;
      out.push({ name: tool.name, size: `- ${tool.name}: ${short}`.length });
    }
  }
  for (const skill of input.skills) {
    if (skill.disabled) continue;
    const description = skill.description?.trim();
    if (description === undefined || description.length === 0) continue;
    out.push({
      name: skill.name,
      size: `${skill.name}: ${skill.description}`.length,
    });
  }
  return out.sort((a, b) =>
    b.size !== a.size ? b.size - a.size : a.name.localeCompare(b.name)
  );
}

/** 剥描述 = 去掉 description 字段;名字与服务归属原样(名字永不删)。 */
function stripMcp(
  mcp: ReadonlyArray<McpServiceSummary>,
  stripped: ReadonlySet<string>
): ReadonlyArray<McpServiceSummary> {
  return mcp.map((service) => ({
    ...service,
    tools: service.tools.map((tool) =>
      stripped.has(tool.name) ? { name: tool.name } : tool
    ),
  }));
}

function stripSkills(
  skills: ReadonlyArray<SkillSummary>,
  stripped: ReadonlySet<string>
): ReadonlyArray<SkillSummary> {
  return skills.map((skill) => {
    if (!stripped.has(skill.name)) return skill;
    // description 字段整体去掉 → `skillsSegment` 降级渲染为裸名行(与 MCP
    // 目录 / 退场内建段的"描述缺席 → 只渲染名字"同一规则,不是第二套判定)。
    const { description: _dropped, ...rest } = skill;
    return rest;
  });
}
