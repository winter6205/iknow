# 0053. 阶段 2 图内绕回是同一 id 再跑；不是偷换新 id。阶段 1 仍拒环

Date: 2026-09-08
Status: accepted

阶段 2：同一次 `run_graph` 内，沿边回到未冻结的节点时 **复用该 id 再 spawn**，每次进入计 effort。禁止「表面上绕回、实际新 id」（那是阶段 1 加格）。已成功完成的 id 仍冻结、不得再跑（ADR-0050 对 done 的约束阶段 2 仍在）。阶段 1 实施与 spec 继续 `validateGraph` 拒环；本决策进阶段 2 spec，不开 wayfinder 子票。
