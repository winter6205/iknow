# Plan: skill-index-increment

**Goal:** 开场技能模型索引冻在 system；新建名经 messages 最末隐藏增量进场并写入索引进场史；人 slash 走可加载技能面且 TUI/Web/CLI 同一入口。
**Approach:** 先把 catalog 两面和 `skill()` 资格钉死，再统一 slash 投影与 DTO，然后进场史 + 注入缝，最后 worker 快照与 plugin/MCP 不自动 diff。不迁开场 listing 出 system，不把 MCP 目录做成同构增量。
**Spec link:** `specs/skill-index-increment.md`
**ACR:** all-yes（与 spec 块相同）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

```
bounded-context-guardian: yes — catalog/进场史/注入在 harness；宿主只消费统一 slash 投影；session-api DTO 是同一可加载面的 HTTP 形，不在 web 另造资格门
input-contract-tests: yes — 上表五类覆盖两查询、skill()、slash、进场史、注入空集
error-handling-enforcer: yes — rescan/落盘/资格拒分型；失败不改冻表、不把失败追加标成已进场（EXIT 写在进场史行）
complexity-anti-drift: yes — 复用 pendingInjected / 隐藏谓词；两查询而非第三套 listing 子系统；不把 MCP 并进本通道
minimal-change-verifier: yes — 只做技能模型索引增量 + 人侧同一 slash 入口 + skill() 资格拒；诊断面、paths、MCP 目录增量、正文采样策略均划出
```

## Tasks (ordered by dependency)

1. **Catalog 两面可测** — tag: `[implementation]`
   - **Inherits:** spec 技能模型索引 = 有 description 且未 disable；可加载技能面 = 有 SKILL.md（含无描述、含 disable）；`get` 仍按名返回含 disabled 的条目
   - **Surface:** `src/harness/skill`（既有 catalog）
   - **Acceptance:** 两查询契约测试覆盖 empty / disable / 无 description / 合格条目；开场冻表只消费模型索引面；`npm test` 相关 skill catalog 路径绿
   - Status: [ ] pending

2. **`skill()` 按模型索引资格拒** — tag: `[implementation]`
   - **Inherits:** spec SC5/SC6；拒不灌正文；不拦读文件；二次短路仍 ADR-0079
   - **Surface:** `src/harness/aci/tools` skill 工具
   - **Acceptance:** 无描述与 disable 的 `skill({name})` 失败且无全文；合格名仍灌正文；读 SKILL.md 的文件工具不因本闸失败
   - [blocks: T1]

3. **Slash 同一入口走可加载面** — tag: `[implementation]`
   - **Inherits:** spec SC5/SC8/SC9；`specs/tui-skill-slash-catalog.md` catalog.get、remainder 按输入 token、静态优先；CLI 纳入本入口
   - **Surface:** harness 可复用的 slash 投影 + `src/tui` / `web` / `src/cli` / `src/session-api` DTO
   - **Acceptance:** TUI、Web、CLI 对同一可加载条目都能信封加载；无 description 出现在列表且 DTO 允许描述缺席；裸名 remainder 不按 canonical 长度切错
   - [blocks: T1]

4. **索引进场史跟 session** — tag: `[implementation]`
   - **Inherits:** spec 进场史 = 冻表 name ∪ 已追加增量；信封不写入；落盘失败不得把 messages 追加标成已进场
   - **Surface:** harness session 状态 / 会话文件夹既有落盘
   - **Acceptance:** 新 session 进场史 = 开场模型索引名；恢复同一 session 不重复那些 name；`/reset` 或新会话重冻后进场史与新冻表对齐
   - [blocks: T1]

5. **送模型前只追加新建增量并隐藏** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC4、SC7；messages 最末；`<available_skills>` 只含新建；完整 description；不过 10% 降档；compact 不重挂 listing
   - **Surface:** `src/harness` loop 注入（pendingInjected 同形）+ TUI/Web 隐藏谓词
   - **Acceptance:** 无新建则不贴、system 仍 deep-equal；有新建则最末隐藏 user 仅那些行；同名第二轮不贴；compact 后不因消息消失再贴；slash 过仍补索引（若尚未进场）
   - [blocks: T4]

6. **可加载面当时热、自动 diff 覆盖现行 scan 根** — tag: `[implementation]`
   - **Inherits:** spec 安装/丢目录/reload 当下 rescan；自动增量覆盖现行 `scan()` 根；rescan 失败不改冻表、不贴残缺 delta
   - **Surface:** 装配 / host reload 与 turn 前 rescan 缝
   - **Acceptance:** 新 SKILL.md 落入已 scan 根后，slash 立刻可见；下一轮模型才见到增量；rescan 失败时冻表与进场史不变
   - [blocks: T3, T5]

7. **Worker 继承父会话当时完整模型索引** — tag: `[implementation]`
   - **Inherits:** spec SC10；不抄父增量 user 消息；worker 不再自做 diff/进场史
   - **Surface:** `src/harness/subagent` worker 装配
   - **Acceptance:** spawn 时 worker system 的 `<available_skills>` 含父冻表 ∪ 父进场史中的模型索引名；prior 无父增量那条隐藏 listing
   - [blocks: T4]

8. **Plugin/MCP 不自动 skill-diff** — tag: `[implementation]`
   - **Inherits:** spec SC11；整包靠 reload 或新会话；reload 后新模型索引名仍走 T5 delta
   - **Surface:** 与 T5/T6 同一 diff 闸（触发源）
   - **Acceptance:** 未 reload 时只改 plugin/MCP 配置不产生 skill 增量消息；显式 reload 后新合格 skill 走 T5
   - [blocks: T5, T6]
