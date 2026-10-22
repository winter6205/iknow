---
paths:
  - "src/tui/**"
  - "tests/tui/**"
---

# TUI 测试与真实交互验证

- TUI 只负责渲染和输入（依赖方向见 `AGENTS.md`「硬边界」）。会话、工具、模型、持久化的行为在核心层用 L1 / L2 测，不经过 TUI。
- TUI 用 `@opentui/core` + `@opentui/react`（React 19），代码在 `src/tui/`（*.tsx）。渲染测试放在 `tests/tui/`，断言帧文本，用 `bun test` 跑，不走 vitest。
- 交互行为再用 `mcp__terminalcp__terminalcp`（start / stdin / stdout / stop）做少量端到端冒烟；汇报里写输入和观察到的输出片段。
