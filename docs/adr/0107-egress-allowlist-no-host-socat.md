# 0107. 出口允许集：默认拒绝 + 出厂域 ∪ 用户名单；有闸、无宿主 socat

Date: 2026-09-19
Status: accepted

## Context

ADR-0106 把 bash 出口锁成「围栏宿主网直连、无域名闸」。操作员否决：那只是有网/没网，拦不住围栏里乱 `curl`。要的是默认拒绝、出厂 defaults 覆盖 git/包管理、用户可增删、未列域走批准或拒绝。

defaults 仍然是**过滤器**，不是「名单内直连公网」。无拦截点就没有允许集。0097 用宿主包 `socat` 把 netns 接到代理；操作员不要 **apt 装 socat**，不是不要域闸。

本决策 **推翻 0106**，在 0097/0104 的产品语义上改桥，不改「bash 出站按域名执法」。

## Decision

**终态：FS 围栏保持；bash 出站默认拒绝；允许集 = 出厂 defaults ∪ 用户层 `allowedDomains`，`deniedDomains` 优先；命中才出网。拦截在宿主代理。不依赖宿主 `socat`。**

锁死子决策：

1. **`--unshare-net` 留在产品 fence。** 否则不认 `HTTP_PROXY` 的进程（`curl --noproxy '*'`、裸 SSH）绕过名单。不恢复 `network:true`，不做关沙箱总开关。
2. **允许集有效，写在两处、合并执法：**
   - **出厂 defaults（代码常量，SSOT 一处 frozen 数组）：**  
     `github.com`、`*.github.com`、`*.githubusercontent.com`、  
     `registry.npmjs.org`、`registry.yarnpkg.com`、  
     `pypi.org`、`files.pythonhosted.org`、  
     `crates.io`、`static.crates.io`、`index.crates.io`、  
     `proxy.golang.org`、`sum.golang.org`、  
     `playwright.download.prss.microsoft.com`、`cdn.playwright.dev`。  
     收口 = git 主路径 + 主流包管理 + 本仓 Playwright 下载。**不进档：** 模型供应商 API、容器镜像仓库、GitLab/Bitbucket（用户增量或批准门）。
   - **用户层** `isolation.network.allowedDomains` / `deniedDomains` **保留、执法**。不是幽灵键。项目文件仍不采纳（ADR-0084）。
3. **未命中：** 交互入口走首见批准（批 = 会话放行，可选写回用户层 allowed）；非交互 fail-closed + 违例回灌。deny 优先。
4. **curl / git-https / npm：** 经 `HTTP_PROXY`/`HTTPS_PROXY` 打宿主代理；代理按 CONNECT host 判允许集；地址守卫（拒 loopback/私网/metadata）仍在代理侧。
5. **SSH / git-over-SSH：** 同一允许集、同一代理（HTTP CONNECT 或 SOCKS，实现里钉死一种，不得 SSH 直连宿主网）。`GIT_SSH_COMMAND` 注入 ProxyCommand。**禁止 socat 作为产品依赖。** 中继 = 本仓/已 pin 运行时自带（unix socket bind 进围栏，或围栏内最小中继），不 `apt install socat`。缺中继 = 出网 fail-closed，提示本产品依赖而非 socat。
6. **推翻 0106 的「删掉 isolation.network / 剥掉写回」。** 旧名单继续当用户增量，与 defaults 合并。
7. **`web_fetch` / `web_search` 的 network-guard 仍独立**（SSRF）。bash `curl` 走本 ADR 的允许集，不靠 network-guard。
8. **0105 sentinel：** 代理在场后技术上可做；**本 ADR 不自动启用**。不阻塞 0107。
9. **yolo / `full_auto`：** 正交。yolo 无围栏则无闸；`full_auto` 不免域闸。

**ADR 关系：** 0106 superseded by 0107。0097 的「域闸 + unshare-net + 代理」恢复为产品语义，**删除「socat 是宿主前置依赖」条款**。0104 预放行档恢复为 defaults 的子集并按本决策扩表。

## Why not

- **0106 开网无闸：** 拦不住乱 `curl`。操作员已否。拒。
- **名单内直连、无拦截：** 有网卡即任意域，允许集作废。拒。
- **继续 apt socat：** 操作员已否。拒。
- **只滤 HTTP、SSH 直连：** 两套出口，SSH 无闸。拒。

## Consequences

- bash `curl https://example.com` 未批准则拦；`curl https://github.com` / `npm i` / `git`（HTTPS 与 SSH）走 defaults 可通。
- 落地面：保留代理与 `--unshare-net`；拆掉 socat 探测与安装文案；自带中继替换两侧 socat；defaults 数组扩到本决策清单；settings 网络段留下执法。
- 进行中的 ssh-bridge / 宿主 socat 计划：**停写宿主 socat**；半桥、`GIT_SSH_COMMAND`、允许集判定可留，中继换成自带件后再合。

## Evidence pointers

- 操作员 2026-09-19：默认拒绝 + 出厂 defaults ∪ 用户名单；不要开网无闸；键有执法才留；不要宿主 socat。
- ADR-0097 / 0104 / 0106。
