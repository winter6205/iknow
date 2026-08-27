# Plan: search-output-integrity（iknow 检索工具 P0 切片）

**Goal:** 修复检索面两处完整性缺陷：frontmatter 一行不可解析导致整个 skill 从 catalog 消失（session-handoff 活体复现），以及 tool_search 无上限输出 + 两工具空白 query 全量倾倒。
**Approach:** 两个独立 tracer bullet，各 1 commit，可并行。T1 只动 scanner 的 frontmatter 解析容错语义（跳行不弃档）；T2 只动两件检索工具的输出边界（可选 `limit`、默认封顶、整行截断 + 引导行、query trim）。不做：匹配算法升级（#635 裁决已封，plans/631-progressive-disclosure-alignment.md:4）、web_search、mcp/、permission/、aci-registry.ts 任何改动。
**Spec link:** 无独立 spec —— 行为真值继承 `specs/224-tool-extension-path.md`（契约 X / S4 / S5）与 `specs/337-skill-mcp-extension.md`（SC3 / SC5）；planner 决策 PROCEED_TO_ACR（agent bc-c907c5e2）。
**Tracker:** 本文件 fallback（本环境 `gh` 只读，无法建 issue；主路径不可用）。
**ACR:** 全 yes（verdict block 如下）

```
bounded-context-guardian: yes — T1 限于 src/harness/skill（parseFrontmatter，scanner.ts:100-111），T2 限于 src/harness/aci/tools 两件工具文件；无新增跨模块依赖，executor 截断权威不动（executor.ts:30 OUTPUT_HARD_CAP 仍是唯一截断者），排除面（web-search.ts / aci-registry.ts / mcp/ / permission/）两 bullet 均不需要
defensive-contract-validator: yes — 3 个源文件均有活体测试（tests/skill/scanner.test.ts、tests/harness/aci/tools/{tool,skill}-search.test.ts）已覆盖 empty/malformed；其余类按 bullet 分配：exception（不可解析行，活体样本 session-handoff SKILL.md:6 无冒号行）、negative（limit ≤ 0 / 非整数走 ajv）、overflow（命中数超 cap、近 20k 整行丢弃）、concurrent N/A-with-reason（纯 read-only handler，isConcurrencySafe 已声明，无共享可变状态）
error-handling-enforcer: yes — T1 降级 warn 不静默（复用 scanner.ts:95 warn 先例；frontmatter 整体缺失仍硬跳过），T2 无新失败路径：空参/无匹配仍是合法 NO_MATCHES 返回（spec 224 S4 / D9），registry 未装配保持 typed ToolExecutionError（tool-search.ts:149）；封顶引导行是有 EXIT 语义的文档化降级，走 NO_MATCHES 非 JSON 行 carve-out 先例（spec 224 S5 + tool-search.ts:54），且引导行是 plain data 而非 truncated/total 元字段 —— 工具自限坐在 executor 权威之下而非绕开（spec 224:172 禁的是绕开封顶；输出少于封顶是遵守，spec 224:208 契约 X 禁的是工具自称截断元数据）
complexity-anti-drift: yes — T1 在既有抽象层内改一个函数（parseFrontmatter throw→跳行），T2 每工具加一个有界投影步骤；无 god-function/god-file 意图，3 文件均 80-153 行，匹配算法零改动（#635 封禁）
minimal-change-verifier: yes — 本轮交付物是 1 个逻辑任务（计划文件）1 commit；实施按本计划切成 2 bullet = 2 commit（631 先例：禁合并落地），范围锁死为两个具名 bullet
OVERALL: PASS — hand to writing-plans
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

> 只有 2 个 bullet 的原因：P0 切片范围由上游裁决锁死为恰好两件（T1 frontmatter 容错、T2 输出有界），禁止增项；一真 bullet 胜过三凑数 bullet。

## 待写入（persist 段）

- 空。两处改动均为既有契约（契约 X、S4/S5、SC3/SC5）的执行修复，不引入新领域词、不构成 one-way door，无 ADR/CONTEXT.md 增量。

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: one vertical-slice outcome, one tag, one commit, headroom for the implementer.

1. **T1 tolerant frontmatter（跳行不弃档）** — tag: `[implementation]` `[parallel]`
   - **Inherits:** spec 337 SC3："`disable-model-invocation: true` 的 skill（session-handoff 活体样本）不出现在 `<available_skills>` 段、`skill_search` 搜不到" —— 该 skill 必须**在 catalog 内且 disabled:true** 才能被正确排除；三字段有效语义（name / description / disable-model-invocation 生效 + ARCHIVED_KEYS 原样归档）不变。故障现状：`parseFrontmatter`（scanner.ts:106）对无冒号行整档抛弃，session-handoff 的多行 `related_skills` 列表（`.cursor/skills/session-handoff/SKILL.md:6`）触发整档消失，disabled 排除语义随之失效。
   - **Surface:** `src/harness/skill`（scanner 的 frontmatter 解析路径）。
   - **Acceptance:**
     - frontmatter 内含不可解析行（无冒号 / 分隔符位置非法）的 SKILL.md 仍产出 entry，且可解析行的 name / description / `disable-model-invocation` 语义与现状完全一致（session-handoff 形态的 fixture：多行 YAML 列表 + `disable-model-invocation: true` → entry 存在且 `disabled === true`）。
     - 跳行降级非静默：每档至多一次 warn（复用既有 warn 通道形态）。
     - frontmatter 块整体缺失仍硬跳过 + warn（既有 "skips malformed siblings" 测试语义不降级）。
     - 5 类边界随 bullet 落测：空 frontmatter 块 / 不可解析行（exception）/ 全行不可解析（退化为无有效字段，name fallback 到目录名的既有语义）；concurrent N/A（scan 无共享可变状态）。
     - `tests/skill/scanner.test.ts` 全绿；`npm test` + `npm run typecheck` exit 0。
   - Status: [ ] pending

2. **T2 bounded search output（可选 limit + 默认封顶 + trim）** — tag: `[implementation]` `[parallel]`
   - **Inherits:** 契约 X（spec 224:208 / 224:172）："executor 是工具结果截断元数据的唯一权威……工具返回纯数据、不带 truncated/total 元字段"、"不为 tool_search 单独绕开 20000 字符封顶" —— 工具自限输出坐在 executor 权威**之下**（输出少于封顶 = 遵守，非绕开），引导行是 plain data 不是截断元字段。S5 line-parseable carve-out 先例：`NO_MATCHES` 已是非 JSON 行（tool-search.ts:54，测试锁定），封顶引导行沿用同一先例形态（非 JSON 的引导性纯文本行）。#635 封禁：匹配算法（子串语义）零改动。spec 337 SC5：skill_search 每行 `{name, description}` JSON 形态不变。
   - **Surface:** `src/harness/aci/tools`（tool-search、skill-search 两件；不触 aci-registry.ts / executor）。
   - **Acceptance:**
     - `tool_search` 接受可选 `limit`（ajv schema 校验，非法值拒于 schema 层），缺省封顶 20 条命中；超出部分**整行**丢弃（每条 emitted 结果行永远可被 `JSON.parse` 反解，无半行 JSON），封顶发生时追加一条纯文本引导行（提示收窄 `query` / 用 `names` 精取 / 调 `limit`），全量输出字符数落在 executor 20000 cap 之下，且输出不含 truncated/total 元字段。
     - 两工具 query 均 trim 后再判空：空白-only query 走 NO_MATCHES 引导返回，不再全量倾倒（现状：`" "` 子串命中几乎全部 description）。
     - `skill_search` 无匹配返回与 `tool_search` 引导语义对齐（换词 / 直呼名引导，非裸 `(no matches)`）。
     - 匹配算法零改动：未触发封顶的输入下，命中集合与现状逐字节一致（既有 S4/S5 测试全绿）。
     - 5 类边界随 bullet 落测：空/空白 query（empty）、`limit` 0/负数/非整数（negative，ajv 拒收）、命中数超 limit 及单条超长逼近 20k（overflow，整行丢弃）、registry 未装配（exception，既有 ToolExecutionError 不变）；concurrent N/A（纯 read-only handler，`isConcurrencySafe` 已声明）。
     - `tests/harness/aci/tools/tool-search.test.ts`、`tests/harness/aci/tools/skill-search.test.ts` 全绿；`npm test` + `npm run typecheck` exit 0。
   - Status: [ ] pending

## Code review phase

两 bullet 全部落地后，整轮改动过一次 end-of-round code review，再收尾。Status: [ ] pending
