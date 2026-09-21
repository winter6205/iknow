# 0054. Phase-2 back edges are drawn by the model on the graph; the host only executes, counts, blocks done, blocks spinning

Date: 2026-09-08
Status: accepted

Edges that loop back inside the graph are part of the decomposition: the model writes them into the graph it submits, and the host does not auto-wire failed work back upstream. The host walks the edges, counts effort on each node entry, refuses to re-run ids already done, and uses the effort seam to prevent infinite spinning. Phase 1 has no back edges and `validateGraph` still rejects cycles. No follow-up tickets; proceed to the phase-2 spec.
