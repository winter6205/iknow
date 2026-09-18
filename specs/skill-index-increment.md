# Spec: skill-index-increment — 技能模型索引增量与人侧 slash 收口

**Status:** ready for plan  
**Surface:** harness skill catalog / identity `<available_skills>` / loop 注入缝 / session 落盘 / TUI·Web·CLI slash / worker 装配  
**访谈:** 2026-09-17 LogicSync（假设门已确认，见 Inherits）

## Objective

会话开场后新出现的 **技能模型索引** 条目必须进入模型眼前，且不得改写 system 前缀。人用 slash 加载技能走 **可加载技能面**（可含无 description 的人侧技能），TUI / Web / CLI **同一个入口**。`skill()` 只服务模型索引资格；读磁盘 SKILL.md 不拦。

**用户：** 本机操作员（装技能、slash、会话中途出现新 SKILL.md）与模型（靠索引 `skill({name})`）。

**成功形态：** 开场冻表仍在 system 且相邻轮 deep-equal；新的模型索引名在下一轮调用前以隐藏 user 消息贴在 messages 最末；slash 立刻能 `/` 可加载条目；子代理出生时拍父会话当时完整模型索引进自己的冻表。

## Assumptions（访谈已确认）

1. 开场 `<available_skills>` 继续冻在 system，满足 **前缀资格线**。
2. 中途只 **追加新建** 的模型索引行，不整表刷新，不改已进场条目的 description。
3. 已进场条目的修改 / 下架 / disable 变更：本会话不对齐，**新开会话** 重冻。
4. slash 信封灌正文 ≠ 索引进场；下一轮仍可为该 name 补索引增量。
5. 已进场 name 跟 **session** 落盘（**索引进场史**）；**compact 不**据此再贴 listing。
6. 新建 delta **带完整 description**，不再跑开场 10% **索引降档**。
7. 子代理不跟增量消息、不第二套 diff；spawn 继承父会话 **此刻完整模型索引快照**。
8. delta 接在 messages **最末**（本轮用户消息 / skill-load 信封已在上）。
9. Plugin 包与 MCP：**显式 reload 或新会话** 才让 scanner 看见；不自动 turn 前 diff。reload 后多出来的 **skill 模型索引** 名仍走同一条 delta（不改 system）。MCP 工具面不套本 listing。
10. 自动 name-diff 覆盖现行 `scan()` **全部技能根**（plugin 根须先 reload 才进入 scan 可见集）。
11. 人侧技能（无 description，或 `disable-model-invocation`）：进 slash、不进模型索引、`skill()` 拒、**读文件不拦**。
12. 本切片不把 MCP 名字目录做成 skill 同构增量。

## Boundaries

- **Does:**
  - catalog 拆清 **技能模型索引** vs **可加载技能面**（`get` 仍按名取条目，含 disabled）。
  - 开场冻表 = 模型索引在装配期的投影 + 既有降档；会话内 system 该段不变。
  - 送模型前：rescan 现行技能根 → 模型索引 − 索引进场史 → 仅新建行渲染为 `<available_skills>` 增量，pendingInjected 同形接到 messages 尾；进场史落盘。
  - 人侧 catalog 在安装 / 丢目录 / reload **当时** rescan，slash 立刻可见。
  - TUI / Web / CLI slash **一个入口**：可加载全集、`SkillCatalog.get` 语义、remainder 按输入 token、别名；HTTP DTO 允许 description 缺席。
  - `skill()`：非模型索引资格 → 拒、不灌正文；不禁止 `read_file`。
  - 隐藏谓词：该增量 user 消息不进 ❯ 气泡 / Web 用户气泡 / CLI ↑ 历史（与 `isTuiHiddenUserMessage` 同纪律）。
  - worker spawn：父会话模型索引全集写入 worker 自己的 system 冻表。
- **Confirms with human:** （none — 访谈已收口）
- **Out of this spec:**
  - MCP 工具目录增量、MCP 自动 name-diff。
  - Plugin 包未 reload 时的自动进场。
  - compact 后重挂 listing 或重挂已调用 skill 正文（正文仍 ADR-0079）。
  - 已进场 description 热更新、按调用次数降档、诊断 slash（`/context` 类）、`paths` / `when_to_use` / 子代理启动预载 SKILL 正文。
  - 改 `IKNOW_ASSEMBLY_ORDER` 六段；把开场 listing 迁出 system。

## Success Criteria

- **SC1** 相邻两轮（无新模型索引名）`tools` + `system` deep-equal，且 `<available_skills>` 冻表字节不变。
- **SC2** 现行 scan 根下新增一条 **有 description 且未 disable** 的 skill 后，下一轮送模型的 messages **最末** 一条 user 文本为 `<available_skills>` 且 **只含** 该新 name（及当时完整 description）；冻表不含该行。
- **SC3** 同一新 name 第二轮不再追加；session 恢复后根据索引进场史仍不重复追加。
- **SC4** compact 之后不因「messages 里增量不见了」再追加同一批 name。
- **SC5** 无 description 的 skill：slash（TUI/Web/CLI 同一入口）能信封加载；不出现在冻表或 delta；`skill({name})` 拒；`read_file` 其 SKILL.md 不因本闸失败。
- **SC6** `disable-model-invocation` 且有 description：同 SC5 的人侧能 `/`、模型索引与 `skill()` 拒。
- **SC7** slash 加载新技能正文后，该 name 若尚非模型索引进场，下一轮仍补 delta（信封 ≠ 进场史）。
- **SC8** 安装 / reload 当下 slash 候选已含可加载新条目，不必等下一 turn。
- **SC9** Web `listSkills`（或后继 DTO）含无 description 条目；remainder 不按 canonical 名长度误切。
- **SC10** spawn 的 worker system 含父会话当时模型索引全集（含已追加进场的 name），worker 不自己往 prior 抄父增量消息。
- **SC11** 未 reload 时，仅 plugin 包 / MCP 配置变化 **不** 产生 skill 索引 delta。
- **SC12** 本切片相关 `npm test` 路径（catalog 两面、skill 工具门、slash 统一入口、注入隐藏、进场史、worker 快照）退出码 0。

## Input-contract classes

| Surface          | empty                         | invalid/negative                     | overflow               | concurrent                       | exception                                                            |
| ---------------- | ----------------------------- | ------------------------------------ | ---------------------- | -------------------------------- | -------------------------------------------------------------------- |
| 模型索引查询     | 无合格条目 → 冻表空清单既有句 | disable / 无 description → 不进索引  | 降档仍只作用于开场冻表 | 同 turn 多次 diff 只贴一次新建集 | rescan 失败 → typed 错，不改冻表、不贴残缺 delta（EXIT：保留进场史） |
| 可加载面 / slash | `/` 非技能                    | 未知名 → 非 skill-load；静态词表优先 | N/A                    | N/A                              | 正文读失败 → 既有 skill-load 错，不假装进场                          |
| `skill()`        | 空 name → 既有校验            | 非模型索引 → 拒、不灌正文            | 二次短路仍 ADR-0079    | N/A                              | 读盘失败 typed，与「资格拒」分型                                     |
| 索引进场史       | 新 session = 冻表 name 集     | 未知 name 写入忽略                   | N/A                    | 追加与落盘同一拍                 | 落盘失败 → typed，不把 messages 追加当成已进场                       |

## Open Questions

(none)

## Inherits / Changes

**Inherits（CONTEXT 原句，实施时不得改义）：**

- **前缀资格线：** 会话内可变的闸门只许落位 messages 尾部或 handler 层。
- **append-only messages：** 消息只能以不可变追加更新。
- **渐进式披露 / 直呼加载 / 索引降档 / 溢出治理：** 开场索引与 10% 闸、有描述则 `skill({name})`。
- **skill() 二次短路 / skill-load display projection / skill bare alias：** 闸只罩 `skill()`；slash 信封仍灌全文；解析问 catalog。
- **session transcript / 会话文件夹：** 进场史跟 session 走，不另造权威 messages。

**Inherits（ADR）：** ADR-0043 前缀冻结与 messages 侧闸；ADR-0046 开场降档与直呼；ADR-0079 `skill()` 短路与 slash 不短路；ADR-0041 可变不进前缀；ADR-0095 插件技能发现（本切片：包启用靠 reload）。

**Amends：** `specs/tui-skill-slash-catalog.md` 将 CLI 划出范围——本 spec **收回** CLI，与 TUI/Web 同一 slash 入口。`specs/tui-skill-slash-catalog.md` 的 catalog.get / remainder / 静态优先 / agents 不进 slash **仍然有效**。

**Changes：** 新增 ADR-0098（开场冻表 + messages 增量 + 索引进场史）。catalog 一名两义的 `available()` 拆成模型索引与可加载面。

## ACR

```
bounded-context-guardian: yes — catalog/进场史/注入在 harness；宿主只消费统一 slash 投影；session-api DTO 是同一可加载面的 HTTP 形，不在 web 另造资格门
input-contract-tests: yes — 上表五类覆盖两查询、skill()、slash、进场史、注入空集
error-handling-enforcer: yes — rescan/落盘/资格拒分型；失败不改冻表、不把失败追加标成已进场（EXIT 写在进场史行）
complexity-anti-drift: yes — 复用 pendingInjected / 隐藏谓词；两查询而非第三套 listing 子系统；不把 MCP 并进本通道
minimal-change-verifier: yes — 只做技能模型索引增量 + 人侧同一 slash 入口 + skill() 资格拒；诊断面、paths、MCP 目录增量、正文采样策略均划出
```

## Persist

已 flush：ADR-0098、CONTEXT 四词条 + vs、`specs/tui-skill-slash-catalog.md` CLI 指向、`docs/STATUS.md` 现状句、`plans/skill-index-increment.md`。
