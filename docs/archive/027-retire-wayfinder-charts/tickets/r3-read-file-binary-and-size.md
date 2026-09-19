# R3 read_file 二进制闸与图片体积

- Map: [路径读图进 Anthropic vision（决策）](../path-image-vision-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved
- Blocked by: —

## Question

现行 `read_file` 对「指定路径的 png/jpeg」会怎样？只陈述本仓事实：

1. 拒二进制的判据（NUL？content-type？扩展名？）。
2. 1MB / 16000 code point / 行分页这些顶对图片有没有意义。
3. 成功回执是不是永远按「行号 + tab + 文本」编码，有没有别的 payload 形状。
4. permission / 围栏路径解析是否与文本读共用（指定路径能不能进同一套 `resolveReadTarget`）。

不写产品代码。不预选扩 `read_file` 还是新工具。

## Resolution

1. **唯一二进制闸 = buffer 含 `0x00`。** 不看扩展名、不看 MIME。
2. **1MB 在 NUL 闸之前**，超大图先体积失败。16000 cp / 行分页只在无 NUL 之后才走到，典型 png/jpeg 到不了。
3. **成功 payload 永远是 string**（行号+tab、空文件提示、截断 trailer）；无 image/base64 成功体。二进制是 throw，不是成功回执。
4. **路径与文本读共用 `resolveReadTarget` / `resolveWithinRoot`。** 无图像旁路。
