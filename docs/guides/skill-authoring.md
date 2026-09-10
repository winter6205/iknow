# skill 作者契约 — 正文精简，细则进 `references/`

> 面向写 skill 的人。写「怎么写出可用的 skill」，不写运行时实现。
> 装配形态 SSOT = `src/harness/skill/body.ts`；扫描 / 索引 = `src/harness/skill/scanner.ts` + `src/harness/skill/catalog.ts`
> （本文与代码冲突时以代码为准）。

---

## 一句话

`SKILL.md` 的正文是**一次装配进上下文、按需加载的整份程序**；`references/` 是**零成本直到被读**的细则仓库。
正文精简是**作者纪律**，不是运行时闸——运行时不对正文大小设限，所以没人替你兜底。

---

## 一、一个 skill 的最小构成

一个 skill = 一个目录，目录下必须有 `SKILL.md`：

```
.iknow/skills/<name>/          # 或 <home>/.iknow/skills/<name>/
├── SKILL.md                   # 必需：frontmatter + 正文
├── references/                # 可选：细则（不进 <skill_files>，见 §二）
└── <其它文件或子目录>          # 可选：会被列进 <skill_files>
```

安装位置（扫描根；按顺序扫描，同名者**后者覆盖前者**）：

1. `<home>/.iknow/skills/<name>/`
2. `<projectIdentityRoot>/.iknow/skills/<name>/`
3. `IKNOW_SKILL_DIRS` 里列出的目录（`path.delimiter` 分隔）

`SKILL.md` 没有 `---` frontmatter 块会被**整条跳过**（warn 一行），不会进索引。

```markdown
---
name: my-skill # 省略则取目录名
description: 一句话说清「什么时候该用它」 # 决定它是否出现在 <available_skills>
---

# 在这里写正文
```

- `description` 超过 1536 字符会被截断并 warn——**写一句话**，别在 description 里做正文。
- 只有「有 `description` 且未 `disable-model-invocation: true`」的 skill 会出现在 `<available_skills>` 清单与 Web 的 skill 列表（`GET /api/v1/skills`）里。按名加载的拒绝面比清单窄：`disable-model-invocation: true` 在 TUI slash 与 Web `GET /api/v1/skills/:name` 都会被拒，而**缺 `description` 只在清单侧隐去**——TUI `/name` 的候选即该清单，故命中不了；但 Web 按名取正文只拒「不存在 / 已禁用」，缺 `description` 的 skill 仍能取到。注意 ACI `skill({name})` 同样不做这项过滤：模型若已知名字仍可直呼命中。

---

## 二、模型加载时实际看到什么（装配形态）

三条加载路径（TUI slash / Web `GET /api/v1/skills/:name` / ACI `skill({name})`）交付**同一份** `createSkillBody` 产物，形态固定为三段，用空行连接：

1. **frontmatter 剥离后的正文**（正文为空则整段省略）
2. **`Base directory: <skill 目录绝对路径>`**
3. **`<skill_files>` 段**

`<skill_files>` 段的实际行为：

- 列出 skill 目录下的**文件**（绝对路径），**字典序排序**；
- **最多列 10 条**，超出时追加一行 `file list is sampled`——清单是采样，不是全量；
- `SKILL.md` 自己不出现；
- **`references/` 整个子树不进清单**（不递归、不列出）；
- `node_modules` / `.git` 目录跳过。

同输入两次装配结果**字节级相等**——所以正文里不要写会漂移的内容（时间戳、随机数）。

---

## 三、作者契约：正文精简，细则进 `references/`

**正文只放「每次执行都必须遵守的程序」**：入口、步骤骨架、判定关卡、失败路径。
**细则放 `references/`**：长表格、模板、示例集、参考资料、按需查阅的清单。

在正文里**显式指路**，模型才知道去哪读：

```markdown
套用 `references/handoff-template.md` 骨架；只在模板「已固化工件」表里填路径，不 inline 复制。
```

这条纪律不是风格偏好，是加载模型的直接后果：正文是一次装配产物、**整份语义**，不是可再生查询。半份技能程序比没有更危险——模型会把半份当全份执行，而本会话内没有「换更精确的输入重调」这条恢复路径。这正是 ADR-0083 把 skill 正文移出通用输出闸的理由：`docs/adr/0083-skill-body-exempt-from-executor-output-cap.md`。

---

## 四、运行时不对正文大小设限（纪律在你这边）

**没有 skill 专属的正文上限，也没有运行期的大小校验**：

- 扫描期不检查 `SKILL.md` 正文长度——唯一按大小裁剪的是 frontmatter `description`（1536 字符 + warn）；
- 装配期不按大小裁剪正文：frontmatter 剥离 + 追加两段，全程没有长度判断；
- 不存在 `SKILL_MAX_*` 一类的 skill 专属上限常量，也没有「正文超限就拒绝扫描 / 拒绝加载」的判定；
- 没有 skill 专属的截断 / 预览 / 补读回退机制。

**不要指望运行时帮你拦**。正文写长了，代价是每次加载都占上下文、挤掉别的东西；这是设计取舍（机制上不设限，纪律留在作者面），所以要你自己守住。

**交付面：正文不经 executor 通用输出闸。** `skill()` 装配出的正文是**完整到达**的 —— executor 的 20000 字符兜底截断（`OUTPUT_HARD_CAP`）对它不适用，不会出现「截断 + 引导重调」的标记。豁免是**装配期静态声明**：只有内建 `skill` 工具在装配时落 `exemptFromOutputCap`，其余内建工具与 MCP 工具照旧走通用闸（MCP 转换路径结构性不落该声明）。也就是说，正文一旦写长，运行期没有第二道兜底——这加重了上面那条作者纪律。缘由见 `docs/adr/0083-skill-body-exempt-from-executor-output-cap.md`。

---

## 五、`references/` 怎么被读到

`references/` 不进 `<skill_files>`，所以模型**不会自动知道里面有什么**。读法：

1. 从正文的指路句拿到相对路径；
2. 用 `Base directory:` 给的绝对路径拼出目标文件；
3. 调 `read_file` 读。

**可达性取决于安装位置**（`read_file` 的围栏约束）：

| skill 安装位置                        | `references/` 能否 `read_file` |
| ------------------------------------- | ------------------------------ |
| `<projectIdentityRoot>/.iknow/skills` | 能                             |
| `<home>/.iknow/skills`                | 能（`~/.iknow/` 是常驻读根）   |
| `IKNOW_SKILL_DIRS` 指向的外部目录     | **不能**（围栏外，会被拒绝）   |

要发到外部目录的 skill，别把「必须读得到」的内容只放在 `references/` 里。

---

## 六、不要

- 把正文写成百科——细则下沉到 `references/`。
- 在 description 里塞正文——它只用于索引与触发判定，且有 1536 截断。
- 假设 `<skill_files>` 是全量——它是采样 ≤10，且不含 `references/`。
- 假设 `references/` 会自动加载——它零成本，直到被 `read_file` 读到。
- 依赖「运行时拦超长正文」——不设限是契约的一部分，兜底在作者。
