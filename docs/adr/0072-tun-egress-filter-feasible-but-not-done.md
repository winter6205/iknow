# 0072. TUN 出口过滤「可行但不做」

Date: 2026-09-09
Status: accepted

> **Amended（2026-09-16，ADR-0097）**：重开触发条件 3（对外承诺域名级白名单）命中。但实现路线**不是**本文评估的 TUN 形态——域白名单走**代理路线**（netns 全断 + unix-socket 缝 + 宿主代理判 CONNECT host），绕开本文列的 TUN / 用户态 TCP/IP 栈 / TLS 终止 / 自建 CA 四个组件。本文对「内核级出口强制 + 内容检查」的「不做」判断仍成立；代理路线不做内容检查，domain fronting 不可防（见 ADR-0097 Trade-offs）。

## Context

本文修正一条已记录的旧判断：**「非特权环境下做强制出口过滤不可能」对 TUN 不成立**。

之前判「不可能」对 **veth** 成立（非特权 user namespace 建不了 veth pair），对 **TUN** 不成立。实测证据（2026-09-08）：

1. `/dev/net/tun` 存在且权限 `crw-rw-rw-`，可正常打开；
2. `bwrap.ts:137-139` 已 `--dev-bind /dev /dev`，沙箱内可见该设备；
3. `--unshare-net`（`bwrap.ts:114`）新建的 netns 内，bwrap 持 CAP_NET_ADMIN。

所以在沙箱 netns 内建 TUN 设备、由宿主用户态进程转发流量，是**非特权可达的路径**。

## Decision

**不做。** 可能 ≠ 该做：完整形态是一个子系统，不是一个补丁。

需要的东西：

- 用户态 TCP/IP 栈或 TUN 转发器；
- 宿主侧代理进程；
- TLS 终止 + 自建 CA —— 否则域名级过滤只能看 SNI，且客户端会因证书不受信直接失败；
- 代理死亡时的 fail-open / fail-closed 抉择 —— fail-open 等于没有过滤；fail-closed 把沙箱网络变成单点故障；
- 与既有两个面的关系需要重排：`bash network:true` 批准轴（ADR-0022）、`network-guard` 六层防线（`network-guard.ts`）。

**当前替代方案的真实强度（诚实标注）：**

- 批准文案说真话 + `network_equals` 资格门禁 = **知情 + 资格**，不是强制过滤；
- `web_fetch` / `web_search` 默认路径的第 4 层防线存在一个真实可达的 DNS rebinding TOCTOU—— **正在修**（spike 已定聚焦补丁臂）。
- **不能让后来读者以为已有出口管控**：批准后（或未设资格规则时）出站内容仍零过滤；TOCTOU 在补丁落地前是已知真实洞。

**重开触发条件** —— 什么情况下这件事变成该做：

1. 出现真实的数据外泄事故；
2. 产品要开放给不受信操作员；
3. 对外承诺域名级白名单。

## 附带观察（不并入本 ADR）

`--dev-bind /dev /dev`（`bwrap.ts:137-139`）是全量绑设备面，而文件面是 deny-by-default 白名单（`createClosedWorldFsPolicy`（**2026-09-13 已随 ADR-0092 退役**））。两者姿态不一致。userns 下大概率不可利用，值得单独看一眼 —— 不在本 ADR 展开。

## Consequences

- `docs/adr/` 内 `0046` / `0055` 各有两个同号文件（并发会话产物）—— 预存 hygiene 问题，操作员单独裁定口径，本文不 renumber。
