# 027 — 已落地 wayfinder 图（只读归档）

> **ARCHIVED 2026-09-19**。本目录是决策过程留档，**不是 SSOT**。
> 产品行为以 `specs/`、`docs/adr/`、`docs/CONTEXT.md` 为准；已落地 plan 在 `docs/archive/025-retire-completed-specs-and-plans/plans/`。**不要**在活文档、spec Basis、STATUS、**产品代码**里再链到这些地图或对应 plan 路径。

## 为何归档

wayfinder 图在「地图到达 → spec/plan 落地」后只保留审计价值；继续放在 `docs/wayfinder/` 会被误当成可引用依据。

## 本包内容

| 图                                      | 活契约 / 记录                                                 |
| --------------------------------------- | ------------------------------------------------------------- |
| `path-image-vision-map.md`              | `specs/read-image-vision.md`（#1067）                         |
| `interrupt-round-visibility-map.md`     | `specs/interrupt-frozen-prefix-keep.md`、ADR-0108（#1064）    |
| `aci-file-tool-surface-map.md`          | `specs/aci-file-search-surface.md`、ADR-0084                  |
| `model-prefix-layering-map.md`          | `specs/model-prefix-layering.md`（归档于 025）、ADR-0041–0043 |
| `tui-tool-settled-appearance-map.md`    | `specs/tui-tool-settled-appearance.md`                        |
| `casual-ask-context-hygiene-map.md`     | `specs/casual-ask-context-hygiene.md`（归档于 025）           |
| `parent-visible-scratch-salvage-map.md` | ADR-0074 等子代理 `/tmp` 决策                                 |
| `session-list-label-map.md`             | `specs/session-list-title.md`、ADR-0113（#1072）              |

票体在 `tickets/`（与图同批归档）。

## 仍活跃的 wayfinder

见 `docs/wayfinder/README.md`（未落地或仍在 worktree 的图）。
