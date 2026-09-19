# G1 写前新鲜度闸放哪

- Map: [ACI 文件/搜索工具面（整体升级决策）](../aci-file-tool-surface-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-12 改口：取消 edit 硬前置)
- Blocked by: [G0 整面决策顺序与同票边界](g0-upgrade-decision-order.md)（已结）

## Question

过程中的一问（G0 先定顺序）：`edit_file` 凭记忆改文件的闸放哪？本票不预选。

- A：只改两条已有失败文案（`old_str not found` / `matched N times`）各附一句指向 `read_file`。不动成功路径，不扫历史。
- B：harness 会话级 last-read 登记（`read_file` 成功写入 path，`edit_file` 检查）。同回合可见。未读则硬拒或软提示（B 内再拆）。
- C：本切片不动新鲜度；靠现有「必须精确匹配一次」当闸。
- D：`edit_file` 未读则 handler 内自动再读再比（token 换确定性）。

不在本票改代码。description 常驻句不是单独一档——若选它当唯一修复，先对照 `prompt-development`（说明书不是闸）。

## Progress

操作员选 3：会话级 last-read 登记，不扫对话。硬拒 vs 先警告未裁。

## Resolution

没读过就硬拒。`read_file` 成功按规范 path 入会话表；`edit_file` 查表，账上没有则失败、不写盘，回执点名先 `read_file`。不扫 `ctx.messages`。猜对 `old_str` 也不能绕过。3b（警告仍写入）否决。`write_file` 是否同闸见 [G3 write_file 是否共用新鲜度闸](g3-write-file-freshness.md)。不改代码。

## Reopen 2026-09-12

1. `edit_file` 硬前置：操作员裁 **取消**。闸回自证：非空、精确、命中恰好 1；0 或 >1 拒绝，不模糊。
2. 过短锚点：同意 **禁止 `replace_all`**（默认阈值：不足 2 行或不足 25 字符）。
3. `write_file`：同意已存在且 `size>0`、本会话未读 → 硬拒；新建与空文件免检。
4. `read_file`：默认 **2000**、硬顶 **2000**；不写 `limit` 走默认，翻页用 `offset`。
5. 覆盖磁盘备份：同意 **不要**。

## Resolution（2026-09-12 改口，取代 3+3a）

`edit_file` 不硬前置 last-read。自证：非空、精确、默认命中恰好 1；0 或 >1 拒绝、不模糊。显式 `replace_all` 换每一处，**不**按行数/字符数禁止（2026-09-12 再裁：否决短锚硬闸）。`write_file`：已存在且 size>0、本会话未读 → 硬拒；新建与空文件免检。入账含成功 `read_file` 与白名单单文件 `bash`（2026-09-12 再裁：照抄该白名单，不复用只读校验函数）。`read_file` **不写 `limit` 读到 EOF**（否决默认/顶皆 2000）。不另做覆盖备份。契约已回写；产品代码未实施。`edit_file` handler 相对 ADR-0004 无新行为。
