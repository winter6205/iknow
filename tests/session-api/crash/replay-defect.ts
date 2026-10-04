/**
 * The replay defect injected for the SC2 mutation control.
 *
 * This is a deliberately WRONG build of the loop engine, written to the copy
 * only, and it is meant to look like the regression the criterion exists to
 * catch rather than like an arbitrary breakage: after a session is reopened, the
 * host re-dispatches the `tool_use` blocks it restored from the checkpoint.
 *
 * It is injected at the one place dispatch converges. `runToolPhase` builds its
 * wave list solely from this turn's `projection.toolCalls`
 * (`src/harness/loop-engine.ts`), and that projection is built by the adapter
 * from the CURRENT response's content — so today a restored block cannot reach
 * the executor at all. The injection adds a second source: every `tool_use`
 * block in the turn's history that the current projection does not already
 * claim. Ids the live response owns are excluded so the turn still converges;
 * everything historical is replayed, which in the SC2 scenario is exactly the
 * restored block. Every downstream consumer — wave partitioning, the per-wave
 * `executeAll` call, the trace mapping — follows automatically, because they all
 * read the list built here.
 *
 * `afterAssistantState.messages` is the history including the current turn's
 * assistant message, so "not claimed by this turn's projection" is the precise
 * test for "came from the restored context".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The exact source line the injection replaces, asserted before replacing. */
const ANCHOR = `  const toolCallViews = opts.turnResult.projection.toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: c.input,
  }));`;

const REPLACEMENT = `  const toolCallViews = [
    ...opts.turnResult.projection.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      input: c.input,
    })),
    // ---- INJECTED REPLAY DEFECT (mutation control; not product code) ----
    // A reopened host must NOT re-dispatch the tool_use blocks it restored from
    // the checkpoint. This build does exactly that, by adding every historical
    // tool_use the live turn has not already claimed as a fresh call.
    ...(() => {
      const live = new Set(
        opts.turnResult.projection.toolCalls.map((c) => c.id)
      );
      const replayed: Array<{ id: string; name: string; input: unknown }> = [];
      for (const message of opts.afterAssistantState.messages) {
        if (message.role !== "assistant") {
          continue;
        }
        for (const block of message.content) {
          if (block.type === "tool_use" && !live.has(block.id)) {
            replayed.push({
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
      }
      return replayed;
    })(),
  ];`;

/**
 * Write the replay defect into a copied tree. Throws if the anchor is not
 * found verbatim, or found more than once: a silently-unapplied mutation would
 * make the control report a green mutant run, which is worse than no control.
 */
export function injectReplayedRestoredToolCalls(copyRoot: string): void {
  const path = join(copyRoot, "src/harness/loop-engine.ts");
  const source = readFileSync(path, "utf8");
  const occurrences = source.split(ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `replay-defect anchor matched ${occurrences} times in the copied loop-engine.ts; expected exactly 1`
    );
  }
  writeFileSync(path, source.replace(ANCHOR, REPLACEMENT), "utf8");
}
