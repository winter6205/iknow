# 0089. grep Node 降级不是第二台 ripgrep

Date: 2026-09-13
Status: accepted

## Context

ADR-0004 规定 grep：ripgrep 子进程优先，ENOENT 则 Node fallback。`feat/aci-grep-surface` 把「自带 rg 起不来仍要能搜」读成「JS `RegExp` 必须实现与 rg 相同的命中集」（D6/SC9「Node 全语义」），并用门禁 fuzz `DIVERGE=0`（甚至 `--engine=auto`）当验收。两套形式语言没有同一判据；测错函数不能证明生产 handler。#1003。

## Decision

**有可用 rg 时，匹配只出 rg，不经 JS 再滤。** 无 rg（对该二进制 ENOENT / 无法执行）时，Node 只做遍历 + 当前 `RegExp` 编得过的 pattern，调用仍成功。允许两条路命中集不同。Node **不**模仿 rg 默认引擎拒绝集。发布门是 `createGrepTool` handler，不是方言对齐 fuzz。禁止为凑同判去改 rg 引擎开关。#1000 落点不在本 ADR（ADR-0088）。

## Why not

**Why not Node 全语义对齐 rg：** 没有可维护的同构；fuzz 绿在门禁上会假过。

**Why not 无 rg 就拒绝调用：** 无自带/无 PATH rg 的机器仍要能搜（操作员已选）。

## Consequences

- (+) #1003 验收对象回到生产 handler。
- (−) 无 rg 档 lookaround 等可能比 rg 更宽；文档与测试必须当特性，不当漏测。
