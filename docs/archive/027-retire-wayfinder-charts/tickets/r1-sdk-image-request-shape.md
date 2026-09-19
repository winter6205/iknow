# R1 SDK 0.115 请求侧 image 形状

- Map: [路径读图进 Anthropic vision（决策）](../path-image-vision-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved
- Blocked by: —

## Question

本仓钉住的 `@anthropic-ai/sdk` `^0.115.0`（看 lock 实装版本）里，`messages.create` / `MessageParam` 请求侧如何携带图片？

只陈述 node_modules 类型与本仓 adapter 是否已经把历史 **cast** 成 `MessageParam[]`。需要钉死：

1. user message 的 image block 字段名（`type` / `source.type` / base64 vs url vs file id）。
2. `tool_result.content` 能否嵌 image block，还是只允许 string / text blocks。
3. 本仓 `buildMessageParams` 会不会改写 content，还是原样上 SDK。

不写产品代码。不评「该不该做」。

## Resolution

Lock 实装 `@anthropic-ai/sdk` **0.115.0**。

1. **User image：** `ImageBlockParam` = `{ type: 'image', source: Base64ImageSource | URLImageSource }`。base64：`source.type: 'base64'` + `data` + `media_type` ∈ jpeg/png/gif/webp。url：`source.type: 'url'` + `url`。stable 请求侧 **没有** `file_id`（只在 beta `BetaFileImageSource`）。
2. **`tool_result.content` 可以嵌 image。** SDK：`string | Array<TextBlockParam | ImageBlockParam | …>`。
3. **`buildMessageParams` 不改写 content。** 滤掉 `role === "system"` 后 `as unknown as MessageParam[]` 原样上 wire（`anthropic-adapter.ts` `buildMessageParams`）。

因此「跟 Anthropic 依赖走」在 **SDK 类型与上 wire 断言** 上成立；本仓自己的联合类型仍无 `image`（见 R2）。
