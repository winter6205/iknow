# Spec: 路径读图进 Anthropic vision

**Status:** draft
**Basis:** wayfinder 地图 [路径读图进 Anthropic vision（决策）](../docs/wayfinder/path-image-vision-map.md)（G1–G3 已裁）；操作员授权代理裁 + 本回合要求写 spec/plan
**Surface:** ACI 读工具 + tools executor + session 落盘（`tool_result.content`）+ Anthropic adapter 原样上 wire

## Objective

让主会话（及共用默认 ACI 注册表的入口）能对**工作区围栏内指定路径**的图片调用工具，把像素作为 Anthropic SDK 0.115 的 `ImageBlockParam` 放进 `tool_result.content`，下一轮 `step` 原样到达 `messages.create` / `.stream`。用户仍只发文本（`encodeUserText` 不动）。`read_file` 的文本契约（NUL 拒二进制、行分页）不变。

成功：模型调 `read_image` 读一张 ≤1MB 的 jpeg/png/gif/webp，权威历史里出现 SDK 形状的 image block，resume 后再 `step` 仍带同一块；非图二进制与超限仍 typed 失败。

## Assumptions（已确认，不再等回复）

操作员已裁目的地与 G1–G3；本列表写入合同。

1. 钉 `@anthropic-ai/sdk` 0.115 的 stable `ImageBlockParam`（base64 + `media_type` ∈ jpeg/png/gif/webp）。不用 beta `file_id`。
2. 新 ACI 工具名冻结为 **`read_image`**。不扩 `read_file`。
3. 路径解析与 `read_file` 共用同一套围栏（`resolveReadTarget` / `resolveWithinRoot` 语义）。
4. MIME 用魔数，不看扩展名。
5. 体积顶 = 现行 `read_file` 的 1MB，在编码前判定。
6. 成功 payload 活在 **`tool_result.content`**，不把 `{ type: "image" }` 放到消息顶层（session `isValidContentBlock` 顶层无 image）。
7. `safeContent` **仅**为 `read_image` 成功臂开洞；其余工具仍压成 text。image 臂不适用 ADR-0006 的字符硬顶（那是文本度量）。
8. 不建模型 vision 能力表；非 vision 送上 wire，4xx 走既有 API error 面。
9. 权威历史持久化 SDK base64（嵌在 `tool_result`）；adapter 不按 path hydrate。
10. `read_image` **不入** last-read ledger。
11. TUI：与 `read_file` 同属 retract / live noise；不摊像素。
12. 子代理 / worker：跟默认 `createDefaultAciRegistry` 走，不单开缝。
13. 贴图、MCP image 透传、`web_fetch` `image/*`、生成图、助手输出 image：本 spec 不做。

## Boundaries

- **Does:**
  - 新增 `read_image`：input `{ path: string }`；成功则 `tool_result.content` 含一条 `{ type: "image", source: { type: "base64", media_type, data } }`（可另附极短 text 标 path，像素权威在 image block）。
  - 魔数只放行 jpeg/png/gif/webp；其它含 NUL 或非允许魔数的文件 typed 拒绝（与「当文本读」失败可区分）。
  - `stat` 目录 / ENOENT / >1MB：typed `ToolExecutionError`，不写盘、不编 image。
  - executor 成功臂识别图像 content blocks 并原样交给 `encodeToolResults`；失败臂仍 text。
  - `ACI_TOOLSET_NAMES` **append-only** 追加 `read_image`（Gate 3：名单与 factories 同序）。
  - `read_file` 对同一 png：仍 NUL 拒二进制（回归）。
  - session save/load：嵌在 `tool_result.content` 的 image 往返后形状可再上 SDK。
  - description：D9 STATIC 锁；轨迹集 **登记不建**（无选型分歧，硬闸在 handler + schema）。
  - compact / token 估算：含嵌套 image 的 messages **不得估成 0**（公式不钉，只要非零且 evaluateCompactTrigger 不崩）。
- **Confirms with human:** （none — 假设门已关）
- **Out of this spec:**
  - TUI / Web 用户贴图、剪贴板。
  - MCP `type: "image"` 透传。
  - `web_fetch` 放行 `image/*`。
  - 助手回合 `image`（既有 ProtocolError 保持）。
  - 改 `encodeUserText` / 用户消息顶层 image。
  - 模型能力登记表、按 model id 预拒。
  - last-read 入账、`write_file` 闸语义。
  - 图片 token 精确公式、compact 优先丢图策略。
  - TUI 新 UI 展示缩略图。
  - 供应商无关第二套 content model。

## Success Criteria

每条均可 `vitest` 绿/红（实现落点由 plan 选测试文件，不在本 spec 发明路径当合同）。

- **SC1** `read_image` 对魔数为 PNG/JPEG/GIF/WEBP 且 ≤1MB 的文件：ok 的 `tool_result.content` 含 `type === "image"` 且 `source.type === "base64"` 且 `media_type` 落在 SDK 四值内，`data` 非空。
- **SC2** 同一 PNG 调 `read_file`：仍 `binary file rejected`（或现行等价 typed 文案），不返回 image。
- **SC3** 含 NUL 但非四类魔数（或无法识别为允许图）：`read_image` typed 失败，不产出 image block。
- **SC4** `path` 空 / 非字符串 / 越围栏 / ENOENT / 目录 / size>1MB：typed 失败，无 image。
- **SC5** 其它 ACI 工具成功路径仍只产出 text tool_result（`safeContent` 洞不泄漏）。
- **SC6** `ACI_TOOLSET_NAMES` 含 `read_image` 且与 factories Gate 3 一致；缺席装配条件若无则常驻。
- **SC7** 将含该 `tool_result` 的 `SessionFileV1` sanitize → save → load 后，嵌套 image 仍在，`buildMessageParams` 不剥掉。
- **SC8** `interpretMessage` 对 assistant `image` 仍 ProtocolError。
- **SC9** `estimateMessagesTokens`（或现行 compact 估算入口）对仅含嵌套 image、无 text 的 tool_result：**结果 > 0** 且 `evaluateCompactTrigger` 不抛。
- **SC10** `read_image` 成功不把 path 写入 last-read ledger（随后对无关文本文件的 `write_file` 闸行为不因读过图而改变；读过图的 png 覆写不因本工具入账而放行——本工具根本不入账）。
- **SC11** description 进入 D9 STATIC 锁；`docs/guides/prompt-development.md` 名册为该工具补一行：STATIC + 轨迹集登记不建。

## Open Questions

(none)

## Inherits / Changes

### 引用 CONTEXT.md（原文，不重定义）

**ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；**基线 8 件**（`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`）之后按 append-only 批次增长（memory 2 / skill / subagent / todo / mcp / bg / run_graph / trace 读侧 / **符号工具面** 15 / worktree 5 …）。**当前件数以 `src/harness/aci/tools/registry.ts:ACI_TOOLSET_NAMES` 数组长度为唯一 SSOT，本词条不复述数字**（该文件自己声明「本表长度以数组为 source of truth」）。SSOT 工厂 = 同文件 `createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。

**last-read ledger**: 本 conversation 内「看过的规范 path」登记表。**进程内存**，键为 conversationId，不落会话文件夹。入账：成功 `read_file`，或成功且可抽单一 path 的白名单 `bash`（`cat` / `nl` / `bat` / `batcat` / `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`；单文件、无管道、无重定向）。只供已存在且 size>0 的 `write_file` 查表，没有则硬拒不写盘；新建与空文件免检。`edit_file` 不查表。不扫 `ctx.messages`。无 conversationId 则非空覆写 fail-closed。resume 空表。ADR-0084。

**retract class（收）**: 落定后不摊正文预览的工具类（读 / 多数搜 / 查询）。live 是否进过程块改问 **live noise**，不是本表整表折进 `calling`。`read_file` 仍不摊文件内容；`web_search` / `web_fetch` 走 **live signal**。

### 本仓已有、合同依赖的缝

- `encodeUserText` 只编 text user message；`buildMessageParams` 滤 system 后 `as MessageParam[]` 原样上 wire。
- `safeContent`（`src/harness/tools/executor.ts`）今日把成功 payload 压成 `[{ type: "text", text }]`。
- `AnthropicContentBlock` 无顶层 `image`；`tool_result.content` 为 `unknown`；session `isValidContentBlock` 对 `tool_result` 不递归校验 content。
- `read_file`：NUL → binary rejected；`MAX_FILE_BYTES` 1MB。
- SDK `ToolResultBlockParam.content` 允许 `ImageBlockParam`。
- 提示词：`docs/guides/prompt-development.md` — 说明书不是闸；新工具 description 走 D9 STATIC。

### Changes（相对现状）

- ACI 增 1 件 `read_image`（append-only）。
- executor 增加图像 content 直通臂（仅该工具成功路径）。
- compact 估算对嵌套 image 非零（SC9）。
- TUI retract / live noise 名册纳入 `read_image`（与 `read_file` 同类）。

### 待写入（persist）

- CONTEXT：**ACI tool set** 增长批次加 `read_image`（仍不在词条复述件数）；**last-read** _Avoid_ 或正文标明 `read_image` 不入账；**retract / live noise** 点名 `read_image` 与 `read_file` 同类。
- ADR：本切片不新开 ADR（协议不改顶层 `AnthropicContentBlock`；失败走既有 `ToolExecutionError` / API error）。若落地时必须改顶层联合，再开 ADR 并停在 persist。

persist（spec Step 4）：上列 CONTEXT 已写入本 worktree `docs/CONTEXT.md`（含新词 **read_image**）。无新 ADR。

## architecture-change-reviewer

```
bounded-context-guardian: yes — 无新 BC：工具落 ACI + executor 直通臂 + compress estimate（仍 harness）；TUI 只改既有名册；ACI_TOOLSET_NAMES 尾部 append-only
input-contract-tests: yes — 公共入口 read_image({path})：empty/非法/越栏=SC4，负例魔数=SC3，overflow>1MB=SC4，ENOENT/目录=SC4；concurrent N/A（不入 last-read；executor 串行）
error-handling-enforcer: yes — 目录/ENOENT/>1MB/非四类魔数均 ToolExecutionError 且不写盘不编图；失败臂仍 text；非 vision 走既有 API 4xx；SC5 钉 safeContent 洞不泄漏
complexity-anti-drift: yes — 独立 read_image 文件（不塞进 read-file.ts）；registry 只追加一名；handler 管魔数/体积，executor 只识别 image block 直通
minimal-change-verifier: yes — 单任务「路径读图经 Anthropic native tool_result」；贴图/MCP/web_fetch/顶层 user image 划出
```

OVERALL: PASS — hand to writing-plans
