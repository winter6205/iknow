/**
 * src/tui/slash.ts
 *
 * #343 T6-A 迁移：从 archive/tui-ink/src/slash.ts 迁回 src/tui/。逻辑与原版
 * 一致（#146 TUI 自建 slash 词表 + 解析 + Tab 补全 + hint 行）；仅文件头注释
 * 更新为本次迁移说明。纯 TS 模块，无 ink / OpenTUI 依赖。
 *
 * 词表：/sessions /new /quit /exit /help /info /thinking /effort /memory
 * /compact /continue /rewind /mcp /graph /config /model（以 VOCABULARY 为准
 * —— 不在此重复条数，条数是漂移源）。/reset 不在词表内即天然不可达（Q5c
 * 废除）。
 * rev 2026-09-13:ADR-0092 / SC13 加 /config（文件系统隔离档切换;值域与
 * 文案单点在 harness/sandbox/fs-mode.ts;三入口 chat / TUI / serve 同语义）。
 * rev 2026-09-14:#1010 加 /model（provider/model picker）。
 * rev 2026-08-11:删 /profile（首启引导由 agent 自己 rm BOOTSTRAP.md 完成,
 * 不再需要宿主斜杠钩子）；#366 加 /rewind；#337/#361 加 /mcp。
 * rev 2026-08-12:#377 系列加 /effort（思考强度调整）。
 * rev 2026-08-26:D-α V1 加 /graph（图模式 overlay 的非 TTY 对等物,值域与
 * 文案单点在 harness/graph/mode.ts;三入口 chat / TUI / serve 同语义）。
 * /effort help 文案由 ADJUSTABLE_EFFORT_LEVELS 派生（不硬编码第二份列表）。
 *
 * 解析规则：输入 trim 后以 "/" 开头先过词表；未命中 → unknown（UI 提示）；
 * 不以 "/" 开头 → message（普通消息）。
 *
 * Tab 补全 + 候选提示词（live filtering）：
 *  - slashSuggestions：按当前输入前缀过滤并保持词表原顺序。
 *  - slashComplete：三态 —— 唯一匹配 → `/{cmd} `；0 匹配 → null；≥2 匹配
 *    → 候选补全形的最长公共前缀（有进展才返回，bash 式部分补全，详见
 *    函数 doc comment）。
 *  - slashHintLines：渲染用一行短描述，便于在输入框下方紧凑展示。
 *
 * #337 Phase C（slash 扩展 + skill 加载发送）：
 *  - 判别联合 `SlashCandidate` = 静态命令 | skill（Phase D 复用）；
 *  - `slashSuggestions(input, skills?)` 混显静态命令（词表前缀过滤，保持在前）
 *    与 skill 名（大小写不敏感前缀过滤，在后）——确定性顺序；
 *  - `slashComplete(input, skills?)` 跨「静态命令 + skill」唯一匹配补全；
 *  - `parseSkillLoad(raw, skills)` 精确命中 skill 名 → {name, remainder}，
 *    命中静态命令 / 不匹配 → undefined（静态命令优先）。发送语义见 app.tsx。
 *    SkillEntryLike = {name, description?, aliases?} 最小投影，slash.ts 不依赖
 *    harness catalog 类型（解耦，便于单测注入扁平对象）。
 *
 * spec tui-skill-slash-catalog（skill bare alias）：
 *  - 匹配认**规范名或唯一裸名别名**（大小写不敏感），出条/展示/补全恒用规范名
 *    （invariant 2）；别名由调用方从 catalog 投影（app.tsx：`stripNamespace`
 *    + `get(bare) === entry` 唯一性判据），slash.ts 不自行拆 `:`（invariant 1）。
 *  - 静态词表在精确碰撞时优先（invariant 4）；remainder 按输入 token 长度切
 *    （invariant 5，复用 slashRemainder）。
 */

import { THINKING_EFFORT_VALUES } from "../session-api/contract.js";
import type { ThinkingEffortWire } from "../session-api/contract.js";
import {
  slashHeadPrefix,
  slashTailRemainder,
} from "../harness/skill/catalog.js";

export type TuiSlashCommand =
  | "sessions"
  | "new"
  | "quit"
  | "exit"
  | "help"
  | "info"
  | "thinking"
  | "effort"
  | "memory"
  | "compact"
  | "continue"
  | "rewind"
  | "mcp"
  | "graph"
  | "config"
  | "model";

export type SlashParseResult =
  | { kind: "command"; command: TuiSlashCommand }
  | { kind: "unknown"; raw: string }
  | { kind: "message"; text: string };

/** skill 最小投影（避免 slash.ts 强依赖 harness catalog 类型；调用方传入
 *  skillCatalog.available() 同形扁平对象即可）。
 *
 *  `aliases`（spec tui-skill-slash-catalog）：插件技能的**唯一**裸名别名
 *  —— 调用方从 catalog 投影（`stripNamespace` + `get(bare) === entry` 唯一
 *  性判据）后塞入；slash.ts 只消费，不自行拆 `:`（spec invariant 1）。缺省 /
 *  空数组 = 无别名（catalog 未登记或冲突被丢）。 */
export interface SkillEntryLike {
  readonly name: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
}

/** slash 候选判别联合：静态命令 | skill（Phase C 引入，Phase D 复用）。
 *  顺序约定：静态命令在前、skill 在后（slashSuggestions 确定性输出）。
 *  skill 臂的 `name` 恒为**规范名**（invariant 2：展示与补全都用
 *  `plugin:skill`）；`aliases` 只参与匹配与 exactness 判定，不出条、不显示。 */
export type SlashCandidate =
  | { kind: "command"; command: TuiSlashCommand }
  | {
      kind: "skill";
      name: string;
      description?: string;
      aliases?: ReadonlyArray<string>;
    };

const VOCABULARY: ReadonlySet<string> = new Set<TuiSlashCommand>([
  "sessions",
  "new",
  "quit",
  "exit",
  "help",
  "info",
  "thinking",
  "effort",
  "memory",
  "compact",
  "continue",
  "rewind",
  "mcp",
  "graph",
  "config",
  "model",
]);

/** 解析输入框内容；空/纯空白 → message（调用方按空输入忽略）。 */
export function parseTuiInput(raw: string): SlashParseResult {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "message", text };
  const head = text.split(/\s+/, 1)[0] ?? text;
  const name = head.slice(1).toLowerCase();
  if (VOCABULARY.has(name)) {
    return { kind: "command", command: name as TuiSlashCommand };
  }
  return { kind: "unknown", raw: text };
}

/** /help 词表文案（无 emoji；中文与仓库 usage 文案风格一致）。
 *  #337 Phase C：`/<skill-name>  加载技能`（skill 名由调用方动态拼入，不参与
 *  静态词表）。#361 Phase D：/mcp 真描述（词表含 rewind，/mcp 末位与
 *  slashSuggestions 的词表序一致）。#377 系列加 /effort（紧邻 /thinking 之后）。 */
export function helpLines(
  skillNames?: ReadonlyArray<string>
): ReadonlyArray<string> {
  const skillLines =
    skillNames !== undefined && skillNames.length > 0
      ? skillNames.map((name) => `/${name}  加载技能`)
      : [];
  return [
    "/sessions  打开会话列表（↑↓ 选择，Enter 打开，Esc 返回）",
    "/new       新建会话",
    "/mcp       查看 MCP 服务看板（r 重载，Esc 返回）",
    "/info      当前会话元信息",
    "/help      本词表",
    "/thinking  切换思考开关（开/关模型的思考）",
    `/effort    调整思考强度（${ADJUSTABLE_EFFORT_LEVELS.join("/")}；缺省/关闭=自适应）`,
    "/memory    自动记忆与 Dream 开关",
    "/compact   Compact context (keep tail, trim early messages)",
    "/continue  续跑未完成的工具环（不追加新任务）",
    "/rewind    回退到更早的回合（选择锚点后确认）",
    "/graph     图模式开关（on|off|status；下一次 run() 装配生效）",
    "/config    文件系统隔离档（status|fs global|fs workspace；下一次 bash 调用生效）",
    "/model     切换模型（provider/model；下一轮生效）",
    "/quit      退出（别名 /exit）",
    ...skillLines,
    "Ctrl+C     打断前台运行中的 turn",
    "Ctrl+O     折叠/展开思考面板",
    "鼠标拖选    选中文本 → 右键复制到剪贴板",
  ];
}

/** 一行短描述（用于输入框下方紧凑提示）。 */
const HINT_DESCRIPTIONS: Record<TuiSlashCommand, string> = {
  sessions: "打开会话列表",
  new: "新建会话",
  info: "当前会话元信息",
  help: "本词表",
  thinking: "切换思考开关",
  effort: "调整思考强度",
  memory: "自动记忆与 Dream 开关",
  compact: "Compact context",
  continue: "续跑未完成的工具环",
  mcp: "查看 MCP 服务看板",
  rewind: "回退到更早的回合",
  graph: "图模式开关（on|off|status）",
  config: "文件系统隔离档（status|fs global|fs workspace）",
  model: "切换模型",
  quit: "退出（别名 /exit）",
  exit: "同 /quit",
};

export interface SlashHintLine {
  readonly command: TuiSlashCommand;
  readonly description: string;
}

/** 首 token 的小写前缀（`/xxx...` → `xxx`；空 / 非 "/" 开头 → ""）。
 *  算法 SSOT 在 harness（`slashHeadPrefix`，plan T3 slash 投影收敛）；本名
 *  是 TUI 宿主的既有出口（app.tsx onSelectHint / tests 消费）。 */
export function slashPrefix(text: string): string {
  return slashHeadPrefix(text);
}

/**
 * 给定当前输入，枚举所有前缀命中的候选（静态命令在前、skill 在后，确定性
 * 顺序）。skill 名匹配为大小写不敏感前缀过滤。空 / 非 "/" 开头 → 空数组。
 * 静态命令仍按词表原顺序（slashHintLines 等既有契约不变）。
 *
 * #377 E（提示过载修复）：空前缀（输入恰为 "/"）只返回静态命令，skill 必须
 * 用户至少打 1 字符前缀（/c /ar …）才进列表 —— 防止 bare `/` 弹出 N 条 skill
 * 长描述撑爆屏外。
 *
 * Task 4 备注：此函数为底层「全量候选枚举」——既服务 slashSuggestions（消歧
 * 过滤），也服务 slashComplete（Tab 补全需要全量 LCP）。两个调用方各自承担
 * 各自的过滤职责（disambig 显示 vs. Tab 行为），不在此函数内分歧。
 */
function enumerateSlashCandidates(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): ReadonlyArray<SlashCandidate> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const prefix = slashPrefix(text);
  const out: SlashCandidate[] = [];
  // 空前缀（输入恰为 "/"）→ 全部命令（cmd.startsWith("") 恒真）。
  for (const cmd of VOCABULARY) {
    if (cmd.startsWith(prefix)) {
      out.push({ kind: "command", command: cmd as TuiSlashCommand });
    }
  }
  // 空前缀 → skill 不入场；用户至少打 1 字符前缀才混入。
  if (skills !== undefined && prefix.length > 0) {
    for (const skill of skills) {
      // 规范名或任一裸名别名命中前缀即入场，但**只发一条** canonical 候选
      // —— 别名不是第二条候选（重复条会把唯一匹配退化成 ≥2 的 LCP 分支）。
      if (skillHeadLowers(skill).some((head) => head.startsWith(prefix))) {
        out.push({
          kind: "skill",
          name: skill.name,
          description: skill.description,
          aliases: skill.aliases,
        });
      }
    }
  }
  return out;
}

/** skill 的全部可匹配首 token 小写形：规范名 + 唯一裸名别名（spec
 *  invariant 3 —— 冲突别名已由 catalog 侧丢弃，这里只消费投影）。 */
function skillHeadLowers(skill: SkillEntryLike): ReadonlyArray<string> {
  return [skill.name, ...(skill.aliases ?? [])].map((head) =>
    head.toLowerCase()
  );
}

/** Task 4：从 SlashCandidate 求其规范化的「首 token 小写名」集合（统一判定
 *  接口）。skill 臂含别名 —— typed 裸名 token 也必须被认成精确命中
 *  （invariant 2/3：exactness 认 bare，展示仍 canonical）。 */
function candidateHeadLowers(c: SlashCandidate): ReadonlyArray<string> {
  return c.kind === "command" ? [c.command] : skillHeadLowers(c);
}

/**
 * 给定当前输入，返回**用于消歧显示**的候选（静态命令在前、skill 在后，
 * 确定性顺序）。
 *
 * Task 4（plans/tui-chrome-interaction.md）：候选列表仅作**消歧**用。
 *  - **唯一精确命中**（typed 首 token === 某候选名）→ 空列表（即便没有更长
 *    兄弟）。
 *  - **精确命中 + remainder**（typed 首 token === 某候选名 + 空格/剩余段）
 *    → 空列表（即便有更长兄弟）。
 *  - **前缀歧义**（typed 前缀没有精确候选；如 `/way` → way-foo + way-bar）
 *    → 列表保留全部，**含 remainder 非空时**（`/way now` 仍显示 way-foo /
 *    way-bar —— 消歧职责未完成）。
 *  - **精确命中无空格但有更长兄弟**（typed 首 token === 某候选名 + 存在其他
 *    匹配项）→ 只显示更长兄弟，**不**显示已完整的名字。
 *  - 大小写不敏感（mixed-case `/ECHO` 仍识别为 echo）。
 *
 * Tab 补全（slashComplete）不走此过滤 —— 那是独立路径，必须按全量候选计算
 * LCP。详见 slashComplete 内部对 enumerateSlashCandidates 的直接调用。
 *
 * #377 E 保留：空前缀（输入恰为 "/"）只返回静态命令，skill 不入场；slashComplete
 * 同契约（"/" 永远 null —— 多匹配）。
 */
export function slashSuggestions(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): ReadonlyArray<SlashCandidate> {
  const text = input.trim();
  if (!text.startsWith("/")) return [];
  const remainder = slashRemainder(text);
  const matches = enumerateSlashCandidates(text, skills);
  if (matches.length === 0) return [];
  const prefixLower = slashPrefix(text);
  // 候选首 token 小写集合逐条算一次（每候选两个消费点：exactness + 兄弟过滤）。
  const headLowers = matches.map((m) => candidateHeadLowers(m));
  // 候选中是否包含 typed 前缀的精确命中（大小写不敏感，skill 臂含裸名别名）。
  const hasExact = headLowers.some((heads) => heads.includes(prefixLower));
  // 1) 精确命中 + remainder → 用户已「提交」（typed `/skillname` 后追加更多
  //    内容）；候选不再有消歧意义，全部隐藏。非 exact 前缀 + remainder 不受
  //    此条影响（前缀歧义仍是消歧场景，列表保留 —— plan T4 只授权 exact
  //    命中清空）。
  if (remainder !== "" && hasExact) return [];
  if (!hasExact) return matches;
  // 3) 存在精确命中 → 过滤掉该精确候选，保留仅「更长兄弟」（仍可消歧）。
  const out: SlashCandidate[] = [];
  for (const [i, m] of matches.entries()) {
    if (headLowers[i]!.includes(prefixLower)) continue;
    out.push(m);
  }
  return out;
}

/**
 * 求一组字符串的最长公共前缀（逐字符精确比较，大小写敏感；空数组 → ""）。
 * 仅供 slashComplete 的多匹配部分补全使用，模块私有。
 */
function longestCommonPrefix(forms: ReadonlyArray<string>): string {
  if (forms.length === 0) return "";
  let lcp = forms[0]!;
  for (let i = 1; i < forms.length && lcp !== ""; i++) {
    const form = forms[i]!;
    const end = Math.min(lcp.length, form.length);
    let j = 0;
    while (j < end && lcp[j] === form[j]) j++;
    lcp = lcp.slice(0, j);
  }
  return lcp;
}

/**
 * 给定当前输入，给出一个 Tab 补全结果，三态语义（shell-like）：
 *  1) 唯一匹配 → `/{cmd} ` / `/{skillName} `（带尾随空格；skill 名可能有
 *     连字符/点，无需转义）；
 *  2) 0 匹配 → null；
 *  3) ≥2 匹配 → 取全部候选补全形（`/{command}` / `/{skill.name}`，命令与
 *     skill 统一，保留声明原始大小写）的最长公共前缀（LCP），按进展规则
 *     决定返回（bash 式部分补全，不带尾随空格，剩余歧义由候选 UI 展示）：
 *       - LCP 严格长于已输入前缀形 `/${slashPrefix(input.trim())}` → 返回 LCP；
 *       - 二者忽略大小写相等但大小写不同（typedForm 恒小写）→ 返回 LCP
 *         （把输入规范化为候选声明大小写，如 '/ECHO' → '/Echo'）；
 *       - 否则（无进展，如 '/e' 对 exit/effort、裸 '/' 对全词表）→ null。
 *     大小写规则确定性说明：skill 前缀匹配大小写不敏感，LCP 用候选原始
 *     大小写逐字符比较 —— 混合大小写候选的 LCP 可能比忽略大小写的理论
 *     公共前缀短，这是可接受的保守行为（宁可少补，不错补）。
 *
 * Task 4 守卫：使用全量候选枚举（enumerateSlashCandidates），**不**走
 * slashSuggestions 的消歧过滤 —— 即使 typed 是精确命中（如 `/echo`），
 * Tab 仍需补全到 `/{name} `（带尾随空格）。remainder 已提交 → null。
 */
export function slashComplete(
  input: string,
  skills?: ReadonlyArray<SkillEntryLike>
): string | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
  const remainder = slashRemainder(text);
  if (remainder !== "") return null;
  const matches = enumerateSlashCandidates(text, skills);
  if (matches.length === 0) return null;
  const forms = matches.map((m) =>
    m.kind === "command" ? `/${m.command}` : `/${m.name}`
  );
  if (matches.length === 1) return `${forms[0]!} `;
  // Task 4：typed 首 token 是某候选的**精确命中**（大小写不敏感，skill 臂
  // 含裸名别名）+ 还存在更长兄弟（matches.length >= 2）→ Tab 补全该精确候选
  // 的**规范名**（带尾随空格），而非 LCP（LCP === typedForm 无进展）。
  const typedForm = `/${slashPrefix(text)}`;
  const typedLower = slashPrefix(text);
  const exactIndex = matches.findIndex((m) =>
    candidateHeadLowers(m).includes(typedLower)
  );
  if (exactIndex !== -1) return `${forms[exactIndex]!} `;
  const lcp = longestCommonPrefix(forms);
  if (
    lcp.length > typedForm.length ||
    (lcp.toLowerCase() === typedForm.toLowerCase() && lcp !== typedForm)
  ) {
    // 部分补全：不带尾随空格（还有剩余歧义，等下一次 Tab 或 ↓ 选择）。
    return lcp;
  }
  return null;
}

/**
 * #337 Phase C：`/skill-name [提示词]` 解析。
 * 输入 trim 后以 "/" 开头，首 token `/xxx` 中 `xxx` **精确命中** skill 的
 * 规范名或唯一裸名别名（spec tui-skill-slash-catalog invariant 3）→ 返回
 * `{ name, remainder }`（`name` 恒为**规范名**，invariant 2；remainder = 去掉
 * 首 token 后的剩余部分，可能为空）。命中静态 slash 命令 / 不匹配 →
 * undefined（静态命令优先，invariant 4 / C1 语义）。与 parseTuiInput 的
 * command/unknown/message 判别正交：skill 名不属于静态词表，parseTuiInput 只
 * 会把它判为 unknown——调用方在 parseTuiInput **之前**先调本函数分流。
 */
export function parseSkillLoad(
  raw: string,
  skills: ReadonlyArray<SkillEntryLike>
): { name: string; remainder: string } | undefined {
  const text = raw.trim();
  const prefix = slashPrefix(text);
  if (prefix === "") return undefined;
  if (VOCABULARY.has(prefix)) return undefined;
  for (const skill of skills) {
    // 精确命中规范名或裸名别名（大小写不敏感，与 slashSuggestions 前缀过滤
    // 同语义；返回原始 skill.name 作为 name，保留声明大小写并确保后续
    // catalog.get 拿到的是规范名而非用户 typed 的裸名）。
    if (skillHeadLowers(skill).includes(prefix)) {
      // invariant 5：remainder 按**输入 token 长度**切（slashRemainder 即该
      // 单一实现）—— 用 skill.name.length 会在裸名输入里吃掉 remainder 前缀。
      return { name: skill.name, remainder: slashRemainder(text) };
    }
  }
  return undefined;
}

/**
 * #377 系列 /effort：可调思考强度档位（SSOT 派生 —— 不硬编码第二份列表）。
 * 复用 contract.ts 的 THINKING_EFFORT_VALUES（含 ""=自适应），过滤掉自适应档：
 * 用户只通过 /effort 显式选 concrete 档（low/medium/high/xhigh/max），
 * 缺省 / 关闭时回归自适应，不把 ""/auto 暴露成可选项。
 */
export const ADJUSTABLE_EFFORT_LEVELS: ReadonlyArray<
  Exclude<ThinkingEffortWire, "">
> = THINKING_EFFORT_VALUES.filter(
  (v): v is Exclude<ThinkingEffortWire, ""> => v !== ""
);

/**
 * #377 系列 /effort：解析 `/effort <level>` 的 level 部分（不含首 token 的剩余段）。
 * 参考 parseSkillLoad 的 remainder 模式：取首 token 之后剩余 → trim →
 * toLowerCase → 须命中 ADJUSTABLE_EFFORT_LEVELS（5 档 concrete，不含 ""）。
 * 空 / 缺参 / 不在集合 → undefined。
 */
export function parseEffortLevel(raw: string): ThinkingEffortWire | undefined {
  const text = raw.trim();
  const firstTok = text.split(/\s+/, 1)[0] ?? text;
  const rest = text.slice(firstTok.length).trim();
  const level = rest.toLowerCase();
  if (level === "") return undefined;
  return (ADJUSTABLE_EFFORT_LEVELS as readonly string[]).includes(level)
    ? (level as ThinkingEffortWire)
    : undefined;
}

/**
 * 首 token 之后的剩余段（trim 后）。`/effort <level>` / `/continue` /
 * `/graph on` 共用同一个切法。算法 SSOT 在 harness（`slashTailRemainder`）。
 */
export function slashRemainder(raw: string): string {
  return slashTailRemainder(raw);
}

/**
 * `/effort <level>` 与 `/continue` 共用：首 token 之后剩余段是否非空。
 * /effort 需区分无参（开面板）与非法档；/continue 任何 args → usage EXIT。
 */
export function slashHasArg(raw: string): boolean {
  return slashRemainder(raw) !== "";
}

export function effortHasArg(raw: string): boolean {
  return slashHasArg(raw);
}

/**
 * 任务 B：按候选列表 + 选中索引补全（PromptInput 内部 hintCursor 用）。
 * cursor 越界 / suggestions 为空 → null。返回 `/{cmd} ` 形式与
 * slashComplete 一致，调用方可直接覆盖 inputValue。
 */
export function slashCompleteFromList(
  suggestions: ReadonlyArray<TuiSlashCommand>,
  cursor: number
): string | null {
  if (suggestions.length === 0) return null;
  if (cursor < 0 || cursor >= suggestions.length) return null;
  const cmd = suggestions[cursor]!;
  return `/${cmd} `;
}

/** #337 Phase C：SlashCandidate 版按 cursor 补全（静态命令 | skill 通用）。
 *  语义与 slashCompleteFromList 一致；skill 名原样保留（含连字符/点）。 */
export function slashCompleteFromCandidates(
  suggestions: ReadonlyArray<SlashCandidate>,
  cursor: number
): string | null {
  if (suggestions.length === 0) return null;
  if (cursor < 0 || cursor >= suggestions.length) return null;
  const candidate = suggestions[cursor]!;
  return candidate.kind === "command"
    ? `/${candidate.command} `
    : `/${candidate.name} `;
}

/** 给候选生成一行短描述的「补全提示行」（调用方负责渲染）。 */
export function slashHintLines(
  suggestions: ReadonlyArray<TuiSlashCommand>
): ReadonlyArray<SlashHintLine> {
  const desc = HINT_DESCRIPTIONS satisfies Record<TuiSlashCommand, string>;
  return suggestions.map((command) => ({
    command,
    description: desc[command],
  }));
}

/**
 * 任务 B：暴露候选短描述（PromptInput 内部渲染 hint 时用；保持外部
 * 调用方仍可走 slashHintLines 自渲）。
 */
export const SLASH_HINT_DESCRIPTIONS: Readonly<
  Record<TuiSlashCommand, string>
> = HINT_DESCRIPTIONS;
