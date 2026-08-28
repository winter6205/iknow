# Plan: auto-memory-prefetch-dedup(会话级去重 · 截断修补 · trace 结构化标记)

**Goal:** memory prefetch 从"每轮重灌"改为"每会话增量灌一次",配截断策略与注入块格式修补,并给 trace 补结构化 `memory_prefetch` 记录,使召回质量可审计。

**Approach:** 主轴是会话级 id 去重(操作员 2026-08-28 裁决:首轮命中注入,后续轮不重灌;历史保持 append-only,不 strip 旧 overlay —— 保 KV cache 前缀)。T2/T3 同文件序列化;T4 依赖 T2 的去重计数;T5 是 T4 的 UI 腿;T6 是独立写路径票可并行。读路径既有契约数值(5 hits / 8000 chars / advisory 包装首行 / 不进 system / ask opt-out)一律不动。T4(promote 供血)为独立裁决,不在本计划。

**Spec link:** none — 操作员 2026-08-28 裁决跳过 spec,契约就地捕获于本文件;读路径设计真值为 ADR-0034(在 `docs/auto-memory-low-trust-read` 分支,未合入 master,见待写入)。

**Tracker:** GitHub 主路径(gh 已认证,winter6205/iknow)——每条 tracer bullet 一个 issue,标签 `ready-for-agent`,按 plan 的 `[blocks:]` 渲染原生 blocking 边。

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch;全部落地后整轮 code-review 收尾。

## 已定契约(操作员裁决 + 讨论定版,T2 依此实现)

- **会话级按 id 去重**:一条记忆在一个 conversation 内只注入一次;首次注入的块随该 user turn 留在历史里,后续轮靠旧引用工作。
- **条目更新不重灌**:会话内 `updated_at` 变化不触发再注入(advisory 本就低信任,旧引用足够)。
- **过滤顺序**:先剔除已注入 id,再 `scoreMemoryEntries` 打分排序取 top5 —— 后续轮可注入首次未进前 5 的条目,去重不占名额。
- **空集直通**:去重后无命中 → overlay 为 `""`,`attachPrefetchOverlay` 返回用户原文,逐字节不变。
- **resume 恢复**:冷启动(ckpt / session-jsonl)时扫历史 user 消息中的 `MEMORY_ADVISORY_PREFIX` 块,提取 `id:` 行恢复已注入集合;提取失败 → 空集 + `// EXIT: log-and-continue`(容忍一次重复,不 fail turn)。
- **跨会话独立**:去重状态 per-conversation,不跨会话共享。
- **历史 append-only**:不 strip、不改写已注入的历史消息(KV cache 不变量,ADR-0034 D2 前缀稳定裁决的延伸)。

## Tasks (ordered by dependency)

1. **prefetch 会话级去重落地** — tag: `[implementation]`
   - **Inherits:** 上节"已定契约"全部条目;ADR-0034 D2(prefetch 走 user turn、5 hits 帽、零词命中剔除);`scoreMemoryEntries` 为唯一打分函数(不得另起第二套)。
   - **Surface:** `src/harness/memory`(打分选择层)、host 接缝(`session-api/hub.ts` 的 `overlayForSession` / `cli/chat-session.ts` 的 overlay closure)。去重状态放 host 侧,per-conversation;不进 loop-engine。
   - **Acceptance:** 同一会话第二轮同 query → 消息里 advisory 块总数不增,且首轮注入的块仍在历史;新会话同 query 重新注入;带历史的 resume 会话不重注;去重后空集 → user 消息与原文逐字节一致;`autoExtract !== true` / `ask` 行为不变。测试:`npx vitest run tests/harness/memory/` + host 接线测试。
   - Status: [ ] pending

2. **截断策略与注入块瘦身** — tag: `[implementation]` [blocks: 1]
   - **Inherits:** `MEMORY_PREFETCH_CHAR_CAP = 8000` / `MEMORY_PREFETCH_MAX_HITS = 5` 数值不变;advisory 包装首行锁定原文;零词命中剔除不变。Changes: 首条命中不再无条件入场;硬 slice 兜底退役。
   - **Surface:** `src/harness/memory`(prefetch 的封顶与格式化路径;`fillToCharCap` / `formatPrefetchOverlay` / `formatHit` 所在层)。
   - **Acceptance:** 单条超帽 → 该条被截断且以可见 truncation 标记结尾,不产生无标记半句;注入块不含 `ttl_days` / `disabled` / `supersedes` 行,`id` / `type` / `importance` / `updated_at` 保留;既有"超帽少取"钉死测例更新后仍表达同一契约。
   - Status: [ ] pending

3. **trace 增设 memory_prefetch 结构化记录** — tag: `[implementation]` [blocks: 1]
   - **Inherits:** trace bounded context 松耦合纪律(字面量 union,不 import memory 域类型,循 `trace/types.ts` 文件头先例);trace 写入 best-effort,失败不影响 turn(`noop.ts` 既有语义)。
   - **Surface:** `src/harness/trace`(record 类型 + jsonl 序列化)、host 接缝(`session-api/hub.ts` / `cli/chat-session.ts` 的 `applyHostPrefetch` 调用点,拿到 overlay 后顺手 record)。
   - **Acceptance:** 注入轮的 jsonl 出现 `record_type: "memory_prefetch"`,含 query、`hits[{id,title,score,titleHits,bodyHits}]`、`charsUsed`、`dedupSkipped`、`reason`(注入 / empty-query / all-deduped / gate-off 四值之一);空 query 与关闸轮也各有一条带 reason 的记录;record 失败时 turn 照常成功。demo:serve 跑两轮同 query,jsonl 第二条 `reason=all-deduped`。
   - Status: [ ] pending

4. **web /trace 面板渲染 memory_prefetch 记录** — tag: `[implementation]` [blocks: 3]
   - **Inherits:** 面板既有记录渲染管线;本票只加"可辨识展示",不做专门视觉设计。
   - **Surface:** `web`(trace 面板)。
   - **Acceptance:** 面板能区分展示 `memory_prefetch` 记录的 query、命中条数与 reason(渲染形态留给实现);`tests/web/` 既有断言仍绿。
   - Status: [ ] pending

5. **extract 候选带双语关键词(写路径,独立)** — tag: `[implementation]` [parallel]
   - **Inherits:** `specs/auto-memory-extract-discipline.md` 的英文纪律条款(三类"勿记/要记"包含断言不动);`scoreMemoryEntries` + CJK tokenize 为唯一召回判定。Changes: 抽取纪律追加"候选须带会话语言的关键词,保证中文 query 可词命中英文条目"(措辞留给实现,不含敏感数值)。
   - **Surface:** `src/harness/memory`(ingest / extract prompt 层)。
   - **Acceptance:** 夹具:中文会话产出的英文条目,用中文 query(如"查一下今天AI新闻"经共享 tokenize)经 `scoreMemoryEntries` 能词命中 —— 该条不再因零词重叠被淘汰;`tests/harness/memory/` 既有 ingest / auto-hook 断言仍绿。
   - Status: [ ] pending

## ACR

```
bounded-context-guardian: yes — 打分/格式/去重纯函数在 harness/memory;状态与 record 只在 host 接缝;loop-engine 零改动;trace types 不 import memory 域
defensive-contract-validator: yes — empty(空库/空 query/去重空集)、negative(已注入剔除/零命中淘汰)、overflow(单条超帽截断带标记)、concurrent(per-conversation 状态隔离)、exception(resume 扫描失败、record 失败 log-and-continue 不 fail turn)
error-handling-enforcer: yes — 新增 IO 全 best-effort,无裸 catch;prefetch 既有 EXIT: log-and-continue 纪律延伸到 resume 恢复与 trace 记录
complexity-anti-drift: yes — 去重状态不进 loop-engine;格式修补留在既有函数;面板只读渲染
minimal-change-verifier: yes — 5 commit 按票拆分;T5 写路径独立不与读路径混提;既有契约数值(8000/5/包装首行)不动
```

## 待写入

- [x] `docs/CONTEXT.md` 新增词条 **memory_prefetch**(含本计划"已定契约"的去重语义:per-conversation id 去重、resume 扫历史恢复、历史 append-only)——2026-08-28 已落盘(domain-modeling,guard exit 0)。
- [x] ADR 补记:ADR-0034 已于 2026-08-28 从 `docs/auto-memory-low-trust-read` 分支补档进 master(连同 low-trust-read spec/plan 与 ADR-0009 D3 修订注);去重语义是 D2 的细化而非矛盾,落在 CONTEXT.md **memory_prefetch** 词条与本计划"已定契约"节,不改写 0034 原文。
- [ ] T5 落地后:`specs/auto-memory-extract-discipline.md` 纪律清单追加双语关键词条目(spec 归 spec-driven-development 管,由实现票带走)。
