# 0084. 非空 write 才查 last-read；edit 靠自证；grep 默认只给路径

Date: 2026-09-12
Status: accepted

成功 `read_file`，或成功且可抽单一 path 的白名单 `bash`，把规范 path 记入本 conversation 的 **last-read ledger**。表在**进程内存**（`conversationId → path`），不落盘；resume 空表。白名单：`cat` / `nl` / `bat` / `batcat` / `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`；必须单文件、无管道、无重定向。`write_file` 仅在目标已存在且 **size>0**、账上没有时 typed 失败、不写盘。不按模型放宽未入账覆写。新建与空文件免检。`edit_file` **不查表**：闸是非空 `old_str`、与磁盘连续原文精确匹配、默认命中恰好 1；显式 `replace_all` 换每一处，不按行数/字符数禁止。不扫对话历史。无 `conversationId` 则非空 `write_file` fail-closed；`edit_file` 不因缺 id 拒绝。禁止进程级全局表。不另做覆盖磁盘备份。不把 `validateReadonlyCommand` 的通过当作入账。

`read_file` 不写 `limit` 则从 `offset` 尽量读到 EOF；工具整读页 **16000** code point，正文提示续读。`>1MB` 仍拒。显式 `limit` 硬顶 2000 行。executor **20000** 字符总闸不改。

`grep` 默认只回路径；匹配行 / 计数为显式出法。结果名单条数参数为 **`head_limit`**（默认 50、硬顶 2000），不与 `read_file` 的行 `limit` 同名。附近几行、结果名单分页、文件名 `glob`、语言 `type`、行窗与 parser/排序/自带安装根搜引擎同属搜面契约（`specs/aci-file-search-surface.md`）。

**Amends** ADR-0004：`grep` 不再默认 `路径:行号:行内容`；`read_file` 不写 `limit` 则读到 EOF（废默认 200 行）。`edit_file` 唯一匹配 / `replace_all` 不改 ADR-0004。**Amends** ADR-0006：`grep` 默认条数 200→50；`read_file` 整读不再用 200/2000 行当默认窗（1MB 与 executor 20000 仍在）。PATH `rg` 不再是生产主路径。

**Why not 扫 messages：** 同回合 tool_result 尚未进 handler 快照，最高频「刚读就改」永远看不见。

**Why not edit 硬前置：** 精确唯一 `old_str` 已自证磁盘现态；硬前置挡不住同回合消息不可见，还会误伤「锚点已对、尚未登记」。

**Why not 未入账也可整文件盖：** 整份 `content` 不自证旧文；白名单 bash 已减假拦截。按模型放行会让账本按会话失效。

**Why not 默认仍吐匹配行：** 第一下搜是发现文件；行是显式出法。有分页后默认 50 够一页。
