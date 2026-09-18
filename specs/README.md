# specs/ — 活跃 module spec 活索引（SSOT）

> **索引维护规则**（重写自 `5ae9889a` 前旧版，AGENTS.md 指针「活跃 spec：`specs/README.md`」指向本文件）：
>
> - **新增 spec** → 在对应主题组加一行（一句话职责 + 依据 ADR）。
> - **spec 落地完成或 superseded** → 从本表删除条目（归档去向按当时约定，本表只列活文件）。
> - 入口文件（AGENTS.md / docs/STATUS.md）只引用本文件，不逐字枚举 spec。

## 活跃 spec

### 运行时核心 / 沙箱

- `network-egress-allowlist.md` — 出口代理缝：`--unshare-net` 恒在 + 域白名单代理 + 首见批准流 + 违例回灌（ADR-0097）
- `egress-preset-allowlist.md` — 默认预放行档（builtin preset 六域，代码承载）+ 配置段缺席也起 session + `allowlistSource` 三档重定（ADR-0104；draft）
- `subagent-layers-worktree-deps.md` — subagent 三层 + worktree 项目依赖

### harness / 状态与传输

- `agent-status-instruction-echo.md` — 状态栏复诵升级：`instruction:` 逐字回显段 + pivot reconcile 一次性标记（ADR-0103 修订 ADR-0028；draft）
- `transport-continue-persist.md` — transport retry / continue / failure persist

### TUI

- `tui-activity-block.md` — 过程块（思考与安静工具共用正文槽，按消息切块追加）
- `tui-skill-slash-catalog.md` — TUI skill slash → harness SkillCatalog
- `tui-subagent-transcript-live.md` — 活子代理两行落在会话 spawn 卡上

### 工具与扩展源

- `251-lsp-tool.md` — LSP 工具（连接卫生增量）
- `skill-index-increment.md` — 技能模型索引增量 + 人侧 slash 收口（ADR-0098）
