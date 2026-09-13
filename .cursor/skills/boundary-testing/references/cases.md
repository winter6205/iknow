# Boundary Testing — Case Library & Templates (on-demand)

> 配套 `protocol.md` 核心 SOP 使用. 此文件 = 完整 case 库 + YAML 样例模板 + 经验启示; 主规则引用本文件做 on-demand 读取.

## 1. 5 类别样例模板

| 类别          | 用途               | 典型 case 类型              |
| ------------- | ------------------ | --------------------------- |
| A 正向控制    | 应该触发           | 直接匹配描述                |
| B 否定/反向   | 不应该触发         | 含 `别/不要/don't` 等否定词 |
| C 歧义/多候选 | 多个候选匹配一个   | 应选对的那一个              |
| D 域外/无匹配 | 完全无关           | 应匹配 0 个                 |
| E 反向语义    | 描述词缺但意图存在 | 应能语义匹配                |

**每个 case 必须包含**: 输入 + 期望结果 + 类别标签 + 一句话描述.

## 2. 10-30 个代表性样例 (具体模板)

每个边界测试项目必须准备 **10-30 个代表性样例**, 覆盖以下 5 类别 (每类 2-6 个). 下面是已落地的 5 类样例模板, 可直接复用:

### A 类: 正向控制 (应该触发)

```yaml
A1:
  input:
    {
      tool: "Write",
      file_path: "docs/CONTEXT.md",
      content: "# t\n\n## Language\n\n**Foo**: bar.\n",
    }
  expected: { exit_code: 0, systemMessage: null }
  desc: "legal CONTEXT.md via Write passes"

A2:
  input: { tool: "Bash", command: "echo x > docs/CONTEXT.md" }
  expected: { exit_code: 2, systemMessage: "BLOCKED: ...CONTEXT.md..." }
  desc: "Bash redirect to CONTEXT.md blocked"
```

### B 类: 否定/反向 (不应该触发)

```yaml
B1:
  input:
    {
      tool: "Write",
      file_path: "docs/CONTEXT.md",
      content: "# t\n\n**Foo**: bar.\n",
    }
  expected:
    { exit_code: 2, systemMessage: "BLOCKED: ...missing ## Language..." }
  desc: "missing ## Language section blocked"

B2:
  input: { tool: "Bash", command: "rm node_modules/.cache" }
  expected: { exit_code: 0, systemMessage: null }
  desc: "rm of non-context path passes"
```

### C 类: 歧义/多候选 (多个候选匹配一个)

```yaml
C1:
  setup:
    team_glossary: { "Account": "billing record" }
    context: { "Account": "auth credential", "_avoid_no_override_marker": true }
  input: { tool: "Write", file_path: "docs/CONTEXT.md", content: "..." }
  expected:
    { exit_code: 2, systemMessage: "...Account...different meanings..." }
  desc: "team/project conflict without override marker HARD blocks"

C2:
  setup:
    team_glossary: { "Account": "billing record" }
    context:
      {
        "Account": "auth credential",
        "override_marker": "<!-- project-override: auth -->",
      }
  input: { tool: "Write", file_path: "docs/CONTEXT.md" }
  expected: { exit_code: 0, systemMessage: null }
  desc: "legitimate override with marker silent"
```

### D 类: 域外/无匹配 (应匹配 0 个)

```yaml
D1:
  input: { tool: "Write", file_path: "docs/foo.md", content: "any" }
  expected: { exit_code: 0, systemMessage: null }
  desc: "non-context path passes (guard not triggered)"

D2:
  setup: { project: "no CONTEXT.md" }
  input: { tool: "Write", file_path: "src/foo.ts", content: "x" }
  expected: { exit_code: 0, systemMessage: null }
  desc: "no CONTEXT.md -> silent graceful absence"
```

### E 类: 反向语义 (描述词缺但意图存在)

```yaml
E1:
  setup: { state: { readMtime: 100, currentMtime: 200 } }
  input: { tool: "Write", file_path: "src/foo.ts" }
  expected: { exit_code: 0, systemMessage: "...stale...advisory..." }
  desc: "stale mtime + write src/ -> advisory"

E2:
  input: { tool: "Bash", command: "cp template.ts src/new.ts" }
  expected: { exit_code: 0, systemMessage: "...read docs/CONTEXT.md first..." }
  desc: "Bash cp src/ + no read -> advisory"
```

## 3. 样例设计自检表 (写完 evals.json 后必走)

- [ ] **数量**: 10 ≤ N ≤ 30
- [ ] **类别覆盖**: 5 类别各 ≥ 2 个 case
- [ ] **正负平衡**: 真值 case 数 ≥ 假值 case 数 (避免样本偏斜)
- [ ] **自洽性**: 每 case 的 `state + input + expected` 三者不矛盾
- [ ] **边界**: 含空输入、坏 JSON、超长字符串、特殊字符、平台差异 (Windows 路径)、并发 (如适用)
- [ ] **disc_state 字段** (hook 注入类): key 路径要么 tmpdir-relative, 要么 `~/` 前缀 (home-relative), **不要**写死绝对路径
- [ ] **expected_has_msg / expected_exit**: 至少一个被断言; 不可两个都 null

## 4. Step 1 成功标准模板

```yaml
success_criteria:
  trigger_accuracy_min: 0.95 # TP rate
  false_trigger_max: 0.05 # FP rate
  negation_boundary_pass: 1.00 # 否定/边界 case 100% 正确
  no_required_behavior_regression: true # 已通过的样例候选不能变差
```

**关键**: 每条指标必须 machine-assertable. 不写"应该正确"——写"TP rate >= 95%".

## 5. Step 6 changelog 模板

```markdown
## What changed

### Files created

- <path> — <description>

### Files modified

- <path> — <what + why>

### Files NOT changed (out of scope this cycle)

- <path> — <reason deferred>

## Why

- Bug 1: <one-sentence symptom + root cause + fix>
- Bug 2: ...

## What got better

- <case X>: was FAIL, now PASS (because...)
- <case Y>: was FP, now silent (because...)
```

## 6. 3 个踩坑案例 (来自 2026-07-13 D/F hook 实施)

### Case 1: 子代理 smoke vs 驱动器级 FS smoke (最关键)

**症状**: 子代理实现 D hook (mtime 对比) 后报告"5/5 PASS". 但主 agent 跑驱动器级 smoke 时发现 case 2 (fresh mtime) 误判为 stale.

**根因**: 子代理的测试用整数 mtime (如 `record.readMtime = 200`), 但 `fs.statSync().mtimeMs` 在 Windows NTFS 上返回 `200.46` 这种浮点数. 严格 `>` 比较时浮点大于整数.

**修复**: `currentMtime > record.readMtime + MTIME_TOLERANCE_MS (10)`.

**教训**: **子代理 smoke 用理想数据** (整数、模拟磁盘), **驱动器 smoke 用真实数据** (fs.statSync 浮点、tempdir 真实路径). 两类 smoke 互补不可替代.

### Case 2: state JSON key 与 hook process.cwd() 不匹配

**症状**: D hook 在 driver 中跑测试时 case 1 应触发 advisory 但 silent.

**根因**: driver 在 `tempfile.TemporaryDirectory()` 跑 hook (cwd=tmpdir), 但 state JSON 的 key 是 evals.json 里写死的 `"D:/test"`. hook 用 `normalizeSlashes(process.cwd())` 算 key, **两个值不匹配**.

**修复**: driver 在每个 case 启动时把 state JSON 的顶层 key 重写为 `tmp_root`.

**教训**: state 文件按**动态值** (cwd、session_id、project root) 索引时, driver 必须**重写 key**, 不能假设 evals.json 写死的 key 适用于 tmpdir.

### Case 3 (历史): 整文件重写 settings.json 的副作用

**症状 (2026-07-13)**: 用 Edit 工具对含 secret 字段的 settings.json 做整文件重写, 引入非预期副作用 (例如影响下游 auth 凭据).

**根因**: Edit / Write / json.dump 会重写整文件, 在 secret-bearing 配置上倾向引入副作用.

**当时缓解**: 用 Python byte-level `rb + regex + wb` + 凭据字段 sha256 baseline.

**当前状态 (2026-07-18)**: pre/post sha256 对照 **不是** always-on 硬门禁. 通用纪律 = **外科式 edit** (行级 patch / 行内追加, 不整文件重写); 不把凭据值当 chat / 日志 / commit 内容. 是否再叠 pre/post 字节比对 = operator 选择.

**教训 (现行)**: secret-bearing 配置 (settings.json / *.env.json / credentials.json) 优先外科式 edit; 禁止默认整文件重写.

## 7. 触发模板 (建议复制粘贴)

```markdown
### Run: 边界测试 on <feature>

**目标**: <一句话>
**改动范围**: <文件列表>
**成功标准**:

- TP rate >= <N>
- FP rate <= <N>
- 必需行为不退化

**样例设计**: 30 个 (5 类别 × 6)
**驱动器**: <driver 路径>
**运行**: `python <driver> <evals.json>`

**A/B**:

- baseline: <rate>
- candidate: <rate>

**Step 5 gate**: <pass/fail>
**采纳/拒绝**: <理由>
```

## 8. 经验启示 (精华)

> **子代理 smoke 是必要的但不充分的.**
> 子代理有合理的上下文理解力但缺乏真实执行能力 (它写的测试是"如果按我以为的路径执行"). 主 agent 必须独立用真实 API 跑 smoke, 因为真实 API 有子代理**想象不到**的边界: NTFS mtime 精度、Windows 路径分隔符、Python int 截断 vs JS float、tmpdir state key 错位.

> **fs/statSync 不可信类型**: 永远不要假设文件元数据 (mtime、size、ctime) 是整数. 即使它们在大多数语言里看起来像整数, Node.js 的 `fs.statSync().mtimeMs` 返回浮点 ms. 要么用 `Math.floor()` 对齐, 要么加 tolerance.

> **state 文件 key 重写是 driver 的责任**: 当 hook 用 `process.cwd()` 算 key, driver 在 tmpdir 跑测试时, 必须在 case 开始前重写 state 的顶层 key. 否则 hook 找不到 record, silent FAIL.

> **secret-bearing 配置走外科式 edit**: Edit / Write / json.dump 整文件改 settings.json / *.env.json / credentials.json 倾向引入副作用. 优先行级 patch 或行内追加; pre/post 字节比对是 operator 选项, 不是 always-on 硬门禁.

> **变更记录是可追溯性的核心**: 3 个月后看 changelog, 应能立即知道"为什么改 / 改了什么 / 哪些样例变好". 变更记录不是文档任务, 是工程纪律.

> **完成性声明不能"包装"未完成**: 禁止在变更报告 / changelog 中用 ✅ / "成功 = …" / "全 PASS" 等措辞包装 deferred 项、infra-gap 或"目标达成"声明. 每一项独立标注 `状态 ∈ {完成, 进行中, deferred, infra-gap}`, deferred 项必标理由与下次 review 触发条件. **完成与否由用户判断, 不由主 agent 自评**.

> **已完成 ≠ 全做完**: 当前 cycle 的边界测试 PASS 只能证明"本 cycle 改动未引入回归", 不能证明"整个体系无问题". **逐项列举未完成/未触达项** (含 deferred、infra-gap、未做修复的 bug), 而非合并为"PASS = ..." 的一句话总结.
