# 0032. In product wording "auto mode" refers only to the permission full_auto; `/goal` continuation is the goal feature

Date: 2026-08-27
Status: accepted

CONTEXT once described "auto mode" as the unattended `/goal` loop, clashing with the permission axis's Shift+Tab Auto (`full_auto`). Product ruling: "auto mode" denotes only that one permission mode; the continuation after pinning `/goal` is kept but is called the **goal feature**, not a mode. On/off is recognized only via slash (`/goal <text>` / `/goal clear`); `## GOAL:` is not a product entry point. ADR-0024's two judge modules remain valid, and its older use of "auto mode" = this document's goal feature.

## Why not

- **Also calling goal continuation "auto mode" / "fully automatic mode"**: same word as the permission Auto, and operators would assume Shift+Tab enables goal.
- **Dual entry via `## GOAL:` and slash**: the product wants slash only; pinning goal from message body would leave the "vanishing command" unexplainable.
