# 026 — Archive: historical research (not product SSOT)

> **Status: ARCHIVED** (2026-08-25). Kept for git history. Runtime and
> current docs (`README.md`, `docs/STATUS.md`, `docs/architecture.md`,
> `docs/coding-agent-capability-gap.md`) do not depend on these files.

## Why

These notes belong to an earlier rewrite / prototype era (upstream Company
Brain mapping, vector retrieval, ACI throwaway contract, verify-loop v2
prototype that never merged to `master`). Leaving them at `docs/` root made
the live documentation look like a second product.

## Contents

| File                                            | Origin                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `UPSTREAM_BASELINE.md`                          | Pin of a gitignored upstream snapshot; runtime has never imported it            |
| `upstream-gbrain-vector-retrieval.*`            | Retrieval-subsystem study; iknow has no vector KB path                          |
| `aci-prototype-contract.md`                     | Throwaway ACI prototype contract; production ACI lives under `src/harness/aci/` |
| `verify-v2-prototype-reports.md` + HTML reports | Research prototype (PR #465, not merged)                                        |
| `verify-pr425-vs-433.html`                      | One-off PR comparison                                                           |

Architecture decisions that still bind the product stay in `docs/adr/`.
