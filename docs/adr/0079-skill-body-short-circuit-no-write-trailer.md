# 0079. skill() second-call short circuit; write locus stays out of the skill body

Date: 2026-09-10
Status: accepted

`skill()` installs the skill program, not where to write. On a same-name re-invocation, if a visible message still carries that name's full-text successful `tool_result`, only a short receipt returns and the body is not reinstalled; only after compaction drops that entry does the body get installed again. The gate covers only the ACI `skill()`; no monotonic session Set is used (it would fight the truncation window and would write the loaded set into mutable session state). Slash / Web `getSkillBody` are not gated. A on-disk SKILL.md that changed within the session is not auto-reinstalled. A change in the write locus is not grounds for reinstall.

The composition of the write-locus notification surface narrows here: the skill-body trailer is dropped. Remaining notification surface = subagent worker prior + once in the main session after rebind (the user-message seam). The receipt remains the gate and the typed error. No write-locus segment is appended on the write tool's success path. On an unbound tree the model may reach for a skill and try one write before seeing the receipt — one self-consistent failure buys the two axes no longer binding each other.

**Why not session Set / annotate-at-write / keep the three-surface trailer:** a Set wrongly bans reinstallation after compaction; annotating at write time is a third copy of the same information beyond the gate receipt; hanging it on the skill invites misreading "I still need this skill" as "reload the skill".
