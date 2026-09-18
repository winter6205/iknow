/**
 * src/harness/sandbox/egress/preset-domains.ts
 *
 * ADR-0104 §Decision 1 —— 代码承载的默认预放行档（builtin preset）。
 *
 * **清单 SSOT 仅此一处**（spec `specs/egress-preset-allowlist.md` invariant 1/2）：
 * 合并只发生在 assembly.ts，任何消费面不得再自行拼 preset。
 *
 * 语义要点：
 *   - apex 与 `*.x` 并列写 —— `*.x` 严格子域不含 apex 是 ADR-0097 实测语义，
 *     缺一漏面；
 *   - 模型供应商 API 域**显式不入档**（ADR-0104 §Decision 3：围栏内有 key，
 *     预放行 = secret 直传通道）——由 egress-assembly 测试反向钉住；
 *   - 收口原则（ADR-0104 §Decision 4）：只收「可重复构建 / 交付流」高频域，
 *     后续新增须对照该原则论证并走代码 review，不是配置开关
 *     （逃生通道 = 用户 `deniedDomains` 逐个砍，deny 优先）。
 */

/** 出厂预放行档：HTTPS git / PR API / 包管理主路径 / webui 测试浏览器二进制。 */
export const BUILTIN_PRESET_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "playwright.download.prss.microsoft.com",
  "cdn.playwright.dev",
]);
