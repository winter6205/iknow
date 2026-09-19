# 0106. 围栏宿主网：bash 出网直连宿主栈，废除 socat / 代理缝 / 域名闸

Date: 2026-09-19
Status: superseded by 0107

> **Superseded（2026-09-19，ADR-0107）**：要默认拒绝 + 出厂 defaults ∪ 用户名单的域名闸，不要开网无闸。本文件的围栏宿主网直连作废。

## Context

ADR-0097 把 bash 出口做成「`--unshare-net` 恒在 + unix socket + socat + HTTP/SOCKS 代理 + 域名允许集」。ADR-0104 用预放行档（GitHub / npm / Playwright）避免默认不可达；ADR-0105 把 HTTP 凭据 sentinel 挂在同一代理上。未落地的 ssh-bridge 还要把 SSH 再塞进 CONNECT。

当时的判断：Linux 上 socat 是宿主前置、本仓不发；直连 SSH 与 HTTP CONNECT 互斥；一旦预放行档非空再「允许域直连」，内核也无法只放行那些域——有网卡就是整次调用宿主网。本决策曾锁成「有围栏即直连、无域名闸」，避免在 socat / 半桥 / 允许集 / 关沙箱之间翻案。**已被 0107 推翻。**

## Decision

（历史正文保留。终态以 ADR-0107 为准，勿按下列条款实现。）

**曾锁终态：** 有 fence 的 bash 使用宿主网络栈直连；无 `--unshare-net`；无代理缝；无 bash 域名闸。

## Why not（当时）

- 保持 0097 缝 + 补 socat/ssh-bridge：操作员不要宿主 socat。
- 允许集直连但仍按域过滤：无拦截点做不到。
- 默认断网、配置才开网：与 0104「默认不可达」事故同构。
- 关沙箱当默认：丢掉 FS 硬边界。
- 混合 HTTP 代理 + SSH 直连：两套出口语言。

## Consequences

以 ADR-0107 为准。本文件不指导落地。

## Evidence pointers

- 操作员 2026-09-19 先锁直连、后改口要域名闸 → 0107。
- ADR-0097 / 0104 / 0105 / 0107。
