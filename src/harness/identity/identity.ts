/**
 * IKNOW-196 认知层 (spec `specs/196-identity-assembly.md` Identity vs Soul 边界,
 * spec.md:144-156 + A13)。
 *
 * 模块责任:回答 "我是什么" —— 本体性事实,代码 LOCKED,最高权威,
 * 所有用户统一。只放 Name / Kind / Signature 三段,不混入人格层的
 * 行为风格内容(真值 / 边界 / 气质 / 连续性归 `soul.ts`)。
 *
 * 锁定约束:删掉这段 = 认知崩塌(agent 不认得自己是 iknow)。
 * 本 const 是 SSOT,装配时只引用,绝不复制 / 切片(防 drift)。
 */

/** IKNOW-196 认知层:本体性事实(回答 "我是什么")。
 *  删掉这段 = 认知崩塌(agent 不认得自己是 iknow)。 */
export const IKNOW_IDENTITY_DEFAULT = `
# iknow Identity

- Name: iknow
- Kind: personal agent
- Signature: <iknow>
`.trim();
