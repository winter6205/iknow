/**
 * Harness-owned contract for the pre-write capture port (Gate B: the harness
 * declares the shape but never the session-api implementation — the host
 * injects an already-constructed `PreimageCapture`).
 *
 * The write tools call the port immediately before mutating the workspace with
 * the bytes on disk and the bytes about to be written. The host decides where
 * those bytes go (content-addressed blob + a ledger entry keyed for later
 * stamping onto the transcript). A throwing port aborts the write; the port
 * body must not be swallowed by the tool.
 */

import { relative } from "node:path";

/** One successful-write preimage observation, before the bytes hit disk. */
export interface PreimageCaptureInput {
  /** Anthropic `tool_use_id` of this call (from `ToolExecutionContext`); the
   *  host keys its ledger on it so the resulting `tool_result` event can be
   *  stamped. Absent (direct-handler / legacy test callers) → nothing to key. */
  readonly toolUseId?: string;
  /** Session the write belongs to; the host derives the blob folder from it. */
  readonly conversationId?: string;
  /** Path relative to the live task root the write resolved against. */
  readonly relPath: string;
  /** Project identity root the relative path is meaningful under. */
  readonly rootIdentity: string;
  /** Bytes currently on disk (empty for a create). */
  readonly preBytes: Buffer;
  /** Bytes about to be written. */
  readonly postBytes: Buffer;
}

export type PreimageCapture = (
  input: PreimageCaptureInput
) => void | Promise<void>;

/** Structural slice of the write tools' `Opts` the helper reads: the optional
 *  port plus the optional identity root. Each tool's opts interface satisfies
 *  it, so the handler passes its `opts` through with no optional chaining. */
export interface PreimageOpts {
  readonly preimageCapture?: PreimageCapture;
  readonly rootIdentity?: string;
}

/** Structural slice of `ToolExecutionContext` the helper reads for the
 *  transcript ids the host keys its ledger on. */
export interface PreimageCallIds {
  readonly toolUseId?: string;
  readonly conversationId?: string;
}

/** Where one write lands and what it changes. Bundled so the helper takes the
 *  same three arguments every write tool already has in hand (its opts, its
 *  call ids, this site) instead of four loose positionals. */
export interface PreimageWriteSite {
  /** Live task root the write resolved against — `relPath` is measured from here. */
  readonly rootAtCall: string;
  readonly absPath: string;
  readonly preBytes: string;
  readonly postBytes: string;
}

/**
 * Fire the pre-write capture seam, absorbing every `?.` / `??` branch so the
 * write handlers stay at their baseline complexity. A no-op when `opts`
 * carries no port (legacy / direct-factory callers). A throwing port
 * propagates, aborting the write at the callsite.
 */
export async function capturePreimageBeforeWrite(
  opts: PreimageOpts | undefined,
  call: PreimageCallIds | undefined,
  site: PreimageWriteSite
): Promise<void> {
  const capture = opts?.preimageCapture;
  if (capture === undefined) return;
  await capture({
    toolUseId: call?.toolUseId,
    conversationId: call?.conversationId,
    relPath: relative(site.rootAtCall, site.absPath),
    rootIdentity: opts?.rootIdentity ?? site.rootAtCall,
    preBytes: Buffer.from(site.preBytes, "utf8"),
    postBytes: Buffer.from(site.postBytes, "utf8"),
  });
}
