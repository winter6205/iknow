# Plan: symbol-primary-aci

**Goal:** 智能体以符号身份查找并改代码；坐标 `lsp_*` 退出模型面；使用规则段恒在。
**Approach:** 先把装配与文案钉死，再 expand 符号查询（旧工具仍在）、再符号改、再 contract 删坐标面并改 MCP 查询名单与归档索引。每颗子弹可演示一条智能体路径。不在计划正文写外部对照来源。
**Spec link:** `specs/symbol-primary-aci.md`
**Tracker:** GitHub 主路径。spec [#843](https://github.com/winter6205/iknow/issues/843)。子弹 T1 [#844](https://github.com/winter6205/iknow/issues/844) → T2 [#845](https://github.com/winter6205/iknow/issues/845) → T3 [#846](https://github.com/winter6205/iknow/issues/846) 与 T4 [#847](https://github.com/winter6205/iknow/issues/847) → T5 [#848](https://github.com/winter6205/iknow/issues/848) → T6 [#849](https://github.com/winter6205/iknow/issues/849)；blocking 已按 `[blocks:]` 接到 tracker。
**ACR:** all-yes（见下）。本计划文件同时是 ACR SSOT。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

**待写入:** （空 — CONTEXT 词条与 ADR-0038 已在本合同 PR persist）

## ACR

Affects (implementation round): `src/harness/identity/`（assemble + 新 usage 常量）、`src/harness/aci/tools/`（注册表与符号工具）、`src/harness/lsp/`（仅当按名字查找必须改客户端/索引）、`src/tui/tool-summary.ts`、子代理约束与 worker 工具面测试、`src/lsp-mcp/`（查询工具名单）、`specs/` 索引与归档、锁工具名的 harness 测试。

bounded-context-guardian: yes — 使用规则落在既有 identity 装配缝；工具仍在 aci；语言服务器仍在 lsp；MCP 仍在 lsp-mcp transport；不新建 controllers/services 层目录。
defensive-contract-validator: yes — spec SC6 要求符号公共 API 覆盖 empty / negative / overflow / concurrent / exception；无服务器与非法身份走可读失败。
error-handling-enforcer: yes — 无 client、rename 冲突、safe_delete 仍有引用均须 typed 或既有非空失败串，禁止空 catch；invalidate 失败不得静默当成功改名。
complexity-anti-drift: yes — 查询/改分工具或分工厂，符号身份解析与 RPC 发送分层；禁止把十几个协议塞进一个 god handler。
minimal-change-verifier: yes — 实施按下列子弹各 1 commit；本合同 PR 只含 spec/plan/ADR/CONTEXT/索引，与实施 commit 分离。

## Tasks (ordered by dependency)

1. **使用规则段进装配** — tag: `[implementation]`
   - **Inherits:** spec Assumptions 5–9；ADR-0038；顺序 identity → soul → usage → user_profile → bootstrap → memory_layer；ask 仍有 usage；soul Vibe 不动排版纪律
   - **Surface:** `src/harness/identity/`
   - **Acceptance:** 装配测试证明六段顺序；ask 夹具含 usage 标题；usage 正文含符号优先与三类 grep 回退；soul 文件无该细则
   - Status: [ ] pending

2. **Expand：符号查询工具与旧 `lsp_*` 并存** — tag: `[implementation]`
   - **Inherits:** spec 模型面查询名单与符号身份主入参；禁止把 line/character 当这些新工具的必填项；无服务器失败串继承；302 dispatch 继承
   - **Surface:** `src/harness/aci/`（及必要时 `src/harness/lsp/`）
   - **Acceptance:** 新查询工具可调用；旧 `lsp_*` 此步仍注册；有一条不填行列、只填符号身份+文件的命中或明确失败测试；Gate 3 名单合法更新
   - Status: [ ] pending
   - [blocks: T1]

3. **工具说明与只读约束对齐使用规则** — tag: `[implementation]`
   - **Inherits:** spec 使用规则；只读 worker 不得把 grep 与符号工具并列为首选
   - **Surface:** identity 约束段 + ACI description（D9 纪律）
   - **Acceptance:** 只读约束测试或快照不再列出旧 `lsp_*` 作为与 grep 同等首选；新工具 description 写符号身份而非「先给行列」
   - Status: [ ] pending
   - [blocks: T2]

4. **符号级改工具** — tag: `[implementation]`
   - **Inherits:** spec rename / replace body / insert before-after / safe_delete；写盘走既有 permission 与 invalidate；edit_file 仍在
   - **Surface:** `src/harness/aci/`
   - **Acceptance:** 改名或换 body 在夹具上可观测；safe_delete 在仍有引用时不删并返回引用；空/非法身份失败可读
   - Status: [ ] pending
   - [blocks: T2]

5. **Contract：模型面去掉坐标 `lsp_*`，索引归档 251** — tag: `[implementation]`
   - **Inherits:** spec SC2、SC7；旧 handler 可留作内部，但不得再出现在 ACI 名单
   - **Surface:** registry、TUI summary、子代理工具面测试、`specs/README.md` 与归档目录
   - **Acceptance:** 全仓测试与 `ACI_TOOLSET_NAMES` 无那 10 个旧名；`251-lsp-tool.md` 不在活跃索引
   - Status: [ ] pending
   - [blocks: T3, T4]

6. **MCP 查询面与 ACI 查询同构** — tag: `[implementation]`
   - **Inherits:** spec Assumption 12；MCP 不强制写类符号工具
   - **Surface:** `src/lsp-mcp/` 与 `specs/lsp-mcp-server.md`
   - **Acceptance:** MCP `tools/list` 查询名为新符号查询集（或明确子集），不含旧 `lsp_*` 十名；in-memory 单测更新
   - Status: [ ] pending
   - [blocks: T5]
