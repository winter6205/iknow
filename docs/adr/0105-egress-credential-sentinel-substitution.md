# 0105. 出口凭据 sentinel 代换：真值不进围栏，代理出口仅对放行域假换真

Date: 2026-09-19
Status: accepted

> **Scope（ADR-0107）**：代理闸恢复后本决策技术上可落地，但 **0107 不自动启用 sentinel**。曾被 0106 标 superseded；0106 已废。

## Context

ADR-0104 放开了数据面（预放行档），凭据面姿态悬而未决。既有 **secret-roundtrip mask** 只保护**可见面**：真值在围栏内（执行时还原），模型可见面（工具输出 / trace / 回显）被掩码——它防不住围栏内代码「不看见也能用」：把真值塞进放行域上的任意数据出口（gist / repo / issue）即可外带，全程不经过任何模型可见输出，域白名单防不住「滥用放行域」（与 ADR-0097 承认 domain fronting 不可防同族）。实测事故（2026-09-18，conversation `ee13c787`）证实围栏内 `gh` / git push 对凭据的真实需求：若 HTTP 系凭据以真值形态进围栏，与放行域组合即成完整外泄通道。

## Decision

出口凭据姿态采用 **sentinel 代换**（HTTP(S) 系凭据：`GH_TOKEN` 类 env 与凭据文件形态）：

1. 围栏内只有**假值（sentinel）**——`[a-z0-9_-]` 精确匹配字节串，可原样穿过 JSON / form-urlencoded / multipart / XML（宿主侧纯字节扫描即可定位，无需解析请求格式）；JWT 形凭据铸同形假值（提取模式 + 结构校验防误伤随机 base64）。
2. 真值仅存在于宿主侧出口代理；**出口处仅对放行域**做假换真（headers 代换 + body 流式代换，body 不整体缓冲，内存以单 chunk + sentinel 长度回持为界）。
3. 代换方向恒 **fake→real**：任何漏代换（压缩体、base64 包裹、被编码器拆散）= 假值原样到达 API = 认证失败，**永不为真值泄露**——失败方向是设计出来的。
4. 代理需 **TLS 终止**（mitmCA）才能见请求明文；围栏内客户端经环境注入信任代理 CA。mitmCA / sentinel / body-substitution 模块均为 pin 依赖 `@anthropic-ai/sandbox-runtime` 内现成件——无新增第三方依赖（node-forge 已在模块加载图上，ADR-0097 实测记录）。
5. **SSH 凭据不在本决策内**：私钥可读性与 `SSH_AUTH_SOCK` 形态归出口 ssh 桥（ADR-0097 形态扩展）；key 进围栏的姿态沿用「出口域限制兜底」（key 只能用于向放行域认证）。
6. 既有 secret-roundtrip mask（可见面）**保留**，两层并存不互替：sentinel 管**存在面**，mask 管**可见面**。

## Why not

- **真值进围栏 + 输出掩码（现状延伸）**：mask 防模型的眼，不防围栏内代码的手；真值 + 放行域 = 外泄通道常在。拒。
- **凭据完全不进围栏（PR 创建等 API 操作留宿主侧代做）**：回避而非解决——agent 在围栏内无法自助 API 类操作，无人值守形态无从谈起。作为 ssh 桥与 sentinel 层落地前的过渡形态可接受，不作为终态。拒。

## Consequences

- TLS 终止是新信任面：CA 私钥的生成 / 权限 / 生命周期、重签证书的范围（是否仅限放行域）必须由 spec 钉死；围栏内不信任代理 CA 的客户端（硬 pin 证书者）表现为连接失败，fail-closed。
- 不可代换形态（`Content-Encoding` 请求体等）退化为认证失败并告警——fail-safe 方向，接受。
- 凭据文件形态需要「宿主读真值 → 铸 sentinel → 生成掩码版文件 bind 进围栏」的启动期流程；真值文件永不进围栏。
- 与 secret-roundtrip mask 的边界：sentinel 假值不是 secret，不得触发 mask 识别层；双重代换要由 spec 钉子防住。
- LLM API 域不入预放行档（ADR-0104）的理由在本决策下依然成立且更强：即便未来放行，模型供应商 key 也应走 sentinel 而非真值进围栏。

## Evidence pointers

- pin 依赖包内参考实现：`node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/body-substitution.js`（流式 fake→real + 失败方向注释）、`credential-decode.js`（JWT 提取 / 校验 / 同形假值铸造）、`credential-sentinel.js`（`SENTINEL_PREFIX`）、`http-proxy.js`（SentinelRegistry headers 代换；`:271` SSH 例外注记）、`mitm-ca.js`。
- 会话 `ee13c787` transcript（2026-09-18）：`gh auth status → X Failed to log in`（围栏内凭据真实需求）。
- `docs/adr/0097-*.md` §Trade-offs（domain fronting 不可防）；`docs/adr/0104-*.md`（「围栏内有 key，预放行 = secret 直传通道」同款逻辑）。
- `docs/CONTEXT.md`「secret-roundtrip mask」（可见面现状）。
