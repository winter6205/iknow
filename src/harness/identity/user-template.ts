/**
 * Seed template for `~/.iknow/user.md`.
 *
 * Responsibility: the placeholder template written on first start. Five
 * sections mirror ohmo's USER_TEMPLATE: Profile / Defaults / Ongoing context /
 * Preferences / Notes. Written only when user.md does not exist (eager +
 * idempotent — `initializeIknowWorkspace` guards with if-not-exists and never
 * overwrites user edits).
 *
 * user.md is the user-editable segment, read verbatim at assembly time; the
 * user persona goes through the `user_profile` segment and is overridden by
 * PRIORITY. Every field is a placeholder for the user to replace on demand.
 * This const is the SSOT — referenced at assembly time, never copied or
 * sliced (drift prevention).
 */

/** user.md seed template (Profile / Defaults / Ongoing / Preferences / Notes). */
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
