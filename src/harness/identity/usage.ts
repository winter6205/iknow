/**
 * IKNOW-symbol-primary T1: 使用规则层 (spec `specs/symbol-primary-aci.md` 装配
 * 顺序约束 + 使用规则段内容契约)。
 *
 * 模块责任:回答 "我按什么规矩动手" —— 代码主路径优先级。不放 soul Vibe 的
 * Markdown / 分段排版纪律(那条归 soul.ts),不放 identity 卡的本体事实(归
 * identity.ts),不放人格 core truths / boundaries(归 soul.ts)。本段只讲
 * 工具优先级与三类回退场景,对应 spec Assumptions 2 / 使用规则段 / SC8。
 *
 * 锁定约束:删掉这段 = agent 在代码上仍会用 grep 开场,违反 spec 假设
 * 1 (代码发现默认走符号工具,不是 grep)。判断标准 "删掉后 agent 是不是
 * 还能按符号身份办事":否 → 归 usage。装配层把本段插在 soul 之后、
 * user_profile 之前,chat / tui / serve / ask 全部注入(SC1 + spec 假设 5)。
 *
 * 后续调整使用规则,改本文件(代码),不进用户工作区。本 const 是 SSOT,
 * 装配时只引用,绝不复制 / 切片(防 drift)。
 */

/** IKNOW-symbol-primary T1 使用规则:代码主路径优先级 (回答 "我按什么规矩动手")。
 *  删掉这段 = agent 在代码上仍会用 grep 开场。 */
export const IKNOW_USAGE_DEFAULT = `
# Usage rules

## Code structure and symbol-level changes
Use the symbol tools — do not start with grep.

- \`find_symbol\` — locate a symbol by name (substring / pattern match when the exact name is unknown).
- \`find_declaration\` — jump to the symbol's declaration or definition.
- \`find_referencing_symbols\` — list every reference to the symbol across the project.
- \`find_implementations\` — find the concrete implementations of an interface or method.
- \`get_symbols_overview\` — read the symbol tree of a single file.
- \`get_hover\` — read the type, declaration shape, or doc attached to a symbol.
- \`get_diagnostics_for_file\` — surface diagnostics for a file.
- \`prepare_call_hierarchy\` / \`list_incoming_calls\` / \`list_outgoing_calls\` — walk the call graph.
- \`rename_symbol\` — rename a symbol project-wide.
- \`replace_symbol_body\` — replace the body of a symbol (range defined by the language server).
- \`insert_before_symbol\` / \`insert_after_symbol\` — insert code around a symbol definition.
- \`safe_delete_symbol\` — delete only when no references remain; otherwise return the reference list and refuse.

When you do not yet know the exact symbol name, use \`get_symbols_overview\` or a \`find_symbol\` substring / pattern first. The tools take a symbol identity (file-internal symbol path + relative file path); do not pass line/character coordinates as the primary input.

## Fallbacks: grep and read_file
\`grep\` and \`read_file\` are restricted to three fallback situations:

- Non-code content — comments, string literals, configuration files, documentation.
- Unknown symbol — still prefer \`find_symbol\` substring / pattern before falling back to grepping source.
- Language server unavailable — retry once; if it still fails, fall back to grep with the readable failure string from the tool.

Do not use grep as the first move for code structure or symbol-level changes.

## edit_file
Use \`edit_file\` only for text patches that are not a single symbol, or when the symbol tools cannot apply the change. Prefer the symbol tools first.

## Coordinates are not the primary input
Do not pass "line N, character M" as the main argument to the symbol tools. The tools accept symbol identity; internal translation to LSP positions is implementation detail.

## Formatting note
Markdown structure and paragraph separation for messages to the user are owned by soul's formatting discipline. This segment does not repeat that guidance.
`.trim();
