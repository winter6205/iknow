# G0 整面决策顺序与同票边界

- Map: [ACI 文件/搜索工具面（整体升级决策）](../aci-file-tool-surface-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-11，操作员要求从具体第一问重来)
- Blocked by: [R1 同波消息快照能否看见刚读的文件](r1-edit-freshness-message-scan.md), [R2 grep 现行 parser / 排序 / CI 盲区](r2-grep-parser-sort-ci.md), [R3 写前新鲜度与搜索面的机制选项](r3-freshness-and-search-mechanisms.md)

## Question

这张面按什么顺序做取舍，哪些问题必须同一轮看完（同票边界），哪些可以后切？开图时不预选「先钉新鲜度」或「先扩 grep」。

- A：先定新鲜度（G1→G3），再定搜索（G2），最后打包落地顺序。写与搜分开收口。
- B：先定搜索（G2），再定写路径（G1→G3）。发现面稳定了再谈改文件。
- C：**同一轮看整面**（新鲜度 × 搜索默认形态 × write 是否同闸），只把「必须与 parser 同票的执行细节」和「multiline/type」后切。过程优先于单点方向。
- D：先定「本轮升级的打包原则」（哪些改动必须一起上船、哪些允许只做失败文案），再回头填 G1–G3。

本票不选机制档，只选过程。不改代码。

## Resolution

操作员否决 A/B/C/D 投票：过程票听不懂，要求从第一个具体问题重新问。过程定为：整面仍都要过，一次只问一件能听懂的事；「必须同票」的边界碰到再标，不预先投打包原则。不预选机制档。
