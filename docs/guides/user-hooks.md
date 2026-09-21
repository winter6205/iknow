# User hooks — command hooks in `settings.json`

> Operator guide. Schema = `IknowSettingsHooks` in `src/config/settings.ts`.
> Runtime compilation shares one mechanism with plugin `hooks/hooks.json` (`createSettingsHookContribution`).

---

## Summary

Write `hooks.PreToolUse` / `hooks.PostToolUse` in command form into the user-level `~/.iknow/settings.json`: `matcher` + `{ type: "command", command, timeout? }`. The engine spawns that command before/after each tool execution. In a Pre hook, **exit 2** blocks the call; all other exit codes fail open. `hooks` in a project `.iknow/settings.json` are **not adopted** (arbitrary shell = clone-and-execute risk).

---

## Template

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node --experimental-strip-types /home/you/.iknow/hooks/pre-tool-guard.ts",
            "timeout": 5,
          },
        ],
      },
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "npx prettier --write \"$f\"" },
        ],
      },
    ],
  },
}
```

stdin receives a JSON envelope (`hook_event_name`, `tool_name`, `tool_input` — including `file_path` and its aliases —, `cwd`). When a Pre hook blocks, the reason is taken from `systemMessage` / `permissionDecisionReason` in a JSON payload on stderr if present, otherwise from raw stderr; the model sees `[hook_blocked] …`.

`timeout` is in seconds, default 30, max 600.

Unknown event names (e.g. `SessionStart`) are ignored. Non-`command` types are ignored.

---

## matcher

Same rules as plugin hooks: a matcher containing only `[A-Za-z0-9_ ,|-]` is an exact alternation (`Write|Edit`); anything else is treated as a regex. Missing or `*` = match all tools. Tool-name mappings: `bash`↔`Bash`, `write_file`↔`Write`, `edit_file`↔`Edit|MultiEdit`, `read_file`↔`Read`, and so on.

---

## Rules

- User layer only. `hooks` in a project file → dropped with a warning.
- Missing section = no user command hooks. There is no global `enabled` switch.
- Execution order — Pre: builtin (secrets) → settings command → plugin command; Post: TUI observation → settings Post → plugin Post.
- Restart the process after editing.
- The `~/.iknow/hooks/` directory is not scanned; put script paths directly in `command`.
- The legacy `{ enabled, rules }` deny-only form no longer takes effect.
