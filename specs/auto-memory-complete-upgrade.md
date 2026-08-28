# Spec: auto-memory-complete-upgrade（CJK 近邻 · dream · §2.5 Medium）

> 在已合入的自动记忆（ADR-0031 / `specs/auto-memory.md`）与 follow-ups（`specs/memory-layer-follow-ups.md`）之上，兑现 Destination 选项 1：中文近邻有效、dream 可开关、STATUS §2.5 三条 Medium 清完。不重开抽取四态表、不改 `autoExtract` 默认、不把 LLM 塞进机械 GC。
>
> 操作员 2026-08-28 跳过 wayfinder grilling，按下列已批准假设成文（地图：[wayfinder:map] 自动记忆完整升级（CJK 近邻 + dream + §2.5 Medium））。

## Objective

chat / tui / serve 在 opt-in 下：纯中文（及 CJK）候选能经 BM25 近邻命中，四态 `memory_op` 不再退化成全 `ADD`；可另开 **dream**（LLM 离线合并），在机械 `memory_gc` 之外用第二条异步 LLM 写路径合并重复/过时条；serve 多 `workspaceRoot` 时自动记忆钩子按根持有，且 chat 与 serve 共用同一套吞错转发。`ask` 记忆层保持全 opt-out。

成功标准见下。`settings.memory.autoExtract` 与 `settings.memory.dream` **默认皆 OFF**。

## Boundaries

- **Does:**
  - 共用切分：`scoreMemoryEntries` 与 ingest 近邻 token 走同一套规则。ASCII 保持现状（`[^a-z0-9_]+`、长度 ≥ 2）。CJK 字系（Han / Hiragana / Katakana / Hangul）对每个连续 run 发重叠 bigram；run 长为 1 时发单字（仅此例外打破「长度 ≥ 2」）。不引入 jieba / `Intl.Segmenter` / 新 npm 依赖。
  - 空 token 集：近邻视为无命中（不得把空集 containment 当成 1 而 UPDATE/NOOP）。
  - **dream**：`settings.memory.dream === true` 才装配合并趟；boolean-only，缺失或非 `true` 为关。与 `auto_extract` **独立**。关 dream 时零 dream LLM。开时走同一 host 闸（`StopReason=completed`、N≥2 完成 turn），**禁止**每 turn 强制合并。抽取仍要求非空 transcript；dream 趟不要求 transcript 非空。抽取与 dream 都开时：先 ingest 再 dream，再机械 GC。dream 不得进入 `gc.ts`。
  - dream 写出：复用四态 `memory_op` 与 `memory_save` 肯定句门禁 + tmp+rename；frontmatter `source: dream`；只经 `memory_recall` 的 tool_result；不豁免 promote；失败 typed + host `// EXIT: log-and-continue`，不 fail 用户 turn。
  - SessionHub：自动记忆钩子与 `engineByRoot` 同形态 per-root，禁止「首根胜出」把 root B 的 transcript 写入 root A 的 `memoryDir`。
  - `notifyAutoMemory`：chat 与 serve 调用同一份 harness 接线辅助（钩子缺席 no-op + 失败吞掉），禁止两宿主各写一份语义。
- **Confirms with human:** （无。2026-08-28 操作员确认 Destination 选项 1，并授权跳过剩余 grilling、直接成文。）
- **Out of this spec:** 向量/图检索；记忆浏览器 UI；per-turn 同步抽取；auto-promote；改 `autoExtract` 或 dream 默认 ON；硬删 `.md`；改 store cap；默认 TTL；跨项目事实库；改 `user.md` 落点；STATUS §2.5 Low 五项（错误类型命名、变量遮蔽、阈值校准、UPDATE 吞 provenance、`drain()` 挂 shutdown）；地图 [wayfinder:map] ④ 记忆层 上的压缩/会话持久化。

## Success Criteria

1. 库中已有一条纯中文现行条，再 ingest 一条同主题、信息量不更多的纯中文候选时，观测为 `NOOP` 或 `UPDATE`/`SUPERSEDE`，**不是**第二条 `ADD`（vitest，FakeLLM）。
2. 既有英文 BM25 / ingest 用例仍绿（`npx vitest run tests/harness/memory/` 相关套件 EXIT 0）。
3. 两候选 token 皆空时，近邻为无命中，不因 containment=1 写成 UPDATE（vitest）。
4. `settings.memory.dream` 缺失或非 `true` 时，即令 `autoExtract === true`，完成闸后的 LLM 调用次数与今日抽取趟一致（无额外 merge complete）（vitest）。
5. `dream === true`、FakeLLM 对两条近重复现行条给出可解析合并时，落盘可观测 SUPERSEDE（旧条 `disabled`）或 UPDATE，且新/改写条带 `source: dream`；`gc.ts` 源文件不出现 LLM 端口引用（vitest + 静态约定：实现不得把 merge prompt 放进 `gc.ts`）。
6. 同一 SessionHub 进程两个 `workspaceRoot` 均 `autoExtract === true` 时，root B 的 completed turn 不在 root A 的 `memoryDir` 写入 `source: auto` 条（vitest）。
7. chat 与 hub 的自动记忆转发失败路径都调用同一导出辅助；钩子缺席与抛错都不改变用户 turn 成功语义（vitest 或模块引用钉死）。
8. `ask` 仍不注册 `memory_recall` / `memory_save`（既有测保持绿）。

## Open Questions

(none)

## Inherits / Changes

- Inherits：`docs/CONTEXT.md` 词条 **auto_extract**、**memory_op**、**memory_gc**、**source: auto**、**source: dream**、**dream**、**surface split (identity vs memory)**（定义以该文件为准，本契约不重写）。
- Inherits: ADR-0009 D3 双通道；ADR-0010 ask opt-out；ADR-0019 `workspaceRoot`；ADR-0031 触发闸 / 四态 / 机械 GC / 默认 OFF；ADR-0033（本契约的设计真值）。
- Changes: 共用 CJK n-gram 切分；空 token 近邻无命中；独立 `dream` 开关与合并趟；`BuiltEngine` 记忆钩子在 `autoExtract || dream` 时装配（仅 extract 关且 dream 关时钩子仍缺席）；SessionHub per-root 钩子；单一 `notifyAutoMemory` 辅助。
- Test command: `npx vitest run tests/harness/memory/` plus targeted session-api hub tests named in SC.
- Surfaces: chat / tui / serve only.

## ACR

```
bounded-context-guardian: yes — 切分/ingest/dream/GC 留在 harness/memory；host 只接线；不新建顶层模块；ask opt-out 不动
defensive-contract-validator: yes — SC 覆盖 empty（关开关/空 token/空 transcript）、negative（非 true 开关）、overflow（dream 输入条数/字符封顶由实现自选但必须有上限）、concurrent（per-root 钩子串行仍在）、exception（LLM·IO → turn 成功）
error-handling-enforcer: yes — dream/extract 失败 typed MemoryError；host 共用辅助必须 // EXIT: log-and-continue；gc 零 LLM；无空 catch
complexity-anti-drift: yes — 切分、per-root notify、dream 分 commit；禁止把 merge prompt 塞进 loop-engine 或 gc.ts
minimal-change-verifier: yes — 一个契约；落地按 plan 分 commit（CJK / Mediums / dream / 文档），禁止与向量检索或默认 ON 混提
```

## 待写入

清单已清空（CONTEXT `dream` / `auto_extract` 钩子条件、Relationships、ADR-0033、ADR-0031 merge 指针已落）。
