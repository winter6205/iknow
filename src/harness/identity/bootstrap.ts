/**
 * IKNOW-196 首启对话脚本 (spec `specs/196-identity-assembly.md` Project
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
 *
 * 设计要点(rev 2026-08-06):`~/.iknow/` 在 ACI 工具 workspace 沙箱根
 * (`process.cwd()`)之外 — read_file / glob / write_file / edit_file 一律
 * "path outside workspace" 拒绝;bash 单命令可读但复合命令(`&&` `||` `>` `;`)
 * 被 hard-wall 拦截。所以引导不能诱导 agent 用工具访问该目录,只能做
 * 纯对话收集。完成路径改为用户**在宿主外**(文本编辑器)直接填
 * `~/.iknow/user.md`,然后回到对话输入 `/profile done` 翻 bootstrap 旗。
 * 这条路径必须经宿主斜杠命令才能走通(`writeIknowState` 没有其它 caller)。
 */

/** IKNOW-196 首启对话脚本。引导用户填 user.md(Goals / Style / When done)。
 *  修 2026-08-06:不去诱导 agent 用工具读 ~/.iknow/;改宿主斜杠完成钩子
 *  /profile done 翻 bootstrap_seeded。 */
export const IKNOW_BOOTSTRAP_PROMPT = `
# First-run bootstrap

Welcome — this is a one-time setup. I'll help you fill in \`~/.iknow/user.md\`
so future sessions can speak to your context. Three short rounds.

## Note on tools
\`~/.iknow/\` is outside the file-tools' workspace sandbox, so read_file /
write_file / edit_file / glob will reject paths there with "path outside
workspace". Compound shell commands can reach the directory directly
(the home tree is bind-mounted read-write under the bash sandbox), but
only after the host has initialized it. The host owns this directory —
you write \`user.md\` in your own editor and tell me when you're done.

## Goals
What do you want me to help you with? Name 1-3 recurring workflows
(e.g. "edit TypeScript projects", "summarize meeting notes"). Be concrete;
vague goals lead to vague help.

## Style
How should I sound? Pick a register: terse / standard / thorough.
Any words or phrases to avoid? Any I should prefer? Tone preferences
live here, not in soul — soul is mine, style is yours.

## When done
We're done when \`~/.iknow/user.md\` has at least Profile, Defaults, and
Preferences filled in (Notes can stay empty for now). Edit the file in
your own editor, then type \`/profile done\` in this session — I'll flip
the bootstrap flag, and next session starts straight into work.
`.trim();
