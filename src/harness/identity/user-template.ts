/**
 * IKNOW-196 user.md seed 模板 (spec `specs/196-identity-assembly.md`
 * Project Structure 段,spec.md:84 + Boundaries 段)。
 *
 * 模块责任:首启时 seed `~/.iknow/user.md` 的占位模板。五段结构对位
 * ohmo USER_TEMPLATE:Profile / Defaults / Ongoing context / Preferences /
 * Notes。仅当 user.md 不存在时写入(eager + idempotent,
 * `initializeIknowWorkspace` 用 if-not-exists 守卫,不覆盖用户已改)。
 *
 * user.md 是用户可改段,装配时纯净读;用户画像走 `user_profile` 段,
 * 被 PRIORITY 压过。每个字段是 placeholder,用户按需替换。
 * 本 const 是 SSOT,装配时只引用,绝不复制 / 切片(防 drift)。
 */

/** IKNOW-196 user.md seed 模板(Profile / Defaults / Ongoing / Preferences / Notes)。 */
export const USER_TEMPLATE = `
# User Profile

## Profile
- Your name / handle: <what should I call you?>
- Working context: <company? role? domain?>

## Defaults
- Primary language: <e.g. English / 中文>
- Preferred output: <terse / standard / thorough>
- Default working directory: <path you usually want me in>

## Ongoing context
- Active projects: <1-3 lines, one per project>
- Current priorities: <what's on fire right now?>

## Preferences
- Tools to prefer: <e.g. prefer git over manual edits>
- Formatting / style likes: <e.g. no emojis, aligned tables>
- Avoid: <explicit non-behaviors>

## Notes
- <anything else worth remembering>
`.trim();
