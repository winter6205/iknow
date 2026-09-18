# Spec: 出口 ssh 桥（传输面）—— 沙箱内 git-over-SSH 可达（补完 ADR-0097 T7/T8 形态扩展）

**Status:** rev 2（ACR PASS——complexity-anti-drift 返工已落，见 ACR Verdict 段；assumptions 全部**待确认**，人类 gate 另行走）
**Basis:** ADR-0097（代理缝结构、生命周期表三形态、「HTTP CONNECT + SOCKS5」原设计、T7/T8 欠账）；ADR-0104（preset 六域；`github.com` apex 与 `*.github.com` 并列）；ADR-0105 §Decision 5（SSH 凭据归本 spec；key 进围栏姿态 = 出口域限制兜底）；承接 `specs/network-egress-allowlist.md`（rev 2）与 `specs/egress-preset-allowlist.md`（rev 1）
**Surface:** `src/harness/sandbox/egress/session.ts`、`upstream.ts`、`src/harness/sandbox/bwrap.ts`（egress bind 段扩多 socket）、`src/harness/aci/tools/bash.ts`（fence 内命令链接线）、`src/harness/background/manager.ts` / `src/harness/verify/sandbox-run.ts`（同规则接线确认）、`scripts/sandbox-probe.ts`（egress 分支重写 + ssh 探针类别）；**不改** `specs/egress-preset-allowlist.md` / preset 清单 / `domain-matcher.ts` 判定语义

## Objective

让沙箱内 `git push`（SSH remote）经**出口代理缝**可达：补完 ADR-0097 挂账的 T7/T8「SOCKS/git 形态扩展」——宿主侧 SOCKS5 代理面、沙箱内 socat 监听、`GIT_SSH_COMMAND` 注入、SSH 目标 `host:port` 的域判定语义，三形态（前台 per-call / background per-task / verify 单例）随 0097 生命周期表同规则起落。成功 = 实测地面：真实 `git push` 经放行域走通、未放行域 :22 被拒且违例回灌可区分。

用户故事：操作员希望 agent 在围栏内对 SSH remote 的仓库完成 push / PR 流。现状 `session.ts:25` 明写「SOCKS5 / git-over-SOCKS 不在 T4 范围（T7/T8 形态扩展时按 mux 形态补）」；ADR-0104 §Consequences 遗留同款；实测事故（conversation `ee13c787`）里 `git push` 走 HTTPS 也因缝未闭合全灭——本 spec 与并行 spec 共同把「能推到 git 主机」变成现实。

**用户已定方向（非假设）**：交付面 = 出口 ssh 桥（传输面）；SSH 凭据（私钥 / agent）归本 spec 设计；TLS 终止与 HTTP(S) 凭据 sentinel 代换归并行 spec `specs/egress-credential-sentinel.md`，本 spec 只声明共享装配缝、不设计对方范围。

### ASSUMPTIONS I'M MAKING（全部「待确认」，人类 gate 由主会话走）

1. 待确认 —— SSH 隧道走**既有 HTTP 半桥的 CONNECT 通道**为 git 主形态（依赖包在 Linux 上同此选择：`sandbox-utils.js:540` 用 `socat - PROXY:`；SOCKS5+`nc` 形态仅作 macOS 系参考，`sandbox-utils.js:531`，且 `nc` 无 SOCKS5 auth、沙箱内可用性未证）。
2. 待确认 —— SOCKS5 面仍按 0097 原设计建齐（宿主 `createSocksProxyServer` + 独立 unix socket + 沙箱内 1080 监听），供 socks5h 感知的通用工具（curl `--proxy socks5h://`、SSH 之外的隧道类）使用，但 **git 路径不依赖它**；若 ACR complexity-anti-drift 判定「git 不用的面先不建」，可整体裁剪 T2 而不影响其余任务。
3. 待确认 —— 沙箱内代理监听端口采**固定值** 3128(HTTP)/1080(SOCKS)（依赖包同款：`linux-sandbox-utils.js:630-631`），宿主侧代理 TCP 端口维持 OS 分配；理由：沙箱 netns 号段私有、固定端口使 `GIT_SSH_COMMAND` 与 env 可预先拼装，去掉现行「宿主/沙箱同号」的巧合式耦合（`session.ts:435-437`）。
4. 待确认 —— 实测教训「沙箱内 `/etc/ssh/ssh_config.d/*` 报 `Bad owner or permissions`」成立（任务前提，本 spec 起草时未在围栏内复验），故注入形态**必含 `-F /dev/null`**；T3 验收含围栏内复验探针。
5. 待确认 —— 现状确认：`~/.ssh` 私钥在 global 与 workspace 两 fs 档**都可读**（global 档 `--bind / /` 可写可见；workspace 档 home `--ro-bind` 可见只读，见 `bwrap.ts:109-141`；全仓 src 无任何 `~/.ssh` deny 规则——grep 实证）。因此「workspace 档 key 不可读」在**当前 fs-policy 下不存在**；`SSH_AUTH_SOCK` bind 仅作为条件分支（未来 read-deny / key 不在 home 时）钉形状，不入必做面。
6. 待确认 —— 允许集**无需**新增 `github.com:22` / `ssh.github.com:443` 形态条目：`domain-pattern.js:106-114` 明义「A pattern without a port matches every port」，preset 的 `github.com` 裸条目已覆盖 :22；`ssh.github.com` 命中 `*.github.com`（严格子域）。preset 清单零改动 ⇒ 无 cross-spec dependency（若实现期发现判定面与此结论不符，**回来改本 spec，不改 preset spec**）。
7. 待确认 —— 批准流对 SSH 不加新语义：filter 回调同闸同 sink，session-grants 按 host 记账（交互批准过 `github.com` 的 HTTPS 会话，同会话 :22 也放行）——视为「域粒度批准」既有语义的自然延伸，不另立端口轴。
8. 待确认 —— passphrase 保护私钥 + 无 agent = 围栏内 fail（ssh 提示口令、fence 无 tty → 失败），本 spec 只钉 Failure path 与指引文案（宿主侧 `ssh-add` / 改用无口令 key / 条件分支 `SSH_AUTH_SOCK` bind），不做口令回传面。
9. 待确认 —— 真实 `git push` e2e 仅对**操作员自有远端 + 非破坏性 ref**（如 `refs/heads/iknow-egress-probe-*` 或 `--dry-run`）执行，默认 skip、显式环境变量开启（对齐 `archive/tests-real-llm/` 的「缺条件 → 显式 skip + Not run」纪律，不落 CI）。
10. 待确认 —— 依赖包 `@anthropic-ai/sandbox-runtime` 升版时，本 spec 引用的包内路径/行号漂移只允许落在适配层 `upstream.ts` 与注释，判定/桥语义不因此改生产码。

## 领域词（逐字引 `docs/CONTEXT.md`，不重新定义）

- 「**出口代理缝**（egress proxy seam）: bash 围栏恒 `--unshare-net` 之下唯一的出网通路——宿主出口代理的 unix socket bind 进沙箱、沙箱内 socat 转成本地端口，`HTTP_PROXY` 系环境变量指过去；域判定在宿主代理做（HTTPS 只看 CONNECT host，不解密）。ADR-0097。」
- 「**域名允许集**（domain allowlist）: …`*.x` 严格子域（不含 apex）、可选 `:port` 后缀、deny 优先；全集 = **预放行档**（代码承载）∪ 用户层 `allowedDomains` 增量…地址守卫…与域名集正交。ADR-0097 / ADR-0104。」
- 「**预放行档**（builtin preset）: …`github.com` 与 `*.github.com` / `*.githubusercontent.com`、`registry.npmjs.org`、playwright 下载面…」
- 「**凭据 sentinel** …ADR-0105」+ ADR-0105 §Decision 5：「**SSH 凭据不在本决策内**：私钥可读性与 `SSH_AUTH_SOCK` 形态归出口 ssh 桥（ADR-0097 T7/T8 形态扩展）；key 进围栏的姿态沿用『出口域限制兜底』（key 只能用于向放行域认证）。」
- 「**沙箱纪律**: 同一 `bash` 调用输入下，前台执行与 `background:true` spawn 共用同一套 bwrap 围栏参数（FS / 网络 / env 隔离 / rlimit / cwdReadonly）…#653 G3。」
- secret-roundtrip mask（#406，`docs/CONTEXT.md` 详条）：可见面掩码，与 sentinel/本 spec 的 key 面正交（ADR-0105 §Decision 6 两层并存纪律照旧）。
- 「yolo 模式」在 `docs/CONTEXT.md` **无词条**（grep 实证），仅以 `settings.isolation.defaultMode: "yolo"`（`src/harness/permission/project-settings.ts:361` 注释面）与 preset spec F6 的口径存在——登记进待写入清单（见 Inherits/Changes），本 spec 正文按「无 fence 即无 egress 缝」引用该口径。

## Boundaries

- **Does:**
  - **沙箱内侧半桥补齐（本 spec 的前提性欠账）**：fence 内命令链起 `socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:<httpSocket>`（+ T2 在场时的 1080 段），形态抄依赖包 `linux-sandbox-utils.js:623-645`（`buildSandboxCommand`：后台监听 + `trap kill EXIT`）；代理 env 三键从「宿主 OS 端口」改指沙箱固定端口；`HTTP_PROXY` URL 嵌入 auth userinfo（修 §Open issues O1 的 407 死路）。
  - **SOCKS/mux 半桥接线**（T2，受 assumption 2 门控）：宿主 `createSocksProxyServer`（`upstream.ts:27-30` 已 re-export 备用）挂**同一 filter 工厂**（同 `decideEgress` + 同一 violation sink + 同 token）+ 第二条宿主 socat（`UNIX-LISTEN:<socksSocket> → TCP:127.0.0.1:<socksPort>`）+ 沙箱内 1080 监听；mux 语义按依赖包规则（`linux-sandbox-utils.js:511-521`：两协议同宿主端口时**复用**桥进程与 socket）——iknow 两 server 端口天然不同，默认两桥两 socket。
  - **`GIT_SSH_COMMAND` 注入**：形态钉死 = `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=3128,proxyauth=<user>:<token>'`（依据 `sandbox-utils.js:536-540` Linux 形态 + :524 mux 中和注释 + assumption 4 的 `-F /dev/null`）；经 `EgressFenceSpec.env` 走既有 `--setenv` 通道；`GIT_SSH_COMMAND` 不在 `BASE_ENV_WHITELIST`（`env-isolation.ts:55-65`），宿主值恒不进围栏，无缝时也不注入（纯断网一致性）。
  - **SSH 域判定语义**：CONNECT/ SOCKS 目标的 `(host, port)` 直接喂既有 `decideEgress`——裸 host 条目匹配任意端口（`domain-pattern.js:106-114`，assumption 6 实证引文）；preset 零改动结论 + 该结论的判定层测试钉子。
  - **凭据可用性分支**：私钥可读性两档现状确认钉成测试（assumption 5）；`SSH_AUTH_SOCK` bind 条件形态（同缝 `--bind` + env 注入 + 与 egress 桥同 dispose 通道）；passphrase/无 agent 的 Failure path 文案。
  - **三形态生命周期**：SOCKS 桥与 GIT_SSH_COMMAND 注入随 session 同起同落（前台 per-call / background per-task `settle()` / verify 单例），stale socket 随机 id + 启动前清理纪律同通道（0097 §dispose 契约逐字沿用）。
  - **yolo no-op**：egress 缝整体缺席（isolation OFF / 工厂返 `undefined` / `SocatUnavailableError` fail-closed）时本桥与注入同跳——无缝 = 无 `GIT_SSH_COMMAND` = git-over-SSH 与其余程序一样纯断网。
  - **bwrap argv 新增项落位**（对照 `.qoder/rules/security-boundaries.md` 固定顺序）：第二条（及条件 SSH_AUTH_SOCK）unix socket `--bind` 并入既有 egress bind 段——**workspaceMounts 之后、cwdReadonly 之前**（`bwrap.ts:191-195` 注释即此规则）；`GIT_SSH_COMMAND` 等新 env 走 `createBwrapFence` 的 `--clearenv` 后 `--setenv` 段（`bwrap.ts:258-262`）；内层命令链在 `--` 之后的 command 位，不改 argv 序。
  - **probe:sandbox 扩展**：egress「socat present」分支重写为真端到端（修 O1–O3，见 Open issues），新增 2 类——ssh 连通正探针（放行域 :22 握手到 banner 即算通）+ 未放行域 :22 违例探针（框架违例 reason 可区分）；全 11 类维持全绿。
  - **测试矩阵**：单测（注入 seam）+ probe + TUI pty 实测 + 真实 `git push` e2e（assumption 9 门控），验收判据见 Success Criteria。
- **Confirms with human（assumptions 未确认前不推进 PLAN）:**
  - 上述 10 条 numbered assumptions 逐条确认 / 纠正 / 删除。
  - T2 SOCKS 面去留（assumption 2 的裁剪选项）与沙箱固定端口 3128/1080 是否可被占用位（assumption 3）。
  - `SSH_AUTH_SOCK` bind 从「条件分支」升「必做面」与否（assumption 5 现状成立时默认不做）。
- **Out of this spec:**
  - **HTTP(S) 凭据 sentinel 代换 / TLS 终止（mitmCA / body-substitution / 真值不进围栏）**——并行 spec `specs/egress-credential-sentinel.md` 负责；共享装配缝 = `EgressSessionOptions` / `createEgressSession` 构造面（其需在同一 session 上挂 `mitmCA` 等 opts），本 spec 只保证 session 形状可叠加、**不设计对方范围**；两 spec 若同改 `session.ts`，合并次序由主会话裁。
  - E 逃逸缝（沙箱内 unix socket / 反向通路面收口，backlog 已挂账）。
  - gh 登录态 / GIT_CONFIG 代做 / 非 push 的 git 子命令便利面（HTTP 系凭据随 sentinel spec 走）。
  - 「沙箱内起服务 → 宿主可达」反向通路（前 spec 已裁定消亡，netns 恒断无反向通路）。
  - preset 清单变更（`specs/egress-preset-allowlist.md` 已提交，不许动；assumption 6 结论 = 本 spec 无需它变）。
  - socat 分发（宿主前置依赖纪律不变，0097）。

## Settled invariants

1. **缝唯一性延续**：SSH 流量与 HTTP/HTTPS 走同一条代理缝（同一 filter、同一 sink、同一 token、同一 dispose 通道），不开第二条出网通路；`--unshare-net` 恒在纪律（0097 invariant 1）不因桥扩展而有例外。
2. **判定不看内容**：SSH 流是 CONNECT 的 opaque 隧道（依赖包 `http-proxy.js:269-274` 注释实证：CONNECT 亦携带非 TLS 流，sniff 非 ClientHello 即原样隧道）——放行 = 能握手，域判定与端口来自客户端自报 authority，内容零检查；不得表述为「SSH 受内容管控」。
3. **无缝 = 无 git ssh 特例**：egress session 缺席（任何原因）时 `GIT_SSH_COMMAND` 不注入——git-over-SSH 与全部非代理感知程序同态 fail-closed（纯断网），杜绝「有注入无桥」的半开形态。
4. **注入面 SSOT 单点**：代理 env（三键 + `GIT_SSH_COMMAND` + NO_PROXY 族）只在 `buildProxyEnv`/`assembleFenceSpec` 一处构造（现 `session.ts:243-259, 439-448`），bash / background / verify 三消费面零复制——沙箱纪律（CONTEXT 词条）在 env 轴的定义即「三形态共用同一套围栏参数」。
5. **host 粒度批准不扩端口轴**：批准 / 违例 / 地址守卫的判定输入恒为 `(host, port)` 纯数据；`:22` 不引入新配置形态（preset 无 :port 条目，assumption 6 若被推翻则回改本 spec 而非 preset spec）。
6. **凭据姿态 = 出口域限制兜底**（ADR-0105 §Decision 5 逐字继承）：私钥进围栏可读是本档既定姿态；其风险收敛于 invariant 1——key 的唯一出网路径被域判定卡住。`SSH_AUTH_SOCK` 条件形态落地时同姿态（agent 只对经缝连接可用）。
7. **argv 顺序不破 fence**：所有新增 bind 落 egress bind 段、新增 env 落 `--clearenv` 后 `--setenv` 段；改 `bwrap.ts` 前后必跑 `npm run probe:sandbox` 全类别全绿（security-boundaries 纪律）。

## 任务拆分

### T1 — 沙箱内侧半桥 + auth 闭环（HTTP 面前提修复）

- `EgressFenceSpec` 扩字段（形状示意，非实现）：`sandboxProxyPorts: { http: 3128, socks?: 1080 }`、`innerBridgeScript: string`（宿主 session 装配期算好的监听前导命令）；`buildProxyEnv` 的 URL host 改 `127.0.0.1:3128` 并嵌 `http://<user>:<token>@` userinfo（token = session 现成 `randomBytes` 值，user 取 `sandbox-utils.js:712-722` 的固定名形态，本仓自定名不带 encodedCommand——归因已有 `commandLabel` sink 通道）。
- fence 命令链接线：`bash.ts` `buildForegroundFence` 的 `args: ["-c", finalCommand]` 在 egress 在场时改为 `-c "<bridge 前导>\n<finalCommand>"`（前导 = `linux-sandbox-utils.js:626-632` 形态：`socat … & trap …`）；无 egress = 零改动（byte-identical 回归基线）。
- bwrap 层端口耦合解除：`sandboxLocalPort` 语义从「与宿主同号」改「沙箱内固定监听号」。

**验收**：单测（注入 `spawn` / `socketPathFactory` seam，不断言真监听）钉 spec 形状 + 前导脚本字符串；`egress-proxy-behavior.test.ts` 的「不起真桥」注释改写为覆盖内层脚本装配；probe「socat present」分支重写为经真链路的端到端（放行 loopback NIC IP → 拿到响应；注意 O2：目标 IP 若落 NO_PROXY 需选 NIC 地址而非 `127.0.0.1` 字面，且地址守卫档对 loopback 的拒绝意味着该正探针须以**非 loopback** 的可寻址 fixture 落地，或把正探针挪到 T5 真域层——实现期以实测为准并在测试注释钉结论）。

### T2 — 宿主 SOCKS 面 + 第二桥（assumption 2 门控）

- `createEgressSession` 内加起 `createSocksProxyServer`（经 `upstream.ts`，import 收口纪律）：`filter` 复用 `createFilterCallback` 同一实例工厂（同 policy、同 sink、token 同值）；`lookupFor` 同款地址守卫（`socks-proxy.js:74-78` 的 dial 路径带 `lookupFor`）。
- 第二宿主 socat 桥 + `iknow-egress-socks-<id>.sock`；mux 规则：仅当宿主两端口相同（外部代理 override 形态，本仓暂不产生）才复用桥（`linux-sandbox-utils.js:511` 语义）。
- `EgressFenceSpec.unixSocketPath` → `unixSocketPaths: readonly string[]`；`egressBindArgs`（`bwrap.ts:216-222`）逐条发射 `--bind`，段内位置不变。

**验收**：单测断言两桥 spawn 参数与 socket 命名；`git push` 不依赖 SOCKS（T3 走 HTTP CONNECT），SOCKS 面的可达性以沙箱内 `curl --proxy socks5h://<user>:<token>@127.0.0.1:1080 https://<放行域>` 探针断言（T5/T6 层）；dispose 单通道同时收两桥 + 两 server（幂等回归）。

### T3 — `GIT_SSH_COMMAND` 注入与 env 策略

- 注入串（钉死形态）：
  `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=3128,proxyauth=<user>:<token>'`
  依据：Linux 形态选型 `sandbox-utils.js:536-540`（`PROXY:` 跨 socat 版本可移植，SOCKS5-CONNECT 需 ≥1.8.0）；mux 中和理由 `sandbox-utils.js:516-524`（用户 config 的 ControlPath 在沙箱内不可 bind、auth 后即退）；`-F /dev/null` 依 assumption 4。
- 覆盖/合并策略：注入值只在 session 在场时存在；围栏内用户命令**显式内联** `GIT_SSH_COMMAND=...` 时后者胜（shell 语义，不加防御）；推荐组合写法 `GIT_SSH_COMMAND="$GIT_SSH_COMMAND -i <key>"` 写进指引文案（既有 `$GIT_SSH_COMMAND` 逐字引用）。known_hosts 不受 `-F` 影响（ssh 独立路径），首次未见主机 key 的失败面归 Failure paths F4。
- env 白名单关系：`GIT_SSH_COMMAND` **不入** `BASE_ENV_WHITELIST`（宿主值不进围栏，invariant 3）；注入经 `spec.env` → `mergedEnv`（`bwrap.ts:224-239`），与 `--clearenv` 序不变。

**验收**：单测逐字符断言注入串（token 位以注入 seam 的固定 token 断言）；围栏内复验 `ssh -G github.com`（经 `bash` 工具）不报 `Bad owner or permissions`（assumption 4 的地面）；TUI 实测 `GIT_SSH_COMMAND` 值屏上可见。

### T4 — SSH 域判定语义钉子（判定层，零生产码改动）

- `decideEgress({host:"github.com",port:22,allowed:[...preset]})` → allow（裸条目匹任意端口）；`ssh.github.com:443` → allow（`*.github.com`）；`example.com:22` 未放行 → deny `not-in-allowlist`；`github.com` 进 `deniedDomains` → :22 同拒（deny 优先无端口例外）。
- 「preset 不需要 `:22` / `:443` 形态条目」结论以测试钉死（assumption 6）；若上游 `matchesDomainPatternWithPort` 升版改语义，`upstream.ts` 适配层唯一改动点（0097 Dependency fork 纪律）。

**验收**：判定层表驱动单测全绿 + 一条显式命名的「ssh-port-inherits-bare-host-entry」回归钉子；grep 断言本 spec 未产生任何 preset 清单 diff。

### T5 — 三形态生命周期 + yolo no-op 接线

- background（`manager.ts:466-497`）与 verify（`sandbox-run.ts:67+` 单例）经同一 `EgressFenceSpec` 消费面自动获得 SOCKS 桥与注入；per-task `settle()` / 单例随宿主的释放通道零新代码，只加断言。
- 内层监听前导脚本在三形态的命令装配点各自接线（background spawn factory 与 verify 的命令包装与 bash.ts 同形——若装配面已收敛在公共 helper 则一处改）。
- yolo / 工厂 `undefined` / `SocatUnavailableError`：断言零注入（invariant 3）。

**验收**：wiring 测试（`build-engine-egress-wiring.test.ts` 形制）断言三形态 spec 字段集相等；stale socket 清理与 dispose 幂等测试覆盖**当前在场的全部桥**——HTTP 桥（`iknow-egress-*`）恒在，SOCKS 桥（`iknow-egress-socks-*`）在 T2 在场时才进「双文件启动前清理 + 亡桥归类 infra」断言集；T2 被裁剪（assumption 2）时本断言退化为单桥，不得因缺 SOCKS socket 而红。

### T6 — 凭据可用性分支

- 私钥可读性现状钉子：global / workspace 两档围栏内 `test -r ~/.ssh/id_ed25519`（fixture key）可读（assumption 5 的地面化）；workspace 档对 key 的**写**必败（ro-bind）。
- `SSH_AUTH_SOCK` 条件形态（默认**关**，assumption 5）：开启时 = 宿主 agent socket 路径经同段 `--bind` + `SSH_AUTH_SOCK` 入 `spec.env`；agent socket 的 stale/缺失 fail-closed（连不上 = ssh 报 agent refused，归类 infra 非域拒绝）。
- 指引文案面：passphrase/无 agent → 违例/失败信息含「宿主侧 `ssh-add` 或无口令 key」一行。

**验收**：两档可读性测试 + 条件形态的开/关行为各有单测（关态断言 `SSH_AUTH_SOCK` 在围栏 env 中不存在）。

### T7 — 探针扩展 + TUI/真 push 实测

- `scripts/sandbox-probe.ts`：T1 的重写 + 新增两类——
  - 正探针：放行 fixture 域 :22（宿主侧可起假 ssh banner listener 于非 loopback NIC 或经域名 fixture）沙箱内 `nc`/`ssh -o ProxyCommand` 握手见 banner = 通；
  - 违例探针：未放行域 :22 → 沙箱内失败 + 框架侧 sink 记 `not-in-allowlist`（port=22），两信号可区分（前 spec「三类信号」表延续）。
  - 类别计数从 11 → 13 时同步 `security-boundaries.md` 的「11 类」表述？——**规范文件不改**（Out of scope：本 spec 不碰 `.qoder/rules/`；数字表述漂移登记进 Open questions OQ3 由主会话裁）。
- TUI pty 实测（AGENTS 实测地面）：干净装配下 ①`git push --dry-run`（SSH remote，github.com）握手通到认证层；②未放行域 push → 屏上 `[network_denied]` typed failure 含被拒 `host:22`；③`echo $GIT_SSH_COMMAND` 屏上值 = T3 钉死形态。
- 真实 e2e（assumption 9）：`archive/` 同纪律落一条显式开启的真 `git push`（操作员自有远端、探测 ref、push 后即删 ref）；缺开关/缺 key → 显式 skip + Not run。

**验收**：`npm run probe:sandbox` 全类别全绿（含新 2 类）；TUI 三条操作的屏上证据入报告；真 push e2e 在开启环境下 exit 0。

## Failure paths

| #   | 路径                                                               | 行为                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | 无 egress session（yolo / 工厂 undefined / SocatUnavailableError） | 不注入 `GIT_SSH_COMMAND`、不起内层监听——git ssh 纯断网（invariant 3），与前 spec「三类信号」的「无出网资格」归类一致                                                                                                     |
| F2  | 未放行域 :22（含 SOCKS 面被拒）                                    | filter 记 `not-in-allowlist`（port=22）→ 隧道建立失败 → 收尾 drain → `execution_failed` typed failure（三跳通道原样复用，SSH 不开第二文案面）；ssh 自身的 `Connection closed`/`kex` 报错是命令层观测，与框架归因并行不混 |
| F3  | 桥/代理进程死（CONNECT 成功前）                                    | ECONNREFUSED/桥亡 → infra 故障归类，不误报域拒绝（前 spec SC5 语义延伸到 :22）                                                                                                                                           |
| F4  | 首次未见主机（known_hosts 无条目）                                 | ssh 要求确认指纹、fence 无 tty → 认证前失败；失败信息含指引（宿主侧先 `ssh-keyscan`/登录确认，或显式 `-o UserKnownHostsFile=` 组合写法）；**不**默认注入 `StrictHostKeyChecking=no`（削弱信任面非本 spec 授权）          |
| F5  | passphrase 私钥 + 无 agent                                         | ssh 提示口令 → 无 tty 失败；指引 = 宿主 `ssh-add` / 无口令 key / `SSH_AUTH_SOCK` 条件形态（T6）；不自动回传口令                                                                                                          |
| F6  | 内层 3128/1080 端口被沙箱内先占                                    | 内层脚本 `socat` 先于用户命令启动（前导序保证），理论竞争仅存在于用户嵌套 bwrap 场景 → 监听失败 fail-closed（连不上），违例不冒充域拒绝；探针含 socat 启动失败即脚本报错可见                                             |
| F7  | `proxyauth` 凭据不符（token 漂移/复用旧串）                        | 代理 407（CONNECT）/SOCKS auth deny（`socks-proxy.js:10-20`）→ 归类 infra；token per-session 随机（`session.ts:489`）保证跨会话不通用                                                                                    |
| F8  | SSH_AUTH_SOCK bind 指向 stale socket（条件形态）                   | 启动前同法清理（随机 id + unlink）；连接失败归类 infra 非域拒绝                                                                                                                                                          |

## Success Criteria（binary）

- **SC1**：干净装配（preset 在场、无用户 settings 段）下，围栏内 `ssh -T git@github.com -o ProxyCommand='<注入值逐字>'` 完成 TCP+CONNECT 并收到对端 banner（probe 正探针 exit 0）。
- **SC2**：未放行域 :22 被拒：沙箱内命令失败 **且** 框架 drain 到 `{host, port:22, reason:"not-in-allowlist"}`，tool_result 呈 `execution_failed` 含 `[network_denied]` 前缀（测试走 bash 真实返回形状，禁直接构造 typed failure——前 spec 假绿纪律）。
- **SC3**：`GIT_SSH_COMMAND` 注入串逐字 = T3 钉死形态（单测）；session 缺席时该 env 在围栏 env 中不存在（三形态各 1 条 wiring 断言）。
- **SC4**：判定层表驱动测试钉住 assumption 6：`github.com:22` allow / `ssh.github.com:443` allow / `example.com:22` deny / deny 优先含 :22；preset spec 文件与 `preset-domains` 清单 git diff 为空。
- **SC5**：dispose 单通道收**全部已起的桥**（HTTP 桥/server/socket 恒在；SOCKS 桥/server/socket 仅 T2 在场时加入，T2 裁剪后本项退化为单桥不判红），幂等回归绿；stale socket 场景归类 infra（F3/F8 测试）。
- **SC6**：`npm run probe:sandbox` 既有全类别 + 新 2 类全绿；`npm test` 全绿（含反转的 `egress-proxy-behavior` / `egress-assembly` / wiring 系列迁移）。
- **SC7**：TUI pty 三条操作（T7）屏上证据齐；真 `git push` e2e 在开启环境 exit 0、默认环境显式 skip。
- **SC8**：LSP/编译零新增错误（Serena `get_diagnostics_for_file` 于改动文件）；`bwrap.ts` argv 顺序纪律回归（egress bind 段位置 + `--clearenv` 前置于全部 `--setenv` 的既有测试不破）。
- **SC9**：私钥两档可读性断言（T6）绿；关态 `SSH_AUTH_SOCK` 不存在断言绿。

## Open questions

- OQ1：mux 单端口形态（HTTP+SOCKS 同居一端口、单 socket 复用）是否在 iknow 引入——当前两 server 天然分端口，mux 分支唯一受益者是外部代理 override 场景（本仓无该配置面）；默认不实现复用分支，仅保留规则引用（`linux-sandbox-utils.js:511-521`）。若 assumption 2 裁剪 T2 则本条自动消失。
- OQ2：`GIT_SSH_COMMAND` 是否需要 `GIT_SSH` 姊妹变量（低版本 git 支持面）——依赖包只注 `GIT_SSH_COMMAND`（:531/:540 均然）；按只注入 `GIT_SSH_COMMAND` 收口，出现真实受害面再议。
- OQ3：probe 类别数 11→13 后 `.qoder/rules/security-boundaries.md` 的「11 类」措辞更新属规范文件变更（本 spec 不碰），留主会话随登记一并处理。
- OQ4：verify 单例的 egress session 跨调用复用与 per-call 内层监听的相互作用——单例 session 起一次、每次 verify 命令各自跑内层前导，端口重绑由 `reuseaddr` + netns 独立解决；实测若撞 `EADDRINUSE`（同 netns 复用异常路径）回到本节补形。

## Inherits / Changes

- **继承（逐字引用面）**：
  - `docs/adr/0097` §Decision「HTTP CONNECT + SOCKS5」代理形态 + §生命周期表三形态 + stale socket 防线 + 批准持久化粒度；§Consequences「domain fronting 不可防」（SSH 隧道同性质）。
  - `docs/adr/0104` §Decision 1 六域清单（本 spec 判定层消费，不改动）；`docs/adr/0105` §Decision 5/6（SSH 凭据归属 + 两层掩码/sentinel 并存）。
  - `specs/network-egress-allowlist.md` 的 Violation feedback channel 三跳 / `execution_failed` 选型 / 三类信号可区分表 / Ownership-dispose 契约 / Dependency fork（适配层收口、私网档显式 opt-in、包深路径无契约稳定）。
  - `specs/egress-preset-allowlist.md` 的合并语义与 `allowlistSource` 三档（SSH 违例文案同源复用，`port` 字段如实渲染）。
  - `.qoder/rules/security-boundaries.md` §Sandbox argv 顺序与 probe 全绿纪律；AGENTS.md 测试规范（TUI 实测面、typed-error catch 契约、矩阵选择、`archive/` 显式 skip 纪律）。
  - 代码既有缝：`session.ts` filter 工厂/sink/token/幂等 dispose、`domain-matcher.ts` 判定序、`bwrap.ts` egress bind 段与 env 段、`bash.ts` 前台编排 6 步、`manager.ts` settle 释放、`upstream.ts` import 收口。
- **变更**：
  - `EgressFenceSpec` 形状（多 socket / 固定内端口 / 注入 env 扩集 / 内层前导脚本）——三消费面随之适配。
  - `session.ts` 头注「SOCKS5 / git 不在本层」欠账清偿；`upstream.ts:25` 同款注释更新。
  - 无新 ADR 级决策（形态全在 0097 已裁框架内）；**待写入清单（persist 由主会话跑）**：`docs/CONTEXT.md`「yolo 模式」词条缺口（见领域词节末条）。
- **依赖面声明（并行 spec 交界，不设计对方）**：`createEgressSession` 的 opts 是两 spec 共享装配缝——sentinel spec 需挂 `mitmCA`/代换注册表进同一 HTTP 代理实例；本 spec 保证 session 构造参数可加性扩展、代理 server 实例句柄不外泄给第二持有者。两 spec 对 `session.ts` 的改动合并冲突由主会话裁。

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

```text
bounded-context-guardian: yes — SSH 桥全部收在 egress 缝（session/upstream/bwrap + EgressFenceSpec.env 单点，invariant 4）；bash/manager/sandbox-run 仅消费接线（T1/T5）；与 sentinel spec 交界显式声明「只保证 session 可加性、不设计对方、句柄不外泄」
defensive-contract-validator: yes — 域判定四态表驱动（T4/SC4）、缺 socat（F1）、桥死归类 infra（F3）、端口先占（F6）、token 漂移（F7）、stale socket + dispose 幂等（SC5/F8）各有验收钉子；SC2 禁直构 typed failure 堵假绿
error-handling-enforcer: yes — F1–F8 全部 infra/域拒绝/合法态分型且经三跳通道 drain 归因；O3「absent 分支报绿掩盖缺口」被点破并由 T1 重写 present 分支为真端到端 + SC6 强制 present 分支实测全绿清偿
complexity-anti-drift: unclear → 已返工（rev 2）— 原判：assumption 2「T2 可整体裁剪」与 T5 验收/SC5 把双 socket/双桥写死进全局判据矛盾。返工：两处断言改为条件于 T2 在场，裁剪后退化为单桥不判红（审查方明示「一处文字性返工后即可交 writing-plans」）
minimal-change-verifier: yes — 范围严格传输面；T6 凭据分支系 ADR-0105 §Decision 5 归属本 spec 的欠账且 SSH_AUTH_SOCK 默认关；preset 零改动双锁；O1–O3 是端到端前提修复非夹带
OVERALL: PASS（rev 2，返工点已按审查方清单落实）
```

## Evidence pointers

- 依赖包现成件（pin 版，包名 = 事实引用）：
  - `linux-sandbox-utils.js:472-560` `initializeLinuxNetworkBridge`（宿主双桥 + mux 复用分支 :511-521 + socket 就绪轮询）；`:623-645` `buildSandboxCommand`（沙箱内 `TCP-LISTEN:3128/1080 → UNIX-CONNECT` 前导 + trap 收尾）；`:1540`（第二 socket `--bind`）、`:1543-1551`（proxy env 经 `--setenv` 指沙箱内端口）。
  - `sandbox-utils.js:531`（SOCKS5+nc 形态，macOS 向）、`:536-540`（Linux `socat - PROXY:…proxyport=…[,proxyauth=…]` 形态 + mux 中和注释 :516-524 + 「DNS 解析发生在沙箱外」注记）、`:421-470`（`generateProxyEnvVars`：auth userinfo 嵌法 :433、NO_PROXY 档 :456-470）、`:712-722`（auth username 形态）。
  - `http-proxy.js:52-67`（`checkAuth`：CONNECT 强制 Proxy-Authorization，无 header → 407 :221/:435）；`:269-276`（CONNECT 携带非 TLS 流 = SSH 隧道的既有实证注释）；`socks-proxy.js:5-49`（同形 `filter(port, host)` + `isValidHost` 畸形拒 + auth handler :10-20）、`:74-78`（dial 带 `lookupFor` 地址守卫）。
  - `domain-pattern.js:106-120`（「无 `:port` 条目匹任意端口」语义原文）。
- 本仓缝：`session.ts:25`（T7/T8 欠账原文）、`:243-259`（buildProxyEnv 无 auth → O1）、`:412-429`（宿主 HTTP 桥）、`:435-448`（同号耦合）；`bwrap.ts:191-195, 216-222`（egress bind 段）；`bash.ts:319-351`（`args:["-c", finalCommand]` 无前导）、`:470-508`（start-fail = 无缝）；`env-isolation.ts:55-65`（白名单无 GIT_SSH/SSH 族）；`assembly.ts:84-95`（段缺席 → undefined = 无缝路径）；`tests/harness/sandbox/egress-proxy-behavior.test.ts:15`（「不起真 socat 桥，沙箱内侧装配 T7/T8 范围」）；`scripts/sandbox-probe.ts:340-400`（present 分支现形，见 O2/O3）。
- 实测事故与语义前提：conversation `ee13c787`（push 死路）；`*.x` 不含 apex / 后缀锚定 / 大小写（0097 §Evidence）；bwrap 0.11.1 对 `--unshare-net` 下 loopback 置起的行为**以 T1/T7 探针实测为证**（spec 不引外部文档当凭据）。

### Open issues（起草期发现，与现有代码冲突，归 T1/T5 修复面）

- **O1（407 死路）**：session 给 HTTP 代理配了 `proxyAuthToken`（`session.ts:401, 489`）而注入的代理 URL 不含 userinfo（`session.ts:243-249`）——沙箱内 CONNECT 必 407（`http-proxy.js:52-59` 无条件校验在场 token）。T1 一并闭环。
- **O2（NO_PROXY 自噬）**：`buildProxyEnv` 的 `NO_PROXY=127.0.0.1,localhost` 使「目标为 loopback 字面」的请求绕过代理直连（沙箱 netns 内必败）——probe present 分支（`sandbox-probe.ts:340+`，allowedDomains = `127.0.0.1:<port>`）在该形态下不可能 exit 0；本 spec 的正探针目标形态须避开 loopback 字面目标（T1/T7 注记）。
- **O3（内层监听缺失 + 同号巧合）**：全仓 src 无 `TCP-LISTEN`/`UNIX-CONNECT` 装配（grep 实证），`session.ts:436` 注释引用的 `buildSandboxInnerCommand` 不存在——现「HTTP 半桥」实为宿主半场，端到端从未在 socat 在场机器上走通（本机 `which socat` = 无 → probe 走 absent 分支报绿掩盖此缺口）。本 spec 的 T1 即清偿。
