# Plan: 围栏 /tmp 垫底与父按 id 读取

**Goal:** 每个身份的围栏 `/tmp` 落在会话文件夹垫底上且活过单次命令；父交差能看见 `task_id` 与 `/tmp` 根，并能按 id 列/读该垫底。
**Approach:** 先钉垫底分配与 bind（主会话再 worker），再让写工具与 `$TMPDIR` 走同一块盘，然后交差字段与 `subagent_result` 读取，最后新 worker 目录与文案。不改闭世界读白名单。
**Spec link:** `specs/parent-visible-tmp.md`
**ACR:** all-yes（见下）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch
**待写入:** （空 — CONTEXT / ADR-0074 / ADR-0068 amendment 已在本 worktree 写出）

## ACR

```
bounded-context-guardian: yes — 仍在 harness 围栏、写工具、子代理信封与会话文件夹；不新开 bounded context，不把垫底当模型交付仓
defensive-contract-validator: yes — Success Criteria 含写解析与按 id 读两类五边界表
error-handling-enforcer: yes — 未知 id / 路径逃逸 / 垫底不可写均为 typed 非空失败；禁止静默丢写
complexity-anti-drift: yes — 垫底分配、信封字段、按 id 读取分缝；不把 bind / 信封 / 读垫底揉成一个函数
minimal-change-verifier: yes — 一项能力；实施按本 plan 一 tracer 一 commit，不与读根外 issue 混交
```

## Tasks (ordered by dependency)

1. **主会话垫底 bind 成围栏 `/tmp`** — tag: `[implementation]`
   - **Inherits:** spec SC1 / SC9；ADR-0074：主会话一块宿主目录，寿命跟会话文件夹；`$TMPDIR` / `mktemp` 落同一块
   - **Surface:** harness 沙箱 / bash 围栏装配
   - **Acceptance:** 同一主会话两次 bash，第一次写 `/tmp/x`，第二次读到同一内容；`echo $TMPDIR` 落在该垫底（或其子路径）
   - Status: [ ] pending

2. **写工具可写当前身份 `/tmp`** — tag: `[implementation]`
   - **Inherits:** spec SC2；可写集 = `taskRoot` + 当前身份 `/tmp`；不写到系统 `/tmp`；不自动拷进 `taskRoot`
   - **Surface:** ACI 写路径解析（`write_file` / `edit_file`）
   - **Acceptance:** `write_file` `/tmp/y` 成功且只出现在主会话垫底；相对 `taskRoot` 的写行为不回退
   - [blocks: T1]

3. **worker 垫底与主会话隔离** — tag: `[implementation]`
   - **Inherits:** spec SC3 / SC7；每 worker 一块；新布局 `subagents/<taskId>/` 含垫底；旧平铺 jsonl 不迁
   - **Surface:** 子代理 spawn / worker 围栏 / 会话文件夹 `subagents/`
   - **Acceptance:** worker 写入的 `/tmp/z` 父 bash 读不到；该 `taskId` 目录下有垫底；旧 `agent-*.jsonl` 仍能被现有列表/查询找到
   - [blocks: T1]

4. **交差带 `task_id` 与 `/tmp` 根** — tag: `[implementation]`
   - **Inherits:** spec SC4；前景 tool_result 与后景 drain 同一套；成功默认无产物名单
   - **Surface:** 子代理信封投影 / spawn 回执
   - **Acceptance:** 成败信封均含非空 `task_id` 与该 worker `/tmp` 根；成功路径名单缺席或空
   - [blocks: T3]

5. **按 `task_id` 列顶层或读一份** — tag: `[implementation]`
   - **Inherits:** spec SC3 / SC6 / S2-B；未知 id 与路径逃逸 typed 拒绝；截断同 `read_file`
   - **Surface:** 已有 `subagent_result` 工具
   - **Acceptance:** 只传 id → 顶层名字含 worker 写下的文件；再传相对路径 → 读到内容；`..` 逃逸拒绝
   - [blocks: T3, T4]

6. **空交差可附短名单** — tag: `[implementation]`
   - **Inherits:** spec SC5；不灌正文
   - **Surface:** 子代理信封 / host 终态投影
   - **Acceptance:** 空摘要且空 result（或 crash/timeout/截断）的终态含顶层短名单，无文件正文
   - [blocks: T4]

7. **新 worker 的 stderr 进同一 `taskId` 目录** — tag: `[implementation]`
   - **Inherits:** spec SC7；旧 `stderr/<taskId>.log` 仍可读
   - **Surface:** 子代理 crash 取证落盘
   - **Acceptance:** 新 spawn 的 stderr 在 `subagents/<taskId>/` 内；指针指向新位置
   - [blocks: T3]

8. **工具描述与写根段** — tag: `[implementation]`
   - **Inherits:** spec Boundaries 告知两句；ADR-0069 写根段不提 `/tmp`
   - **Surface:** bash / 写工具 description；写处境文案
   - **Acceptance:** bash 与写工具描述含「进项目写 taskRoot / 不必进仓写 `/tmp`」；写根段仍只说交付根
   - [blocks: T2]
