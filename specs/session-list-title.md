# Spec: 会话列表标题（lite 生成）

会话列表一行显示主题标签，不是压缩摘要。占位用首条 user 截断；有 lite 槽时后台生成一次，落成 transcript 独立事件。

## Does

- TUI `/sessions`、Web 侧栏、HTTP list 主文案都读 header `title`（缓存）。
- 无标题事件：`title` = `extractTitle`（首条带 text 的 user，trim + 80）。
- 有标题事件：`title` = 最新事件正文；save / compact 不再 `extractTitle` 回盖。
- `settings.llm.liteModel` 为合法 `provider/model` 且第一次 `StopReason=completed` 后：无工具补全一次；失败留占位。
- 寒暄（与 `shouldSeedTaskFocus` 同一套「不是寒暄」闸）不单独烧 lite；过短则等已有助手后再生成。
- `lastFinalText` 可继续被搜索命中，不显示为主行。

## Does not

- 用 `title` 当文件夹名或 worktree slug。
- 把 full compact 摘要当列表名。
- compact / memory extract / dream 改用 lite。
- 给人改会话名（斜杠命令、侧栏点按、HTTP PATCH）。标题只由占位截断或 lite 生成。
- 中途反复改题、列表双行、话题聚类。
- 第二套 provider 表；lite 缺席时拒绝启动。

## Contract

- 标题事件不进 `messages`、不进模型 prior。
- lite 走用户 settings；项目文件 `llm` 段仍丢弃。
- 主模型缺失仍 ADR-0015 fail-fast。

依据：wayfinder **会话列表显示的会话概要（决策）** G1–G4；ADR-0113（proposed）。
