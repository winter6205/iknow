# G3 write_file 是否共用新鲜度闸

- Map: [ACI 文件/搜索工具面（整体升级决策）](../aci-file-tool-surface-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-12 改口：仅 size>0 未读硬拒)
- Blocked by: [G0 整面决策顺序与同票边界](g0-upgrade-decision-order.md), [G1 写前新鲜度闸放哪](g1-edit-freshness-gate.md)

## Question

G1 的闸要不要罩 `write_file`？

- A：只罩 `edit_file`。`write_file` 保持「创建或整文件覆写」，0 字节与新建在 stat 上不好分，不套新鲜度。
- B：已存在文件的覆写与 `edit_file` 共用同一套闸；创建新文件不闸。
- C：一律不闸（G1 若选 C，本票随它关）。

不在本票改代码。G1 未结前不领取。

## Resolution

已存在文件的 `write_file` 与 `edit_file` 共用 last-read 硬拒；路径不存在才直接新建。空文件算已存在（stat），须先读。不扫对话。只闸 `edit_file`、整份写一律不查 — 否决。不改代码。

## Reopen 2026-09-12

操作员改口：仅已存在且 `size>0`、本会话未 `read_file` → 硬拒。新建与空文件免检。`edit_file` 不再共用「必须先读」。

## Resolution（2026-09-12 改口，取代「空文件也要读 / edit 同闸」）

`write_file`：已存在且 size>0、本会话账上无读 → 硬拒不写盘。不按模型放宽。入账：成功 `read_file`，或成功白名单单文件 `bash`（`cat` / `nl` / `bat` / `batcat` / `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`；无管道无重定向）。新建与空文件免检。`edit_file` 不查 last-read。契约已回写；产品代码未实施。
