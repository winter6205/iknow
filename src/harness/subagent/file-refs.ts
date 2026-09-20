/**
 * Derivation of `envelope.fileRefs` — fills the write-side gap where the field
 * was declared on `SubAgentEnvelope` / `PARENT_SCHEMA` but never populated,
 * so parents always received envelopes without fileRefs.
 *
 * Source of truth = `tool_use` blocks in `RunResult.messages` (the append-only
 * authoritative history): when the tool name is in the write set, take
 * `input.path`. The write set itself is derived from the ACI catalog via
 * `aci.category === "write"` (`writeToolNamesFrom`) rather than hardcoded
 * here, so new write-class tools join automatically.
 *
 * Known boundaries (deliberately uncovered):
 *   - `bash` is `execute` class; files written via shell redirection / `tee`
 *     cannot be recovered from tool_use input and are excluded;
 *   - `memory_save` / `todo_write` / `bash_stop` are write-class but carry no
 *     `path` in their input, so the path filter drops them naturally.
 *
 * Pure function, zero IO: no stat / realpath / on-disk checks — fileRefs is an
 * observational projection of "paths the subagent claims it touched", not a
 * filesystem assertion.
 */

import type { AciCatalog } from "../aci/types.js";
import type { AnthropicNativeMessage } from "../model-adapter/types.js";

/** All tool names with `category: "write"` in the ACI catalog (derived, not hardcoded). */
export function writeToolNamesFrom(catalog: AciCatalog): ReadonlySet<string> {
  const out = new Set<string>();
  for (const def of catalog.all()) {
    if (def.aci.category === "write") out.add(def.name);
  }
  return out;
}

/**
 * Scan `tool_use` blocks in the authoritative history, collecting `input.path`
 * of write-class tools.
 *
 * Deduplicated in first-occurrence order (a file edited several times yields
 * one entry; the order is the subagent's touch order). Any malformed shape
 * (non-object input / non-string path / empty path) is skipped, never thrown —
 * observational derivation must not turn a successful subagent run into a
 * protocol error.
 */
export function deriveFileRefs(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  writeToolNames: ReadonlySet<string>
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (!writeToolNames.has(block.name)) continue;
      const input = block.input;
      if (input === null || typeof input !== "object") continue;
      const filePath = (input as Record<string, unknown>).path;
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      out.push(filePath);
    }
  }
  return out;
}
