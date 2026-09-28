# 0129. Protect effects beyond shell intent filtering

Date: 2026-09-28
Status: accepted

The shell parser and hard-wall can reject enumerated command intents, but they cannot establish the runtime effects of arbitrary interpreters: the observed `rm -f` command was denied while an equivalent Python `os.remove` call succeeded. Keep the hard-wall as a pre-execution guardrail whose matched denies remain non-overridable, without treating a clean scan as proof that an action is safe. Paths and credential sources that must remain protected across languages require enforcement at the filesystem, process, or controlled-capability boundary; legitimate cleanup of an agent-created backup should be allowed when its target is authorized, regardless of the command spelling. This clarifies ADR-0068 and does not change ADR-0092's broad-write global mode.

## Consequences

- The downstream specification must identify protected targets and allowed write roots, then test equivalent shell, Python, and other interpreter operations against the same target. Shell parsing tests alone cannot satisfy this acceptance point.
- A global-mode operator grants broad host-write capability subject to the physical protected-path boundary and the existing permission flow. Preventing every possible deletion in global mode would require a separate mode-level decision.
