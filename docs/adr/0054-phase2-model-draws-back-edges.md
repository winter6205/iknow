# 0054. 阶段 2 回边由模型画在图上；host 只执行、计数、挡 done、挡转死

Date: 2026-09-08
Status: accepted

图内绕回的边是分解的一部分，由模型写进该次提交的图，不由 host 在失败时自动接回上游。Host 按边走、每次进入节点计 effort、拒绝再跑已 done 的 id、用 effort 缝防止转死。阶段 1 无回边、`validateGraph` 仍拒环。不开子票；进阶段 2 spec。
