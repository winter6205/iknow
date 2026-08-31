# 0039. Ctrl+C 等待语义：不可解开等待的边界与反馈

Date: 2026-08-31

Status: accepted

## Context

Ctrl+C 的目标不是让每个底层调用都能物理中止，而是让调用方得到确定、可解释的结果。当前 ACI executor 已按工具元数据区分 `cancel` 与 `block`：`block` handler 收到 tier signal 而不是 caller signal，caller abort 在 handler 收尾后再归一为 `cancelled`（`src/harness/aci/aci-executor.ts:306-310, 349-377`）。

这条既有 `block` 语义必须与权限等待区分。`AskUser` 接口当前只有工具、输入、提示和可选网络标记，没有 signal（`src/harness/permission/types.ts:97-107`），权限 executor 直接等待 `askUser` 的布尔结果（`src/harness/permission/permission-executor.ts:209-223`）。这说明权限等待是待修复的 abort 缺口，不是可以接受的不可解开等待。

`read_mcp_resource` 的「handler 不透传 signal」是显式的 M3 决议，不是偶然漏接：handler 形参名为 `_ctx`，注释以「当前 manager.readResource(server, uri) 契约无 signal 入参」为理由（`src/harness/aci/tools/read-mcp-resource.ts:71-82`）。该前提已经失效：`McpManager.readResource` 已有可选 signal（`src/harness/mcp/manager.ts:237-241`），实现把 caller signal 与 shutdown signal 经 `mergeAbort` 合并后传给 MCP client（`src/harness/mcp/manager.ts:659-676`）。

## Decision

### 1. 允许不可被 abort 解开的等待

仅允许以下两类等待暂时无法被 caller abort 解开：

1. `interruptBehavior: "block"` 工具的 handler 自身执行期间。该 tier 的合同就是让 handler 收尾，而不是把 caller signal 传进 handler。
2. 第三方 MCP server 已经收到请求但不响应取消的情形。server 是否遵守取消协议不由 host 保证。

权限等待（`AskUser`）不属于上述任一类，必须能够被 abort 解开。除这两类之外，不得把底层等待默认为「不可取消」。

### 2. 不可解开时的用户反馈

caller abort 后，调用方必须收到明确的可见反馈，至少区分以下事实：

- 界面已经停止等待，或本次 turn 已按取消收口；
- 底层操作仍在后台收尾或运行，原因是该等待未能被真正解开；
- 这不等同于底层操作已停止，不能把它伪装成已停止、已回滚或已完成。

反馈应沿既有 typed `cancelled`/停止结果和 host 可见状态通道呈现；不得用静默返回、普通成功结果或模糊的「无响应」代替这三项事实。若底层最终仍会完成，完成事实也不得覆盖此前「界面已停止等待、取消未物理中止」的说明。

### 3. `block` tier 排除 caller signal 的语义维持

维持 M3 已有决议：`block` tier 排除 caller signal，handler 继续使用 tier timeout signal 并自然收尾。理由是 `block` 的语义定义就是让 handler 完成收尾，而不是在 caller abort 时强行中断 handler。

这不代表 caller abort 被忽略。外层必须在 handler 收尾后把结果归一为既有 typed `execution_failed`，其 `message` 为 `cancelled`；同时按第 2 节向调用方说明「界面已停止等待，底层仍在收尾/运行」。不新增另一套取消状态，也不把该调用伪装为成功。

### 4. 重开并推翻 `read_mcp_resource` 的 M3 决议

本 ADR 明确**推翻既有决议**中「`read_mcp_resource` handler 不透传 signal」的部分。

- **原决议**：handler 使用 `_ctx`，调用 `manager.readResource(parsed.server, parsed.uri)` 时不传 signal；理由是注释所写的「当前 manager.readResource(server, uri) 契约无 signal 入参」（`src/harness/aci/tools/read-mcp-resource.ts:71-82`）。
- **理由失效**：manager 的公开契约已支持 `readResource(server, uri, opts?: { signal })`（`src/harness/mcp/manager.ts:237-241`）；其实现还明确用 `mergeAbort(opts?.signal, slot.callAbort?.signal)` 合并 caller 与 shutdown signal（`src/harness/mcp/manager.ts:659-676`）。因此「无 signal 入参」不再是代码事实。
- **新决议**：`read_mcp_resource` handler 必须透传 `ctx.signal` 到 `manager.readResource` 的 options；manager 继续负责与 shutdown signal 合并。该工具原本就声明 `interruptBehavior: "cancel"`（`src/harness/aci/tools/read-mcp-resource.ts:120`），透传 signal 才与自身 metadata 及 `cancel` tier 语义一致。

本次重开只覆盖 signal 透传，不推翻该工具其余 M3 约束（资源内容按 untrusted 数据处理、typed error 包装和 executor 输出截断）。

## Consequences

### Positive

- Ctrl+C 的结果有确定口径：允许不物理中止的范围被限制，权限等待不再被错误地纳入例外。
- `block` 的收尾保护与既有 `cancelled` 类型结果保持兼容。
- `read_mcp_resource` 的声明 metadata 与实际 signal 链路一致；第三方 MCP 不响应取消时，调用方仍能区分界面停止等待与底层未停止。

### Negative / Trade-offs

- `block` handler 和不响应取消的第三方 MCP 请求可能在界面停止等待后继续占用资源，直到自然结束或 tier/shutdown 处理。
- host 需要同时展示取消收口和底层仍在运行的事实，不能只依赖单一成功/失败字面。
- `AskUser` 的接口和各 host 实现需要另行补 signal，迟到的批准必须按取消后的状态处理。

## Reversibility

若后续所有 `block` handler 和第三方 MCP client 都能提供可靠取消，可另立 ADR 收窄例外；在此之前，任何收窄都必须先提供真实的取消合同和可见状态证据。`read_mcp_resource` 的 signal 透传可独立回退，但回退必须重新解释其 `cancel` metadata，不得静默恢复旧决议。

## Evidence

- `plans/ctrl-c-interrupt.md` T3：不可取消等待、用户反馈与 `block` tier 语义定案。
- `src/harness/aci/aci-executor.ts:306-310, 349-377`：`block` 排除 caller signal，并在收尾后归一 `cancelled`。
- `src/harness/permission/types.ts:97-107`、`src/harness/permission/permission-executor.ts:209-223`：权限等待当前没有 signal 入参。
- `src/harness/mcp/manager.ts:237-241, 659-676`：`readResource` 已支持并合并 caller signal。
