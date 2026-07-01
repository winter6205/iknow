# 强制工作流规则

---

## 规则 A: 开始任务前强制进行技能检查

**触发**: 任何非平凡任务开始前 (改代码 / 重构 / 加功能 / 解 bug / 审阅).

**强制动作**: 通过 Skill 工具 invoke 相关技能, 不凭印象直接动手.

**检查清单**:

| 场景 | 必 invoke 的技能 |
|------|------------------|
| 接手新项目 / 理解陌生架构 | `codebase-memory` (get_architecture / search_graph) |
| 改前摸调用链 / 找引用 | `serena` (find_symbol / find_referencing_symbols) |
| 全局检索 / 多跳依赖 / 死代码 | `codebase-memory` (trace_path / query_graph / search_graph max_degree=0) |
| 改代码 / 重构 / LSP 精准编辑 | `serena` (replace_symbol_body / insert_* / rename_symbol) |
| 查库 / 框架 / SDK / API 文档 | `context7` (resolve-library-id + query-docs) |
| 改前先写测试 | `test-driven-development` |
| 新功能 / 创意 / 模糊需求 | `brainstorming` |
| 写 spec / 设计文档 | `spec-driven-development` |
| 解 bug | `debugging-and-error-recovery` |
| 大改动 (>20 files) | `dispatching-parallel-agents` |
| 完成前验收 / 多维 audit | `project-code-quality-audit` |
| 文档 / ADR | `documentation-and-adrs` |

---

## 规则 B: 工具绑定与动态路由 (Tool Binding & Dynamic Routing)

### 1. 任务分级与工具路由 (Tiered Routing)

| 任务级别 | 判据 | 推荐工具 | 禁忌 |
|----------|------|----------|------|
| **L1 局部/简单** | 单文件修改 / 简单 Bug 修复 / UI 微调 / 配置项微调 / 文档修正 | 原生文件系统工具 (`Grep` / `Glob` / `Read` / `Write`) | 不得强制调用 Serena/Codebase |
| **L2 结构/复杂** | 跨模块重构 / 调用链追踪 / 多态/接口实现查找 / 大型遗留系统分析 / 新增核心业务链路 | **Codebase Memory 先** (全局拓扑/多跳调用/死代码) → **Serena 后** (浅跳引用/精准编辑/LSP 诊断) | 不得降级用原生工具盲改; 不得跳过 Codebase 直接用 Serena 盲改 |

### 2. 前置上下文闭环 (Pre-Execution Context Validation)

- 任何代码变更 (增/删/改/移) 执行前, 必须建立完整的上下文依赖链.
- **L2 任务**: 必须先通过 Codebase/Serena 确认全局拓扑、接口契约和副作用边界.
- **L1 任务**: 必须通过原生 `Read/Grep` 确认局部上下文与变量作用域.

### 3. 熔断与安全降级机制 (Fallback & Halt)

| 熔断类型 | 触发条件 | 强制动作 |
|----------|----------|----------|
| **L2 工具熔断** | L2 任务执行时, Serena/Codebase 不可访问 / 超时 / 查询失败 | 暂停并输出 `[NEED_STRUCTURAL_INFO]` |
| **通用上下文缺失** | 任何任务, 目标文件 / 核心逻辑 / 业务意图无法确认 | 暂停并输出 `[NEED_MORE_INFO]` |

### 4. 业务与结构双轨对齐 (Dual-Track Alignment)

- 涉及**核心业务逻辑变更**时, 除代码结构检索外, 必须查询项目级 Memory (`CLAUDE.md` / `rules/`) 或相关背景文档.
- 目标: "代码拓扑结构" 与 "人类业务规范" 严格对齐.

---

## 跨引

- 项目入口: `CLAUDE.md`
- 全局规则: `~/.claude/rules/*.md` (用户级规则, 跨项目生效)
- Serena 工具文档: 触发 Skill `serena`
- Codebase Memory 工具文档: 触发 Skill `codebase-memory`