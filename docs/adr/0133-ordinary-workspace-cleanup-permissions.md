# 0133. Route ordinary workspace file cleanup through normal permissions

Date: 2026-09-30
Status: accepted

Issue #1170 exposed a blanket `rm -f` denial for an ordinary workspace intermediate file. A finite, explicit, non-recursive file deletion whose operands are established inside the live `taskRoot` must leave that blanket destructive-command wall and enter ordinary permission handling: the existing default mode asks, while automatic mode may admit the operation. Existing user files are governed by that same permission policy; creating a global file-creator ledger is not a prerequisite for this repair. Preserve protected-target enforcement, other dangerous-operation rules, the separate current-identity scratch boundary in ADR-0132, and review/deny routes for unresolved or out-of-scope targets.

This refines ADR-0068's command-intent filtering for ordinary bounded cleanup; it does not remove the interpreter-independent effect boundary in ADR-0129 or imply that workspace location alone grants deletion authority. Admission and the Bash handler must consume the same host-owned root context and classification. The trade-off is to rely on the existing permission modes for ordinary mutation rather than ban all forced file deletion or build a new provenance-based authorization system. The executable acceptance contract is [Hard-wall denial alignment](../../specs/hard-wall-denial-alignment.md).
