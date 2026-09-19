> **ARCHIVED** — 只读留档；活契约见 `docs/archive/027-retire-wayfinder-charts/README.md`。

# wayfinder:map — 路径读图进 Anthropic vision（决策）

> Tracker: 本地 markdown（沿用本仓既有 wayfinder 惯例，不开 GitHub issue）
> Charted: 2026-09-19
> 图名（人读引用时用全名）：**路径读图进 Anthropic vision（决策）**
> 触发：操作员确认「读取指定图片」；约束「用现有 Anthropic 依赖，不另起 content model」。

## Destination

走完一次决策：工作区内指定路径的图片，如何作为 **Anthropic 原生 image content** 到达已声明 vision 的模型。到达标志是入口、协议块、非 vision 失败面、历史落盘四条 grilling 都有 Resolution，能交给 spec。不把 TUI/Web 贴图、MCP image 透传、`web_fetch` 放行 `image/*` 当到达。

**Handoff（2026-09-19）**：地图到达。契约 [`路径读图进 Anthropic vision`](../../specs/read-image-vision.md)；plan（归档）[`read-image-vision`](../025-retire-completed-specs-and-plans/plans/read-image-vision.md)。已合入 `master`（[#1067](https://github.com/winter6205/iknow/pull/1067)）。

## Notes

**domain**：请求侧跟已钉的 `@anthropic-ai/sdk`（`^0.115.0`）走；不发明第二套多模态 content model。助手回合仍禁止 `image`（既有 ProtocolError 不变）。

**每个 session 开工前必读**：

- `arthurpower:logicsync` —— grilling 默认
- `src/harness/model-adapter/types.ts` —— `AnthropicContentBlock`
- `src/harness/model-adapter/anthropic-adapter.ts` —— `encodeUserText` / `buildMessageParams` / `interpretMessage`
- `docs/guides/prompt-development.md` —— 动 `read_file`（或新工具）description 必对照
- `arthurpower:domain-modeling` —— 若改 `AnthropicContentBlock` 或 session schema 白名单才走

**落盘纪律**：调研结论写在票的 Resolution（本仓惯例，不开 throwaway `research/` 分支）。

**本图必须尊重的既有决策**（票内点名挑战者除外）：

- Gate A 用户入口仍是文本；本图不把 `encodeUserText` 扩成贴图。
- `read_file` 文本分页 / NUL 拒二进制保持；G1 已裁为新工具，不扩 `read_file`。
- `buildMessageParams` 把 `state.messages` 断言成 SDK `MessageParam[]` 原样上 wire——请求侧形状必须是 SDK 已接受的 image block，不是平行方言。
- 助手侧 `image` 仍是 ProtocolError。

## Decisions so far

- [R1 SDK 0.115 请求侧 image 形状](tickets/r1-sdk-image-request-shape.md) — SDK 0.115：user/`tool_result` 都能带 `ImageBlockParam`（base64 jpeg/png/gif/webp 或 url）；`buildMessageParams` 原样 cast 上 wire。
- [R2 adapter / 历史 / tool_result 现在能否承载非 text](tickets/r2-adapter-history-image-blocks.md) — 本仓联合无 image；`safeContent` 把成功 tool 压成 text；顶层 image 过不了 session schema；嵌在 `tool_result.content` 里不递归校验；assistant image 仍 ProtocolError。
- [R3 read_file 二进制闸与图片体积](tickets/r3-read-file-binary-and-size.md) — 指定 png/jpeg 走同一围栏；NUL 即拒；无图像成功 payload。

- [G1 扩 read_file 还是新读图工具](tickets/g1-read-file-vs-read-image.md) — 新 ACI 读图工具；`read_file` 仍拒二进制；魔数限 jpeg/png/gif/webp；1MB；`safeContent` 只为该臂开洞；不入 last-read。
- [G2 非 vision 模型怎么失败](tickets/g2-non-vision-model-failure.md) — 不上工具层能力表；送 wire；4xx 走既有 API error。
- [G3 会话落盘存字节还是只存路径再读](tickets/g3-persist-bytes-vs-reread-path.md) — `tool_result.content` 内存 SDK base64 image；不 hydrate、不当轮丢弃。

## Not yet specified

- 图片 token 估算 / compact 是否把 image block 当非零体积（G3：不得估成 0，具体公式未钉）。
- TUI 过程块对「读了一张图」怎么显示（默认按 retract：不摊像素，只露 path/工具名）。
- 子代理 / worker 是否同缝（默认同主会话 ACI；未单独立票）。
- 新工具的英文 `name` 与 description 黄金集（spec / prompt-development）。

## Out of scope

- TUI / Web 用户贴图、剪贴板。
- MCP tool result 的 `type: "image"` 透传（现行只拼 text）。
- `web_fetch` 放行 `image/*`。
- 生成图片、改助手输出协议。
- 供应商无关的第二套 multimodal 抽象。

## Tickets

票体在 `docs/wayfinder/tickets/`。阻塞用正文 `Blocked by:`。

| 票                                                                                                | 类型     | 在过程中的位置 | 阻塞       |
| ------------------------------------------------------------------------------------------------- | -------- | -------------- | ---------- |
| [R1 SDK 0.115 请求侧 image 形状](tickets/r1-sdk-image-request-shape.md)                           | research | 事实           | —          |
| [R2 adapter / 历史 / tool_result 现在能否承载非 text](tickets/r2-adapter-history-image-blocks.md) | research | 事实           | —          |
| [R3 read_file 二进制闸与图片体积](tickets/r3-read-file-binary-and-size.md)                        | research | 事实           | —          |
| [G1 扩 read_file 还是新读图工具](tickets/g1-read-file-vs-read-image.md)                           | grilling | 取舍（入口）   | R1, R2, R3 |
| [G2 非 vision 模型怎么失败](tickets/g2-non-vision-model-failure.md)                               | grilling | 取舍（能力闸） | R1, G1     |
| [G3 会话落盘存字节还是只存路径再读](tickets/g3-persist-bytes-vs-reread-path.md)                   | grilling | 取舍（历史）   | R2, G1     |

Frontier：空。grilling 已结。地图到达：决策过程走完，待交接下一技能（不自动开写代码）。
