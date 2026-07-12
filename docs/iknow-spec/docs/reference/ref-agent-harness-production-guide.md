# Agent Harness 工具调用修复层 — 软件工程规范生产指南

> 来源：Ahmad Awais (CommandCode.ai) X 推文 + Latent Space 访谈 + commandcode.ai/launch 官方文档
> 标注规则：每条陈述标注来源。Ahmad 未公开的实现细节不写入。

---

## 0. 文档约定

| 标记 | 含义 |
|------|------|
| [A-X] | Ahmad X 推文（微博全文转载） |
| [A-LS] | Ahmad @ Latent Space 访谈（biggo/atmes 转载） |
| [A-CC] | commandcode.ai/launch 官方页面 |
| [A-GH] | CommandCode GitHub README |
| [第三方] | 非 Ahmad 来源，单独标注 |

---

## 1. 需求分析

### 1.1 业务需求

| ID | 需求 | 来源 |
|----|------|------|
| BR-01 | 接入开源模型（DeepSeek / Qwen / GLM / Kimi / MiniMax）后，工具调用成功率达到闭源模型水平 | [A-LS] |
| BR-02 | 单次对话可维持 12 小时以上稳定运行 | [A-LS] |
| BR-03 | 自动学习开发者偏好，减少 AI 代码生成后人工编辑次数（目标：一个月后编辑次数降至 0.2~0.5 次） | [A-CC] |

### 1.2 功能需求

| ID | 需求 | 来源 |
|----|------|------|
| FR-01 | 自动修复四类工具调用格式错误 | [A-X] |
| FR-02 | 修复 Markdown 链接泄露到路径字段的问题 | [A-X] |
| FR-03 | 修复后向模型注入教学提示（repair hint），使模型在 3 次调用内学会自主修正 | [A-LS] |
| FR-04 | 从开发者 accept/reject/edit 行为中自动学习偏好，存入 markdown 文件 | [A-CC] |
| FR-05 | 偏好支持跨项目共享（push/pull） | [A-CC] |

### 1.3 非功能需求

| ID | 需求 | 来源 |
|----|------|------|
| NFR-01 | 修复层必须为确定性逻辑，不含 ML/微调/嵌入向量 | [A-LS] |
| NFR-02 | 修复层执行开销应为纯内存操作，不影响工具调用延迟 | [A-LS 推断：3200 行纯逻辑代码的执行特征] |
| NFR-03 | 权限确认逻辑下沉到框架层，不暴露给模型，避免降低模型输出质量 | [A-LS] |
| NFR-04 | 偏好文件对人类可读（markdown 格式），开发者可手动检查和修改 | [A-CC] |

### 1.4 约束条件

| ID | 约束 | 来源 |
|----|------|------|
| C-01 | 修复必须在 Zod 校验失败之后执行，禁止在校验前做预处理（防止误改写合法文件内容） | [A-X] |
| C-02 | 修复管道中，"JSON 字符串解析为数组"必须在"裸字符串包装为数组"之前执行，否则 `'["a","b"]'` 会被错误包装为 `['["a","b"]']` | [A-X] |
| C-03 | Markdown 链接修复仅剥离退化情况（链接文本 = URL 去掉协议），真正的 Markdown 链接必须原样保留 | [A-X] |
| C-04 | 路径字段必须使用专用 schema 类型（Ahmad 称为 `pathString()`），不得使用裸 `z.string()` | [A-X] |
| C-05 | 每种错误修复代码量控制在 30~100 行 | [A-X] |

---

## 2. 架构设计

### 2.1 系统边界

```
┌────────────────────────────────────────┐
│                LLM (模型层)              │
│       DeepSeek / Qwen / GLM / ...       │
│        输出 raw tool_call 参数           │
└────────────────┬───────────────────────┘
                 │
┌────────────────▼───────────────────────┐
│          Agent Harness (框架层)          │
│  ┌──────────────────────────────────┐  │
│  │     Zod Schema Validation        │  │
│  │     (先校验，不预处理)             │  │
│  └─────────────┬────────────────────┘  │
│                │ 校验失败时触发          │
│  ┌─────────────▼────────────────────┐  │
│  │   Deterministic Repair Pipeline  │  │
│  │   Rule1 → Rule2 → Rule3 → Rule4  │  │
│  │   + Markdown Link Strip          │  │
│  └─────────────┬────────────────────┘  │
│                │ repaired + hint        │
│  ┌─────────────▼────────────────────┐  │
│  │       Tool Executor              │  │
│  │       (实际执行工具调用)           │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

**关键设计原则 [A-X]**：修复层位于 Zod 校验与 Tool Executor 之间，而非校验之前。只修复报错字段，不影响合法数据。

### 2.2 修复管道执行顺序 [A-X]

```
Rule 1: 移除 null 可选字段        (remove-null-optionals)
  ↓
Rule 2: JSON 字符串 → 数组        (parse-json-string-array)  ← 必须在 Rule 4 之前
  ↓
Rule 3: 空对象 {} → 空数组 []     (empty-object-to-array)
  ↓
Rule 4: 裸字符串 → 单元素数组     (wrap-string-in-array)
  ↓
Rule 5: Markdown 链接剥离          (strip-degenerate-md-link) ← 仅路径字段
```

### 2.3 Repair Hint 教学回路 [A-LS]

```
Tool Call #1: 模型发错误格式 → 修复层修正 → 执行 → 返回结果 + hint "正确格式是 X"
Tool Call #2: 模型可能仍错 → 修复层再修正 → 执行 → 返回结果 + hint "正确格式是 X"
Tool Call #3: 模型已学会 → 直接发正确格式 → 校验通过 → 正常执行
```

Ahmad 观察到：模型通常在 **第 3 次调用后** 自主修正。

### 2.4 Taste 偏好系统架构 [A-CC]

```
用户交互 (accept/reject/edit)
        │
        ▼
  信号提取层 (Observation → Extraction)
        │
        ▼
  符号约束编码 (写入 .commandcode/taste/taste.md)
        │
        ▼
  条件生成: output = LLM(prompt | taste(user))
```

Taste 文件结构 [A-CC]：

```
.commandcode/taste/
├── taste.md          # 主偏好文件，按类别分组，每条带 confidence score
└── ...               # 可进一步拆分为多文件（API 偏好、前端偏好等）
```

---

## 3. 实现策略

### 3.1 修复规则规格

#### Rule 1: 移除 null 可选字段 [A-X]

| 项 | 规格 |
|----|------|
| 触发条件 | 工具调用参数中，Zod schema 标记为 optional 的字段值为 null |
| 处理 | 从参数对象中删除该字段（而非设为 null） |
| 代码量参考 | 30-100 行 [A-X] |
| 风险 | 无（可选字段省略与传 null 语义等价） |

#### Rule 2: JSON 字符串解析为数组（⚠️ 顺序关键）[A-X]

| 项 | 规格 |
|----|------|
| 触发条件 | 工具调用参数中，Zod schema 期望数组的字段值为 JSON 数组字符串 |
| 输入示例 | `'["a","b"]'` |
| 输出示例 | `["a","b"]` |
| 处理 | JSON.parse 后校验是否为数组 |
| 风险 | 可能误解析恰好为 JSON 数组字符串的文件内容——须结合约束 C-01 和 C-03 防护 |

#### Rule 3: 空对象 → 空数组 [A-X]

| 项 | 规格 |
|----|------|
| 触发条件 | schema 期望数组，实际值为 `{}`（空对象，非空数组） |
| 处理 | 替换为 `[]` |
| 代码量参考 | 30-100 行 [A-X] |

#### Rule 4: 裸字符串 → 单元素数组 [A-X]

| 项 | 规格 |
|----|------|
| 触发条件 | schema 期望数组，实际值为裸字符串（如 `"foo"`） |
| 处理 | 包装为 `["foo"]` |
| 代码量参考 | 30-100 行 [A-X] |
| ⚠️ | 必须在 Rule 2 之后，否则 `'["a","b"]'` 会变成 `['["a","b"]']` |

#### Rule 5: Markdown 退化链接剥离 [A-X]

| 项 | 规格 |
|----|------|
| 触发条件 | 路径字段值匹配模式 `[text](url)`，且 text = URL 去掉协议前缀 |
| 输入示例 | `[notes.md](http://notes.md)` |
| 输出示例 | `notes.md` |
| 处理 | 正则匹配 + 条件判断（退化链接才剥离） |
| 不触发 | `[click](https://x.com)` 等真正的 Markdown 链接 |
| 补充方案 | Schema 层：路径字段用专用类型（`pathString()`）代替 `z.string()`，从源头阻断 |

### 3.2 执行流程伪逻辑 [A-X]

```
function execute_tool_call(model_output, zod_schema):
    // 第一步：校验（不是预处理）
    validation = zod_schema.safeParse(model_output)
    
    if validation.success:
        return execute(validation.data), hints = []
    
    // 第二步：仅对失败字段触发修复
    repaired = copy(model_output)
    
    for error in validation.errors:
        field = error.path
        repaired[field] = apply_repair_rules(repaired[field], field_schema)
    
    // 第三步：重校验修复后数据
    re_validated = zod_schema.parse(repaired)  // 预期此时成功
    
    // 第四步：执行
    result = execute(re_validated)
    
    // 第五步：返回结果 + hint
    hints = generate_hints(validation.errors)  // 告知模型正确格式
    return result, hints
```

### 3.3 框架接入点 [A-LS]

| 接入维度 | 要求 | 来源 |
|----------|------|------|
| 挂载位置 | Zod 校验之后，Tool Executor 之前 | [A-X] |
| 权限提示 | 在框架层处理，不暴露给模型上下文 | [A-LS] |
| 错误可见性 | 不隐藏——修复层记录所有修复事件，但模型看到的是修复后结果 + hint（而非原始错误） | [A-LS 推断] |

---

## 4. 测试验证

### 4.1 测试用例矩阵（基于 Ahmad 发现的五类错误）[A-X]

| 用例ID | 输入 | 期望输出 | 命中规则 |
|--------|------|----------|----------|
| TC-01 | `{path: null, offset: null}` (可选字段) | `{}` | Rule 1 |
| TC-02 | `{files: '["a.ts","b.ts"]'}` | `{files: ["a.ts","b.ts"]}` | Rule 2 |
| TC-03 | `{files: {}}` | `{files: []}` | Rule 3 |
| TC-04 | `{files: "a.ts"}` | `{files: ["a.ts"]}` | Rule 4 |
| TC-05 | `{path: "[f.md](http://f.md)"}` | `{path: "f.md"}` | Rule 5 |
| TC-06 | `{path: "[click](https://x.com)"}` | `{path: "[click](https://x.com)"}` | 不修复 |
| TC-07 | `{files: '["a","b"]'}` → Rule 2/4 顺序测试 | `["a","b"]` 非 `['["a","b"]']` | 顺序验证 |
| TC-08 | writeFile content = `'{"key": "value"}'` | 内容原样写入，不被预处理修改 | C-01 验证 |

### 4.2 验收标准 [A-LS] [A-CC]

| 验收项 | 标准 | 来源 |
|--------|------|------|
| 工具调用失败率 | 修复后趋近于零 | [A-LS] |
| 最长稳定对话 | > 12 小时 | [A-LS] |
| 模型自主修正 | 第 3 次调用后不再触发同类型修复 | [A-LS] |
| Taste 编辑次数 | 使用 1 月后降至 0.2~0.5 次 | [A-CC] |
| 修复覆盖率 | 新模型接入 48 小时内覆盖 > 90% 已知错误模式 | [A-LS 推断] |
| 误修复率 | 零（writeFile 内容不被改写、真 Markdown 链接不被剥离） | [A-X] |

### 4.3 可观测性指标 [A-LS]

| 指标 | 用途 |
|------|------|
| `repair_rate` = 修复次数 / 总调用次数 | 模型质量直接指标，发现模型退化 |
| `repairs_by_rule` | 发现新 failure pattern |
| `repairs_by_model` | 指导模型选型 |
| `post_repair_failures` | 修复覆盖缺口，触发新变体录入 |
| `time_to_self_correct` | 教学效果追踪 |

---

## 5. 部署与运维

### 5.1 部署清单 [A-LS] [A-CC]

| 阶段 | 操作 |
|------|------|
| 接入 | 在 harness 中插入修复中间件，Zod 校验后、执行前 |
| 初始化 | 为每个仓库创建 `.commandcode/taste/` 目录（或等价偏好存储） |
| 灰度 | 先对 1~2 个模型启用修复层，观察 48 小时 |
| 全量 | 修复覆盖率 > 90% 后扩展到全部模型 |
| 持续 | 每日遍历修复日志，发现新模式 → 新增修复规则 → 更新变体库 |

### 5.2 修复变体库维护 [A-LS]

Ahmad 团队已记录 1.6 万种修复变体。运维要点：

- 每种修复规则对应多个变体（如 Rule 1 的 null 字段名因模型而异）
- 变体新增触发条件：`post_repair_failures` 中出现新的失败模式
- 变体不新增规则类别时直接在现有规则中追加匹配条件
- 同期适配多个模型（Kimi、MiniMax 等共享同一规则集） [A-LS]

### 5.3 偏好文件运维 [A-CC]

| 操作 | 方法 |
|------|------|
| 导出 | `npx taste push --all` |
| 导入 | `npx taste pull ahmadawais/cli` |
| 共享 | 团队 leader 推送 → 成员拉取 |
| 重置 | 删除 `.commandcode/taste/` 目录或手动编辑 taste.md |

### 5.4 回滚策略

| 场景 | 操作 |
|------|------|
| 修复层误改写合法数据 | 立即下线修复层。回查原因：误解了 C-01（先校验后修复）还是 C-03（真链接被误剥） |
| 新规则导致修复后仍失败 | 该规则回滚，日志保留，加入新变体后重新上线 |

---

## 6. 工程检查清单

### 需求阶段
- [ ] 确认目标模型列表（DeepSeek / Qwen / GLM / Kimi / MiniMax 等）
- [ ] 抽样 1000 条工具调用日志，统计四类错误的实际分布
- [ ] 验证 90% 命中率是否在当前环境中成立 [A-X]

### 设计阶段
- [ ] 修复层挂载在 Zod 校验之后、执行之前（不是之前）[A-X]
- [ ] Rule 2 在 Rule 4 之前，写入顺序约束文档 [A-X]
- [ ] 路径字段使用专用 schema 类型 [A-X]
- [ ] 确定 hint 注入位置和格式

### 实现阶段
- [ ] 每类规则代码量 30-100 行 [A-X]
- [ ] 纯确定性逻辑，无 ML 依赖 [A-LS]
- [ ] Markdown 链接剥离仅处理退化情况 [A-X]
- [ ] writeFile 等内容字段不被修复逻辑触达 [A-X]

### 测试阶段
- [ ] 通过 TC-01 ~ TC-08 全部测试用例
- [ ] 验证模型在 3 次调用内自主修正 [A-LS]
- [ ] 验收对话持续时间 > 12 小时 [A-LS]

### 部署阶段
- [ ] 灰度 48 小时，修复覆盖率 > 90% 后全量
- [ ] 监控面板上线，追踪 repair_rate / post_repair_failures
- [ ] 初始化偏好文件存储

### 运维阶段
- [ ] 每日审查修复日志 → 发现新 failure pattern
- [ ] 增量更新变体库（不新增规则类别时扩展匹配条件即可）
- [ ] 新模型接入时优先跑修复层兼容性测试

---

## 附录 A: 信息来源明细

| 缩写 | 来源 | 类型 | 可靠性 |
|------|------|------|--------|
| [A-X] | Ahmad Awais X 推文（微博全文转载, 5月3日） | 一手 | 高 |
| [A-LS] | Latent Space 访谈（biggo / atmes 转载） | 二手，引 Ahmad 原话 | 中高 |
| [A-CC] | commandcode.ai/launch 官方页面 | 一手 | 高 |
| [A-GH] | CommandCode GitHub README | 一手 | 高 |

## 附录 B: 已知信息空白

以下内容 Ahmad 尚未公开，本指南未包含：
- 修复层源码
- 修复管道在 CommandCode 代码中的具体实现
- repair hint 的具体消息格式
- Taste 学习算法（元神经符号 RL 目标函数）
- 1.6 万变体的分类分布
- 与 Fireworks / HuggingFace / SambaNova 的具体对比数据
*（内容由AI生成，仅供参考）*
