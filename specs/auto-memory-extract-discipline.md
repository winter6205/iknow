# Spec: auto-memory-extract-discipline（对照说明书丢弃 · 不记仓库可推 · 本轮 save 跳过抽取）

> 只改自动抽取**写路径**。目录 / 预取 / 低信任包装 / dream 闸 / 默认 OFF / promote 门槛一律不动。

## Objective

`autoExtract === true` 时：抽取提示词带上用户级与项目级说明书；候选在进四态闸之前若与说明书词重叠过高则丢弃；打开仓库就能知道的内容靠提示词禁止写入；本轮已成功 `memory_save` 则跳过这次 extract。`ask` 仍不接线。

## Boundaries

- **Does:**
  - 抽取前读用户 + 项目 `AGENTS.md` 与 `rules`（现成 discovery；按既有静态层文件帽截断）。把该文本和 transcript 一起交给 `buildExtractPrompt`。记忆库 body 不进抽取提示词。
  - 提示词英文纪律（实现锁定原文，测试做包含断言）：说明书里已有的不要再输出为候选；仓库/git 能推出来的（架构、路径、已合入修复）不要记；用户纠正过的以及明确肯定过的要记；本轮任务进度 / 当天需求 / 临时路径 / 调试闲聊不要记。
  - 静态层读失败：当空字符串，抽取仍跑；`// EXIT: log-and-continue`；用户 turn 成功。
  - 「仓库可推」只靠提示词，不扫工作区。
  - `extractMemoryCandidates` 之后、`decideMemoryOps` 之前：候选 title+body 与静态层用同一套 tokenize 算重叠。零词命中不得留下。重叠过线（门槛由实现选定、测例钉死）→ 丢弃，不进 ADD/UPDATE/SUPERSEDE。不回灌抽取模型、不加第二次 LLM。静态层为空则本闸不丢任何候选。
  - 顺序：抽取 → 说明书重叠丢弃 → 四态 decide → persist。库内近邻四态保留。
  - 同一 `completed` turn 内已有成功 `memory_save` → 即使 N≥2 到期也不调用 `ingestMemory` 的 extract。dream 双闸独立，该做梦仍做。save 未发生或失败 → 抽取与今日相同。
- **Confirms with human:** （无。操作员确认按上列三刀落地。）
- **Out of this spec:** 自动 promote / 正文进 `system`；改默认 ON；扫仓检测；拦截后回灌模型；改 N≥2；改 dream 闸；改目录/预取/召回；记忆 UI；`ask` 接线。

## Success Criteria

1. `autoExtract !== true`：无新 LLM、重叠闸与 save 跳过均不出现（既有 hook / build-engine 测绿）。
2. 有静态层文件时，FakeLLM 收到的 prompt 含说明书片段，且含三类纪律英文要点（勿抄说明书、勿记仓库可推、纠正与确认要记）。
3. 静态层有约定句、候选与之高词重叠 → 不进入 ops / 不 written；无关候选仍可 ADD。
4. 静态层为空：重叠闸不丢候选。
5. 静态层 IO 失败：ingest 可完成（或空候选），不 throw 到用户 turn。
6. 本轮 `memory_save` 成功且 N≥2 到期：extract LLM `complete` 次数为 0；无 save 时仍为 1。
7. 跳过 extract 时，dream 开且双闸到仍可跑 dream。
8. `npx vitest run tests/harness/memory/` 及相关 hook 测 EXIT 0。

## Open Questions

(none)

## Inherits / Changes

- Inherits：`auto_extract`、user-level / 项目 `AGENTS.md`、四态 ingest、N≥2、dream 24h ∧ 5 session、ADR-0031 / 0033 / 0034 读路径与默认 OFF。
- Changes：抽取输入增加静态层；候选增加说明书重叠丢弃；本轮成功 save 跳过 extract。
- Test command: `npx vitest run tests/harness/memory/`
- Surfaces: `src/harness/memory`；host 只传静态层与「本轮是否 save 成功」。

## ACR

```
bounded-context-guardian: yes — 提示词/重叠闸/skip 在 harness/memory；host 只接线；loop-engine 不嵌抽取纪律
defensive-contract-validator: yes — SC 覆盖 empty（关抽取/空说明书）、negative（高重叠丢弃）、overflow（静态层截断）、concurrent（per-root memoryDir 仍隔离）、exception（静态层 IO 不 fail turn）
error-handling-enforcer: yes — 静态层失败 EXIT: log-and-continue；无空 catch；不回灌二次 LLM
complexity-anti-drift: yes — 提示词+重叠闸、save 跳过分 commit；禁止把比对塞进 loop-engine
minimal-change-verifier: yes — 一个写路径纪律契约；禁止与目录/预取/dream 闸/默认 ON 混提
```

## 待写入

清单空（落地后再改 STATUS；需要时短补 ADR-0031，本 PR 不写 ADR）。
