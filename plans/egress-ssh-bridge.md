# Plan: egress-ssh-bridge —— 出口 ssh 桥（传输面）

> **Halt（ADR-0107，2026-09-19）：停写宿主 `socat`。** 允许集、`--unshare-net`、HTTP 代理、`GIT_SSH_COMMAND`、内层半桥仍要；凡 `apt install socat` / `which socat` / 两侧 socat argv 改为本仓自带中继后再继续。未改中继前不要合入。

**Goal:** 让沙箱内 `git push`（SSH remote）经出口代理缝可达：补齐沙箱内侧半桥 + auth 闭环、`GIT_SSH_COMMAND` 注入、`:22` 域判定钉子、三形态生命周期与 SSH 凭据可用性分支，顺带清偿 O1（407 死路）/O2（NO_PROXY 自噬）/O3（内层监听缺失 + probe 假绿）；未放行域 :22 被拒且违例回灌可区分。
**Approach:** T1（内层桥 + auth 闭环）是前提性子弹——HTTP 面端到端不闭合则其余全是假绿；注入面与判定层钉子随后叠加 / 并行；SOCKS 面是独立可摘的翼（assumption 2 门控），后续子弹的判据一律写成「T2 在场」条件形态（照抄 spec rev 2 的 T5/SC5 返工文字）；生命周期与凭据分支收口三形态；最后以探针 + TUI/真 push 实测做验收面。姊妹面边界一句：凭据面（TLS 终止 + sentinel 代换）在 `specs/egress-credential-sentinel.md` / `plans/egress-credential-sentinel.md`，本 plan 只保证 `createEgressSession` 共享缝的可加性、不设计对方范围。
**Spec link:** `specs/egress-ssh-bridge.md`（rev 2）
**ACR:** PASS（rev 2，complexity-anti-drift 返工已落；verdict 块照录 spec）
**Tracker:** 本地 markdown fallback——本文件 Status 字段即 tracker，无 GitHub issue 边（沿用仓内 plans 先例形态）。
**待写入:** `docs/CONTEXT.md`「yolo 模式」词条缺口（spec §Inherits/Changes 已登记，主会话统一 flush，此处不新增项）。
**Assumptions 裁定纪律:** spec 10 条 assumptions 全部**待确认**——某条 assumption 依赖的子弹翻车时按 spec 的回退形态处理（assumption 6 翻车 → 回 `specs/egress-ssh-bridge.md` 改，不改 preset spec；assumption 2 翻车 → 整颗摘除子弹 2，条件判据自动退化为单桥），plan 不自行裁定 assumption。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

```text
bounded-context-guardian: yes — SSH 桥全部收在 egress 缝（session/upstream/bwrap + EgressFenceSpec.env 单点，invariant 4）；bash/manager/sandbox-run 仅消费接线（T1/T5）；与 sentinel spec 交界显式声明「只保证 session 可加性、不设计对方、句柄不外泄」
defensive-contract-validator: yes — 域判定四态表驱动（T4/SC4）、缺 socat（F1）、桥死归类 infra（F3）、端口先占（F6）、token 漂移（F7）、stale socket + dispose 幂等（SC5/F8）各有验收钉子；SC2 禁直构 typed failure 堵假绿
error-handling-enforcer: yes — F1–F8 全部 infra/域拒绝/合法态分型且经三跳通道 drain 归因；O3「absent 分支报绿掩盖缺口」被点破并由 T1 重写 present 分支为真端到端 + SC6 强制 present 分支实测全绿清偿
complexity-anti-drift: unclear → 已返工（rev 2）— 原判：assumption 2「T2 可整体裁剪」与 T5 验收/SC5 把双 socket/双桥写死进全局判据矛盾。返工：两处断言改为条件于 T2 在场，裁剪后退化为单桥不判红（审查方明示「一处文字性返工后即可交 writing-plans」）
minimal-change-verifier: yes — 范围严格传输面；T6 凭据分支系 ADR-0105 §Decision 5 归属本 spec 的欠账且 SSH_AUTH_SOCK 默认关；preset 零改动双锁；O1–O3 是端到端前提修复非夹带
OVERALL: PASS（rev 2，返工点已按审查方清单落实）
```

## Tasks (ordered by dependency)

各 bullets 编号与 spec T1–T7 一一对应；`[blocks: Tn]` 同时指 spec 任务与本 plan 子弹。

1. **沙箱内侧半桥 + auth 闭环（O1/O2/O3 清偿）** — tag: `[implementation]`
   - **Inherits:** spec T1「沙箱内侧半桥补齐（本 spec 的前提性欠账）」：fence 命令链前导 `socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:<httpSocket>` + `trap kill EXIT` 形态、代理 env 三键改指沙箱固定端口、`HTTP_PROXY` URL 嵌 auth userinfo；invariant 7 逐字「所有新增 bind 落 egress bind 段、新增 env 落 `--clearenv` 后 `--setenv` 段；改 `bwrap.ts` 前后必跑 `npm run probe:sandbox` 全类别全绿」；清偿对象 = O1「注入的代理 URL 不含 userinfo——沙箱内 CONNECT 必 407」、O2「正探针目标形态须避开 loopback 字面目标」、O3「全仓 src 无 `TCP-LISTEN`/`UNIX-CONNECT` 装配……本 spec 的 T1 即清偿」。
   - **Surface:** `src/harness/sandbox/egress`（session.ts 的 `buildProxyEnv` / `assembleFenceSpec` / `EgressFenceSpec` 扩字段）、`src/harness/sandbox/bwrap.ts`（`sandboxLocalPort` 语义改「沙箱内固定监听号」）、`src/harness/aci/tools/bash.ts`（前台命令链前导）、`scripts/sandbox-probe.ts`（egress「socat present」分支重写）。
   - **Acceptance:** 单测经注入 `spawn` / `socketPathFactory` seam 钉 spec 形状 + 前导脚本字符串（不断言真监听）；probe「socat present」分支改为经真链路的端到端——正探针以**非 loopback** 可寻址 fixture 落地并拿到响应（O2 纪律），实现期实测结论钉进测试注释；无 egress 时命令链 byte-identical 回归基线（零改动）；`npm test` 绿 + `npm run probe:sandbox` 全类别全绿。本子弹改 `session.ts`，与 credential-sentinel plan 的 `session.ts` 子弹串行落地，合并冲突主会话裁。
   - Status: [x] done（实现机无 socat → probe present 分支 Not run，absent 分支全绿；单测 + typecheck 绿）0107 换装：本条 socat 半桥形态与 present/absent 分支已被自带 node 中继替换，probe 真端到端全绿

2. **宿主 SOCKS 面 + 第二桥（可整体裁剪）** — tag: `[implementation]`
   - **裁剪判定点（assumption 2，待人类确认，本子弹唯一门）:** 若裁定「git 不用的面先不建」，本子弹**整颗摘除**——git 路径不依赖它（子弹 3 走 HTTP CONNECT），摘除后子弹 5/7 的 SOCKS 相关断言按 spec SC5 条件形态自动退化为单桥不判红；未裁定前本子弹不进实施。
   - **Inherits:** spec T2「`filter` 复用 `createFilterCallback` 同一实例工厂（同 policy、同 sink、token 同值）+ 第二宿主 socat 桥 + `iknow-egress-socks-<id>.sock`」+ mux 语义「仅当宿主两端口相同……才复用桥……默认两桥两 socket」；invariant 1 逐字「SSH 流量与 HTTP/HTTPS 走同一条代理缝（同一 filter、同一 sink、同一 token、同一 dispose 通道），不开第二条出网通路」。
   - **Surface:** `src/harness/sandbox/egress/session.ts`（`createEgressSession` 内加起 `createSocksProxyServer`）、`upstream.ts`（import 收口纪律）、`bwrap.ts` egress bind 段（`unixSocketPath` → `unixSocketPaths: readonly string[]` 逐条发射 `--bind`，段内位置不变）。
   - **Acceptance:** 本子弹在场时单测断言两桥 spawn 参数与 socket 命名；dispose 单通道同时收两桥 + 两 server、幂等回归绿；SOCKS 面可达性以沙箱内 `curl --proxy socks5h://<user>:<token>@127.0.0.1:1080 https://<放行域>` 探针断言（落点在子弹 7 层）；`npm run probe:sandbox` 全类别全绿（argv 段位置纪律）。本子弹与 credential-sentinel 的 `session.ts` 改动串行落地，合并冲突主会话裁。
   - Status: [ ] pending
   - [blocks: T1]

3. **`GIT_SSH_COMMAND` 注入与 env 策略** — tag: `[implementation]`
   - **Inherits:** spec T3 钉死注入串（Surface 引用）；invariant 3 逐字「egress session 缺席（任何原因）时 `GIT_SSH_COMMAND` 不注入——git-over-SSH 与全部非代理感知程序同态 fail-closed（纯断网），杜绝『有注入无桥』的半开形态」；invariant 4「代理 env（三键 + `GIT_SSH_COMMAND` + NO_PROXY 族）只在 `buildProxyEnv`/`assembleFenceSpec` 一处构造……三消费面零复制」；assumption 4（注入形态必含 `-F /dev/null`，本子弹含围栏内复验探针）。
   - **Surface:** `src/harness/sandbox/egress/session.ts`（注入经 `spec.env` → `mergedEnv`）；`env-isolation.ts` 面为**确认不改**（`GIT_SSH_COMMAND` 不入 `BASE_ENV_WHITELIST`，宿主值恒不进围栏）；TUI pty 实测面。
   - **Acceptance:** 注入串形态 = `ssh -F /dev/null -o ControlMaster=no -o ControlPath=none -o ProxyCommand='socat - PROXY:127.0.0.1:%h:%p,proxyport=3128,proxyauth=<user>:<token>'`（spec 冻结形态），单测逐字符断言（token 位以注入 seam 固定值）；围栏内复验 `ssh -G github.com` 不报 `Bad owner or permissions`；session 缺席时该 env 在围栏 env 中不存在；围栏内用户命令显式内联 `GIT_SSH_COMMAND=...` 时后者胜（shell 语义，不加防御）；`npm test` 绿 + TUI 实测 `echo $GIT_SSH_COMMAND` 屏上值可见。
   - Status: [x] done（逐字符注入串 + token 同源 + 缺席不注入 + 白名单钉 + 后者胜注释全落；围栏内 `ssh -G github.com` 复验与 TUI `echo $GIT_SSH_COMMAND` deferred 到子弹 7——实现机无 socat 起不了真围栏，仓内无先例可自动化）0107 换装：注入串换新冻结形态（ProxyCommand=自带 CONNECT 件，token 走 env 不进 argv），spec §T3 同步修订
   - [blocks: T1]

4. **SSH 域判定语义钉子（preset 零改动）** — tag: `[implementation]`
   - **Inherits:** spec T4 四态表（`github.com:22` allow / `ssh.github.com:443` allow / `example.com:22` deny `not-in-allowlist` / deny 优先含 :22）；invariant 5 逐字「批准 / 违例 / 地址守卫的判定输入恒为 `(host, port)` 纯数据；`:22` 不引入新配置形态」；assumption 6 引文「A pattern without a port matches every port」；「若上游 `matchesDomainPatternWithPort` 升版改语义，`upstream.ts` 适配层唯一改动点」。
   - **Surface:** `src/harness/sandbox/egress/domain-matcher.ts` 判定层（测试钉子，零生产码改动）。
   - **Acceptance:** 表驱动单测全绿 + 一条显式命名的「ssh-port-inherits-bare-host-entry」回归钉子（SC4）；grep 断言本 spec 未产生任何 preset 清单 / `specs/egress-preset-allowlist.md` diff；`npm test` 绿。
   - Status: [x] done
   - [parallel]

5. **三形态生命周期 + yolo no-op 接线** — tag: `[implementation]`
   - **Inherits:** spec T5/SC5 条件形态照抄：「stale socket 清理与 dispose 幂等测试覆盖**当前在场的全部桥**——HTTP 桥（`iknow-egress-*`）恒在，SOCKS 桥（`iknow-egress-socks-*`）在 T2 在场时才进『双文件启动前清理 + 亡桥归类 infra』断言集；T2 被裁剪（assumption 2）时本断言退化为单桥，不得因缺 SOCKS socket 而红」；invariant 4（沙箱纪律 env 轴）；F1（yolo / 工厂 `undefined` / `SocatUnavailableError` → 零注入）；0097 §dispose 契约逐字沿用。
   - **Surface:** `src/harness/background/manager.ts`、`src/harness/verify/sandbox-run.ts`、`src/harness/aci/tools/bash.ts` 三消费面（内层监听前导脚本在各自命令装配点接线，若已收敛公共 helper 则一处改）。
   - **Acceptance:** wiring 测试（`build-engine-egress-wiring.test.ts` 形制）断言三形态 spec 字段集相等；双桥 / 单桥断言依子弹 2 在场与否条件化（不写死）；yolo / 工厂 undefined / SocatUnavailableError 三路径各断言 `GIT_SSH_COMMAND` 与内层前导均缺席；per-task `settle()` / verify 单例释放通道零新代码只加断言；`npm test` 绿。本子弹触 `session.ts` 相关字段消费面时与 credential-sentinel 子弹串行落地，合并冲突主会话裁。
   - Status: [x] done（三形态消费同一 spec：background spawn factory 补 egress 缝 + 内层前导、verify 命令包装补前导、bash.ts 前台 T1 已在；wiring/三路径/生命周期测试落 `tests/harness/egress-three-form-lifecycle.test.ts`，在场桥断言从 spawn 现场派生不写死桥数）0107 换装：SocatUnavailableError 三路径断言换为 EgressRelayUnavailableError；在场资源断言改 unix listen 现场（宿主无桥进程）
   - [blocks: T1, T3]

6. **凭据可用性分支** — tag: `[implementation]`
   - **Inherits:** ADR-0105 §Decision 5 逐字「**SSH 凭据不在本决策内**：私钥可读性与 `SSH_AUTH_SOCK` 形态归出口 ssh 桥……key 进围栏的姿态沿用『出口域限制兜底』（key 只能用于向放行域认证）」；invariant 6（凭据姿态 = 出口域限制兜底）；spec T6 + assumption 5（`SSH_AUTH_SOCK` bind 仅条件分支、默认**关**）；F5 / F8 文案与归类纪律（passphrase/无 agent 失败含指引一行；agent socket 连不上归类 infra 非域拒绝）。
   - **Surface:** `src/harness/sandbox/bwrap.ts`（条件 `SSH_AUTH_SOCK` bind 同段落位）、`session.ts`（开态 env 注入、同 dispose 通道）、失败指引文案面。
   - **Acceptance:** global / workspace 两档围栏内 `test -r ~/.ssh/id_ed25519`（fixture key）可读、workspace 档对 key 的**写**必败（ro-bind）；关态断言 `SSH_AUTH_SOCK` 在围栏 env 中不存在，开态断言 `--bind` + env 注入 + 与 egress 桥同 dispose，各有单测；passphrase/无 agent 失败信息含「宿主侧 `ssh-add` 或无口令 key」一行；`npm test` 绿。
   - Status: [x] done（两档 key 可读 + workspace 写必败 = 真 bwrap 实测绿（fixture key 生成于 tmpdir、HOME 重定向，不碰真 `~/.ssh`）；关态零注入 / 开态 `--bind` 段内落位 + `SSH_AUTH_SOCK` env + 与桥同 dispose / 缺失 fail-closed 含指引行 = `tests/harness/sandbox/egress-ssh-authsock.test.ts` 5 条单测；`npm run probe:sandbox` 全类别绿）登记（end-of-round review）：**SSH_AUTH_SOCK 开态的宿主侧装配接线 = deferred 后续子弹**（assumption 5 默认关；`EgressSessionOptions.sshAuthSockPath` → `spec.sshAuthSockPath`/env → fence bind 的缝已钉形状，生产入口何时填值另行裁定）。
   - [blocks: T1, T3]

7. **探针扩展 + TUI / 真 push 实测（验收面）** — tag: `[implementation]`
   - **Inherits:** spec T7 新增 2 类探针与 SC1/SC2 判据（「probe 正探针 exit 0」/「沙箱内命令失败 **且** 框架 drain 到 `{host, port:22, reason:"not-in-allowlist"}`，tool_result 呈 `execution_failed` 含 `[network_denied]` 前缀（测试走 bash 真实返回形状，禁直接构造 typed failure——前 spec 假绿纪律）」）；assumption 9 逐字「真实 `git push` e2e 仅对**操作员自有远端 + 非破坏性 ref**……默认 skip、显式环境变量开启」；SC6「`npm run probe:sandbox` 既有全类别 + 新 2 类全绿；`npm test` 全绿（含反转的 `egress-proxy-behavior` / `egress-assembly` / wiring 系列迁移）」；SC8（LSP 零新增错误 + argv 顺序纪律回归）；OQ3（类别数 11→13 的数字表述漂移登记主会话裁，**不碰 `.qoder/rules/`**）。
   - **Surface:** `scripts/sandbox-probe.ts`、TUI pty 实测面（`mcp__aiterm__pty_*`）、`archive/` 真 push e2e（显式 skip 纪律同 `tests-real-llm`）。
   - **Acceptance:** `npm run probe:sandbox` 既有全类别 + 新 2 类全绿——正探针 = 放行 fixture 域 :22 握手到 banner（非 loopback 字面目标，O2）、违例探针 = 未放行域 :22 沙箱内失败且 sink 记 `not-in-allowlist`(port=22)，两信号可区分；TUI 三条操作屏上证据齐（`git push --dry-run` 到认证层 / 未放行域 `[network_denied]` 含 `host:22` / `echo $GIT_SSH_COMMAND` = 子弹 3 钉死形态）；真 push e2e 开启环境 exit 0、默认环境显式 skip + Not run；SOCKS 探针断言仅当子弹 2 在场时纳入；`npm test` 全绿且改动文件 `get_diagnostics_for_file` 零新增错误。
   - Status: [x] done 0107 换装：probe 侧 socat present/absent 两分支已退役，egress 类别改经自带中继真端到端；`npm run probe:sandbox` 三档全绿（正探针 github.com:22 真网拿到 SSH banner、exit 0 零违例；违例探针 gitlab.com:22 沙箱内 exit 1 且 drain 到 `{host:"gitlab.com",port:22}` 域判定拒绝，两信号可区分）；TUI pty 三操作屏上证据齐（push --dry-run 到远端 `To github.com:...` exit 0 / `git ls-remote ssh://git@gitlab.com/...` 呈 `[execution_failed] [network_denied] gitlab.com:22 denied by user for this session`（交互入口含域审批弹窗，拒绝路径）/ `echo $GIT_SSH_COMMAND` = 新冻结形态：node 绝对路径 + `vendor/egress-relay/egress-http-connect.mjs %h %p`、argv 无 token）；真 push e2e 落 `archive/tests-real-llm/egress-real-git-push.test.ts`，默认环境显式 skip（`[SKIP] IKNOW_EGRESS_REAL_PUSH_E2E != 1`），开启环境实测 Not run（见下 OQ3 行）；`npm test` 全量绿。 OQ3 登记（主会话裁）：①类别数 11→13（三档各 +2 类 ssh 探针）；②spec SC2 的 drain reason 文字 `not-in-allowlist` 是 T6 批准流细分前措辞，生产 filter 按入口面细分——非交互面记 `no-approval-inlet`（probe 实测值）、交互面拒绝记 `denied-by-user`（TUI 实测值），同属域判定拒绝家族且与 infra-unavailable 可区分；③真 push e2e 开启态（IKNOW_EGRESS_REAL_PUSH_E2E=1）本轮未跑，仅证默认 skip 纪律，留操作员按需触发。④assumption 4 复验（围栏内 `-F /dev/null` 下 ssh 不报 `Bad owner or permissions`）由 TUI 围栏内 `git push --dry-run` 达远端认证层（`To github.com:...`）间接实证——ssh 配置解析若失败到不了认证层。 `.qoder/rules/` 未触碰。
   - [blocks: T1, T3, T5, T6]
