# Project permission rules (`settings.permissions`)

Operator guide. Contract SSOT = ADR-0090. Loading implementation = `src/harness/permission/` (this page is not the schema authority).

---

## Summary

Declare tool policy with `allow` / `ask` / `deny` strings in the shared project file `<repo>/.iknow/settings.json`. This is a project-layer setting only; `permissions` in `~/.iknow/settings.json` is ignored.

---

## Template

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(rg:*)",
      "Bash(npm run test:*)"
    ],
    "ask": ["Bash(pnpm:*)", "Bash(yarn:*)"],
    "deny": [
      "Bash(git push --force:*)",
      "Bash(rm -rf:*)",
      "Read(.env)",
      "Read(.env.*)",
      "Read(**/*.pem)",
      "Read(**/*.key)",
      "Edit(.env)",
      "Edit(**/*.pem)"
    ]
  }
}
```

`defaultMode` is optional; the only valid values are `default` and `plan`. Do not put an auto-approve mode in a repo file.

---

## Syntax

- `Bash` / `Read` / `Edit` are family names mapped to concrete tools (`bash` / the read-file family / the write-file family).
- Literal tool names also work (`web_fetch`, `mcp__…`).
- No parentheses = every call of that tool; `Bash(*)` equals `Bash`.
- Bash: `*` is a wildcard; `:*` is valid only as a **suffix** (`Bash(git status:*)` ≡ `Bash(git status *)`).
- Paths are gitignore-style: `Read(.env)` blocks `.env` at any depth under the work root.
- Within one file, **deny beats ask beats allow**.

Hard walls (e.g. `.ssh`) can never be allowed. An allow for the whole `Bash` tool also overrides the code-level ask on `network:true` — if you want outbound-network prompts to survive, allow command prefixes instead of bare `Bash`.

---

## Relationship to hooks

`permissions` is the team policy that applies by default; `hooks` are extra interceptions (regex / PreWrite / PreCommit) that can be switched off wholesale — see `docs/guides/user-hooks.md`. Don't rely on hook-only path denies as a substitute for this section.
