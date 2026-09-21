# 0085. todo 账本：id + 三件事；worker 共用同一主会话

Date: 2026-09-11
Status: accepted

修正 `docs/adr/0046-todo-ledger-replace-and-snapshots.md` 的主路径（该文件编号曾与另一 0046 撞号——即现 `0114-exact-name-load-and-index-demotion.md`，撞号已由重编号解决——amendment 无法写回原文件）。快照纪律与「换表不灌 messages」仍有效。

现行账本每条有稳定 **id**，状态 `pending` | `in_progress` | `completed`。主路径是三件事：一次可多条的**添加**（追加不覆盖）、按 id **更新**（subject / status / 删除；`check` 并入）、**读取**现行。`replace` 降为整表逃生口，不是换计划主路径。

id 的稳定域是**表内**：`add` 取现有最大编号 +1（删中间项不释放号，旧 id 不被后来者复用），`replace` 换整表后**从 `t1` 重新编号**——旧 id 随旧表作废，不跨 replace 继承，模型需重新 `read` 取新 id。回执仍是短串 `Updated todos.md`，不逐条列 id（整表作废不是「新增 N 条」）。

同一**主会话**内子代理与父共用账本：worker 可读取与更新；**添加仅父会话**，worker `add` typed 拒绝。跨主会话共用不做。

状态栏仍只投影未完成项（ADR-0028），不把整表灌进 messages。限额与原子写沿用既有 64KB / 500 与不半写。

**Why not 只放宽 add 收数组：** 模型还要按条改状态；没有 id 就只能整表重写。**Why not 跨主会话任务池：** 本切片到达标志是「一次会话能写下多步并让 worker 看见」，不引入列表身份与 opt-in。

