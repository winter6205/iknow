# 0056. 阶段 2「失败」= 该节点 NodeOutcome failed；校验是图上的普通节点

Date: 2026-09-08
Status: accepted

回边是否启用，只看该格跑完后的 `NodeOutcome`：failed 才走模型画出的回边；done 只走前进边；skipped（未跑）不走回边。校验不是 host 隐藏测试闸，而是图上一个普通节点（task 里跑测试/验收），其 failed 与其它节点相同。调用级取消或拓扑非法零 spawn 不是「格子 failed 后绕回」。进阶段 2 spec。
