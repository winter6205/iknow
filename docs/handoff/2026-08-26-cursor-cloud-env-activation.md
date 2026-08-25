# 交接：Cursor Cloud 环境激活（W1 运行时验证 + W2 构建权限探测）

日期：2026-08-26
分支：`winter/cloud-env-activation-evidence-b40c`
基线 HEAD：`73d62bc`（`chore(cursor): pin Cloud Agent install/start and vendor arthurpower`）

**结论先行：Cloud 环境构建（prebuilt builds）尚未确认激活。** 触发（trigger）已成功，但状态与日志读取被权限拒绝，因此无法证明构建成功；仍需人工在 Dashboard 侧确认或授权。本文只汇总 W1/W2 两个 worker 的证据与剩余人工步骤，不改任何脚本或配置。

---

## 1. W1 运行时验证（bc-5d3ce70b-f120-5771-962e-f11b3a2a251a）

在 `73d62bc` 上按 `.cursor/environment.json` 的 `install` / `start` 实跑：

| 步骤                        | 命令来源                         | 结果                                 |
| --------------------------- | -------------------------------- | ------------------------------------ |
| install（连跑两次，验幂等） | `bash scripts/cursor-install.sh` | exit 0 / exit 0                      |
| 工作树洁净度                | `git status --porcelain`         | 空输出（install 不污染工作树）       |
| start                       | `bash scripts/cursor-start.sh`   | exit 0                               |
| 类型检查                    | typecheck                        | exit 0                               |
| 测试（出厂状态）            | `npm test`                       | **exit 1：186 failed / 4394 passed** |

### 1.1 出厂 `npm test` 失败的五个根因

- **G1**：镜像缺 `bwrap`（bubblewrap），沙箱相关用例直接失败。
- **G2**：Node 版本 PATH 偏斜——`/exec-daemon` 上的 node 22.14 先于 nvm 的 22.22.2 被解析，`.ts` type-strip 行为不一致。
- **G3**：`~/.ssh` 目录不存在，tmpfs 相关断言失败。
- **G4**：grep abort 时序 flaky（与环境无关的不稳定用例）。
- **G5**：bun TUI 环境不匹配（缺 `xclip` / `DISPLAY`）叠加加载超时。

### 1.2 仅做 VM 侧修补后的复跑

在 VM 上安装 `bubblewrap`、切到 nvm node 22.22.2、`mkdir -p $HOME/.ssh` 之后：

```
4594 passed / 4595 total   （只剩 G4 这一个 flaky）
```

即：**失败绝大部分来自镜像/环境缺件，不是产品代码回归。**

### 1.3 建议的脚本修复（不在本次交接范围）

以下三条应由兄弟 worker（W4）落到 `scripts/cursor-install.sh`，此处仅登记为**在途 / pending**：

1. 安装 `bubblewrap`；
2. 让 nvm 的 node 在 PATH 上优先于 `/exec-daemon`；
3. `mkdir -p $HOME/.ssh`。

（G4 属 flaky 用例，G5 属 TUI 依赖，二者是否纳入脚本由 W4 判断。）

---

## 2. W2 构建权限探测（bc-409ceec9-ecb2-50c1-b1d3-f13a3bf8f8bf）

环境标识：

- environment id：`d0726e61-a09e-11f1-b532-320a589b8025`
- source：`Repository`
- `environmentJsonPath`：`null`

### 2.1 探测结果

| 操作                        | 结果                                                |
| --------------------------- | --------------------------------------------------- |
| `list-environment-builds`   | **permission denied**（仅 owning user / team 可读） |
| `trigger-environment-build` | **成功**，返回 draft buildId                        |
| 构建状态 / 构建日志读取     | 不可读（同一权限边界）                              |

已触发的 draft build（两次，均**状态不可读**）：

- `bld-20260826-6241344e-af6d-4035-925e-9bcfe9d3236d`（W2 触发）
- `bld-20260826-356a6360-573f-42c9-8646-db1540050aa7`（W1 侧另行触发）

### 2.2 分类

**`trigger_succeeded` + 读取 `permission_denied`。**

这一点要说清楚：**不是 `builds_not_enabled`。** 触发能通过说明环境本身允许发起构建；失败的只是本 run 的读取权限。因此「构建是否成功」目前是**未知**，不是「失败」，也不是「已激活」。

已通过 `request-environment-setup-actions` 登记 external_action：`grant-build-read-or-report-draft-build-status`。

### 2.3 待澄清的不一致

`source=Repository` 却带 `environmentJsonPath=null`。仓库里确实存在 `.cursor/environment.json`，按 Repository 来源的语义该字段本应指向它。这可能只是接口回显缺省，也可能意味着平台侧并未真正绑定到仓库内的那份配置——**在人工确认之前不要据此推断构建用的是哪份 config**。

---

## 3. 剩余人工步骤

按顺序执行，前两步是解锁后续判断的前提：

1. **在 Cursor Dashboard 查两个 draft build 的最终状态**（`bld-20260826-6241344e-...` 与 `bld-20260826-356a6360-...`）：succeeded / failed，以及失败时的 install 日志。
2. **给本 run 的 principal 授予 build 读取权限**（或由 owner 把状态回帖给本线程），否则 agent 侧无法自证构建结果。
3. **核对 `environmentJsonPath` 与 `source=Repository` 的不一致**，确认平台绑定的确实是仓库内 `.cursor/environment.json`。
4. **等 W4 的脚本修复合入后重跑一次构建**，用「出厂 `npm test` 是否 4594/4595」作为验收线。
5. 注意：环境为 repo-managed，因此**不做** `propose-environment-json`，也**不做**手动 snapshot——这是 planner 的明确约束。

---

## 4. 状态口径（不要写成已完成）

- 环境构建：**未确认激活**。仅证明「可触发」，未证明「能成功」。
- 运行时验证：**通过**（在 VM 侧补齐三项缺件后 4594/4595）。
- 脚本修复：**在途**，由 W4 承接。
- 本交接：只新增本文件，未改动任何其他受版本控制的文件。
