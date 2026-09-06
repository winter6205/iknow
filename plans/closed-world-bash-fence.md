# Plan: 闭世界 bash 围栏（deny-by-default 反转）+ sandbox server 化

**Goal:** bash 围栏默认姿态从「writable home 打底 + 黑名单补罩」反转为「闭世界（home 下非白名单不可见）+ 白名单放行读写」，并把 sandbox 执行面整理成独立 server，供后续调用方统一消费。

**Approach:** 先用探针把「删掉 writable home bind 后哪些合法场景断链」实测出来（T1，闭世界读面的证据源），再反转 fs-policy 双轴 + bwrap argv（T2–T3），迁移消费方（T4），#891 T2 的 identity overlay 降级为读白名单成员并清理旧黑名单形态（T5），探针扩类别验收（T6）。

**两轮结构（ACR minimal-change-verifier discharge）：** 本计划承载两条独立轨，各自独立收尾、不混 commit——

- **Round 1 = 围栏反转**（T1–T6）：本轮主线，per-bullet loop + 一轮 code review phase。
- **Round 2 = sandbox server 化**（T7–T8）：独立轨。现状为 in-process `runInSandbox` 库（被 bash tool / background manager / verify 直接消费），非 server 形态；server 化先 [decision] 定合同（T7）再实施（T8）。Round 1 合入后再开 Round 2（避免和 T2–T6 抢同一段 argv 代码），届时独立过 ACR + code review phase。

**Spec link:** 本计划无独立 spec；决策锚 = ADR-0037 reopen amendment（T2 产出）。调研来源不写入任何文件（操作员指示：以本轮讨论事实为准，web 调研结论不落盘）。

**ACR:**

```
bounded-context-guardian: unclear — plan keeps module boundaries but does not name how the new FsPolicy shape drops [1]=home positional semantics that bwrap.ts indexes at 4 sites (bwrap.ts:71/96-97/143/160) or how installRoot/toolchain paths get threaded (zero sandbox-layer references today)
defensive-contract-validator: unclear — 39 existing fsPolicy test sites will need rewrites (path shape changes) and plan adds probe categories but does not enumerate per-boundary (empty/negative/overflow/concurrent/exception) coverage for the reversed fence or for the installRoot/PATH exposure
error-handling-enforcer: no — ADR-0037 §1 OFF=byte-identical contract is broken without naming typed fail-loud paths for new white-list misses (installRoot outside $HOME, ~/.nvm binaries unreachable, PATH rebuild), and no EXIT clause is documented
complexity-anti-drift: yes — single fsPolicy factory + per-call rebuild in bash.ts:187 preserved; no god-function/file introduced, identity-overlay seam stays additive
minimal-change-verifier: no — 7 files (4 src + 1 probe + 1 ADR reopen + 1 verify) plus an explicitly forward-pointed "subsequent independent track" for fence server extraction is ≥2 logical tasks, not 1 commit
```

OVERALL: BLOCKED。Discharge 映射（本轮 plan 修订）：

| 维度                         | 意见                                                           | discharge                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bounded-context-guardian     | `[1]=home` 位置合同 4 处消费点未点名；installRoot/工具链零接线 | T3 验收 (a) 显式列出 4 处消费点改造（`pathForHome` / `bindArgs` / `baseArgs` tmp 索引 / homeRebind），installRoot 经 `resolveSessionRoots` 已有根角色接线（不是新状态），线程路径写入 T3 验收   |
| defensive-contract-validator | 39 处 fsPolicy 测试点改写 + 新探针缺 5 类边界覆盖              | T4 验收 (c) 明确 fsPolicy 测试改写按「不变式等价或更强」执行；T6 验收补 5 类边界（empty/negative/overflow/concurrent/exception，走 defensive-contract-validator skill）对白名单 miss 路径的覆盖 |
| error-handling-enforcer      | 白名单 miss 无 typed fail-loud 路径、无 EXIT 条款              | T2 验收 (d) 新增：白名单 miss 的 typed fail-loud 分型 + EXIT 条款写入 amendment                                                                                                                 |
| minimal-change-verifier      | ≥2 逻辑任务                                                    | 计划拆两轮：Round 1 = 围栏反转（T1–T6），Round 2 = sandbox server 化（T7–T8，独立轨独立收尾）；两轮各自过 per-bullet loop + 各自的 code review phase，不混 commit                               |

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 背景与病灶（本轮讨论事实，不引外部调研）

- 现状围栏 argv：`--bind tmp tmp` → `--bind home home`（**可写**打底）→ 敏感路径 tmpfs 罩 →（改绑后）identity ro-bind 后挂补罩 → cwd bind。
- 病灶三件：
  1. 其它 project / home 下任意路径在围栏内**可写**（黑名单永远枚举不完）；
  2. 持久执行配置（`~/.bashrc` / 全局 git config / `~/.ssh` 等）无物理保护，只有 `overlaySensitivePaths` 一层 tmpfs 罩 6 条固定路径；
  3. `~/.iknow/init.sh` 是被执行的持久文件，围栏内可写它 = 跨会话持久代码执行（#896 的核心疑虑）。
- 反转原则：**deny-by-default**——home 下非白名单**不可见**（闭世界，不是「可见但只读」）；可写集 = taskRoot + /tmp；其余按需 ro-bind 进读白名单。
- 闭世界的直接后果：#891 T2 的 identity overlay（waveRoot≠identityRoot 时后挂 `--ro-bind` 补罩）在闭世界下**失效为无操作**——home 不可写后没有「writable 祖先罩住主仓」的病灶可堵；主仓读通道改为读白名单成员。T5 负责清理。
- harness 层写（memory_save / settings 写回 / trust / recents / state.json）不经 bash 围栏，闭世界不触及；#896 的「memory_save 兼容面」因此不构成白名单项。
- `pathForHome` 位置合同：`fsPolicy.allowedPaths()` 按 index 取 `[1]=home` `[2]=tmp`——双轴改造必须显式处理（T2 验收项）。
- OFF 档不再承诺 argv byte-identical：反转是全档位语义变更，ADR-0037 需 reopen amendment 承接（T2 产出）；「默认 OFF 保证零回归」的 Positive 条目同步失效。

## Tasks (ordered by dependency)

1. **T1 探针盘点：闭世界断链实测** — tag: `[implementation]`
   - **Inherits:** none — 开放给实施者；本 bullet 产出是 T2 的读白名单证据源。
   - **Surface:** `scripts/sandbox-probe.ts`（新分支/新脚本形态由实施者定；现有 11 类探针框架复用）。
   - **Acceptance:** 存在一个可复跑的探针脚本/模式，在「无 writable home bind」的围栏形态下逐条列出哪些合法场景断链（预期断链候选：`~/.nvm`/node 二进制链、git 全局 config 读取、npm/pip 缓存、`~/.iknow` 读取、`~/.claude` 等），每条断链有名字、命令、退出码证据；输出可被人工裁决进读/写白名单。现有 11 类探针在**当前** argv 下保持全绿（本 bullet 不改围栏）。
   - Status: [ ] pending

2. **T2 [decision] 白名单集合裁决 + ADR-0037 reopen amendment** — tag: `[decision]`
   - **Inherits:** ADR-0037 §1「OFF=byte-identical」与本改动冲突——worth reopening because 反转是全档位语义变更，闭世界对 OFF 档同样生效（否则其它 project 在 OFF 档仍可写，病灶 1 未闭合）。§4 amendment 2026-09-05 的 identity ro-bind 条款同步失效。
   - **Surface:** `docs/adr/0037-worktree-isolation-on-mutate.md`（amendment）；白名单集合裁决写进 amendment，不另立文件。
   - **Acceptance:** amendment 明确四件事：(a) 全档位 deny-by-default 反转 + 闭世界读面语义；(b) 读/写白名单集合（依据 T1 证据逐条列名 + 为何在场）；(c) #891 T2 identity overlay 条款标 superseded 并写明理由（闭世界下无 writable 祖先可堵）；(d) 白名单 miss 的 typed fail-loud 分型 + EXIT 条款——白名单根空白/盘上不存在 = 配置故障（对齐 #891 T2 (c) fail-loud 纪律），工具链断链（如 installRoot 在 home 外、`~/.nvm` 二进制不可达、PATH 重建失败）= 运行时可观察错误（spawn 失败冒泡，不静默降级），amendment 写明每型的错误面与退出行为。amendment 独立 commit，不与代码混合。
   - Status: [ ] pending
   - [blocks: T1]

3. **T3 fs-policy 双轴 + bwrap argv 反转** — tag: `[implementation]`
   - **Inherits:** 本计划「背景与病灶」节的白名单原则（deny-by-default、可写集 = taskRoot+tmp、闭世界）；ADR-0037 amendment（T2）的白名单集合。
   - **Surface:** `src/harness/sandbox/fs-policy.ts`、`src/harness/sandbox/bwrap.ts`。
   - **Acceptance:** (a) fs-policy 呈读写双轴（writeRoots/readRoots），home 退出 bind roots；**位置合同 4 处消费点全部显式改造**（ACR bounded-context-guardian 点名）：`pathForHome`（bwrap.ts:71）、`bindArgs` 内 home/tmp 索引（bwrap.ts:96-97）、`baseArgs` tmp 索引（bwrap.ts:143）、homeRebind 推导（bwrap.ts:160）——按 index 取根改为按角色取根，installRoot 经 `resolveSessionRoots` 既有根角色接线（复用第四角色，不新增状态源），工具链路径线程路径（fsPolicy opts → bwrap 选项）写进实施，不借位置巧合；(b) argv 形态 = 系统 ro-bind → 读白名单 ro-bind → 写白名单 bind → tmpfs → cwd 重绑 → proc/dev，writable home 打底 token 消失；(c) fail-loud 纪律保持：白名单根空白/盘上不存在（合同输入）→ typed error 不 spawn；可选主机前缀（如 /opt）继续存在性跳过；(d) SENSITIVE_PATHS tmpfs 罩在闭世界下自动失效为无操作（不可见即无操作），保留或删除由实施者依测试最小化裁决。
   - Status: [ ] pending
   - [blocks: T2]

4. **T4 消费方迁移（bash 前台/后台 + verify）** — tag: `[implementation]`
   - **Inherits:** ADR-0037 §7.2 batch 快照语义（waveRoot 波次冻结）；#891 T2 (e)「前台与后台消费同一 fence token」。
   - **Surface:** `src/harness/aci/tools/bash.ts`（前台 + defaultBackgroundSpawn 后台路径）、`verify/sandbox-run.ts`。
   - **Acceptance:** (a) 三处调用面改喂新双轴 policy，前台/后台同一波仍消费同一份 token；(b) `projectIdentityRoot` 选项在闭世界下退化为读白名单成员——waveRoot≠identityRoot 的条件分支删除，identity 根恒进读白名单；(c) 既有 fsPolicy 测试点（约 39 处，含 `tests/harness/sandbox/bwrap.test.ts:320-368` 的位置断言）按 test.md 过时测试规则改写——认证的不变式仍在则更新断言（等价或更强），不机械保留位置断言；(d) npm test 全量绿。
   - Status: [ ] pending
   - [blocks: T3]

5. **T5 #891 T2 旧形态清理** — tag: `[implementation]`
   - **Inherits:** 本计划「背景与病灶」第 4 条（overlay 失效为无操作）。
   - **Surface:** `src/harness/sandbox/bwrap.ts`（identityOverlay/postTmpfsRebinds 的 cover-then-reclaim 排序合同）、`src/harness/aci/tools/bash.ts`（identityOverlay token 透传）。
   - **Acceptance:** identity ro-bind 的「后挂覆盖 writable home」排序合同与 identityOverlay 条件透传代码删除；读白名单成员形态保留；相关测试改写认证「identity 根进读白名单」而非「ro-bind 覆盖 writable 祖先」，断言不变式等价或更强。
   - Status: [ ] pending
   - [blocks: T4]

6. **T6 探针扩类别验收** — tag: `[implementation]`
   - **Inherits:** ADR-0037 amendment（T2）的白名单集合（探针断言与之对齐）。
   - **Surface:** `scripts/sandbox-probe.ts`。
   - **Acceptance:** 新增类别全绿：home 拒写、home 非白名单不可见、其它 project 不可写、`~/.iknow` 不可写（#896 闭合探针）、installRoot 可读可执行、taskRoot 可写；T1 裁决进白名单的每条读路径有对应探针；OFF 档与改绑档各跑一遍全绿；对白名单 miss 路径补 5 类边界覆盖（empty=空白名单根 / negative=路径越界 / overflow=超长路径 / concurrent=并发 fence 构造 / exception=typed fail-loud 冒泡），走 `arthurpower:defensive-contract-validator` 出报告。
   - Status: [ ] pending
   - [blocks: T2]（与 T3–T5 可 [parallel]，但验收须在 T5 后重跑）

7. **T7 [decision] sandbox server 化合同** — tag: `[decision]`
   - **Inherits:** ADR-0022 的 fence/网络合同边界（server 化只挪执行面位置，不改 fence 物理语义）；本计划「背景与病灶」——现状为 in-process `runInSandbox` 库，被 bash tool / background manager / verify 直接消费。
   - **Surface:** 决策落点 = ADR（新开或并入 ADR-0037 amendment，由实施者依 T2 amendment 体积裁决）；消费方 = `aci/tools/bash.ts`、`background/manager.ts`、`verify/`。
   - **Acceptance:** 决策记录明确：(a) server 形态选型（同进程 Unix socket 单例 / 独立 daemon / MCP 面——三种里裁决一种并写理由）；(b) 运行时合同 = fence 请求/回执的消息形状、超时/中断（signal）语义、输出截断合同沿用 `DEFAULT_MAX_OUTPUT_CODE_POINTS`；(c) 现有消费方迁移路径与兼容期策略；(d) `violation-handling`（应用层观察者）在 server 形态下的归属；(e)【Round 2 ACR discharge】fence 请求协议分两型——**短生命周期 request/response**（前台 + verify，进程结束即关闭句柄）+ **长生命周期 task-handle**（后台，spawn → log-stream channel → stop control message，pid 所有权随 task-handle 从 host 转移到 server，`bash_stop` 经 server 转发 `kill(-pgid)`，host 不再持 pid）；(f)【Round 2 ACR discharge】IPC 边界 5 类故障路径——empty（空消息帧 / 无 command）→ typed fail-loud 不 spawn；negative（`maxOutputCodePoints <= 0`、`killGraceMs < 0`）→ `RangeError` 沿 `runner.ts` `truncateByCodePoint` 契约不丢失；overflow（输出未截断送回 client）→ 沿 `DEFAULT_MAX_OUTPUT_CODE_POINTS`；concurrent（server 多请求并行 vs 串行）→ fence 无共享 mutable state 故并行允许，决策显式记录；exception（server-down mid-spawn / accept 后子进程退出未回执）→ typed fail-loud + orphan 进程组 reap 纪律；(g)【Round 2 ACR discharge】失败合同——server 不可达 = typed fail-loud，**不静默降级**到 in-process spawn（否则违反 ADR-0037 §9 围栏物理合同统一）；`ctx.signal` abort = 走 server 端 control message 取消（不只丢 client promise，避免 orphan 进程）。
   - Status: [x] done（T7 `c077a782`） — ADR-0045 落定同进程 router + 两型协议 + 5 类故障分型 + fail-loud 不降级；T7 acceptance (a)–(g) 逐条自查清单写入 ADR 尾部 Evidence 段
   - [parallel]（与 T3–T6 无共享 mutable state，可并行起草）

8. **T8 sandbox server 实施** — tag: `[implementation]`
   - **Inherits:** T7 决策（形态/消息形状/超时/截断合同，含 (e)–(g) discharge 条款）。
   - **Surface:** `src/harness/sandbox/`（runner/bwrap 消费面）；消费方迁移 = `aci/tools/bash.ts`、`background/manager.ts`、`verify/`。
   - **Acceptance:** (a) fence 构造 + spawn 执行面经 server 边界表达，bash tool / background / verify 全部经 server 请求 fence 执行，`runInSandbox` in-process 直调路径删除或降级为 server 内部实现；(b) 超时/中断/截断行为与今日 observable 等价（现有 runner 测试语义保留或等价改写）；(c) violation 观察面按 T7 裁决落位；(d) npm test 全量绿 + probe:sandbox 全绿（server 形态下探针复跑）；(e)【Round 2 ACR discharge】T7 (e)–(g) 的合同条款各有对应测试：两型协议各自的 happy path + 5 类故障路径 + fail-loud（server 不可达不降级）+ signal abort 经 control message 的 server 端取消。
   - Status: [ ] pending
   - [blocks: T5, T7]

### Round 2 ACR verdict（2026-09-06，开轨评审）

```
bounded-context-guardian: yes — sandbox/ 单向依赖保持，server 边界留在 sandbox/ 内；后台 fire-and-forget 生命周期缺口经 T7 (e) task-handle 协议分型 discharge
defensive-contract-validator: yes — 5 类边界缺口经 T7 (f) IPC 故障分型 + T8 (e) 配套测试 discharge
error-handling-enforcer: yes — 失败合同缺口经 T7 (g) fail-loud / control-message 取消 / pid 所有权转移条款 discharge
complexity-anti-drift: yes — 分层保持；若 daemon 分支胜出须拆 server/supervisor/protocol，不进单文件
minimal-change-verifier: yes — T7、T8 各 1 逻辑任务各 1 commit，独立于 Round 1
```

OVERALL: PASS（discharge 已落 T7 (e)–(g) / T8 (e)，ACR BLOCKED→PASS）。

## 验收（Round 1 整轮）

- `npm run probe:sandbox` 全绿（11 旧类 + T6 新类，OFF 档 + 改绑档）。
- `npm test` 全量绿。
- 真实 TUI 走查（mcp aiterm pty）：worktree ON → mutate 拦截 → 建树改绑 → bash 写进树 → bash 写主仓拒 → exit 回主仓。
- #896 关闭判据：围栏内 `~/.iknow` 不可写（T6 探针固化）。

Round 2（T7–T8）验收在开轨时按 T7 决策另立，不占本轮 EXIT。

## 待写入（persist 清单）

- ADR-0037 amendment（T2 bullet 产出本身，走 domain-modeling 落盘时按其流程）。
- `docs/CONTEXT.md` 候选新词：**闭世界围栏（closed-world fence）**——「home 下非白名单不可见；可写集 = taskRoot + tmp」的围栏语义术语。若 T2 裁决后术语稳定，进 persist 清单。
- sandbox server 化若新开 ADR，编号与域词由 T7 裁决后补入本清单。

## 收尾

- Round 1（T1–T6）全部落地后跑一轮 code review phase（实施环境选 code-review skill），再 `verification-before-completion`。
- Round 2（T7–T8）开轨时独立过 architecture-change-reviewer，收尾同构。
