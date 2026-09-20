/**
 * Keep slash candidates "hot at hand" (web half).
 *
 * Fetching `GET /api/v1/skills` once at mount does not meet the spec: the server
 * already answers from the current skill roots (hub-side rescan), but a
 * mount-only client never sees skills installed later — they would only show
 * up in `/` candidates after a full page reload.
 *
 * ## Why window focus, not polling or fetch-before-send
 *
 * - Polling: `/skills` is a pure disk read + full root scan; hammering the
 *   server continuously for a low-frequency event like "a skill was
 *   installed" is disproportionate. `useSubagentsPolling` / `useAsksPolling`
 *   poll session-scoped high-frequency state; the skill surface is not that.
 * - Fetch-before-send: would put a network round-trip on the critical send
 *   path. Returning to the page after installing a skill elsewhere (terminal /
 *   editor) *is* the focus signal, and it fires before any send — fresher and
 *   never blocking a send.
 * - focus also covers "came back after reload": skills installed while away
 *   appear on return.
 *
 * Failure does not clear known candidates (keep the last successful result):
 * one network blip should not empty the `/` surface; a first-fetch failure is
 * still an empty list (equivalent to the pre-change `setSkills([])`).
 */
import { useEffect, useState } from "react";
import * as api from "../api/client";
import type { SkillSummary } from "../api/types";

export function useSkills(): readonly SkillSummary[] {
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);

  useEffect(() => {
    // Discard responses that arrive after unmount / remount: a stale response
    // must never write into the new run's state (same alive-ref discipline as
    // useSubagentsPolling).
    let alive = true;
    const refresh = (): void => {
      void api
        .listSkills()
        .then((res) => {
          if (alive) setSkills(res.skills);
        })
        .catch(() => {
          // EXIT: refetch failed → keep known candidates (first failure = empty
          // list). Visibility is handled by existing composer behavior: candidates
          // stay as-is, no error banner.
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return skills;
}
