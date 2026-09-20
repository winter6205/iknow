/**
 * Cognitive layer.
 *
 * Responsibility: answer "what am I" — ontological facts, LOCKED in code,
 * highest authority, identical for all users. Only Name / Kind / Signature;
 * behavioral-style content belongs to the persona layer (`soul.ts`: core
 * truths / boundaries / vibe / continuity).
 *
 * Locked constraint: deleting this segment = cognitive collapse (the agent no
 * longer knows it is iknow). This const is the SSOT — referenced at assembly
 * time, never copied or sliced (drift prevention).
 */

/** Cognitive layer: ontological facts (answers "what am I").
 *  Deleting this segment = cognitive collapse (the agent no longer knows it is iknow). */
export const IKNOW_IDENTITY_DEFAULT = `
# iknow Identity

- Name: iknow
- Kind: personal agent
- Signature: <iknow>
`.trim();
