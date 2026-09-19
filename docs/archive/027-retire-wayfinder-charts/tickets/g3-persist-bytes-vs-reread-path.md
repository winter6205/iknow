# G3 会话落盘存字节还是只存路径再读

- Map: [路径读图进 Anthropic vision（决策）](../path-image-vision-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-19 操作员授权代理裁)
- Blocked by: [R2 adapter / 历史 / tool_result 现在能否承载非 text](r2-adapter-history-image-blocks.md), [G1 扩 read_file 还是新读图工具](g1-read-file-vs-read-image.md)

## Question

下一轮 `step` 和 resume 时，图片从哪来？本票不预选。G1 未裁前不裁。

- A：权威历史里存 SDK 形状的 base64 image block（session JSON 变大）。
- B：历史只存 path + MIME，每次上 wire 再读盘（文件变了则看见新字节）。
- C：只在当轮 tool_result 里带图，压缩 / resume 后不再送像素。

不在本票改代码。

## Resolution

**A：权威历史里存 SDK 形状的 base64 image block（活在 `tool_result.content` 内）。**

`buildMessageParams` 原样上 wire；若历史只存 path、上 wire 再读盘，等于在 adapter 里改写 content，违背本图「跟 SDK、不另开方言」。C 会让 resume / 压缩保留尾丢像素，模型以为看过图其实没有。

体积由 G1 的 1MB 顶拦住。session 顶层仍不出现 `type: "image"`（嵌在 `tool_result` 里，现行 schema 不递归拒）。

否决 B、C。图片 token 估算 / compact 策略仍在雾区：至少不得把 image 估成 0。
