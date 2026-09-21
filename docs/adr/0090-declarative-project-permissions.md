# 0090. Project permission rules become declarative string lists

Date: 2026-09-13
Status: accepted

Project `settings.permissions` no longer uses the `schema_version` + `rule[]` predicate DSL. The operator writes `allow` / `ask` / `deny` strings (`Tool` / `Tool(specifier)`), plus an optional `defaultMode` (only `default` | `plan`). Loading compiles them into the existing `NormalRuleSpec`; within the same layer the order is **deny → ask → allow**. The old form and `full_auto` in a project file both fail-loud. The user layer still does not accept `permissions`; the toml dual-source case stays fail-loud per ADR-0084.

**Why not keep the predicate DSL:** after being stored, every rule would need id/tool/decision/reason fields, the nine fixed predicates can add no glob, and the form would diverge from the hooks section's shape.

**Why not read both forms side by side:** the same discipline as the toml→json move — two SSOTs make "which rule actually wins" unauditable.

**Why not allow `full_auto` in project files:** a shared repository must not turn automatic mode into a team contract; automatic mode stays an operator's session choice (ADR-0032).

Related: ADR-0084 (the allowlist and the permissions' home remain in project settings; this ADR only swaps the rule form).
