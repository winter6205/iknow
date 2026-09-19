# R2 adapter / 历史 / tool_result 现在能否承载非 text

- Map: [路径读图进 Anthropic vision（决策）](../path-image-vision-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved
- Blocked by: —

## Question

若要把一张图送进下一轮 `step`，现行管道哪一层会丢掉或拒掉？只陈述本仓 file:line：

1. `AnthropicContentBlock` 联合有没有 image。
2. `encodeUserText` / `encodeToolResults` / executor `safeContent` 把成功 tool payload 编成什么。
3. session `isValidContentBlock` 对未知 `type`、以及对 `tool_result.content` 里嵌套 block 的校验有多宽。
4. 助手回合 `interpretMessage` 对 `image` 的既有拒绝是否只约束 assistant，不约束 user / tool_result。

不写产品代码。

## Resolution

要把图送进下一轮 `step`，丢掉的是本仓编码与顶层 schema，不是 SDK 请求类型。

1. **`AnthropicContentBlock` 无 image**（`types.ts`）：只有 text / tool_use / tool_result / thinking / redacted_thinking。`tool_result.content` 是 `unknown`。
2. **成功 tool 恒压成 text：** `safeContent` → `[{ type: "text", text }]`（`executor.ts`）；`encodeToolResults` ok 臂转发这份 payload；`encodeUserText` 只有 text。
3. **session：** 消息顶层未知 `type`（含 `image`）→ `isValidContentBlock` default false。`tool_result` 只查 `tool_use_id` + 有 `content` 键，**不递归**嵌套块——图若只活在 `tool_result.content` 里，sanitize 不会因 image 拒。
4. **`interpretMessage` 只打 assistant。** user / tool_result 不经这条 ProtocolError。
