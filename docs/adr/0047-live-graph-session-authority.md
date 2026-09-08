# 0047. 长程图的权威态是会话级活图状态，不是无状态多次 run_graph

Date: 2026-09-07
Status: accepted

长程图执行要已完成不重演。V1 每次 `run_graph` 只在调用栈里留下 `GraphExecution`，父代理只拿到 condense JSON，TUI 进度在调用结束清掉，节点 `id` 跨调用挂不上旧 worker。因此 host 必须在会话持有 **活图状态**；不得把长程寄托在模型对 transcript 的记忆上。术语见 `docs/CONTEXT.md`。改图刀口见 ADR-0048。本 ADR 仍不锁修订 wire、活图创建/销毁时机。

## Why not

- **无状态多次 `run_graph`（票 B）**：host 不能强制跳过已完成 id；compact 之后更不可靠。
- **把权威放进 todo 账本**：ADR-0046 已否把清单当管线。
