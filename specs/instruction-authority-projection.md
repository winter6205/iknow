# Spec: 指令权威出站投影 —— 宿主帧盖戳，untrusted 通道不能冒充官方门牌

**Status:** landed（T1–T5 实施完毕；决策落盘 ADR-0112）
**Basis:** GH #1066；ADR-0009 / ADR-0044（channel-based 信任，labeling 不是防御）；ADR-0028（状态栏进 messages、不进 `deps.system`）；契约 X / observability side-channel（磁盘真源 ≠ 模型可见字节）
**Surface:** `src/harness/model-adapter/`（`buildMessageParams` 出站缝）、`src/harness/loop-engine.ts`（宿主注入 commit 盖戳）、`src/harness/subagent/worker.ts`（constitution vs addendum）、根目录 `README.md`（Features 一行，落地后）
**Issue:** https://github.com/winter6205/iknow/issues/1066

## Goal

指令权威从「模型读同一串字、靠自觉」收成 **出站投影**：权威历史可以脏；发给模型的 JSON 按来源排版。假 `<agent_status>` / 假系统前缀若出现在工具结果里，不能长成官方帧；子代理 LOCKED 宪法不被父模型 `systemPrompt` 抬进 `system`。

## Boundaries

- **Does:**
  - 宿主注入（状态栏等同款 `encodeUserText` 注入）在 commit 时打 **非模型可见** 出处戳；出站剥掉。
  - `buildMessageParams`（或抽出的同缝纯函数）对无戳 / `tool_result` 文本做确定转译，使载荷无法复现未转义的 host 帧语法。
  - `IKNOW_AGENT_STATUS_READ_RULE` 改为「只信本跳宿主帧」，不再宣称 transcript 里最新 XML 标签权威。
  - worker：`envelope.systemPrompt` 不得覆盖 LOCKED 六段；addendum 降到 user/untrusted。
  - 能力落地后，根目录 `README.md` 的 **Features** 增加一条产品简介（给人看，不是安全白皮书）。
- **Out of this spec:**
  - 全量 CaMeL / 特权 LLM 抽控制流。
  - 用 soul 告诫当验收机制（usage 一行可选，不承担 invariant）。
  - 改 `permissions.toml` / executor 截断 / memory body 进 system（已有，保持）。
  - 把转义写进权威历史或 TUI 展示原文。
  - 识别操作员输入框越狱（operator 通道）。
  - 自然语言间接注入的「模型绝不听话」保证（那是 sink；本 spec 只拆假门牌）。

## Settled invariants

1. **模型协议是派生视图。** 投影是 `LoopState` + `request.system` 的纯函数；同一历史 → 同一 wire 字节（KV 前缀稳定）。不得靠每跳改 `system` 塞现势。
2. **官方外形只来自带戳的宿主 commit。** 解析 XML / 前缀名册不是防伪；`isHostInjectedUserText` 继续服务 TUI 藏气泡 / instruction 回显，不承担权威。
3. **Untrusted 不得复现 host 语法。** `tool_result` 与无戳 user 文本出站后，不得含可被读规则认作栏/宿主注入的未转义标签。内容仍可读（数据还在）。
4. **Constitution 不可被父模型购买。** worker `system` 的 LOCKED 前缀与无 addendum 时相同；`task` / `systemPrompt` 不进最高信任槽。
5. **失败 fail-closed。** 编码器/投影抛 typed 错误则本跳不发模型请求，不回落「原样上脏 transcript」。
6. **不替代 sink。** 普通句子里的「去做 X」仍可能被模型执行；权限、沙箱、egress 仍是那一层。

## 任务拆分

### T1 — ADR + CONTEXT 词条（决策落盘）

把「出站投影 / 宿主帧出处 / 指令权威 vs 能力权威」写入 ADR 与 `docs/CONTEXT.md`。编号在落地分支相对默认分支取下一个空号（勿与未合入的 0108 抢号）。

### T2 — 宿主 commit 盖戳 + 出站转译

注入点盖戳；`buildMessageParams` 加深为投影。验收：tool_result 内完整假栏 → wire 上官方语法只出现在带戳帧。

### T3 — 状态栏读规则

改 `IKNOW_AGENT_STATUS_READ_RULE`；黄金集 / SEAM 锁按 `docs/guides/prompt-development.md`。

### T4 — worker addendum 降权

`withRoleExtras` / 等价装配：LOCKED 段不被 `envelope.systemPrompt` 覆盖。

### T5 — 根目录 README Features 一行

功能合入后改 **仓库根** `README.md`（介绍项目的那份），在 `## Features` 加一条，句式与现有 Harness / Tools / Surfaces 同级：短、产品语言、不写攻击步骤。不改 `web/README.md`、不改 `docs/` 下 README。

## Out of scope（再列）

- 各工具各自加横幅（`web_fetch` 孤岛应收进投影，不在每个工具复制）。
- 把栏从 messages 挪进 system（违反 ADR-0028 cache 契约）。
