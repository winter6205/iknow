# 0109. worktree 门禁 bash 拦截：从预测式分类翻转为物理 ro-bind 保证

Date: 2026-09-19
Status: accepted

## Context

ADR-0037 门禁在「gate ON 且未绑 task worktree」档位对 bash 做**预测式拦截**：`classifyCall` 自行裁决「会不会写工作区」，`>` 重定向 / `rm` / **未知命令一律 fail-closed 判 mutate**（Amendment 2026-09-04 锁定的语义）。deny-by-default 的预测表在结构上误触只读命令：trace 实测 23 个会话出现 `cd` 组合 15 次、`curl` 10 次、`gh` 4 次、`sleep` 3 次等只读命令被判 mutate 遭拦。补全读臂白名单是打地鼠——命令语言面无穷，预测分类永远枚举不完，而每一次误触都把「模型正常干活」变成「门禁回执 + 模型绕行」的上下文污染。

门禁要认证的真实不变式是「**写不落主 checkout**」，不是「命令被预测为读」。bwrap 的 last-mount-wins 挂载序（ADR-0037 Amendment 2026-09-05 (b) 已确立「后挂覆盖先挂」纪律）允许把这个不变式直接做成物理保证：主 checkout 在围栏内以 `--ro-bind` 存在，真写自然 EROFS。

## Decision

**unbound 会话的 bash 写保护从「预测拦截」翻转为「物理 ro-bind + 事后 EROFS 违例回灌」。推翻 ADR-0037 中针对 bash 的预测拦截条款（Amendment 2026-09-04 的判定核心、§9.2 写白名单的 unbound 形态），门禁其余语义（model-provision、活 taskRoot、fail-closed 建树、不 auto-provision）不变。**

锁死子决策：

1. **适用条件** = 门禁 ON ∧ 本波 waveRoot 为主 checkout（unbound）。bound（已改绑 task 树）与 gate OFF 两档的围栏装配与今日 **byte-identical**。
2. **fence argv**：满足条件 1 时追加 `--ro-bind <mainCheckout> <mainCheckout>`，置于该根可写 bind **之后**、`--proc` **之前**——bwrap last-mount-wins，只读覆盖可写。session fence tmp pad 在其**后**再重绑为 rw（pad 可落主 checkout 子树，须被 ro-bind 罩住后再翻回可写），scratch 写走 pad。
3. **执行姿态**：unbound bash **一律放行执行**，门禁不再按预测分类拦任何 bash 命令；唯一的 fail-closed 例外 = **非字符串 / 空白命令**（意图不可解析，维持拦前 mutate 判定）。真写主 checkout → 文件系统返回 **EROFS** → **非零退出 ∧ stderr 命中 EROFS** 时以 `[fs_denied]` 违例前缀回灌送达模型（走既有 ok-envelope stderr 旁路——F4 ssh-hostkey 先例，不进违例计数），文案点名 `create-worktree` 与重发指引（沿用 `unboundMutateNotice` 的条件式 + 「重发这一次调用」语义）。后台档 stderr 不上回执，改在 **spawn 回执 preflight notice** 预披露同一事实（仅 unbound 态在场；bound / gate OFF 回执形状 byte-identical）。
4. **`.git` 写**：对主 checkout `.git`（gitdir）的写同样 EROFS、同样回灌——语义正确（未绑树不该写主仓 gitdir），但**文案区分**：识别路径线索（目标在 `.git` 下）时给出对应指引（先建树再在 task 树提交），不与普通文件写共用一条含糊文案。
5. **不变项**：`write_file` / `edit_file`（FILE_WRITE 类工具）与 `root_flip`（enter/exit）的拦截**维持预测式不变**——它们是结构化调用、分类零歧义，不存在打地鼠问题。
6. **EROFS 后的出路** = 既有重绑机器：模型调 `create-worktree` 成功 → 活 `taskRoot` 翻到新根 → 按 ADR-0037 §7.2 batch 快照语义，本 run 下一波 tool calls 在主 checkout 之外的新根上重发被 EROFS 的写。不新增任何第二套改绑路径。

**裁定点明示**（实施与后续翻案时的锚）：

- `.git` EROFS 语义正确但文案区分（子决策 4）；
- scratch 写走 session fence tmp pad 而非主 checkout（子决策 2）；
- EROFS → `create-worktree` → 既有重绑机器复用，不另立机制（子决策 6）。

**ADR 关系：** ADR-0037 Amendment 2026-09-04 的 bash「会不会写工作区」自备判定与未知命令 fail-closed 拦截条款、§9.2 写白名单在 unbound 档的物理形态，**superseded by 本 ADR**（in-place 注记于 0037）。`validateReadonlyCommand` 仍只服务 `bashMode === "readonly"`，与本决策无涉（该半句存续）。PreWrite 用户钩子事件仍复用 `classifyCall`，但 `classifyCall` 对 bash 不再是门禁的执法面。

## Why not

- **短期批量补读臂（扩白名单救预测表）**：打地鼠。trace 已证明误触面由「命令语言 ∩ 未知命令 fail-closed」结构性生成，补不完；每轮补表还引入「哪些算读」的二次裁决债。拒。
- **保留预测拦截、仅放宽未知命令为放行**：把 fail-closed 换成 fail-open，真写的首次拦截靠运气，主 checkout 写保护出现洞。拒。
- **FILE_WRITE 工具也改事后回灌**：结构化工具的调用面就是完整意图，预测分类零误触，事后化只损失「不执行即不写」的更强保证。维持拦前。

## Consequences

- 「未知命令 fail-closed 拦截」条款**对 bash 作废**：门禁的 bash 执法从拦前移到事后——命令确实执行，但 mount 面保证主 checkout 零写入落盘；非 FS 侧效应（网络、进程）本就不在 worktree 门禁管辖内，不受本翻转影响。旧 spec `casual-ask-context-hygiene.md`（已于 `5ae9889a` 退役）钉住的 bash 半边验收约束随之作废。
- unbound 会话误触面归零：`cd` / `curl` / `gh` / `sleep` 类只读命令不再收到门禁回执。
- 真写的反馈时点从「调用前」变为「执行中 EROFS」，模型看到的错误从门禁文案变为文件系统违例回灌（含同等指引）。
- 写保护的正确性锚点从分类表移到 argv 组装：`--ro-bind` 的位置（rw bind 后、`--proc` 前）与 pad 重绑序成为必须实测的合同（`npm run probe:sandbox` + TUI）。
- bound / gate OFF 档 byte-identical 承诺给出回归底线：翻转只在 unbound 一档引入差异。

## Evidence pointers

- trace 实测 23 会话误触样本（cd 15 / curl 10 / gh 4 / sleep 3 等）。
- 旧钉作废对象：`5ae9889a` 退役的旧 spec 验收条款（引用不作恢复）。
- ADR-0037 Amendment 2026-09-04、Amendment 2026-09-05 (b)（后挂覆盖纪律）、§9.2（写白名单）。
- spec `specs/worktree-unbound-ro-bind.md`（验收三条：unbound 零误触 / EROFS 回灌含指引且主 checkout 无污染 / bound byte-identical + probe 全绿）。
