# G1 扩 read_file 还是新读图工具

- Map: [路径读图进 Anthropic vision（决策）](../path-image-vision-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-19 操作员授权代理裁)
- Blocked by: [R1 SDK 0.115 请求侧 image 形状](r1-sdk-image-request-shape.md), [R2 adapter / 历史 / tool_result 现在能否承载非 text](r2-adapter-history-image-blocks.md), [R3 read_file 二进制闸与图片体积](r3-read-file-binary-and-size.md)

## Question

路径读图的**入口**放哪？本票不预选。调研未结案前不裁。

- A：扩 `read_file`：识别图片 MIME 后改返回 image block，文本路径保持现状。
- B：新 ACI 工具（例如只读图），`read_file` 继续拒二进制。
- C：本切片只打通 adapter / 历史协议，入口仍靠用户文本里写路径（host 侧装配）——模型不调工具。

不在本票改代码。description 不是单独一档。

## Resolution

**B：新 ACI 工具读图，`read_file` 继续拒二进制。**

`read_file` 的分页、NUL、last-read、成功回执行号格式是一张文本契约；塞进 vision 会逼所有调用面改形状。SDK 真正要的是 `tool_result.content` 里的 `ImageBlockParam`，入口不必叫 `read_file`。

钉死（本票一并收 MIME/体积，不再另开票）：

- 工具名落地时再定英文标识；职责 = 围栏内指定 path → 一张图。
- 路径解析复用 `resolveReadTarget`（与 `read_file` 同围栏）。
- 只认 SDK stable `media_type`：`image/jpeg` | `image/png` | `image/gif` | `image/webp`（魔数，不看扩展名）。其它二进制仍拒。
- 体积顶沿用 `read_file` 的 1MB（先于编码）。
- 成功：`tool_result.content` 为 SDK `ImageBlockParam`（`source.type: "base64"`）。可附一条极短 text（path）便于人读 transcript，但像素权威在 image block。
- `safeContent` 必须为这条成功臂开洞：不得把 image 压成 JSON 字符串。其余工具仍只出 text。
- 不入 last-read ledger（那是文本覆写闸）。
- `encodeUserText` 不动。不把 image 放进消息顶层（session 顶层 schema 仍无 `image`）。

否决 A（扩 `read_file`）、C（host 从用户文本装配、模型不调工具）。
