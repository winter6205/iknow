# Session Handoff — Multi-subagent V2 Phase 0 live e2e 收口 (2026-08-26)

## 当前 live 状态

- **任务**: Phase 0 唯一残留项 —— T8 real-llm 两条路由任务的 live 证据。此前记为
  Not run（归因 "minimax 单 turn > 360s"）。
- **结论**: 两条路由任务 **live PASS**，`t8-live-subagent-routing.test.ts` 14/14
  asserts、5/5 tests、15.8s。原归因不成立，真实原因是测试 fixture 缺陷。
- **分支**: `winter/phase0-live-e2e-closeout-366f`（base `master`）。
- **生产代码零改动**：改动只落在测试 fixture、探针脚本、新增测试与文档。

## 归因更正：不是模型慢，是 fixture 挂死

同一网关实测（`https://api.minimaxi.com/anthropic`，`MiniMax-M3`，thinking 关）：

```
POST /v1/messages            → HTTP 200, 2.15s
POST /v1/messages (stream)   → HTTP 200, 1.89s，事件流完整到 message_stop
```

而三条 LLM 用例每条都精确卡满 360s testTimeout。精确撞上限而不是随机慢，说明是
挂死不是延迟。逐层复现后定位到三处 fixture 缺陷：

| #   | 缺陷                                                                            | 后果                                                             | 修法                                                  |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | `fakeSpawn` 只挂 `stdin.on("end")`；PassThrough 的读侧无人消费时 `end` 永不触发 | fake worker 从不回写 envelope，manager 一直等到 per-task timeout | 补 `stdin.resume()`（模拟真 worker 读到 EOF）         |
| 2   | fake envelope 的 `result` 是 `T8-fake ok (...)`，不含任务要求的 `subagent-ok`   | 父代理 final 文本里不可能出现该 token，断言无法满足              | 让 fake worker 扮演照做了的 worker，result 带该 token |
| 3   | 调用方自带 `subagentManager` 时 build-engine 的 trace 自动接线不介入            | manager 拿不到 trace，`subagent_*` 事件恒 0 条                   | `createSubAgentManager({ spawn, trace })` 显式传      |

缺陷 1 的最小复现（`stdin.on("end")` 不触发，`finish` 才触发）：

```
stdin 'finish' (writable side) fired
after 1000ms: endFired=false finishFired=true
```

### 回归守卫

新增 `tests/subagent/manager.test.ts` 一条常跑用例：worker 侧 `for await` 读 stdin
到 EOF 应拿到整条 payload 行。变异验证 —— 去掉 manager 的 `child.stdin.end()` 该
用例即红，恢复即绿，守得住这道缝。

## 断言更正：trace 里没有 `arguments.subagent_type`

原断言读 JSONL 的 `tool_call.arguments.subagent_type`。但 `loop-engine.ts` 的
`recordToolCall` 固定 `argumentsCaptured: false` 且不写 `arguments` —— 生产 trace
不把任意工具入参落盘（bash 命令 / write_file 内容都会进去）。该字段在 JSONL 里恒
缺席，断言的是一个不存在的契约。

改为断 trace 侧真实可得的两件事：

- **spawn/stop 真配对**：每条 `subagent_stop` 的 `subagent_id` 都能在
  `subagent_spawn` 里找到，且两侧条数相等（原判据只要求"至少有一个 spawn"）；
- **两档不串味**：`explore` / `general` 两个 conversation 分档各恰好一次成功的
  `spawn_subagent` tool_call。

`subagent_type → role` 的双值真值仍由 wire 侧 `capturedDefs[0].role` /
`capturedPayloads[0].role` 承担 —— 那才是路由真正的落点。

> **[Phase 1 backlog] 观测面缺口**：trace 的 `subagent_spawn` / `state_change` /
> `stop` 三类记录都没有 role / subagent_type 字段，`tool_call` 又不落 arguments。
> 结果是**单看 trace 无法判断某次 spawn 路由到了哪个 agent**。这属于 overview §3
> Phase 1 "观测性 V1 地板"的范围，且 §8 要求与 #383 transcript schema v4 对齐，
> 本次不擅自加字段。

## 附带修复：subagent 探针的预检打错协议

`npm run probe:sandbox:subagent` 的上游预检打 `${baseUrl}/chat/completions` +
`Bearer`（OpenAI 形态），但 worker 走 `new Anthropic({ baseURL })`，SDK 打的是
`${baseUrl}/v1/messages` + `x-api-key`。配置里的网关是 Anthropic 形态：

```
POST ${baseUrl}/chat/completions  → HTTP 404 "404 page not found"
POST ${baseUrl}/v1/messages       → HTTP 200
```

于是预检恒 404 → 四条探针全部 not-run，且把 404 一律播报成 `429/quota`，还白等满
10 分钟重试窗口。修法：预检改打 Anthropic Messages 端点；状态分类拆开
`ok / quota / unauthorized / not-found / unavailable`，配置类失败立即返回不重试；
纯函数 `buildPreflightRequest` / `classifyPreflightStatus` 导出并单测覆盖；入口执行
加 argv 守卫，import 取纯函数不再起副作用。

修复后探针真跑，44–53s 出结果（此前 10 分钟假 not-run）。

## Phase 0 验收对照

overview §3 Phase 0 三条验收：

| 验收条目                                                   | 状态     | 证据                                                               |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `npm run probe:sandbox` 10 类全绿                          | **PASS** | `all green (10/10)`                                                |
| explore 角色 bash 写操作被 validator 拦 + fence EROFS 兜底 | **PASS** | 新增 3 条真 spawn 用例（见下）                                     |
| ≥2 真任务 e2e 跑通                                         | **PASS** | explore + general-purpose 两条 live 任务，连跑两次均 14/14 asserts |

> `docs/multi-subagent-v2-overview.md` 尚未 merge 进 `master`（在 PR #697 的
> `winter/handoff-540-phase-0-1` 分支上），本分支从 `master` 切出因此看不到该文件。
> §3 Phase 0 的状态标记待 #697 合入后按本表回填，避免与该 PR 冲突。

### readonly 双闸的 live 证据

Phase 0 验收要 "validator 拦 + fence EROFS 兜底"，但既有 `bash-readonly.test.ts`
只覆盖 validator 那一闸的命令 taxonomy（纯函数），fence 那一闸落没落到 EROFS 从未
真跑过。新增 `tests/harness/aci/bash-sandbox.test.ts` 三条真 spawn 用例：

```
GATE1 (bashMode=readonly)  echo hi > out.txt
  → ReadonlyViolationError: output redirection is not allowed in readonly mode
  → 文件未落地
GATE2 (validator 关，只留 cwdReadonly)
  echo hi > out2.txt → code=1  "bash: line 1: out2.txt: Read-only file system"
  touch out3.txt     → code=1  "touch: cannot touch 'out3.txt': Read-only file system"
  → 文件均未落地
BASELINE (cwdReadonly 缺省)  touch baseline.txt → code=0，文件落地
```

第三条是关键：证明 GATE2 的 EROFS 是 fence 打的，不是环境自带的。

### 产品 CLI 路径 live e2e（真 worker 子进程）

T8 用 `fakeSpawn` 拦住了 manager.spawn，所以 worker 子进程根本不发。为了不让"真
worker 起不起得来"这件事只靠探针说话，另跑了一趟产品 CLI pipe 模式：

```
$ printf '<spawn_subagent explore 任务>' | node dist/cli.js chat --data-dir <tmp>
── turn 1 ──
The sub-agent reported "subagent-cli-ok" verbatim.
stop=completed · turns=2 · tools=spawn_subagent · 9321ms
```

真 worker 子进程起来、跑完、结果回到父代理。

**dev 模式的坑（记一笔，不改代码）**：同一条命令走 `npx tsx src/cli.ts chat` 会得到
`The sub-agent crashed and returned no response.`。`defaultSubAgentSpawn` 用
`spawn(process.execPath, [process.argv[1], "--subagent-worker"])` 重入，tsx 加载器
没被继承，node 直接跑 `.ts` 文件即崩。`NODE_OPTIONS="--import tsx"` 可绕过（实测
同一命令随即通过）。**发布路径不受影响** —— 构建产物里 `argv[1]` 是 `.js`。
改 spawn argv 会动到 V1 冻结契约面（既有测试逐字节断言该 argv 形态），为一条 dev
人机工程问题不值当，记为 backlog。

## 跑通证据（命令 + 结果）

```bash
npm run probe:sandbox
# all green (10/10)

npm run test:real-llm
# 5 passed (5)，14/14 asserts，15.80s
# 连跑第二次同样 14/14（两条路由任务 live 稳定，非侥幸）

npx vitest run tests/harness/aci/bash-sandbox.test.ts
# 9 passed (9)，含 readonly 双闸 3 条

npx vitest run
# 5 failed | 4598 passed (4603) —— 5 条全是 pre-existing，见下

$HOME/.bun/bin/bun test tests/tui/
# 1 fail（OSC52 门控，pre-existing）

npm run probe:sandbox:subagent
# 修复预检后真跑；net denied 一条不稳定，见"已知不稳定项"

npm run build && printf '<spawn_subagent 任务>' | node dist/cli.js chat --data-dir <tmp>
# 真 worker 子进程跑通，父代理拿到 "subagent-cli-ok"
```

### 基线 pre-existing 失败（本次不修，与本任务无关）

| 用例                                          | 条数 | 原因                                                                             |
| --------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| `tests/harness/sandbox/env-isolation.test.ts` | 4    | 云 VM 注入的 `CLOUD_AGENT_*` / `ANTHROPIC_AUTH_TOKEN` 进了 secret 名单，干扰断言 |
| `tests/harness/aci/tools/grep.test.ts`        | 1    | abort 中途 kill ripgrep 进程树，未如期 reject                                    |
| `tests/tui/copy-osc52-gate.test.tsx`          | 1    | bun TUI 侧；headless 下 OSC52 fallback 链未渲出"已复制"                          |

前 5 条在改动前的 baseline 里就存在（`/opt/cursor/artifacts/baseline-npm-test.log`），
数量与用例名逐条一致。OSC52 那条同样是 baseline 就有，只是任务描述里没列。

本次新增 8 条用例（1 stdin EOF 握手 + 4 预检 + 3 readonly 双闸），全绿：
baseline `4590 passed / 4595` → 现在 `4598 passed / 4603`。

### 已知不稳定项（非本次引入）

`probe:sandbox:subagent` 的 `net denied` 一条在 4 次运行里 2 次报
`fence did NOT block`。**不是沙箱逃逸** —— 直接复现 worker 拿到的是
`curl: (6) Could not resolve host: example.com`，`probe:sandbox` 的 network denied
一条也稳定绿。根因是探针的证据来源：`tool_call` 记录不落 result
（`resultCaptured: false`），fence 的输出只出现在**下一次** `llm_call` 的 messages
里；模型若在 bash 之后直接收尾，就没有那条 llm_call，探针便判 "无证据"。
属探针取证方式的脆弱性，修它要动 trace 落盘策略，留作 backlog。

## 本 session 变更

| 文件                                                      | 一行效果                                                         | commit    |
| --------------------------------------------------------- | ---------------------------------------------------------------- | --------- |
| `archive/tests-real-llm/t8-live-subagent-routing.test.ts` | fixture 三处缺陷修复（stdin EOF / result token / manager trace） | `39adef0` |
| `tests/subagent/manager.test.ts`                          | 新增 stdin EOF 握手回归守卫                                      | `39adef0` |
| `archive/tests-real-llm/t8-live-subagent-routing.test.ts` | trace 断言改为对齐真实 `tool_call` 契约                          | `74efb79` |
| `scripts/sandbox-probe-subagent.ts`                       | 预检改打 Anthropic Messages 端点 + 状态分类 + 入口守卫           | `4cef00c` |
| `tests/scripts/sandbox-probe-subagent-preflight.test.ts`  | 预检契约单测（4 条）                                             | `4cef00c` |
| `tests/harness/aci/bash-sandbox.test.ts`                  | readonly 双闸 3 条真 spawn 用例                                  | `f31e1ff` |
| `plans/556-562-builtin-catalog-bash-readonly.md`          | T8 Status 更正 + Acceptance 措辞更正                             | 本 commit |
| `docs/handoff/2026-08-20-t8-live-subagent-routing.md`     | 顶部加更正块（原文保留，便于对照判断链条）                       | 本 commit |
| `docs/handoff/2026-08-26-phase-0-live-e2e-closeout.md`    | 本文（新建）                                                     | 本 commit |

## Open blockers + next steps

1. **`docs/multi-subagent-v2-overview.md` §3 Phase 0 状态回填** —— 等 PR #697 合入
   `master` 后按上面的验收对照表改状态。本分支切自 `master`，该文件不在。
2. **Phase 1 观测性地板补 role 字段** —— trace 三类 subagent 记录都无 role，单看
   trace 判不出路由去向。归 Phase 1，需与 #383 transcript schema v4 对齐。
3. **`probe:sandbox:subagent` 取证脆弱性** —— 见"已知不稳定项"。
4. **dev 模式（tsx）起不了子代理** —— 见"产品 CLI 路径 live e2e"。发布路径不受
   影响；修它要动 spawn argv（V1 冻结契约面），暂记 backlog。
5. **5 条 pre-existing 失败** —— env-isolation ×4 是云 VM 环境注入导致，grep ×1
   与 OSC52 ×1 独立。本任务按约束不动。

## 脱敏

- 无 API key / token / credential 值出现。凭据一律用环境变量名
  （`ANTHROPIC_AUTH_TOKEN`、`IKNOW_LLM_BASE_URL`）。
- 日志留档里的 `apiKey.len=125` 只有长度，无内容。
