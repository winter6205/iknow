# 0021. background task lifecycle：iknow 进程单锚 + registry 落盘 + 启动 stale 清扫

Date: 2026-08-18
Status: accepted

> **Amendment 2026-09-13**（ADR-0088）：落盘命名空间锚从 `workspaceRoot` 改为 **home 项目树**。D1.3 路径 = `<dataDir 或 ~/.iknow>/projects/<slug>/tasks/<task_id>.{json,log}`，slug 键 = `projectIdentityRoot`。`--workspace-root` 不再隔开 task 登记。进程物理锚、conversation 可见性锚、stale 清扫、task_id 格式不变。登记表仍**不**进会话文件夹叶子。

## Context

bash 工具要支持「起长驻服务 → 验证 → 停」闭环，需要 background 执行（spawn 后立即返回 task_id）、日志回读（bash_output）、终止句柄（bash_stop）三件能力。关键前提：**iknow 尚无 conversation 拆除事件** —— 对 `removeSession` / `deleteSession` / `closeSession` 的 src 全域检索零命中（2026-08-18 实测），只有 `registerShutdown`（`src/cli/runtime.ts:172-218`）在进程退出时走唯一一层收尾。因此生命周期锚点只能在现有事件面内选取。resolution 见 #491（grilling，D1-D6）；本篇按 #491 决议方向定稿未被锁定的细项（task_id 格式），并给出三条件论证。

## Decision

background task 的生命周期由三个锚各司一段，其中**物理锚 = iknow 进程**：

- **conversation = 可见性 + 操作权锚**：conversationId 仅作记账字段与 bash_output / bash_stop 的入参过滤（`task_not_in_scope` 拒绝跨 conversation 读/停的范围，见 T5），**不参与 kill 锚点** —— 没有 conversation 拆除事件可挂（检索零命中），不为不存在的消费者发明机制。
- **iknow 进程 = 物理边界锚**：退出前 reap 全部 running child + bwrap `--die-with-parent` 兜底宿主被强杀（SIGKILL）场景。
- **home 项目树 = 落盘命名空间锚**（ADR-0088；原文 workspace root **superseded**）：registry 落在 `<dataDir 或 ~/.iknow>/projects/<slug>/tasks/`，与会话记录同一 slug。`--workspace-root` 互不可见 **不再**适用于 tasks。

关键子决策：

- **D1.1 退出前 reap（mirror subagent SC12）**：`registerShutdown`（`src/cli/runtime.ts:172-218`）→ manager.shutdown() 复刻 `src/harness/subagent/manager.ts:479` shutdown 链：清 timer / killFallback → abort in-flight → SIGTERM 全部 running child → ≤5s 等退出（`SHUTDOWN_SIGKILL_GRACE_MS = 5000`）→ SIGKILL 兜底。
- **D1.2 保留 bwrap `--die-with-parent`**：内核在父进程死亡时无条件投递死亡信号，含宿主被 SIGKILL 的场景——它与 background（detached 进程组、独立生命周期）不是冲突方，而是防泄漏的正确语义。后台 task 必须能横跨 sandbox runner 的返回而存活，同时必须随 iknow 进程死亡而终止，两层由不同机制承担。
- **D1.3 registry 双层**：内存 Map（child/pgid/status 活句柄，仅进程内有效）+ 落盘 `<dataDir 或 ~/.iknow>/projects/<slug>/tasks/<task_id>.{json,log}`（ADR-0088）。json 记 owner_pid + conversationId。路径派生与会话池同一 `(baseDir, projectIdentityRoot)` 公式，不再 mirror memory 的 workspace-root 先例。
- **D1.4 conversationId 纯记账**：不参与 kill 锚点；可见性 scope（bash_output / bash_stop 按 conversationId 过滤）是独立轴，由 T5 落地，本 ADR 只声明三锚分工终版（见 decision 首段）。
- **D1.5 启动 stale 清扫**：启动扫 tasks/，只对 owner_pid 已死的记录动手（owner 活着 = 另一 iknow 进程的活 task，跳过）：杀进程组 + 标 dead + 日志卫生。无文件锁——单写者（每 iknow 进程只写自己的 task 文件）+ 幂等清扫（`/proc/<pid>/stat` 的 starttime 与 registry 记录比对，不一致只标 dead 不动手——pgid 已被内核回收复用而误杀它是不可接受故障）。
- **D1.6 治理值定稿（引 #491 D6，此处即 SSOT）**：并发上限 **8**；达到上限时以正面措辞拒绝（说明现状 + 可用动作，不用负面禁令）；日志读取只回尾部防 context 爆：默认 **12KB**、上限 **100KB**（bash_output 的 max_bytes 参数语义）。
- **D1.7 task_id 格式定稿（#491 未定稿，本篇定稿）**：`bg-` 前缀 + 12 位随机 hex（`crypto.randomBytes(6).toString("hex")`，等价 randomUUID）。理由：短前缀便于日志 / ask hint 辨认；12 hex = 48 bit 熵碰撞概率可忽略；不自增、不泄露递增计数；文件名安全（无路径分隔符/点问题）、检索友好、与 bash_stop / bash_output 入参一一对应。
- **D1.8 bash_stop 句柄语义**：host 侧 `kill(-pgid)`，SIGTERM → 2s → SIGKILL（复用 `src/harness/sandbox/runner.ts:121-129` stopTree 模式）；不给模型裸 pid——沙箱内 pid namespace 与宿主不同，task_id 是唯一干净句柄。
- **D1.9 Out of scope（入 fog / 单独跟踪）**：conversation lifecycle v2（createdAt/archivedAt schema、archive、session events、busy/idle、SSE 接缝）——单独 grilling issue 跟踪，实施票 T6 仅预留 `onConversationDeleted(conversationId)` 订阅缝；服务完成通知机制（模型用 bash_output 轮询，先观察）；egress 侧 secret 审计。

## 三条件论证

- **hard-to-reverse**：registry 落盘形状 + task_id 对外契约（bash_output / bash_stop 入参）一旦有真实 task 即难迁移——换格式要动存量 `<task_id>.json/log` 与模型侧工具调用；生命周期锚选择决定孤儿进程的清理语义，事后换锚要么漏清泄漏孤儿，要么误杀别人进程。
- **surprising-without-context**：三个「新手必踩」点——为何不做 conversation 拆除 reap（没有拆除事件可挂，不发明无消费者的机制，答案在一个检索之内）；为何保留 `--die-with-parent`（看起来与长驻服务冲突，实为防泄漏的正确语义，后台独立性由 detached 进程组承担）；为何 stale 清扫只动 owner 已死记录（多 iknow 进程共存时误杀他人活 task 是不可接受的事故）。
- **real-trade-off**：生命周期锚三选——「三锚分治（conversation = 可见性 / iknow 进程 = 物理边界 / workspace root = 命名空间）」vs 单锚 conversation（无事件可挂，直接否决）vs 完全落盘自治（脱离进程边界则无法在宿主存活时保证干净退出前清理）；有文件锁 vs 单写者 + 幂等清扫（锁引入跨进程耦合与死锁面，幂等清扫以 starttime 比对换取等价安全）；starttime 校验 vs 信任 pgid（信任 pgid 在 PID 回收复用场景下会杀错进程）。

## Consequences

- bash 工具出现第三形态：`background: true` 的 task 不再被 sandbox runner 的 tier timer 收割，存活语义移交给 manager + bwrap `--die-with-parent` 两层。
- iknow 进程必须保证退出路径完整：`registerShutdown` 是唯一出口，serve / chat 的既有 shutdown 链不变，manager.shutdown 以镜像方式接入。
- 多个 iknow 进程共享同一 `projects/<slug>/tasks/` 时互不干扰：各写各的文件，清扫只动 owner 已死记录。
- 治理数值（并发 8 / 日志 12KB 默认 100KB 上限 / task_id 格式）自此固定在 ADR，实施与 CLI 文档一律引用本篇，不写死于计划。
- 由 T2（manager + registry 落盘 + 状态机）→ T3（bash background e2e）→ T4（bash_output / bash_stop + 装配）→ T5（conversation scope + 并发上限）→ T6（退出 reap + 启动清扫 + onConversationDeleted 接缝）共 5 commits 提供实施证据，各 commit 单逻辑任务。

## Evidence

- #491 grilling resolution（D1-D6 + post-close 修订 comment）；architecture-change-reviewer PASS（2026-08-18，5/5 yes，记录于 bash-service-loop plan）。
- 前提断言（conversation 拆除事件检索零命中、registerShutdown / shutdown / stopTree / fs-policy 各锚点的源码位置）2026-08-18 对当前 HEAD 实测确认。
- ACR 5 维 PASS（bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier）。
