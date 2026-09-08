# 0064. 阶段 2 effort 熔断默认阈值 = 每 id 每次 run_graph 进入 8 次；本图不进 settings

Date: 2026-09-08
Status: accepted

计数仍按 ADR-0057：一次 `run_graph` 内每个节点 id 被进入的次数（含首次）。默认阈值 **8**，第 9 次进入该 id 熔断。正常失败绕回不应碰到；空转应碰到。本图不把该数字做成 settings；要改再另开决策。阶段 1 仍不触发。
