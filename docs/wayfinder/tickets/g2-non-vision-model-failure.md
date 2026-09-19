# G2 非 vision 模型怎么失败

- Map: [路径读图进 Anthropic vision（决策）](../path-image-vision-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-19 操作员授权代理裁)
- Blocked by: [R1 SDK 0.115 请求侧 image 形状](r1-sdk-image-request-shape.md), [G1 扩 read_file 还是新读图工具](g1-read-file-vs-read-image.md)

## Question

配置的模型不支持 vision 时，读指定图片怎么失败？本票不预选。G1 未裁前不裁。

- A：工具层 fail-closed（调用时就拒，不把 image 送上 wire）。
- B：送上 wire，吃供应商 4xx，按既有 transport / API error 面展示。
- C：降级成「无法作为图像阅读」的文本说明，继续跑。

不在本票改代码。不发明模型能力登记表，除非本票明确选要做。

## Resolution

**B：送上 wire，吃供应商 4xx，走既有 API error 面。**

本仓没有 vision 能力表。为模型 id 建 denylist 会误伤、也与「跟 Anthropic 依赖走」重复。工具 description 写明仅 vision 模型有用；调用层不预判。非 vision 与其它非法请求同一条失败面（ADR-0094 已有 `apiError`）。

否决 A（工具层能力闸）、C（降级成「无法当图像读」的文本继续跑——等于假装读过）。
