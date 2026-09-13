# Subagent prompt template

```
ROLE: <senior X> with <Y perspective>
SCOPE: <1 file path or 1 logical task>
PERMISSION: <read-only | write 1 file | write N files in <scope dir>>
REFERENCE: <paths to read first>
CONSTRAINTS:
  - Surgical change (only the tasked code)
  - No drive-by refactors
  - Do not write plaintext API keys / tokens / passwords
DELIVERABLE:
  - What changed or was found (file:line)
  - Commands run (command + exit code + short output)
  - Any deviation from scope (name it)
OUTPUT RULES:
  - No thinking-aloud preamble
  - The deliverable is the output
```

Missing ROLE, SCOPE, or PERMISSION → drift. Missing CONSTRAINTS → drive-by work.

SCOPE is one logical task with write paths that do not overlap other workers. File-size review (complexity-anti-drift) is a different skill, not a dispatch quota.
