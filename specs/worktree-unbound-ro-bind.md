# Spec: worktree 门禁 unbound bash 物理 ro-bind（预测拦截翻转为 EROFS 回灌）

> Basis: issue #1059 / ADR-0109。翻转对象 = ADR-0037 Amendment 2026-09-04 的 bash 预测判定核心与 §9.2 写白名单的 unbound 档（已 in-place 标注 superseded）。
>
> 门禁回执、违例回灌文案 **只许英文**（沿用 ADR-0037 Amendment 2026-09-04 文案纪律）。

## Objective

worktree 门禁 ON 且会话 unbound（waveRoot = 主 checkout）时：bash **不再被预测式拦截**——围栏对主 checkout 追加 `--ro-bind`，全部 bash 放行执行；真写主仓（含 `.git`）由文件系统返回 EROFS，以 typed 违例回灌送达模型，文案点名 `create-worktree` 与「建树后重发这一次调用」指引；主 checkout 零写入落盘。`write_file` / `edit_file`（FILE_WRITE 类工具）与 `root_flip`（enter / exit）的拦前门禁不变。bound 与 gate OFF 两档的围栏装配与今日 byte-identical。

## Boundaries

- **Does:**
  - **fence argv**：条件「门禁 ON ∧ waveRoot = 主 checkout」下追加 `--ro-bind <mainCheckout> <mainCheckout>`，置于该根可写 bind **之后**、`--proc` **之前**（bwrap last-mount-wins，继承 ADR-0037 Amendment 2026-09-05 (b) 的后挂纪律）。
  - **session fence tmp pad**：在 `--ro-bind` 之后重绑为 rw；scratch / 临时文件写走 pad，不落主 checkout。
  - **EROFS 违例回灌**：真写命中 EROFS 且非零退出 → `[fs_denied]` 前缀指引经 tool result stderr 回灌（ok-envelope 旁路，不进违例计数），含 `create-worktree` 指引（条件式 + 重发语义，沿用 `unboundMutateNotice` 三段结构）；非零退出但无 EROFS、或零退出 stderr 含字样 → 结果 byte-identical。后台档在 spawn 回执附 `notice` preflight（仅 unbound 态）。
  - **`.git` 文案区分**：回灌目标路径落在主仓 `.git`（gitdir）下时，识别路径线索给出对应指引（先建树、在 task 树提交）；EROFS 语义本身不变。
  - **出路复用既有机器**：`create-worktree` 成功 → 活 `taskRoot` 翻根 → 按 ADR-0037 §7.2 batch 快照，本 run 下一波 tool calls 在新根上重发；不新增第二套改绑路径。
- **Confirms with human:** （无。翻转决策已在 issue #1059 与 ADR-0109 收口。）
- **Out of this spec:** 改 FILE_WRITE / root_flip 拦截形态；改 `validateReadonlyCommand`（仍只服务 `bashMode === "readonly"`）；改 isolation 开关值域 / settings 接线；改 `create-worktree` ACI 形状；非 FS 侧效应（网络出口归 ADR-0107）；补读臂白名单（明确拒绝的路线，不再重提）。

## Success Criteria

1. **unbound 零误触**：门禁 ON 且 unbound 时，trace 误触样本类命令（`cd` 组合、`curl` 允许域、`gh`、`sleep`、`date && ls 2>&1 | head` 等）实际执行并返回正常结果，无门禁回执（vitest + TUI `mcp__aiterm__pty_*` 实测，屏上证据）。
2. **EROFS 回灌含指引且主 checkout 无污染**：unbound bash `echo x > <主仓>/f.txt` 与 `.git` 写（如裸 `git add`）→ EROFS typed 违例回灌，文案含 `create-worktree` 与重发语义（语义 + 子串双断，沿用 SC7 纪律）；`.git` 分支含路径线索文案；执行后主 checkout `git status` 干净、零新文件。
3. **bound / gate OFF byte-identical + probe 全绿**：已改绑 task 树与门禁 OFF 两档的围栏 argv 与翻转前逐字节相等（vitest argv deepEqual）；`npm run probe:sandbox` 全部类别（14 类，11 物理 + 3 violation）绿。
4. **不变项回归**：FILE_WRITE 工具与 root_flip 拦前测仍绿；`validateReadonlyCommand` readonly 模式测仍绿；建树失败主仓零写入（ADR-0037 §6）验收不受影响。

## Inherits / Changes

- Inherits：ADR-0037 model-provision 契约、活 `taskRoot`（§7）、fail-closed 建树（§6）、`unboundMutateNotice` 三段语义；ADR-0109（本 spec 的决策源）。
- Changes：ADR-0037 Amendment 2026-09-04 bash 判定核心、§9.2 写白名单 unbound 档（superseded 注记已落 0037 正文）；`classifyCall` 对 bash 不再是门禁执法面（PreWrite 钩子面语义按 ADR-0109 调整）。
- 作废旧钉：`casual-ask-context-hygiene.md` SC5/SC6 的 bash 半边（原文见 `git show 5ae9889a^:specs/casual-ask-context-hygiene.md`，引用不恢复）。
- Test command: `npm test`；沙箱面另跑 `npm run probe:sandbox`；验收面 TUI（`mcp__aiterm__pty_*`）。
- Surfaces: `src/harness/isolation/`、`src/harness/sandbox/bwrap.ts`（argv 顺序纪律见 `.claude/rules/security-boundaries.md`，改动后必须全类 probe 绿）。
