# specs/ — 活跃 module spec 活索引（SSOT）

> **索引维护规则**（重写自 `5ae9889a` 前旧版，AGENTS.md 指针「活跃 spec：`specs/README.md`」指向本文件）：
>
> - **新增 spec** → 在对应主题组加一行（一句话职责 + 依据 ADR）。
> - **spec 落地完成或 superseded** → 从本表删除条目（归档去向按当时约定，本表只列活文件）。
> - 入口文件（AGENTS.md / docs/STATUS.md）只引用本文件，不逐字枚举 spec。

## 活跃 spec

### 运行时核心 / 沙箱

- `network-egress-allowlist.md` — 出口代理缝 + 域名允许集（ADR-0097，桥接改 ADR-0107：无宿主 socat）
- `egress-preset-allowlist.md` — 出厂 defaults 清单（ADR-0104，扩表见 ADR-0107）
- `egress-ssh-bridge.md` — SSH 走同一允许集；实现改为自带中继，禁止 socat 依赖（ADR-0107）
- `egress-credential-sentinel.md` — sentinel 可选，0107 不自动启用（ADR-0105）
- `subagent-layers-worktree-deps.md` — subagent 三层 + worktree 项目依赖

### harness / 状态与传输

- `agent-status-instruction-echo.md` — 状态栏复诵升级：`instruction:` 逐字回显段 + pivot reconcile 一次性标记（ADR-0103 修订 ADR-0028；ACR PASS）
- `transport-continue-persist.md` — transport retry / continue / failure persist

### TUI

- `tui-activity-block.md` — 过程块（思考与安静工具共用正文槽，按消息切块追加）
- `tui-skill-slash-catalog.md` — TUI skill slash → harness SkillCatalog
- `tui-subagent-transcript-live.md` — 活子代理两行落在会话 spawn 卡上

### 工具与扩展源

- `251-lsp-tool.md` — LSP 工具（连接卫生增量）
- `skill-index-increment.md` — 技能模型索引增量 + 人侧 slash 收口（ADR-0098）
