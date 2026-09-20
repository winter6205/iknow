/**
 * First-run guidance seed template.
 *
 * BOOTSTRAP is a seed file `~/.iknow/BOOTSTRAP.md`, not a scripted
 * conversation with a host hook: on first run the assembly layer injects the
 * file content into the system prompt; after the guided conversation the
 * agent writes `~/.iknow/user.md` directly (write_file / edit_file / bash)
 * and then `rm BOOTSTRAP.md` — file gone → next assembly skips injection →
 * implicit completion, no host slash command needed.
 *
 * Completion semantics mirror ohmo's BOOTSTRAP_TEMPLATE closing line:
 * "This file can be deleted when done. If it is gone later, do not assume it
 * should come back."
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
