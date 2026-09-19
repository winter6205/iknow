# Spec: 出口代理缝 —— 域白名单网络边界

**Status:** ready for review (rev 2；桥接实现以 ADR-0107 为准：无宿主 socat)
**Surface:** `src/harness/sandbox/`（bwrap argv、egress 新目录）、`src/harness/aci/tools/bash.ts`、`src/harness/permission/`（删 ask 轴）、`src/harness/background/`、`src/harness/verify/`、`src/config/settings.ts`、`scripts/sandbox-probe.ts`

## Goal

bash 围栏的出口从「二值开关」（默认断网 / `network:true` 全开）改为**唯一通路**：netns 恒定断网 + **出口代理缝** + **域名允许集**判定。模型不再需要 per-call 网络参数；出网资格只由「域名是否在名单」回答，且失败带可行动的违例反馈。

用户故事：操作员希望 agent 能跑 `npm install` / `git clone` 这类构建命令，但**不能**把任意数据发到任意站点。现状是「要么全断要么全开」，没有中间档；且 `STATIC_NETWORK_WHITELIST` 是声明未实施的死码。本 spec 落地中间档并清算死码。

## Boundaries

- **Does:**
  - `--unshare-net` 改**恒定项**（任何路径不摘除），覆盖**全部 3 处 fence 装配点**：前台 `bash.ts:271` / background `manager.ts:275` / verify `sandbox-run.ts:78`（实测：subagent worker 不单独造 fence，走的就是这三条）。
  - 新增 `src/harness/sandbox/egress/`：宿主出口代理（HTTP CONNECT + SOCKS5）+ **桥**（unix socket → 沙箱内本地端口）+ 域匹配器接线 + 地址守卫接线 + **违例记录与回灌**。
  - 新增**域名允许集**判定：CONNECT host 匹配（`*.x` 严格子域不含 apex、可选 `:port`、deny 优先）+ 地址守卫（拒 loopback / 私网 / link-local / metadata）。
  - **首次域名批准流**：交互入口首见新域名 → 走既有 ask 面问一次 → 批准 = 会话级放行 + 可选持久化到用户层 settings；非交互入口（background / verify / 无 ask 面）**无法问 = fail-closed 拒绝**，违例含缺失域名与补配指引。
  - 配置面：用户层 settings 新键（`isolation.network.allowedDomains` / `deniedDomains`），用于**预置**与 CI 场景；项目文件不采纳。
  - **删除面**（完整清单见「Deletion surface」）：bash input 的 `network?: boolean` 字段与其 description；`code-ask-bash-network` 权限规则；`isBashNetworkTrue` SSOT；`wantsHostNetwork` 全部分支；`BackgroundSpawnRequest.network`；`AskUser` ctx 的 `network` 字段；`NETWORK_HINT_MARKER` / `summarizeNetworkBash` / `NETWORK_HINT_TAIL` / `SECRET_WARNING`；probe 的 opt-in 类别。
  - 依赖引入：`@anthropic-ai/sandbox-runtime`（Apache-2.0，pin 精确版）**只取网络半场**；bwrap argv 仍自装配（fsMode / workspace mount / argv 顺序纪律不动）。
- **Confirms with human:**
  - ~~首次批准的持久化粒度（仅会话 vs 可写回用户层）落地形态。~~ **已裁定（2026-09-17）**：批准 = 会话级放行必成；写回用户层 settings 是可选附属动作，写回失败降级为仅会话放行 + 一次性警告，已批准调用照常执行。见 ADR-0097「批准持久化粒度」。
  - ~~代理进程生命周期细节（前台随调用生灭 / background 桥活到任务结束的具体实现缝）。~~ **已裁定（2026-09-17）**：三形态共用「起桥 → 绑 socket → 注入 env → 收尾清理」接口，异常路径与正常路径同一释放通道；background 挂 `settle()`，verify 为模块级单例。见 ADR-0097「代理生命周期 / dispose 契约」。
- **Out of this spec:**
  - `--yolo` 无沙箱模式（另票 #1035；两轴正交，yolo 的豁免面在该票裁定）。
  - 「沙箱内起服务 → 宿主可达」反向通路（旧 `network:true` 的核心用例，netns 恒断下不成立；如需另开独立轴）。
  - 内容级管控 / TLS 终止 / 凭据注入（ADR-0072 的 TUN 路线范围）。
  - `web_fetch` / `web_search` 的 `network-guard` 栈（另一条防线，不受本 spec 影响）。
  - worktree 门禁（`worktreeOnMutate`）——另一根轴，本 spec 不改。

## Settled invariants

1. **唯一通路**：`--unshare-net` 恒在；出网只能经代理缝。不存在第二出口、不存在逃生开关。
2. **判定不看内容**：代理只看 CONNECT host / absolute-URI host，不解密。不得表述为内容级管控。
3. **fail-closed 全覆盖**：未命中允许集、代理/桥进程死、非代理感知程序（raw socket）= 拒绝或断网；绝不静默放行。
4. **删除而非并存**：旧 per-call `network:true` 语义整体移除，不留双轨。
5. **只认用户层配置**：允许集 / 拒绝集只从用户层 settings 读（ADR-0084 纪律），项目文件出现该段即丢弃。
6. **地址守卫正交**：域名命中不豁免地址守卫——解析后落在 loopback / 私网 / link-local / metadata 一律拒。
7. **配置层永不抛**：允许集条目的非法形态不抛异常（对齐 `settings.ts:34-43` 的「非法值丢弃不抛错」纪律），但**必须留痕**——静默丢弃等同于让用户以为边界已生效。丢弃方向恒为**收紧**（不可达），不是放宽。

## Violation feedback channel（ACR error-handling 项收敛）

**实测事实**：`@anthropic-ai/sandbox-runtime` 的代理拒绝文案是**硬编码常量**（`http-proxy.js:10-13` 的 `ALLOWLIST_DENY`，无 options 注入点），403 body 恒为 `Connection blocked by network allowlist` + `X-Proxy-Error: blocked-by-allowlist`。因此「补配指引」**不可能**由代理自带文案承担，必须由本仓发射。

（沙箱内的 `curl` 仍会把该 403 写进自己的 stderr——这是**命令层**的观测，与下述**框架层**的违例回灌是两条独立信息，后者才是模型据以补配的依据。）

**通道（具名，三跳）**：

1. **记录**：本仓传给代理的 `filter(port, host, ...)` 回调是**我们的**代码。它返回 false 时，就地记录结构化违例 `{host, port, reason: "not-in-allowlist" | "address-denied" | "no-approval-inlet", command}`。这是唯一权威的拒绝观测点。
2. **回灌**：bash handler 在调用收尾时 drain 本调用的违例记录，把可行动文本**追加到返回的 `stderr` 字段**（`bash.ts:314-319` 的 `{code, stdout, stderr}` 形状不变）——模型经 tool_result 可见，TUI 经 `meta.stderr` 旁路可见（`bash.ts:320-326`）。
3. **前缀与 tier 入口**：回灌文本以既有 `VIOLATION_PREFIXES.networkDenied`（`[network_denied]`，`prefixes.ts:25`）起头。

**第 3 跳的既有挂点在当前形状下不可达（ACR 实证，本节必须连带改）**：`violation-handling.ts:120-122` 对**非 `execution_failed`** 的结果直接返回 `tier: undefined`，而 bash 沙箱内命令非零退出时 handler 正常 return，结果恒为 `kind: "ok"`（`tools/executor.ts:259-275` 的 `buildOkResult`），exit code 仅作 payload 的 JSON 字段（`bash.ts:316`）。因此 `:139` 的 `networkDenied → mid` 分支在「追加 stderr」形态下**永不命中**。

**选定形态（(a)：转 typed failure）**：域判定拒绝是**边界表态**，不是命令的执行结果——被拒时该次调用**没有真正执行**，语义上就是失败，把它塞进 `ok` 的 stderr 是形状错配。

- bash handler 收尾 drain 到违例记录时，**不**返回 `ok`，改返回 `execution_failed`（typed，message 含完整违例文案）——由此走通既有 tier 门。
- 该失败**仍然执行完毕**（进程已 spawn 并退出），因此文案必须同时交代「命令已跑完但出网被拒」，避免模型误判为进程崩溃。
- **反例（已否决）**：扩展 tier 门去识别 ok-payload 内的违例——那会让「成功的调用」与「被边界拒绝的调用」在观测面上同形，且 `violation-executor.ts:72-75` 只对 failure 取 `message`，需连改三处。

**测试必须走 bash 的真实返回形状**（`{code, stdout, stderr}` 经 handler → executor），不得复用 `violation-handling.test.ts:269-279` 那种直接构造 `kind: "execution_failed"` 的造法——后者对本条是**假绿**。

**三类信号必须互相可区分**（实测证据，见 Evidence pointers）：

| 情形            | 代理侧信号                                  | 归类         |
| --------------- | ------------------------------------------- | ------------ |
| 未命中允许集    | 403 + `X-Proxy-Error: blocked-by-allowlist` | 域判定拒绝   |
| 命中但上游失败  | 502                                         | 上游故障     |
| 代理 / 桥进程死 | 连接层拒绝（ECONNREFUSED / 桥亡）           | 基础设施故障 |
| 非代理感知程序  | 无路由（ENETUNREACH）                       | 无出网资格   |

违例文案对「未命中」必须含：被拒域名、当前允许集来源（会话级 / 已持久化 / 预置配置）、补配指引（配置键名 + 交互入口的批准提示）。对「基础设施故障」不得表述为「域名被拒」——两者修复动作完全不同。

## Failure paths（ACR error-handling 项要求的具名路径）

| 路径                                | 行为                                                                                                           | 留痕                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 宿主无 `socat`（实测未 vendored）   | **启动探测**：桥装配前检查可执行；缺失 → 网络能力 fail-closed 拒绝，不静默降级为「无网」                       | typed 错误 + 补装指引（包名 + 本机实测路径） |
| 沙箱内无 socat / 桥装配失败         | 代理不可达 → 全部出网调用失败（fail-closed），**不**回落直连                                                   | 归类为基础设施故障，附装配失败原因           |
| stale unix socket（代理重启）       | socket 路径带 per-session 随机 id + 启动前清理；残留 socket 的连接拒绝归类为基础设施故障，不得误报为域判定拒绝 | 启动时清理动作 + 连接失败归因                |
| 批准后写回用户层 settings 失败      | **降级为仅会话放行**；已批准的调用**必须照常执行**，不得因持久化失败而失败                                     | 一次性警告（说明本次放行不持久）             |
| 批准流 pending 期间同域名第二次请求 | **等待**（合并为一次询问的结果），不重复问、不立即拒                                                           | 合并计数入诊断                               |
| 非交互入口首见新域名                | 直接拒绝（无 ask 面可问）                                                                                      | 违例含缺失域名 + 建议的配置键                |

## Input-contract classes (public surfaces)

| Surface                  | empty                        | invalid/negative                                                                                                                 | overflow                                      | concurrent                                    | exception                            |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| 允许集条目（配置层）     | 空数组 → 全拒（fail-closed） | 非字符串 / trim 空 / allowed 中出现裸 `*` → **丢弃该条目 + 警告**（不抛）                                                        | 条目数上限实现定，超出 → 丢弃超出部分 + 警告  | N/A                                           | 不抛（对齐 settings 纪律），但恒留痕 |
| 允许集 pattern（语义层） | N/A                          | `:port` 越界（0 / >65535 / 非数字 / 空）→ **拒绝该条目 + 可行动诊断**（不得透传给匹配器静默退化为永不匹配）；通配位置非法 → 同左 | N/A                                           | N/A                                           | 不抛；诊断经警告面上报               |
| 首次域名批准             | N/A                          | 拒绝 → 该域名本会话不再问                                                                                                        | N/A                                           | 同域名并发首见 → 合并为一次询问（后到者等待） | ask 面不可用（非交互）→ 直接拒       |
| 代理请求                 | N/A                          | 未命中名单 → 403 + 违例回灌；**畸形 CONNECT**（空行 / 超长行 / 非 CONNECT method / 缺 authority）→ 拒绝，不得静默放行或崩溃      | 超长请求行 → 拒绝（实测代理已 403/400，不崩） | 并发请求共享代理进程                          | 代理死 → 连接失败（fail-closed）     |
| bash input               | N/A                          | 旧 `network` 字段传入 → 未知字段（`additionalProperties: false` 已钉，`bash.ts:352`）                                            | N/A                                           | N/A                                           | N/A                                  |

## Success criteria

- **SC1**: `--unshare-net` 在全部 3 处 fence 装配点（前台 / background / verify）恒在——探针断言逐条覆盖，含旧 `network:true` 路径不复存在。
- **SC2**: 命中允许集的域名经代理可达（探针：`curl` 经代理拿到 HTTP 响应）。
- **SC3**: 未命中域名被拒，且模型可见违例含被拒域名、允许集来源与补配指引（**经 Violation feedback channel 的三跳通道**，以 `execution_failed` 形态落在 tool_result 的 message，非静默）；测试走 bash 真实返回形状（handler → executor），不得直接构造 `execution_failed` 造绿。
- **SC4**: 地址守卫：允许集域名解析到私网/loopback → 拒（DNS rebinding 防线）。
- **SC5**: 代理/桥进程被杀 → 后续出网调用失败（fail-closed），不出现直连回落；且**归类为基础设施故障**，不与域判定拒绝混淆（有测试断言两类信号可区分）。
- **SC6**: 非代理感知程序（如 raw socket）在沙箱内无路由——探针断言。
- **SC7**: `STATIC_NETWORK_WHITELIST` / `NetworkPolicy.assertDomain` / `createNetworkPolicy` 死码移除或升级为真匹配器，无「声明未实施」残留；`VIOLATION_PREFIXES.networkDenied` 保留并接线到真拒绝路径。
- **SC8**: 删除面全仓无残留（grep 断言，清单见「Deletion surface」），含 ACR 点名的四处耦合点。
- **SC9**: 项目层 settings 写 `isolation.network` → 丢弃（不生效），有测试钉住。
- **SC10**: 首次域名批准流：交互入口新域名触发一次 ask，批准后本会话内不再问；pending 期间同域名并发请求合并为一次询问；非交互入口直接 fail-closed（各有测试）。
- **SC11**: 既有 sandbox probe 全部类别保持全绿（§security-boundaries 纪律：新增 fence flag 必跑 `npm run probe:sandbox`）。
- **SC12**: 配置层契约：空允许集全拒、`*` 被丢弃、`:65536` 被拒绝且**不**透传为静默永不匹配、非法条目丢弃有留痕——逐条有测试。
- **SC13**: 宿主缺 `socat` 时网络能力 fail-closed 且给出补装指引（有测试，用注入的探测结果断言，不依赖 CI 是否装了 socat）。

## Deletion surface（ACR minimal-change 项收敛：grep 实证清单）

**生产代码（逐点，全部需清空；共 17 个文件）**：

| 文件                                            | 位置                                                                                         | 对象                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/harness/aci/tools/bash.ts`                 | `:43`/`:45`、`:213-222`、`:261-278`、`:343-350`、`:368-375`、`:411-413`                      | `network` 字段 + schema 项 + description + `wantsHostNetwork` 全部分支                                                |
| `src/harness/permission/policy.ts`              | `:36`/`:40`、`:64`、`:109`                                                                   | `isBashNetworkTrue` SSOT + `code-ask-bash-network` 规则                                                               |
| `src/harness/permission/permission-executor.ts` | `:29`、`:331-342`、`:497-547`                                                                | `isNetworkBash` / hint 分支 / `NETWORK_HINT_MARKER` / `summarizeNetworkBash` / `NETWORK_HINT_TAIL` / `SECRET_WARNING` |
| `src/harness/permission/types.ts`               | `:117-124`                                                                                   | `AskUser` ctx 的 `network?: boolean`                                                                                  |
| `src/harness/permission/declarative.ts`         | `:419-441`                                                                                   | `network:` specifier 家族（`buildBashMatcher` 分支）                                                                  |
| `src/harness/background/manager.ts`             | `:34`、`:130-133`、`:265`、`:278-285`                                                        | `BackgroundSpawnRequest.network` + `createNetworkPolicy()` + fence opt                                                |
| `src/harness/verify/sandbox-run.ts`             | `:16`、`:69`                                                                                 | `createNetworkPolicy()`                                                                                               |
| `src/harness/sandbox/index.ts`                  | `:17`                                                                                        | `createNetworkPolicy` 导出                                                                                            |
| `src/harness/sandbox/bwrap.ts`                  | `:154`（`network` 参数）、`:160-162`、`:196`、`:220-224`                                     | 条件 `--unshare-net` + `void opts.networkPolicy`                                                                      |
| `src/harness/permission/ask-user.ts`            | `:136-138`、`:200`                                                                           | `PendingAskView.network` 字段 + 透传                                                                                  |
| `src/tui/ask-user.ts`                           | `:20`、`:22`、`:86`                                                                          | TUI 侧 ask 视图的 `network` 字段与透传                                                                                |
| `src/tui/app.tsx`                               | `:3573`、`:3629`                                                                             | `[宿主网络]` 标记渲染 + 透传                                                                                          |
| `src/tui/modal.tsx`                             | `:65-67`、`:77`、`:79`、`:141`                                                               | **第二处** `[宿主网络]` 渲染点（`:79`）+ 三处 `network` 字段声明                                                      |
| `web/src/api/client.ts`                         | `:312`、`:314`                                                                               | `PendingAskView.network` 的 web 侧类型与透传                                                                          |
| `web/src/components/PermissionDialog.tsx`       | `:52`、`:63`、`:65`                                                                          | web 侧 `host network` 标记渲染（`aria-label` 亦需改）                                                                 |
| `scripts/sandbox-probe.ts`                      | `:58`、`:76`、`:127`、`:134`、`:137`、`:162`、`:169`、`:172`、`:489`、`:494`、`:503`、`:518` | `NETWORK_POLICY` 常量 + `network` 形参 + 两个 opt-in 探针类别                                                         |
| `scripts/sandbox-probe-subagent.ts`             | `:16-19`、`:228`、`:488`                                                                     | 探针说明文案中的 `network:true` 选参（围栏姿态本身不变，改文案与 marker 即可）                                        |

**注意**：`VIOLATION_PREFIXES.networkDenied`（`prefixes.ts:25`）**不删**——升级为真拒绝路径的发射前缀（见 Violation feedback channel）。

**测试迁移清单（直接钉住被删轴，需改写而非删除；共 20 个文件）**：

| 测试文件                                                | network 引用数 | 处置                                                                                                             |
| ------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tests/harness/permission/policy.test.ts`               | 34             | `isBashNetworkTrue` + `code-ask-bash-network` 断言移除（`:17`/`:403-429`）                                       |
| `tests/harness/permission/bash-network-ask.test.ts`     | 29             | 重写为新批准流（首见域名 ask / 会话放行 / 非交互 fail-closed）                                                   |
| `tests/harness/aci/bash-fence-parity.test.ts`           | 29             | 改为断言「`--unshare-net` 恒在」的前后台集合相等                                                                 |
| `tests/harness/permission/project-settings.test.ts`     | 24             | `isolation.network` 项目层丢弃断言                                                                               |
| `tests/harness/aci/bash-service-loop.e2e.test.ts`       | 15             | e2e 前提依赖 `network:true`（`:5`/`:13-14`）→ 改建为经代理可达                                                   |
| `tests/harness/aci/bash-sandbox.test.ts`                | 13             | `networkOptIn` suite（`:386+`）专断「摘除 `--unshare-net`」→ 反转                                                |
| `tests/harness/aci/permission.test.ts`                  | 12             | 移除 network 轴，保留其余                                                                                        |
| `tests/harness/permission/declarative-rules.test.ts`    | 11             | `network:` specifier 规则移除断言                                                                                |
| `tests/harness/permission/ask-user.test.ts`             | 8              | `network` 字段断言移除（`:243-262`）                                                                             |
| `tests/harness/sandbox/bwrap.test.ts`                   | 7              | `--unshare-net` 恒在断言                                                                                         |
| `tests/tui/ask-modal.test.tsx`                          | 6              | 移除 `network` 标记字段                                                                                          |
| `tests/harness/aci/tools/bash.test.ts`                  | 4              | 移除 `network` 入参相关断言                                                                                      |
| `tests/harness/aci/bash-main-session-fence-tmp.test.ts` | 2              | 移除 `createNetworkPolicy` 引用（`:25`/`:80`）                                                                   |
| `tests/harness/sandbox/bwrap-rebind.test.ts`            | 2              | 移除 `createNetworkPolicy` import 与 `networkPolicy` 构造（`:14`/`:44`）                                         |
| `tests/harness/sandbox/fs-mode-workspace.test.ts`       | 3              | 移除 `createNetworkPolicy`（`:44`/`:102`/`:314`）                                                                |
| `tests/harness/sandbox/fs-policy-boundary.test.ts`      | 4              | 移除 `createNetworkPolicy`（`:8`/`:53`/`:148`/`:172`）                                                           |
| `tests/harness/verify/sandbox-run.test.ts`              | 2              | 移除 `createNetworkPolicy`（`:34`/`:180`）                                                                       |
| `tests/harness/sandbox/network-policy.test.ts`          | 2              | 被测模块整件将删（`:24`）→ 删除该测试文件或改为新匹配器测试                                                      |
| `tests/harness/sandbox/violation-handling.test.ts`      | —              | `networkDenied` 前缀升级后的 tier 断言；**且须走 bash 真实返回形状**（见 Violation feedback channel 的假绿警告） |
| `tests/harness/sandbox/secrets-no-leak.test.ts`         | 2              | 移除 `createNetworkPolicy`（`:9`/`:66`）；secret 面断言保留                                                      |

**CI 排除说明**：`bash-service-loop.e2e.test.ts` 与 `bash-sandbox.test.ts` 在 `vitest.ci-excludes.ts:43,46` 内（CI 不跑），但语义照样要迁移——不得因 CI 不跑而跳过改写。

**`createNetworkPolicy` 编译连锁**（grep 实证）：`tests/` 共 **10 个文件** import 它（bwrap / fence-parity / bash-sandbox / fence-tmp / bwrap-rebind / fs-mode-workspace / fs-policy-boundary / sandbox-run.test / network-policy / secrets-no-leak）——T8 删除 `network-policy.ts` 时这些文件**编译失败**，全部在上表内；迁移时一并摘除该 import 与 `networkPolicy:` 传参（`createBwrapFence` 不再收该字段）。

**全仓命中面（复裁 grep 复验）**：`src/` 16 文件 + `web/` 2 文件 + `scripts/` 2 文件 = 生产面 17 文件（表列齐）；`tests/` 23 文件命中，其中 20 个需迁移（表列齐），其余为无害的通用词命中（如 `tests/tui/modal.test.tsx` 零引用）。

## Dependency fork（ACR minimal-change 项：spike 已闭环）

**实测结论（2026-09-16，包 `@anthropic-ai/sandbox-runtime@0.0.76`）**：

- **纯逻辑件可独立导入**（无 node_modules 时即成功）：`domain-pattern.js`、`address.js`、`resolved-address-guard.js`、`parent-proxy.js`。四者只依赖 `node:*` 与彼此。
- **代理服务器件需完整依赖安装后可导入**：`http-proxy.js`（缺 `node-forge` 即 `ERR_MODULE_NOT_FOUND`）、`socks-proxy.js`（缺 `@pondwader/socks5-server`）。
- **`http-proxy.js` 无条件拉入 `node-forge`**（复裁实证，修正先前误判）：`http-proxy.js:8` 静态 import `CRL_PATH` ← `mitm-ca.js:10` 顶层 `import forge from 'node-forge'`。**「MITM 是惰性路径」只在运行时成立**（不传 `mitmCA` 即不终止 TLS），**在模块加载图上不成立**——node-forge 是硬依赖。这不改变「不做内容检查」的语义，但依赖面比预想大：node-forge 随包引入，无法裁掉。
- **包无 `exports` 字段**——深路径导入可用但**无契约稳定性**。
- **`socat` 是宿主前置依赖，未 vendored**（包内 `vendor/` 只有 seccomp / srt-win / java-proxy-agent）。

**裁定**：

- 复用其**匹配器与地址守卫**（`domain-pattern` / `resolved-address-guard` / `address`），**不复刻**——但经**单一适配层**收口（`src/harness/sandbox/egress/upstream.ts` 或同址单文件），版本升级只改该文件，不外溢。
- 代理 server 亦复用（`http-proxy` / `socks-proxy`），拒绝文案不回改（由本仓 `filter` 侧记录承担，见 Violation feedback channel）。
- **`socat` 缺失**按 Failure paths 处理（探测 + fail-closed + 指引），不在本 spec 引入 socat 分发（供应链成本另议）。
- **地址守卫只有一份实现**：复用 sandbox-runtime 的 `resolved-address-guard`，**不**在 `network-guard` 栈旁再写第二份私网判定（`docs/CONTEXT.md` 声明两栈互不替代，但 private-IP 判定漂移是真实风险）。
- **私网拒绝必须显式 opt-in**（复裁实证，否则 SC4 落空）：复用件的 `DENIED_CLASSES`（`resolved-address-guard.js:52-65`）**故意不含 RFC 1918 / ULA / CGNAT**，注释明写「allow-listing an intranet hostname is legitimate, so those are opt-in via `network.deniedResolvedAddresses`」（`:131` 即该入口）。本 spec 的地址守卫语义要求**拒私网**，因此**适配层必须传入 `deniedResolvedAddresses`**（值域 = RFC 1918 + ULA + CGNAT + 既有的 link-local / loopback / metadata）。这不是可选项，是 SC4 的落地前提；T3 验收须包含该注入。
- **文件承载纪律**：桥生命周期与新配置键解析各入独立文件；`background/manager.ts`（已 836 行）与 `config/settings.ts`（已 1639 行）只加接线点，不加实现体。

## Ownership / dispose contract（ACR 非阻断观察：spec 阶段先钉形状）

代理实例三形态，plan 必须落成显式接口（不留给实现即兴）：

| 形态            | 生命周期               | 释放时机               |
| --------------- | ---------------------- | ---------------------- |
| 前台 bash 调用  | per-call               | 调用收尾（含异常路径） |
| background 任务 | per-task，活到任务结束 | 任务终止 / 会话结束    |
| verify          | 随宿主进程，可复用     | 进程退出               |

三形态共用同一「起桥 → 绑定 socket → 注入环境变量 → 收尾清理」接口；**异常路径必须释放**（泄漏的 socat 进程会成为下一次调用的 stale socket 来源）。

## Open Questions

- background 任务的桥生命周期收口细节（代理进程随任务存活，任务结束如何收口）——`Confirms with human` 已列，plan 阶段定形。
- 批准流的 ask 文案与既有 `PendingAskView` 三视图（hub / TUI / web）如何整合。
- `socat` 是否最终改为随包分发（本 spec 按「宿主前置依赖」处理）。

## Inherits / Changes

- **继承**：`src/harness/sandbox/bwrap.ts` 的 argv 顺序纪律（`.claude/rules/security-boundaries.md`「Sandbox argv」：系统 ro-bind → 用户 bind → `--size`/`--tmpfs` → cwd 重绑 → `--proc`/`--dev-bind` → `--chdir` → `--`）；`fence-tmp` 装配；`network-guard` 六层防线（`web_fetch`/`web_search` 用，不改）；`VIOLATION_PREFIXES` + `categorizeResult` mid-tier 升级挂点（`violation-handling.ts:139`）；`PendingAskView` 追问面（三视图）；`settings.ts` 的「非法值丢弃不抛错」纪律（`:34-43`）。
- **变更**：ADR-0022 → `superseded by 0097`；ADR-0072 补记 amended；ADR-0097（`proposed`，本 rev 补 socat 前置 / 硬编码拒绝文案 / 深路径导入三项实测事实）；`docs/CONTEXT.md` 三条词条已落。
- **依赖**：`@anthropic-ai/sandbox-runtime`（Apache-2.0，pin 精确版；其 zod ^3 与项目 zod ^4 嵌套共存，不动项目 zod；lockfile 变更在 commit 正文留引入依据）。

## Evidence pointers

- 代理拒绝文案硬编码：`@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js:10-13`（`ALLOWLIST_DENY`）、`:236-239`、`:458`。
- 三类信号实测（2026-09-16 spike）：未命中 → `403 + X-Proxy-Error: blocked-by-allowlist`；命中但上游死 → `502`；畸形 → `400`；空行 → 连接关闭；超长行（8 KB host）→ 403 不崩。
- 域匹配语义实测：`*.example.com` 匹配 `api.example.com` / `a.b.example.com`，**不**匹配 apex；`evilexample.com` / `example.com.evil.com` 不匹配（后缀锚定正确）；大小写不敏感；尾部点**不**归一。
- 端口解析实测：`:0` / `:65536` / `:99999` / `:abc` / `:` / `:-1` **不抛错**，原样成为永不匹配的 hostname pattern（→ 本 spec 要求配置层拒绝，不透传）。
- socat 前置：`linux-sandbox-utils.js:437-438`（`socat not installed`）、`:472`（`initializeLinuxNetworkBridge`）；本机 `which socat` = 无；包 `vendor/` 无 socat。
- 死码锚点：`src/harness/sandbox/network-policy.ts:4`、`bwrap.ts:220-224`（`void opts.networkPolicy`）、`src/harness/sandbox/network-policy.ts:30`（`createNetworkPolicy`，零生产 caller）。
- 回灌形状：`src/harness/aci/tools/bash.ts:314-326`（`{code,stdout,stderr}` + `meta` 旁路）；tier 挂点：`src/harness/sandbox/violation-handling.ts:139`。
- 项目层丢弃纪律：`src/config/settings.ts:34-43`、`:1124-1145`（`parseIsolation`）。
