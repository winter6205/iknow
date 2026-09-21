# 0025. The user profile and first-run bootstrap always live in the global home only

Date: 2026-08-21
Status: accepted

ADR-0019 D1.4 bound `user.md` / `BOOTSTRAP.md` to `workspaceRoot`, seeding an empty profile at every launch root. The operator contract is that the profile is forever a single global copy: the physical root of the identity files (`user.md`, `BOOTSTRAP.md`, and the `state.json` recording `bootstrap_seeded`) = `userHome/.iknow` (default `homedir()`). `--workspace-root` isolates only the settings write-back fallback; it does **not** isolate session records, tasks, or project memory (ADR-0087 / ADR-0088 / ADR-0099), and does not move the profile. Test isolation goes through the injected `userHome`. Files mistakenly seeded into a project's `.iknow/` are not auto-deleted. ADR-0019 D1.1–D1.3 and D1.5 are unchanged.
