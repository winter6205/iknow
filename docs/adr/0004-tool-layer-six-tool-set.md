# 0004. Tool layer six-tool set (bash / read_file / grep / glob / edit_file / write_file)

Date: 2026-08-04
Status: accepted

## Context

GH issue #140（winter6205/iknow，`[wayfinder:grilling]` 工具层重写设计，父 #114 记忆层地图）。现行 5 个 ACI 工具（`shell_exec` / `fs_search` / `fs_view` / `fs_edit` / `context_manager`）自身均标 `PROTOTYPE（throwaway）`，且逐个有致命硬伤：shell_exec timeout 不杀进程 + allowlist 是可执行文件名非能力；fs_search 单工具混"搜内容/找文件"两语义（`pattern:""` 匹配所有文件）；fs_view 标 `isConcurrencySafe:true` 却用闭包共享状态 `lastPath/lastOffset`；context_manager 实际是死的（`lazy:true` 真实 CLI 路径失效）。#125 已裁决 context_manager 删除。重写是兑现既定 graduation 债务。业界参照：OpenHarness（Claude Code 的 Python 移植，`upstream-openharness/`）+ SWE-agent。操作员 2026-08-03~04 经 10 轮逐题 HITL grilling 裁决。

## Decision

**6 工具集定型，业界通用名，executor/registry/契约层 production-ready 保留并加固**：

1. **bash**（替代 shell_exec）。安全边界 = OS 沙箱（#123 阻塞前置），allowlist 降级为沙箱落地前过渡措施。输出截断 12000 字符照搬（修现行 UTF-16 surrogate 拆断 → 按 code point）；timeout 不暴露给模型（统一 executor 层）；输出保留结构化 `{code, stdout, stderr}`（供 eval/trajectory）。
2. **read_file**（替代 fs_view）。纯无状态（废闭包），输入 `path` + `offset`（0 基）+ `limit`（默认 200 / 上限 2000）；NUL 二进制检测；文件大小上限 1MB（读前 stat，超限拒绝并引导 grep）；输出纯字符串带行号 `<n:>6\t<line>`。废除现行 `{path, lines, from, to, nextOffset, eof}` 六字段——`nextOffset`/`eof` 模型自推可得，零信息增量。
3. **grep**（拆自 fs_search 的搜内容半）。ripgrep 子进程优先 + Node fallback；正则；默认大小写敏感（`ignoreCase` 可选）；`limit`（默认 200 / 上限 2000）；输出纯字符串 `路径:行号:行内容`。
4. **glob**（拆自 fs_search 的找文件半）。真 glob 模式（废子串匹配）；`rg --files` + Node fallback；`limit`（默认 200 / 上限 5000）；输出字母序相对路径纯字符串。
5. **edit_file**（替代 fs_edit）。保留 poka-yoke linter（括号/引号配对检查，写入前拒绝不配对——iknow 领先项，SWE-agent 最佳实践，OpenHarness 缺）；新增 `replace_all`（默认 false）；保留 `split().join()` 替换（避 `$&` 污染）。
6. **write_file**（新增，弥补缺口）。输入 `path` + `content` + `create_directories`（默认 true）。语义 = 创建或整体覆写。现行无任何工具能新建文件（edit_file 要求 old_str 已存在；过渡期 bash allowlist 禁 `>` 重定向）。同款 poka-yoke linter。

**跨工具契约**：

- **契约 X（截断元数据单一权威）**：工具返回纯数据，不带 `truncated`/`total` 元字段；executor 是唯一权威——自测序列化字符数、自截断、自合成标记、永不信任工具声称字段。防 MCP 第三方伪造面。
- **契约 Y1（输出纯字符串，deprecated→#298）**：对齐 OpenHarness（其 wire 边界 `serialize_content_block` 丢弃 metadata）。bash 例外（Y1b 保结构化 code）。**#298 起 Y1「纯字符串」读法被 observability side-channel 取代**——model-facing tool_result 仍为纯字符串（Y1 精神保留），但 handler 可返回 envelope `{ output, meta? }`，executor 拆分后仅 `output` 串行化进 model tool_result，`meta`（典型如 edit_file/write_file 的 `oldContent`/`newContent`）经 `PostToolUseHook.payload` → `TuiToolEvent.payload` → `LiveToolRun` 走观测旁路，永不进模型视野。
- **symlink**：resolve + containment 本期落地；挂载边界 OS 隔离归 #123。

**工作流语义**：grep/glob 发现 → read_file 精读；大文件永不整体进上下文。

**Why not alternatives**:

- _保留 5 工具、不拆 grep/glob、不加 write_file_：fs_search 单工具语义模糊（`pattern:""` bug 级副作用）；无 write_file 则 agent 无法新建文件（过渡期 bash 兜底也被 allowlist 堵死）。
- _沿用 iknow 自造名（shell_exec / fs_view / fs_search）_：业界通用名（OpenHarness/Claude Code/SWE-agent 共识）降低模型学习成本 + prompt 语义清晰；rename 安全因 permission 载重的是 `aci.category` 字段非 name 字符串。
- _保留 fs_search 的 `{matches, truncated, total}` 结构化输出_：偏离业界（OpenHarness 工具返回纯字符串）；`truncated`/`total` 是可伪造字段（MCP 第三方可塞假值骗过封顶）；契约 X 改为 executor 唯一权威。
- _read_file 保留有状态分页_：闭包状态与 `isConcurrencySafe:true` 矛盾，且 loop 串行根本无人读该状态；无状态可重放、可并发、易测试。
- _bash 输出纯字符串（完全对齐 OpenHarness）_：bash `code` 对 eval/trajectory 是真有用信息（区分"跑了但报错"与"没跑"），OpenHarness 把它塞 metadata 但 wire 边界丢弃；iknow 不必照搬"丢弃 metadata"。

## Consequences

- (+) 工具集对齐业界通用名 + 动作语义分离，模型学习成本与 prompt 清晰度双优。
- (+) 契约 X 把截断元数据收敛到 executor 单一权威，MCP 第三方伪造面收敛到一处。
- (+) write_file 弥补"无法新建文件"缺口，agent 可做完整编码任务。
- (+) read_file 无状态化消除并发矛盾 + 隐藏耦合。
- (−) rename 到业界名需同步 permission/category 装配 + eval/trajectory 引用（`shell_exec` 等旧名）。
- (−) bash 生产路径阻塞于 #123 沙箱（allowlist 仅过渡）；5 条沙箱痕迹清单留 #140 评论区 + #123 已留指针。
- (−) edit_file/write_file 的 poka-yoke linter 对"合法但不配对"内容（如 markdown 代码块）有误报风险——先应用，真实误报再放宽（记录在案）。
- (−) 契约 Y1 使模型失去结构化 `total`（"200/347 matches"），靠截断标记 + "re-invoke with narrower input" 引导——OpenHarness 已验证模型可读文本 marker 正确决策。
- (+→−) 契约 Y1 在 #298 被 observability side-channel 取代：model-facing tool_result 仍纯字符串（Y1 精神保留），但 handler envelope 的 `meta` 字段经独立旁路供 TUI 等观测消费者，模型视野不被结构化字段污染。

**Evidence pointers**:

- GH issue #140（winter6205/iknow）— 10 轮 grilling 逐题裁决 + Resolution + 各工具决议评论。
- GH issue #125（closed）— context_manager 删除决议。
- `upstream-openharness/src/openharness/tools/` — 业界工具源码参照（bash_tool / file_read_tool / grep_tool / glob_tool / file_edit_tool / file_write_tool）。
- `docs/harness-report/p04-tool-aci.html` — OpenHarness 工具层映射报告 + SWE-agent 对照。
- `src/harness/aci/tools/` — 现行 5 个 PROTOTYPE 工具（重写对象）。
- 关联 ADR：0005（executor 加固）/ 0006（封顶策略）。
