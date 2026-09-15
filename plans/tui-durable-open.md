# Plan: TUI durable open

**Goal:** A real TTY can start TUI after a failed assemble, isolation ON still allows read-only bash on the main checkout, and a session cannot hang the host on unbounded `find /`.
**Approach:** First lock the four incident invariants (typed catch, renderer after assemble, isolation read vs mutate, hard-wall for root `find`). Then ship start-path visibility, isolation classification, hard-wall, cancel process-group, and OpenTUI teardown drain as separate demoable slices. Stay on pinned `@opentui/core` 0.5.1 — bump is out of scope (spec 321 Ask first).
**Spec link:** archived `docs/archive/025-retire-completed-specs-and-plans/specs/321-tui-opentui-migration.md` Error Paths E1/E2 + Success Criterion 11; ADR-0037 (isolation ON = read on main, mutate blocked until rebind); ADR-0068 / CONTEXT **hard-wall**; `.claude/rules/code-quality.md` typed-error catch. Incident evidence 2026-09-14: conversation `fa040526-64f7-4b60-8462-c1be74a518ff` (`find /` cancelled after ~232s); aiterm PTY `TUI 渲染后端初始化失败：[object Object]`.
**ACR:** all-yes (block below)
**待写入:** (empty — reuse hard-wall, worktree isolation mode, `provider_api_key_missing` / `isLlmProviderConfigError`)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## ACR

bounded-context-guardian: yes — hard-wall stays in permission; bash workspace-write classification stays in isolation; TUI start/teardown stays in tui; chat already formats LLM provider typed errors and TUI reuses that helper rather than importing session-api.
input-contract-tests: yes — empty bash command; invalid/root `find` path; overflow-style unbounded walk; concurrent cancel of an in-flight bash; exception = plain-object provider miss on TUI start.
error-handling-enforcer: yes — E1/E2 keep the existing prefix and exit 1; cause is `formatLlmProviderConfigError` or equivalent typed kind, never `String(plain object)`; hard-wall and isolation blocks stay typed and non-empty; fail-closed classify-mutate and deny-find carry `// EXIT:` on the reject branch.
complexity-anti-drift: yes — extend existing classify / hard-wall / `runTui` catch; one abstraction level (classify segment vs wall vs format vs teardown); no god-file intent and no planned OpenTUI vendor fork.
minimal-change-verifier: yes — one task (durable TUI open + no unbounded find hang); no OpenTUI version bump, no isolation default flip, no `/model` persist drive-by.

## Tasks (ordered by dependency)

1. **Record the four incident invariants** — tag: `[decision]`
   - **Inherits:** spec 321 Ask first = do not bump `@opentui/*` without an operator ask; ADR-0037 isolation ON still allows read on the main checkout; ADR-0068 hard-wall is the un-overrideable intent filter; code-quality typed-error catch forbids `String(err)` on plain objects; bash `timeoutTier: build` (300s) is not the control for `find /`.
   - **Surface:** this plan file (decision outcome lives here; no new ADR unless an implementer finds a one-way door against ADR-0068/0037)
   - **Acceptance:** the four sentences below are quoted by later bullets' Inherits; the plan does not authorize an OpenTUI major bump, turning isolation OFF, or relying on the 300s build timer as the `find /` fix
   - Status: [x] done — 2026-09-14 事故四条锁句落定于本文件；后续 bullet 的 Inherits 一律引它们，不再另开 ADR（无 against ADR-0068 / ADR-0037 的单向门）
   - Locked sentences:
     1. TUI catch must format LLM-provider (and other startup) typed plain objects the same way `cli.ts` already does.
     2. `createCliRenderer` runs only after assemble that can throw those objects has succeeded (non-TTY fail-fast still before any renderer).
     3. Isolation classify: `cd` and read-only rest are `read`; unknown/write segments stay fail-closed `mutate`. `sed` 的实际准入面是 **quiet mode（`-n`）且每个 `;` 分隔项都是行号范围 print（`Xp` / `X,Yp`，X/Y = 行号或 `$`）** —— 比本句初稿窄：GNU sed 4.9 下 `sed -n '1w out.txt' f` 会创建文件、`sed -n '1e cmd' f` 会执行命令，二者都**不需要** `-i`，只禁 `-i` 会把真实写判成读。`sed -n '/re/p'` 与 `sed 's/a/b/'` 因此归 `mutate`（只写 stdout 但语法不在准入面内）；方向是 fail-closed，需要时用 `grep` / `head` / `rg`。
     4. `find` whose search root is `/` (or equivalent filesystem root) is hard-wall deny, not isolation-read.

2. **TUI start prints a typed cause and does not probe the terminal first** — tag: `[implementation]`
   - **Inherits:** T1 sentences 1–2; spec 321 E1/E2 prefix `TUI 渲染后端初始化失败` + exit 1 + single catch; code-quality typed-error catch; existing `isLlmProviderConfigError` / `formatLlmProviderConfigError`
   - **Surface:** tui run entry (same catch that today does `String(err)`)
   - **Acceptance:** a TTY start that throws `provider_api_key_missing` exits 1, stderr contains that kind (not `[object Object]`), and the process has not entered alternate-screen / OSC 10–11 query; existing E1 factory-throw tests still show the prefix and exit 1
   - Status: [x] done — T2 落地：`describeTuiStartError`（判别联合优先，绝不 `String(plain object)`）+ 渲染器工厂移到装配链之后（T1 句 2）。
   - [blocks: T1]

3. **[parallel] Isolation treats cd + read-only bash as read** — tag: `[implementation]`
   - **Inherits:** T1 sentence 3; ADR-0037: isolation ON, unbound session, read paths stay on the main checkout; `classifyBashWorkspaceWrite` fail-closed for unknown commands
   - **Surface:** isolation worktree gate (bash workspace-write classifier + readonly segment policy it already borrows)
   - **Acceptance:** unbound + isolation ON: `cd <main> && head …` and `cd <main> && sed -n …` execute (or at least are not isolation-blocked); `cd <main> && sed -i …` and unknown first tokens still isolation-block with the existing unbound-mutate notice
   - Status: [x] done — T3 落地：gate 专属 read 臂（`cd` 单操作数 + quiet-mode print-only `sed`）先于共享表查表；readonly 模式未被放宽；顺带关掉 `splitShellSegments` 不切换行导致的 `head a\nrm -rf b` fail-open。
   - [blocks: T1]

4. **[parallel] Root `find` is hard-wall denied before spawn** — tag: `[implementation]`
   - **Inherits:** T1 sentence 4; CONTEXT **hard-wall** (not grant-overridable); ADR-0068 fence cannot see whole-machine walk intent
   - **Surface:** permission hard-walls (bash dangerous-command / execute-dangerous wall)
   - **Acceptance:** `find / …` and `find / -maxdepth N …` never spawn (hard-wall deny, including full_auto); `find .` / `find <taskRoot-relative>` without denied find flags still not this wall; isolation-read classification does not bypass the wall
   - Status: [x] done — T4 落地：`root-find-walk` 进 hard-wall（`full_auto` / session grant 均不可覆盖，isolation-read 不旁路）。
   - [blocks: T1]

5. **[parallel] Foreground bash cancel tears down the process group** — tag: `[implementation]`
   - **Inherits:** bash `interruptBehavior: cancel`; existing background `bash_stop` SIGTERM → grace → SIGKILL process-group pattern; 2026-09-14 turn ran ~232s until host cancel
   - **Surface:** harness bash execution / ACI executor abort path
   - **Acceptance:** aborting an in-flight foreground bash whose children would otherwise keep walking the tree leaves no descendant `find` after the tool call returns cancelled; a completed short bash is unchanged
   - Status: [x] done — T5 落地：前台 exec 的拆除链收进 `createTreeTeardown`；根因是 `close` 回执清掉 SIGKILL 升级 timer，使 pipe-free + SIGTERM-immune 后代存活。
   - [blocks: T1]

6. **TUI destroy does not leave capability replies on the shell** — tag: `[implementation]`
   - **Inherits:** T1 stay-on-0.5.1; spec 321 Success Criterion 2 scrollback 收口; OpenTUI #904 class (cooked mode before mouse/capability off); host owns destroy, no `node_modules` patch required if a wrapper drain works
   - **Surface:** tui run entry destroy / quit / catch teardown
   - **Acceptance:** after E1/E2 or `/quit` on a real TTY, the following prompt is not prefilled with `10;rgb:` / DECRQM `$y` / SGR mouse `M` leftovers (operator or aiterm PTY); mouse tracking and raw mode are off
   - Status: [x] done — T6 落地：`teardownTuiTerminal` 四步顺序（关鼠标 → destroy → drain 能力应答 → raw 兜底），catch / `/quit` / 正常退出三路唯一收口。
   - [blocks: T2]

## Code review phase

`code-review`（Standards + Spec 双轴，pinned ref = 441cb33c + 工作树未提交 diff）：**GATE: BLOCKED: 2 High unresolved** →
`review-report-repair` 已开。

High（两轴各自独立复现，均已修）：

- 包装器带值 flag 旁路：`sudo -u root find / …` / `env -u FOO find / …` / `timeout -s KILL 5 find / …` / `xargs find / …` 在 `full_auto` 下 allow。
- 相对根操作数：`cd / && find ./..` / `find ../` 未判定（绝对写法 `find /tmp/..` 已被同一测试钉为 deny，形成自相矛盾）。

Medium（同批修复）：引号化命令词 `"find" /` 旁路；`sed -n -f- …` / `-fFILE` 粘连写法把真实写判成 read；
quote-stripper / tokenizer 三处重复（`FIND_WRAPPER_TOKENS` 漏 `xargs` 正是旁路成因）；T6 真 TTY 证据缺失（已补原始字节）。

修复的根因聚类（`review-report-repair`）：

- **A. 命令词解析**：包装器带值 flag 无 arity → `WRAPPER_FLAG_ARITY` 逐 wrapper 声明；未建模 flag 一律 fail-closed 吃掉下一个 token；命令词补 quote 归一；wrapper 集合并入 `xargs`/`stdbuf`/`setsid`/`ionice`。
- **B. 根操作数归一**：`find` 操作数与 `cd` 走同一个 `resolveCdTarget`（相对写法按已知 cwd 解析），并覆盖 glob 词干前缀（`find /*`）。
- **C. sed 粘连 flag**：`isSedScriptFileFlag` 认 `-fFILE` / `-f-`，与 `hasSedNoWriteFlag` 的粘连处理一致。

负对照（证明新测不是同义反复）：还原修复前代码 → wall 探针 10/30 通过、sed 探针 13/19 通过；修复后 **30/30、19/19**。

## 实测（acceptance 地面）

- **T2**（aiterm PTY 真 TTY）：`env -u <KEY>` 起 `cli.ts tui` → `TUI 渲染后端初始化失败：provider_api_key_missing: acme (env IKNOW_T2_REVIEW_KEY unset)`，exit 1，无 `[object Object]`。
- **T4**（真模型 turn，`--auto-mode full_auto`）：模型调 bash 执行 `find / -maxdepth 1 -name home` → `[execution_failed] [permission_denied] [hard_wall] dangerous command pattern matched (id=root-find-walk, pattern="find")`，未 spawn。
- **T5**：`bash.test.ts` cancel 两例全绿，含新增「pipe-free + SIGTERM-immune 后代不得存活」（负对照：还原 runner 即失败）。
- **T6**（aiterm PTY 真 TTY）：`/quit` 后新 prompt 无 `10;rgb:` / DECRQM `$y` / 鼠标 `M` 残留；E1/E2 失败路径同样干净。
  原始字节（`pty_read raw:true`，`/quit` 退出段）：鼠标关闭 `?1003l ?1002l ?1000l ?1006l`
  出现在 alt-screen 退出 `?1049l` **之前**（即 teardown 承诺的顺序），退出后 68 字节内
  `rgb:` / `$y` / `\d+;\d+;\d+M` / `?1000-1003h` / `?1049h` 命中数全为 **0**，
  收尾 `\r\r\n` = 干净的新 prompt 行。
