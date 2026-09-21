# 0086. Runtime capability observation must not become durable memory

Date: 2026-09-11
Status: accepted

If one environment snapshot (egress, DNS, whether some tool works right now) is saved as a `constraint` and later recalled, the model will skip that run's live tool probe. The authority for capability facts is the current tool result, not the memory store.

Therefore: `memory_save` and the extraction persist share a **runtime capability persist gate** — an observation judged to be about capability / environment availability is typed-rejected at write time, not silently NOOPed, not rewritten into a `note` to get it into the store first. Existing entries go through read-side filtering plus a **capability memory sweep** (gated together with the extraction default of 3 `completed`; best-effort after exit). `SUPERSEDE` is not returned to in-session save, the extraction CONTRADICTION_FLOOR is not restored, and no "store only if useful" blanket filter is added. Product/policy `constraint` entries remain writable.

**Why not only add a TTL / only change the prompt:** a TTL guesses lifetime and hollows out the meaning of `constraint`; wrapper prose cannot stop a high-importance false gate. **Why not synchronous GC at startup:** it delays the first packet; before the session ever sees the memory, read-side filtering suffices.

ADR-0031 D1/D5 amended the same day.
