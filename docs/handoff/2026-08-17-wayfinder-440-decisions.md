# wayfinder #440 决策定稿 — todo_write + MCP resources（2026-08-17）

> 状态：全部条目已经 operator 逐条 grilling 通过（D5-D10 逐条过审、M1-M7 逐条过审）。
> 上游讨论：`2026-08-16-wayfinder-440-toolset-destination.md`（destination 重定位）。
> 方向锚：**B 方向 = 单 agent 的任务执行闭环深度**（operator 选定；A 多 agent 编排、C 以后再说）。
> 镜头：**改进完善，不是查漏补缺**（operator 显式指令）。

## 总纲（两条设计哲学，贯穿全部决策）

1. **todo_write 是模型自维护的辅助账本**——模型自治、宿主不查账、验证锚（task 公式 + 真实证据）不因它移动。
2. **MCP resources 是协议层补全，不是工具面凑数**——照 Claude Code / 上游参考实现参考做两个显式工具（list→read 两步式），不进 ACI 动态注册路径。

---

## 一、todo_write 任务账本（D1-D10）

### D1 工具形状：单工具 + mode 枚举

`todo_write(mode: "add" | "check" | "list", item?: string)`。否决上游参考实现的 `item + checked` 布尔（语义双关），否决拆三工具。

### D2 存储：session 作用域，宿主注入

文件 `<session 目录>/todos.md`，每个 conversationId 一份；工厂 `todoDir` seam 注入（mkdtemp 测试隔离）。模型只能通过工具访问（工具是唯一入口，不可被 read_file/edit_file 绕过）。否决全局单文件。

### D3 装配：条件化，ask 排除

同 memory_recall/memory_save 条件化模式；ask surface（无状态 oneshot）排除；Gate 3 镜像照抄；`ACI_TOOLSET_NAMES` append-only 25→26，四处 SSOT 锁同步。

### D4 治理上限：贴合语义，不照抄 memory_save

- 文件上限 64 KB（PR #430 的 1MB 过大）；
- 单条上限 500 codepoints（对齐 taskFocus 纪律）；
- **负面措辞拒绝不做**（todo 条目「别忘了跑测试」是合法任务；记忆才拒绝负面措辞）；
- tmp + rename 原子写。

### D5 输出：纯字符串短回执，无 pending 计数、无 envelope meta

- add/check 返回短回执（如 `Updated todos.md`），list 返回全文；
- **否决 pending 计数**（grilling 修正：模型从叠加的 checkbox 自数即可，工具不替它数）；
- 否决 envelope meta（TUI todo 面板是不存在的消费者）。

### D6 并发：装配期单写者，不引文件锁

- iknow **不是单 agent**（spawn_subagent 已在工具面）——原「executor 串行化兜底」论证不成立（grilling 修正）；
- 所有权规则：todos.md 属主 loop，worker 的 deps 不注入 todoDir，跨 executor 竞态在装配期排除；
- 主 loop 内保留 `isConcurrencySafe: false`；不引文件锁（锁为多写者准备，我们用所有权边界隔离写者）；
- 将来多 agent 共享账本（A 方向）要加的是协调机制，不是锁。

### D7 权限：category "write"，默认 mode ask

- 每次 add/check 走 ask 确认（operator 裁定：「写入权是模型」指的是模型发起写，不是免 ask；ask 是宿主守门）；
- list 只读，实现时确认 bypass ask；
- 不引入 `~/.iknow` 免确认白名单（曾提议，被 operator 否决）。

### D8 联动：无。模型自治

- verify 不读 todos.md，不追加 evidence-checker 规则，**也不记 gaming signal**（grilling 从「第 7 条硬规则」降级为 gaming signal、再被 operator 砍到零）；
- 理由：上游参考实现 / Claude Code 都是模型自治形态；硬联动会把「辅助账本」偷偷升格成验证证据，与「todo 只是辅助」冲突；
- 验证锚不动：`task = goal.text ?? taskFocus.text ?? query` + 真实执行证据；账本完全在验证链路之外；
- 漂移出口 = 模型自己处理（勾选或注明作废），责任在模型。

### D9 触发纪律：正面引导式 tool description

- 纪律写进 todo_write 的 **tool description**（不是 system prompt 条件段——grilling 修正：工具在场描述就在场，条件化免费，且与 Claude Code TodoWrite 同形态）；
- **只写正面引导**：「多步骤跨多轮的复杂任务，先用 todo_write 建清单并随进展更新」；
- **无负面禁令**（「简单任务不要建」被砍——模糊负面措辞增加模型决策噪声，精确正面条件自排除简单任务）。

### D10 与 PR #430 关系：不 merge，摘模式不搬代码

- PR #430 的 todo_write（cwd 全局文件 / item+checked 布尔 / 1MB / envelope meta）整体不 merge；
- 可复用：homeDir seam + mkdtemp 测试隔离模式、Gate 3 条件化装配模式（复用思路，不搬代码）；
- PR #430 标 superseded。

---

## 二、MCP resources 通道层（M1-M7）

### M1 形态：两个显式工具，照参考实现

- `list_mcp_resources` + `read_mcp_resource`，模型显式调用（list→read 两步式）；
- **否决目录段注入方案**（grilling 修正：两个参考实现都不做目录段；资源集合可能很大，盲目全灌烧上下文；显式两步式让资源访问有目的、不自动——Claude Code 公开设计理由）；
- **否决 PR #430 的 registerExternal 动态注册路径**（走 ACI native 条件化装配，见 M2）；
- MCP manager 补协议方法 `resources/list` / `resources/read`（SDK @modelcontextprotocol/client@2.0.0 已提供 `Client.listResources()` / `readResource()`，薄包装即可）。

### M2 装配：进 ACI_TOOLSET_NAMES，条件化，read-only 免 ask

- `ACI_TOOLSET_NAMES` 25→27（append-only），manager-level native 工具（跨 server 聚合，非某个 server 的具体工具）；
- 条件：mcpManager 在场（build-engine.ts:294-307 的 `getMcpManager` 惰性闭包已在 master）；Gate 3 镜像照抄；
- `category: "read-only"`、默认 ask 关闭——对齐 web_fetch/web_search 先例（ask 是副作用守门，不是内容审查门）；
- 与 `mcp__<server>__<tool>` 动态工具的保守 write 默认不同：list/read 是 iknow 自写的 meta 工具，行为透明，诚实标 read-only。

### M3 安全边界：零新机制，复用现有纪律

- 资源内容注入：不设 sanitization 层，同 web_fetch（外部内容当 untrusted 数据）；
- executor 截断 20000 + 契约 X（ADR-0006）兜底输出大小；
- URI/server 入参 schema 最小校验 + typed error（helpers.ts 现有工具）；
- SSRF 不额外防：fetch 发生在 server 进程（user-configured trust），不是 iknow 进程；
- server 无 resources capability（如 codebase-memory，实测 -32601）：list 跳过该 server、read 返回 typed error，不崩不重试；
- worker 默认可见（同 mcp__*，不进 DEFAULT_DISALLOWED_TOOLS）。

### M4 边界：stdio-only，remote 自然跟随

- 资源通道只在 stdio server 上工作（整个 manager 就只接 stdio，manager.ts:457-459）；
- remote 不做、不为资源单独推进（现有政策统一：remote tools 也不工作）；
- 实现纪律：slot-based 写法（同 callTool 抽象）→ 将来 remote 接线零改动跟随；
- 现实锚：codebase-memory 是 stdio server，覆盖当前唯一真实场景。

### M5 验证联动：零联动，锚不动

- evidence-checker 零改动（资源读取不是测试运行，天然 scope 外，同 web_fetch 待遇）；
- 判官 deny-list 不加（read-only 工具与判官已持有的 read_file/grep 同类）；
- 不加 gamingSignals（过度关联）；trace 如常落。

### M6 成本：零新机制

- read 输出大 → executor 截断；重复 read → reactive compact 兜底，不建缓存/去重；
- list 协议本身轻（每行 `server:uri description`）；
- description 自限定触发（「URI 不确定时才 list」）防滥用。

### M7 PR #430 关系：摘取 MCP 部分，丢弃 todo_write 部分

- **摘取**：manager 资源通道（McpClientHandle.listResources/readResource + 聚合层 + 共享类型，+258 行）、两个工具文件（169+132 行，factory 形态）、三份测试；
- **适配**：注册路径 registerExternal → ACI_TOOLSET_NAMES 条件化（M2）；`read_mcp_resource.isConcurrencySafe` 沿用 false（operator 拍板：保守默认，与 mcp__* 一致）；
- **丢弃**：todo-write.ts（234 行）+ 相关测试——被 D2/D5/D7 否决，重写不摘取；
- PR #430 标 superseded；worktree `p04-tool-aci-completion` 不 merge 不强删。

---

## 三、附带决议

1. **#468 移出决策**：已由 PR #469 合并修复（disallowedTools 入参 + Gate 3 镜像 + worker 透传），不再是待办。
2. **新增任务：现有 ACI 工具按「描述即纪律」范式补齐**（task #4）——审计 25 件工具的 description 现状（触发条件引导 / 治理约束显式声明），前提是本决策定稿作为对照基准。
3. **调研文档「MCP 动态生成机制」定性**：指 MCP-served 工具的注入路径（JSON Schema→schema 直传 + ajv 校验 / `mcp__server__tool` 名规整 / microcompact 前缀信号），iknow 已全部实现（adapter.ts / manager.ts / deps.ts），非待办；新增的 list/read 是 iknow-native meta 工具，与该机制不沾边。SDK 2.0.0 已含最新协议 `_meta` 处理与 resources primitives，无升级跟踪项。
4. **mcp_auth 维持搁置**（handoff 结论 3 不变）；**plan mode 维持关闭**（handoff 结论 2 不变）。

## 四、实施前置约束

- map #440 重画完成前不写代码、不改 master（handoff 纪律延续）；
- 实施票两张：todo_write（D1-D9）、MCP resources（M1-M7 含 PR #430 摘取适配）；
- 验证矩阵按项目测试规范：todo_write 接真实 SessionStore + fresh conversationId；MCP resources 走 stub client 单测 + 暴露 resources 的 stdio fixture server 端到端（codebase-memory 不暴露 resources，实测 -32601）。
