# 0022. bash network opt-in：per-call `network: true` 去掉 `--unshare-net`，permission 强制 ask 且 full_auto 不豁免

Date: 2026-08-18

Status: accepted

## Context

iknow 的 Bash 工具默认在 bwrap 沙箱内运行，`baseArgs` 硬编码 `--unshare-net`（`src/harness/sandbox/bwrap.ts:98`）——沙箱内进程完全隔离于宿主网络。这使得「起本地服务 → 宿主机/浏览器/测试 client 验证」闭环做不了：服务在沙箱内 bind 成功，对外不可达（#491 调查事实 2）。另一方面，`network-policy.ts:4` 的 `STATIC_NETWORK_WHITELIST` 与 `assertDomain` 校验在 fence 层本就未执行（`bwrap.ts:156` 直接 `void opts.networkPolicy`）——「域名过滤」在当前实现里是死代码，没有内核级抓手可让它在 bwrap 层真正起效。

需求信号（#491 question 2）是要**单次服务验证**的网络可见性，不是永久性的网络开放。三个候选答案：默认隔离 + 显式 per-call 放行、settings 级网络白名单、白名单端口映射。本 ADR 选第一种，并把 permission 面、ask 提示、诚实声明边界一并锁定。

## Decision

引入 `network?: boolean` 作为 bash 工具 input schema 的 per-call 可选项（默认 `false`），命中后只放开沙箱网络这一个批准轴，其余 fence 一条不动。六个子决策：

### 1. per-call opt-in：`network: true` 去掉 `--unshare-net`，其余 fence 全保留

bash tool input schema 增加 `network?: boolean`（默认 `false`）。当 `network === true` 时，bwrap argv 分支：去掉 `src/harness/sandbox/bwrap.ts:98` 的 `--unshare-net`；**其余 fence 全部保留**——`--unshare-user-try` / `--die-with-parent` / 系统 `--ro-bind`（/usr /bin /lib /lib64 /etc）/ fs-policy bind / `--size` / `--tmpfs /tmp` / env `--clearenv` + `--setenv` / `--chdir` / 10 条 fence 顺序纪律（`.claude/rules/security-boundaries.md`「Sandbox argv」段）原样不动。默认路径（无 `network` 参数）argv 逐字节不变，既有 `--unshare-net` 断言零回归。诚实声明语义：`network: true` = **整条 bash 调用放行宿主网络**，不做调用内细粒度控制（端口 / 域名 / 协议不分流）。

### 2. permission 强制 ask，full_auto 不豁免

照 `policy.ts:56-65`（`code-allow-todo-write-list`）input-aware code 层规则先例，新增一条规则：`network === true` → `decision: ask`。实现自然性论证：`checkPermission` 的 layered rules（第 2 步，`policy.ts:145-146`）在 mode 解析（第 3 步，`policy.ts:152` `opts.mode?.get()`）**之前**逐条命中即 return —— `network === true` 的规则一旦命中就直接返回 `ask`，mode 解析永远执行不到，`full_auto` 分支（`policy.ts:155`）对这条调用不可能放行。「fence 形状变化」与「动作批准」是不同批准轴：动作在什么环境里执行，是在批准动作之前就该由人类确认的元决策——hard-walls 先于 mode 的既有优先级（任何模式都不可 override）为此设计提供先例。风险即双侧扩大：不 ask 则一次 network 授权等于把「环境信任」和「动作信任」合并，用户在非交互入口可能无感知地放行了一整条出站命令。

### 3. ask hint 带「请求宿主网络」+ 命令摘要 + secret 警告

ask 视图的 summaryHint（`src/harness/permission/ask-user.ts:116` `PendingAskView`）增加网络语义字段或文案：必带「请求宿主网络」标注 + 命令摘要；当待执行命令含 `<<<SECRET_N>>>` 占位符（#406 roundtrip 占位符化产物）时，追加 secret 警告——真值会在 spawn 前回填（bash 还原层），因此出站数据可能携带真值；回读 mask 只盖「host → sandbox 回路」的显示，不盖 sandbox → network 的 egress。三个同构展示面同步加字段：`src/session-api/hub.ts:496`（`listPendingAsks` 暴露给 serve/SPA）→ web `src/api/client.ts`、`src/tui/ask-user.ts`。

### 4. 不做白名单端口映射 / 域名过滤（诚实声明，入 fog）

- **白名单端口映射不采用**：bwrap 无端口映射原语，要映射必须引入 userspace proxy（新进程管理面，超出沙箱能力）——与 #491 D4「照 bwrap 原语范围内实现」约束冲突。
- **域名过滤不做**：`STATIC_NETWORK_WHITELIST` 在 fence 层本就未执行（`bwrap.ts:156` void 掉），域名过滤无内核级抓手，做出来也只是「看起来存在」的装饰，违背诚实声明原则。
- **project-settings 网络谓词不做**：`settings.json` 里配 `network` 相关 open 谓词同样入 fog——需求信号是单次服务验证，settings 级白名单是过度设计且无执行抓手（#491 D4）。

因此 `network: true` 的语义就是 **整调用放行宿主网络**，不假装存在比这更细的控制。

### 5. egress 审计 fog 边界

`network: true` + 命令含 secret 时，secret 真值可随命令出站，且 sandbox → network 方向没有 egress 侧审计。本 ADR 只承诺 ask 时的 secret 警告（决策 3），**不做 egress 侧审计**——入 map #440 Not yet specified，等有需求信号再议。

### 6. Out of scope

- `bash_stop` / `bash_output` / background detach 基建——属 Track A（#502，票 A）的 T2-T7，本 ADR 是 Track B（#503，票 B）的前置文档，两轨正交并行。
- `STATIC_NETWORK_WHITELIST` 复活——维持现状（fence 层不执行），不因本 ADR 顺手把它接上或删掉。

## Consequences

### Positive

- 闭环能力打通：`network: true` 的 service 可在沙箱内 bind，宿主机 / 浏览器 / 测试 client 真实可达——「起服务 → 验证 → 停」e2e（T11）由此可测。
- 默认安全面零变化：不传 `network` 的调用 argv 逐字节不变，既有 `--unshare-net` 断言与 probe 保持绿。
- 批准轴显式分离：环境信任（fence 形状）永远由人类确认一次，不随模式（含 full_auto）整体放行；动作是否批准仍走既有 mode/rule 管线。
- 诚实声明消除了假细粒度：不部署根本不执行的域名过滤，避免「界面安全、实际裸奔」的错觉。

### Negative / Trade-offs

- `network: true` = 整调用放行，粒度粗——受信任进程可在沙箱内直连任何宿主网络资源；这是「bwrap 原语能力 vs userspace proxy 复杂度」权衡下选粗粒度（#491 D4）。
- 强制 ask 在非交互入口（ask / serve）会新增一次人类确认往返——对需网络的调用这是有意的 friction，避免静默放行。
- 网络安全边界成为对外 schema 契约 + permission 规则落点，后续收紧/放宽都牵动用户与模型行为锚定（见 Reversibility）。

### Concrete Quiddity

- `src/harness/sandbox/bwrap.ts`：`baseArgs` 增加 network 分支，`network: true` 时跳过 `--unshare-net` 这一项，argv 其余顺序不变（10 条 fence 顺序纪律保持为单一权威顺序）。
- `src/harness/permission/policy.ts`：code 层新增 `code-ask-network-opt-in` 规则（`network === true` → ask），mirror `code-allow-todo-write-list`（`policy.ts:56-65`）的 input-aware 匹配模式。
- `src/harness/permission/ask-user.ts:116` `PendingAskView`：加网络语义字段；`src/session-api/hub.ts:496` → web `src/api/client.ts`、`src/tui/ask-user.ts` 三处同步展示。
- `scripts/sandbox-probe.ts`：新增 host-net 类别——`network: true` 分支内 `curl` / 端口 connect 可达、默认分支不可达，与既有 6 + 2 类别并列。
- secret 警告触发条件：命令串含 `<<<SECRET_N>>>` 占位符（#406 roundtrip 形态）；不读 secret 真值进视图，只标警告。

### Reversibility

**Hard to reverse**（满足 ADR 三条件）。逐条论证：

- **Hard to reverse**：`tool input → fence 形状`是全新批准轴——一旦 `network` 参数成为对外 schema 契约、permission 规则与 `PendingAskView` 字段依赖它、probe 断言锚定它，撤回需同时还原 schema / policy 规则 / ask view / probe 四类落点；沙箱网络边界的收紧或放宽是安全承诺，用户与模型行为都会锚定这个边界，不能当普通 feature flag 随手摘除。
- **Surprising without context**：三条易误读点都需要 ADR 显式钉死——① 为什么 full_auto 不豁免：fence 形状轴 ≠ 动作批准轴，规则命中先于 mode 解析，full_auto 分支永远到不了；② 为什么不做域名过滤：内核层无抓手、fence 层本就不执行，做出来是装饰；③ 为什么其余 fence 一条不松：网络不是信任升级，只放开一个轴，别的轴维持原约束。无 ADR 则实施者会试图「顺便」放宽容许（env 白名单、`--unshare-user-try`）或给 full_auto 豁免。
- **Real trade-off**：三个真实取舍点——per-call opt-in vs settings 级白名单（需求信号是单次服务验证，白名单是过度设计且无执行抓手，选 per-call）；强制 ask vs allow + warning（fence 形状变化值得一次显式人类确认，warning 在非交互入口不可见，选强制 ask）；kernel netns 开关 vs userspace proxy（bwrap 原语内可一行实现，proxy 引入新进程管理面与生命周期，选前者）。

## Evidence

- #491 Resolution D4（grilling 锁定，2026-08-18）：「默认隔离 + per-call `network: true` opt-in」「照 `policy.ts:56-65` input-aware 先例强制 ask，full_auto 下不豁免」「白名单端口映射不采用」。
- 事实锚点：`src/harness/sandbox/bwrap.ts:98`（`--unshare-net` 硬编码）、`bwrap.ts:156`（`void opts.networkPolicy`）、`src/harness/sandbox/network-policy.ts:4`（`STATIC_NETWORK_WHITELIST`）、`src/harness/permission/policy.ts:56-65`（input-aware 先例）、`policy.ts:145-146`（layered rules 先于 mode 返回）、`policy.ts:152/155`（mode 解析 / full_auto 分支）、`src/harness/permission/ask-user.ts:116`（`PendingAskView`）。
- 实施证据由 T9（bwrap argv 分支 + probe 新类别）→ T10（policy 规则 + ask hint + 三视图字段 + policy 测试）→ T11（起服务 → 验证 → 停 e2e 闭环）共 3 commits 提供，各 commit 单逻辑任务。
