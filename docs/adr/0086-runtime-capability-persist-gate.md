# 0086. 运行时能力观测不得成为耐久记忆

Date: 2026-09-11
Status: accepted

一次环境快照（出网、DNS、某工具此刻能不能用）若写成 `constraint` 并被召回，模型会跳过当次工具试探。能力事实的权威是当次工具结果，不是记忆库。

因此：`memory_save` 与抽取 persist 共用 **runtime capability persist gate**——判定为能力/环境可用性观测则 typed 拒写，不是静默 NOOP，也不是改 `note` 先入库。已有条走读侧过滤 + **capability memory sweep**（与抽取默认 3 个 `completed` 同闸，退出再尽力）。不把 `SUPERSEDE` 还给会话内 save，不恢复抽取 CONTRADICTION_FLOOR，不加「有用才存」总滤。产品/政策类 `constraint` 仍可写。

**Why not 只加 TTL / 只改 prompt：** TTL 猜寿命且掏空 `constraint` 词义；包装句挡不住高 importance 假闸。**Why not 开局同步 GC：** 挡首包；本会话看见记忆之前用读滤即可。

ADR-0031 D1/D5 同日 amendment。
