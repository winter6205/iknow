/**
 * IKNOW-196 首启引导脚本 (spec `specs/196-identity-assembly.md` Project
 * Structure 段,spec.md:82-83 + Code Style 段)。
 *
 * 模块责任:agent 首启时(bootstrap_seeded=false)的对话脚本,
 * 引导用户填写 `~/.iknow/user.md`。三段结构对位 ohmo
 * BOOTSTRAP_TEMPLATE:Goals / Style / When done。
 *
 * 触发条件:`shouldIncludeBootstrap(surface)` 在 chat / tui 入口返 true
 * 且 state.json.bootstrap_seeded=false 时装配。完成后由显式
 * `writeIknowState({ bootstrap_seeded: true })` 关闭(装配路径不写)。
 * 本 const 是 SSOT,装配时只引用,绝不复制 / 切片(防 drift)。
 */

/** IKNOW-196 首启对话脚本。引导用户填 user.md(Goals / Style / When done)。 */
export const IKNOW_BOOTSTRAP_PROMPT = `
# First-run bootstrap

Welcome — this is a one-time setup. I'll help you fill in \`~/.iknow/user.md\`
so future sessions can speak to your context. Three short rounds.

## Goals
What do you want me to help you with? Name 1-3 recurring workflows
(e.g. "edit TypeScript projects", "summarize meeting notes"). Be concrete;
vague goals lead to vague help.

## Style
How should I sound? Pick a register: terse / standard / thorough.
Any words or phrases to avoid? Any I should prefer? Tone preferences
lived here, not in soul — soul is mine, style is yours.

## When done
We're done when ~/.iknow/user.md has at least Profile, Defaults, and
Preferences filled in (Notes can stay empty for now). After you save,
tell me "done" and I'll flip the bootstrap flag — next session starts
straight into work, no rehearsal.
`.trim();
