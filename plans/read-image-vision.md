# Plan: 路径读图进 Anthropic vision

**Goal:** 围栏内指定路径的 jpeg/png/gif/webp 经 `read_image` 进入 `tool_result` 的 SDK `ImageBlockParam`，下一轮 `step` 原样上 Anthropic wire；`read_file` 文本契约不变。
**Approach:** 先打通 executor 直通臂与 handler 的可观测成功/失败，再挂进 ACI Gate 3，然后锁会话往返、估算非零、last-read/D9/TUI。不改 `encodeUserText`，不建 vision 能力表。
**Spec link:** `specs/read-image-vision.md`
**ACR:** all-yes（与 spec 块相同）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)
**待写入:** 空（CONTEXT 已在 spec persist 刷完；无 ADR）

## ACR

```
bounded-context-guardian: yes — 无新 BC：工具落 ACI + executor 直通臂 + compress estimate（仍 harness）；TUI 只改既有名册；ACI_TOOLSET_NAMES 尾部 append-only
input-contract-tests: yes — 公共入口 read_image({path})：empty/非法/越栏=SC4，负例魔数=SC3，overflow>1MB=SC4，ENOENT/目录=SC4；concurrent N/A（不入 last-read；executor 串行）
error-handling-enforcer: yes — 目录/ENOENT/>1MB/非四类魔数均 ToolExecutionError 且不写盘不编图；失败臂仍 text；非 vision 走既有 API 4xx；SC5 钉 safeContent 洞不泄漏
complexity-anti-drift: yes — 独立 read_image 文件（不塞进 read-file.ts）；registry 只追加一名；handler 管魔数/体积，executor 只识别 image block 直通
minimal-change-verifier: yes — 单任务「路径读图经 Anthropic native tool_result」；贴图/MCP/web_fetch/顶层 user image 划出
```

## Tasks (ordered by dependency)

1. **Executor 直通 + `read_image` 经执行器可见** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC5；image 只活在 `tool_result.content`；`safeContent` 仅该成功臂开洞；失败仍 text；体积顶与 `read_file` 同档 1MB；魔数 ∈ jpeg/png/gif/webp；路径围栏与 `read_file` 同语义
   - **Surface:** `src/harness/tools` executor；`src/harness/aci/tools` 新读图工具（不改 `read_file` 成功形状）
   - **Acceptance:** 经 executor 跑成功读图：编码后的 tool_result 含 SDK 形状 image block；同一 PNG 的 `read_file` 仍二进制拒绝；空 path / 越栏 / ENOENT / 目录 / >1MB / 非允许魔数 typed 失败且无 image；其它工具成功仍纯 text。相关 `npm test` 路径绿
   - Status: [x] done — 1c4dcb64（executor 名字闸+形状闸直通臂；read-image.ts 魔数/1MB/围栏 typed 失败）+ 98bddcfc（review 修复）；read-image.test 19+1 例、executor.test +6 例绿

2. **ACI 名单尾部挂上 `read_image`** — tag: `[implementation]`
   - **Inherits:** spec SC6；`ACI_TOOLSET_NAMES` append-only + Gate 3 与 factories 同序；默认 `createDefaultAciRegistry` 常驻（无缺席条件）
   - **Surface:** `src/harness/aci/tools` registry
   - **Acceptance:** 装配不抛 Gate 3；默认注册表 `has("read_image")`；ask/tui/serve 共用该工厂的入口不另写名单
   - [blocks: T1]
   - Status: [x] done — bbb25520；registry.test Gate 3 46 件锁 + 9 个计数/顺序断言文件收敛为 SSOT 派生；d9-description-guard 绿

3. **会话往返仍带嵌套 image** — tag: `[implementation]`
   - **Inherits:** spec SC7–SC8；顶层 content 仍无 `type: image`；`buildMessageParams` 不剥 `tool_result.content`；assistant image 仍 ProtocolError
   - **Surface:** `src/session-api/store` schema/sanitize；`src/harness/model-adapter`
   - **Acceptance:** 含嵌套 image 的 session 文件 sanitize → save → load 后块仍在；再走 `buildMessageParams` 的 messages 仍含该 image；既有 assistant image ProtocolError 测试仍红不了
   - [blocks: T1]
   - Status: [x] done — fbf1ac1c；nested-image-roundtrip.test 4 例（真实 SessionStore temp dir + fresh id）绿；零 src 改动纯测试锁

4. **compact 估算嵌套 image 非零** — tag: `[implementation]`
   - **Inherits:** spec SC9；公式不钉，只要 `> 0` 且 `evaluateCompactTrigger` 不抛
   - **Surface:** `src/harness/compress` 现行估算入口
   - **Acceptance:** 仅含嵌套 image、无 text 的 tool_result 估算 `> 0`；trigger 求值不抛
   - [blocks: T1]
   - [parallel] 可与 T3 并行
   - Status: [x] done — fb909fe6；estimate/trigger 测试锁（FALLBACK=1 token 已非零）；零 src 改动

5. **产品锁：last-read / D9 / TUI / 名册** — tag: `[implementation]`
   - **Inherits:** spec SC2、SC10、SC11；`read_image` 不入 last-read；description D9 STATIC；prompt-development 轨迹集登记不建；TUI retract 且不摊像素（未注册名已缺省 retract，本票显式登记以免 summary 空洞）
   - **Surface:** last-read 入账缝；D9 description guard；`src/tui` settled/summary 名册；`docs/guides/prompt-development.md` 已改行只需测试锁住
   - **Acceptance:** 成功 `read_image` 后 last-read 仍无该 path；D9 覆盖新工具 description；TUI 对该名 `settledClassOf === "retract"` 且无像素预览通道；`read_file` 对 PNG 回归仍拒
   - [blocks: T2]
   - Status: [x] done — 68fa8f87；read-image-last-read.test 2 例 + tool-settled 显式 retract 登记 + isLiveNoise 派生锁；D9/SC2 既有用例复跑绿

## Landing（收尾登记）

- **commits:** 7f62bf4b(docs) → 1c4dcb64(T1) → bbb25520(T2) → fbf1ac1c(T3) → fb909fe6(T4) → 68fa8f87(T5) → 98bddcfc(review 修复)
- **code-review:** Standards 0H/3M/3L + Spec 0H/0M/1L → GATE PASS。已修：M1 loop-detect image 指纹化（resultKey 不收像素，sha256 判等 + 6 锁测试）、M2 media_type 名单单源（read-image.ts 导出，executor 派生 Set）、L(PNG) 魔数补满 8 字节签名、L(identity-root) 收窄 why 注释。
- **review follow-up（登记不修）:** ① executor 名字闸 `IMAGE_PASSTHROUGH_TOOL_NAME` 为可辩护 containment（SC5 背书）；第二个直通内容类型出现时收敛为 ToolDefinition 声明式字段（如 `contentShape`）。② `readRoot`/1MB 常量与 read-file.ts 轻度重复，可在后续 cleanup 上收 helpers。
- **真实交互证据（TUI + 真实模型，Opus 4.8 经网关）:** 模型自主选型调用 read_image；会话权威历史落盘 image block（media_type=image/png, data 232 chars）；trace llm_call 捕获的上 wire 请求原文含 SDK ImageBlockParam；TUI retract 生效（屏上仅 `called read_image × 1`，无像素摊屏）；`npm run test:real-llm` 17 passed / 1 skipped（egress push 环境门控）。
- **环境差异登记:** 本机 `ANTHROPIC_BASE_URL` 第三方中继把 tool_result 内 image block 降级为文本 base64 交给模型（tool_use id 为 OpenAI 风格 `call_*`），模型可见 base64 但无像素——非产品缺陷（spec 假设 8：非 vision 走既有 API error 面；该中继不 4xx 而文本化）。
- **附带观察（非本轮引入）:** 运行中 Escape 中断的回合以 protocolError 收尾且该轮历史回滚（ctx 26.8k→18.9k），与主仓在途 interrupt-round-visibility 调查同域。
