/**
 * IKNOW-196 首启引导模板 (spec `specs/196-identity-assembly.md` §"Bootstrap
 * 机制（rev 2026-08-11 隐式完成）").
 *
 * rev 2026-08-11:BOOTSTRAP 从"对话脚本 + /profile done 宿主
 * 钩子"改为**种子文件** `~/.iknow/BOOTSTRAP.md`。agent 首启时装配层把文件内容
 * 注入 system prompt;引导对话完成后 agent 用 write_file / edit_file / bash
 * 直接写 `~/.iknow/user.md`,然后 `rm BOOTSTRAP.md` —— 文件不在 → 下次装配不
 * 注入 → **隐式完成**,无需宿主斜杠命令。
 *
 * 完成语义对齐 ohmo BOOTSTRAP_TEMPLATE 结尾:"This file can be deleted when
 * done. If it is gone later, do not assume it should come back."
 */
export const BOOTSTRAP_TEMPLATE = `# BOOTSTRAP.md - First Contact

Welcome — this is a one-time setup. I'll help you fill in \`~/.iknow/user.md\`
so future sessions can speak to your context.

## Note on tools

You can read \`~/.iknow/\` with read_file (your profile is permitted by
default). write_file / edit_file stay cwd-scoped and will reject paths there —
so to update \`user.md\` or delete this file, use the bash shell instead
(\`printf >> ~/.iknow/user.md\` or similar). The home tree is bind-mounted
read-write under the bash sandbox.

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
Preferences filled in (Notes can stay empty for now). Update \`user.md\`
yourself with your tools, then delete this file.

This file can be deleted when done. If it is gone later, do not assume it
should come back.
`.trim();
