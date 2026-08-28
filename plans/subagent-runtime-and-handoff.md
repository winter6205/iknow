# Plan: 子代理运行时缺陷 + 冷启动交差对齐

**Goal:** 修好占槽、非法超时/token、双钟漏接；冷启动子代理交差变短、通用角色带说明书、并发上限可配默认 15，并改主模型工具说明。
**Approach:** 先修会锁死容量和误报超时的运行时错误（占槽优先于把上限调到 15），再改父可见交差与说明书注入，最后改工具说明（说明必须与已落地行为一致）。Fork、worktree、对话拷贝不在本轮。
**Spec link:** 无。操作员跳过独立 spec；已决合同写在各票 **Inherits**。
**Tracker:** 操作员指定不建 GitHub issue；本文件随 PR 合入即为票单 SSOT。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

```
bounded-context-guardian: yes — 改动留在 config、subagent、identity/memory 装配既有面；不新建 controllers/services 技术层目录；worker 仍独立进程、不反向依赖父 loop 实现细节
defensive-contract-validator: yes — 公开行为票覆盖 empty / negative / overflow / concurrent / exception（无信封退出、非正 env、容量打满、并行 spawn、解析失败）
error-handling-enforcer: yes — 无信封干净退出走 typed 失败信封 + 放槽，禁止空 catch、禁止 null 当失败；waitFor 超时不单独充当放槽唯一手段
complexity-anti-drift: yes — 退出路径与装配透传保持单层组合；禁止把占槽、env、交差、上限、说明揉进同一函数/同一 commit
minimal-change-verifier: yes — 下表一票一逻辑任务一 commit；禁止运行时修复与交差文案同 commit；禁止把 Fork 塞进本轮
```

## 待写入

- [x] CONTEXT：`父可见信封`、`子代理并发上限`、`说明书静态层`（本 PR 与计划同落）

## Out of scope

- Fork（显式拷贝父对话前缀；默认仍冷启动）
- git worktree / 主会话互踩
- 父附 brief 通道（仍不是整段历史）
- 信封 `model` 字段真正下发
- 子代理独立输出 token 帽
- 靠缩短默认 2 小时任务钟掩盖占槽
- 把 0 解释成「关钟」

## Tasks (ordered by dependency)

1. **timeout/token env 与 settings 共用正整数** — tag: `[implementation]`
   - **Inherits:** 有限正整数才生效；未设/空/非数字/非正 → 视为未设，回退 settings 或既有代码默认（任务钟缺省仍 2 小时、输出帽缺省仍 32k）；禁止把 0/负数当关钟或 `max_tokens=0`
   - **Surface:** `src/config`（env 与 settings 校验）
   - **Acceptance:** `IKNOW_SUBAGENT_TASK_TIMEOUT_MS=0` 不关闭任务钟、wait 不立刻超时；同类 LLM timeout/idle/hard-cap 与 `IKNOW_LLM_MAX_OUTPUT_TOKENS` 非正回退；合法正整数仍覆盖 settings
   - Status: [ ] pending
   - [parallel]

2. **无信封干净退出立即失败并放槽** — tag: `[implementation]`
   - **Inherits:** `exit(0)` 且无信封且尚未终态 → `failed` + `protocolError`（不是 crashed）；`listActive` 不再计入；退出路径必须放槽，不能只靠 wait 拒绝
   - **Surface:** `src/harness/subagent`（manager 退出/状态）
   - **Acceptance:** 静默 exit 0 后 query 为失败且名额腾出；四个静默退出后第五个 spawn 不再因容量失败；原「维持 running」断言改为失败放槽；非 0 退出仍 crashed
   - Status: [ ] pending
   - [parallel]

3. **worker 接上与父同一套 idle / hard-cap** — tag: `[implementation]`
   - **Inherits:** 数字来自同一份 `env.llm`；不是第二套子代理钟配置；worker 装配必须把 idle 与 hard-cap 传入 loop，与父透传同形
   - **Surface:** `src/harness/subagent`（worker 装配）
   - **Acceptance:** 注入非默认 idle/hard-cap 后 worker 的 loop deps 带上这两项；只设 timeoutMs、缺双钟的路径消失
   - Status: [ ] pending
   - [parallel]

4. **子代理并发上限可配，默认 15** — tag: `[implementation]`
   - **Inherits:** 同时 `starting|running` 硬顶可配，默认 15；模型自决定张数；超限立即失败、不排队；用户调天花板，不每次填要发几个
   - **Surface:** `src/config` + `src/harness/subagent`（容量门）
   - **Acceptance:** 默认 15 路打满后第 16 个立即容量错误；配成更小值时按配置打满；非法/非正回退默认 15
   - Status: [ ] pending
   - [blocks: T2]

5. **父可见信封改为短摘要 + 路径** — tag: `[implementation]`
   - **Inherits:** 成功时父侧要看到 status、短 summary、fileRefs、stop_reason；`result` 不再等于终稿全文；超长汇报标明「汇报已收束」而非任务失败；磁盘上的写文件不回滚；bash 写盘仍可不进 fileRefs（已知边界）
   - **Surface:** `src/harness/subagent`（envelope 派生 / 截断）
   - **Acceptance:** 长终稿成功任务父可见层短、带路径（有 write_file/edit_file 时）；`truncated` 语义是汇报收束；失败仍带 reason + 非空 summary
   - Status: [ ] pending

6. **通用 worker 注入说明书静态层，记忆工具仍关** — tag: `[implementation]`
   - **Inherits:** 通用子代理 system 含用户级+项目级 AGENTS.md 与 rules；`memory_recall`/`memory_save`、自动抽取、记忆库灌窗仍关；探索可不注或只注极短说明；与 `memoryEnabled` 整段关掉说明书脱钩
   - **Surface:** `src/harness/identity` 与 memory 静态装配 + worker 装配
   - **Acceptance:** general-purpose worker 的 system 含仓库 AGENTS.md 正文（有文件时）；无 memory 工具；explore 不因本票获得写工具
   - Status: [ ] pending

7. **缺省角色为 general-purpose，终稿不贴整文件** — tag: `[implementation]`
   - **Inherits:** 不传 `subagent_type` 走 general-purpose（含 persona 与说明书静态层），不再走「无 persona 的 V1 空角色」；persona 要求交差短、列路径、不把整文件贴进终稿
   - **Surface:** `src/harness/subagent`（catalog / spawn 缺省）
   - **Acceptance:** 省略 `subagent_type` 的 spawn 与显式 `general-purpose` 工具面和说明书注入一致；explore 仍只读
   - Status: [ ] pending
   - [blocks: T6]

8. **spawn / subagent_result 工具说明与行为一致** — tag: `[implementation]`
   - **Inherits:** 说明写清：何时派、任务要自洽、独立才并行、满员减并发、交差看摘要和路径、默认 general-purpose、探索只读、同时最多 N（默认 15）。不写尚未交付的 Fork/worktree。不把运行时三件缺陷改成「靠说明修」
   - **Surface:** spawn 与 subagent_result 工具 description（及仍注入的 coordinator 文案若有）
   - **Acceptance:** 主模型可见文案与 T4/T5/T7 行为一致；不再声称「完整 result 是唯一真相」
   - Status: [ ] pending
   - [blocks: T4, T5, T7]
