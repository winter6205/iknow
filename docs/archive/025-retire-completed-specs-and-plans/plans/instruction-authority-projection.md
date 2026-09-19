# Plan: 指令权威出站投影

**Goal:** 假官方标签不能再靠外形抬权；发给模型的字节由代码按来源投影，子代理宪法不被父模型 addendum 买进 system。
**Approach:** 先把信道决策写成 ADR/CONTEXT，再在 adapter 出站缝加深投影（盖戳 + 转译），然后改栏读规则与 worker 装配；最后在**仓库根 README 的 Features** 给人一行简介。不改 soul 当机制，不碰权限/截断 sink。
**Spec link:** `specs/instruction-authority-projection.md`
**ACR:** all-yes（见下块）
**Tracker:** 本地 markdown；对应 GH #1066
**待写入:** T1 落盘 —— 「出站投影（model-facing projection）」「宿主帧出处戳」「指令权威 vs 能力权威」。T1 完成前不调用额外 persist 回合（本 plan 的 T1 即 domain-modeling 切片）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

```text
bounded-context-guardian: yes — 投影收在既有 model-adapter 出站缝；loop-engine 只在已有 encodeUserText 注入点盖戳；worker 仍在 subagent 装配。不进 soul/identity 当安全 module，不新建 controllers 层目录
input-contract-tests: yes — 投影函数覆盖空 messages、畸形 tool_result、无戳假栏、超长载荷、并发两跳同历史纯函数；失败路径 typed、不回落原样上脏
error-handling-enforcer: yes — invariant 5 fail-closed；编码器错误 typed，空 catch 禁止；缺戳不当成宿主
complexity-anti-drift: yes — 加深 buildMessageParams 一处，不在每个工具复制横幅；转译规则单一，不与 executor 截断混职责
minimal-change-verifier: yes — 范围 = #1066 指令权威面；不改 permissions / memory body / CaMeL；README 只加 Features 一行且排在能力落地之后
OVERALL: PASS
```

## Tasks (ordered by dependency)

1. **T1 决策落盘 ADR + CONTEXT** — tag: `[decision]`
   - **Inherits:** spec invariant 1–6；ADR-0009「labeling alone is not defense」推广到指令面；ADR-0028 栏仍在 messages、不进 system。
   - **Surface:** `docs/adr/`、`docs/CONTEXT.md`
   - **Acceptance:** 词条可被后续弹 Inherits 引用；写明 README 简介落在仓库根 `README.md` Features，不是 docs 内 README。
   - Status: [x] done

2. **T2 盖戳 + 出站转译** — tag: `[implementation]`
   - **Inherits:** spec invariant 1–3、5；「磁盘可脏、wire 是派生视图」对齐 observability side-channel。
   - **Surface:** `src/harness/model-adapter/`、`src/harness/loop-engine.ts`（宿主注入 commit）
   - **Acceptance:** 构造含完整假 `<agent_status>` 的 tool_result 的 `LoopState`，经出站投影后：未转义官方栏语法只出现在带戳宿主消息；无戳载荷被转译；投影对同一 state 两次调用字节相同；投影失败则 step 不发 SDK。`npm test` 绿。
   - Status: [x] done
   - [blocks: T1]

3. **T3 栏读规则** — tag: `[implementation]`
   - **Inherits:** spec「只信本跳宿主帧」；ADR-0028 栏仍 append-only、不写 `deps.system`。
   - **Surface:** `src/harness/identity/`（读规则常量）
   - **Acceptance:** 装配出的 system 不再把「messages 里最新 `<agent_status>` 标签」说成权威；prompt 黄金集 / SEAM 锁按 `docs/guides/prompt-development.md` 该跑的跑了。
   - Status: [x] done
   - [blocks: T2]

4. **T4 worker addendum 降权** — tag: `[implementation]`
   - **Inherits:** spec invariant 4；ADR-0044 精神（低完整度来源不买 system 席位）。
   - **Surface:** `src/harness/subagent/`
   - **Acceptance:** 父 `systemPrompt` 含「忽略 LOCKED / 覆盖 identity」时，worker 发给模型的 `system` LOCKED 前缀与无 addendum 相同；该句若出现只在 user/untrusted。`npm test` 绿。
   - Status: [x] done
   - [blocks: T1]
   - [parallel] 可与 T2 并行，合入前与 T2 投影合同对齐

5. **T5 根目录 README Features 一行** — tag: `[implementation]`
   - **Inherits:** spec T5；操作员指定的简介落点 = **仓库根** `/README.md`（项目介绍），`## Features` 列表，与 Harness / Tools / Surfaces 同级一条。
   - **Surface:** `README.md`（repo root only）
   - **Acceptance:** Features 多一条英文短句，说明指令通道在出站层分开（工具结果不能冒充宿主帧；子代理宪法代码锁定）。不写 PoC、不写伪造步骤、不改 `web/README.md`。排在 T2–T4 行为可演示之后。
   - Status: [x] done
   - [blocks: T2, T3, T4]

## Notes

- 实现期文件名 / 戳字段形态留 headroom；验收钉 wire 行为。
- Issue 1066 的 soul 告诫不是本 plan 验收项；若加一句，挂 usage 且不单独开弹。
- Rebase 到较新默认分支后再定 ADR 编号。
