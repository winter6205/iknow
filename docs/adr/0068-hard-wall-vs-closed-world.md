# 0068. Layer responsibilities: hard-wall vs the closed world

Date: 2026-09-08

Status: accepted

> **Amendment 2026-09-09** (ADR-0074): `/tmp` is still not a delivery landing spot; the writable set is still `taskRoot` + `/tmp`. The lifetime changes to a per-identity host-backed dir following the session folder, instead of a fresh empty tmpfs per bash call. `write_file` / `edit_file` may write the current identity's `/tmp`.

> **Amendment 2026-09-13** (ADR-0092): the closed-world fence is no longer the **default** posture. The default becomes the global tier (real host paths readable and writable, home not hidden); the fence still runs (network / env / rlimit / FS sandbox), the hard-wall is unchanged, and the closed world retreats to an optional posture of the workspace tier (to come later).

The closed-world fence (ADR-0037 §9) is bash's only physical sandbox. (Default FS posture amended by ADR-0092: default global tier; the fence still runs, hard-wall unchanged.) The hard-wall does only pre-spawn intent filtering: intents the fence cannot see or cannot stop (destructive argv against the writable root, command substitution, sensitive paths, fork bombs). A newline is not a danger pattern (it is only a segment separator); `"format"` must not be substring-matched. This replaces the patches that simulated a sandbox with a syntax blacklist (including "newline equals danger").

Durable deliverables land only in the live `taskRoot`. The bash `/tmp` is the fence's transient surface, not a product delivery landing spot. (Default FS posture amended by ADR-0092: default global tier, the writable set is no longer `taskRoot` + `/tmp`; the session tmp uses a host path and is no longer bound as `/tmp`.) Subagents share the parent session's write root (ADR-0040); no separate artifact directory. For `spawn_subagent`'s `sandboxRoot`: lexical containment under the parent root and boundary crossing are separate checks; "does not exist yet" must not be reported as outside.

**Why not only loosen the newline rule:** the writable-set split and the misclassification would remain, and the next shot would still mis-kill.

**Why not a semantic shell AST:** the closed world already covers what the host cannot punch through; an AST is a different door, out of scope for this ADR.
