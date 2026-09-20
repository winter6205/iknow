/**
 * Usage-rules layer: priority of the primary code path.
 *
 * Responsibility: answer "by what rules do I act". Does not carry soul's
 * Vibe markdown/paragraph formatting discipline (that stays in soul.ts), nor
 * identity's ontological facts (identity.ts), nor core truths / boundaries
 * (soul.ts). This segment covers only tool priority and the three grep/read_file
 * fallback situations.
 *
 * Locked constraint: deleting this segment = the agent still opens with grep
 * on code. Test: "after deleting it, can the agent still act by symbol
 * identity?" no → usage. The assembly layer inserts this segment after soul
 * and before user_profile; it is injected on chat / tui / serve / ask alike.
 *
 * Future usage-rule tweaks go in this file (code), never in the user
 * workspace. This const is the SSOT — referenced at assembly time, never
 * copied or sliced (drift prevention).
 */

/** Usage rules: priority of the primary code path (answers "by what rules do I act").
 *  Deleting this segment = the agent still opens with grep on code. */
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
