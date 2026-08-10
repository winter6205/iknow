# teach Skill — Test Harness & Evaluation Spec

**Target skill:** `productivity/teach` (user-invoked pedagogical meta-skill)
**Domain skill it may link to:** `ai-job-coaching-v2` (+ `resume-optimization-v2`, `interview-mock-v2`, `project-selection-v2`)
**Author of spec:** subagent (research-only; this file is NOT executed here)
**Purpose:** Define measurable success criteria + 24 representative test samples so a later harness run can mechanically grade `teach`'s behavior.

---

## 0. How the harness runs (mechanics for the grader)

For each sample:

1. Start from a **fresh working directory** (the teaching workspace = CWD). Pre-seed any state files the sample requires (e.g. an existing `MISSION.md`, prior `./lessons/`, `./learning-records/`) exactly as described in the sample's `precondition`.
2. Load the `teach` skill (and, for routing tests, the `ai-job-coaching-v2` family) into the agent context.
3. Feed `user_input` as the single user turn (no tool calls beyond what the skill itself invokes, e.g. opening a lesson file via CLI).
4. Capture:
   - **files**: full tree written under CWD (`MISSION.md`, `RESOURCES.md`, `NOTES.md`, `./lessons/*.html`, `./reference/*.html`, `./learning-records/*.md`, `./assets/*`).
   - **message**: the agent's final natural-language reply to the user.
   - **routed_skill**: which skill (if any) the agent actually executed/deferred to.
5. Score against the sample's `pass_if` / `fail_if` checks. A sample PASSES only if **all** `pass_if` hold and **no** `fail_if` holds.

**Scoring convention:** every check is a boolean a grader can assert programmatically (file exists / regex on file content / substring in message / skill-routing fact). No subjective grading.

---

## 1. SUCCESS CRITERIA (global, apply to every sample)

### (a) Correctness of teaching output

A `teach` firing is **correct** iff, when it produces artifacts:

- `MISSION.md` exists and matches the `MISSION-FORMAT.md` template (`# Mission:`, `## Why`, `## Success looks like`, `## Constraints`, `## Out of scope`).
- Every lesson is one self-contained **HTML** file in `./lessons/`, filename `NNNN-slug.html` with zero-padded sequential numbering continuing from existing lessons.
- Each lesson HTML contains: (i) a single tightly-scoped topic tied to the mission, (ii) at least one external resource **citation/anchor link**, (iii) a "recommended primary source" pointer, (iv) an explicit reminder to ask the agent follow-up questions, (v) at least one HTML anchor link (`href="#..."` or `href="...html`) to another lesson or a `./reference/` doc.
- `RESOURCES.md` (when created) follows `RESOURCES-FORMAT.md`: a `# {Topic} Resources` heading with `## Knowledge` and `## Wisdom (Communities)` sections; every entry annotated with a "use for" line.
- `./learning-records/` entries (when created) follow `LEARNING-RECORD-FORMAT.md`: `NNNN-slug.md`, a `# title` + 1–3 sentence body; numbering continues from existing records.
- `./reference/*.html` are well-formed HTML, printable-oriented (a `<style>`/layout present), not raw markdown.
- `./assets/` contains at least a shared stylesheet (`*.css` or inline `<style>` reused via link) once ≥2 lessons exist.
- `NOTES.md` records stated user preferences when given.
- **Domain independence:** `teach` embeds NO domain knowledge of its own. For the AI-job-hunting topic it must _reference_ `ai-job-coaching-v2` by **path/pointer** (e.g. "see skill `ai-job-coaching-v2`"), never by inlining that skill's curriculum/content into lessons.

### (b) Skill adherence (structure)

- **Mission-first:** if `MISSION.md` is absent or the user's mission is unclear, `teach` asks clarifying "why" questions and does **NOT** emit lessons until a mission is captured (or a draft mission is explicitly confirmed).
- **Resource-gathering:** before asserting non-trivial knowledge claims, `teach` populates or is actively populating `RESOURCES.md` (high-trust, annotated). It must not rely solely on parametric knowledge when the topic has a known resource surface.
- **Zone of proximal development (ZPD):** lesson topic selection is justified by reading `./learning-records/` (or stated prior knowledge) and the mission — the chosen lesson is the "just-enough" next step, not a random/advanced leap.
- **Lesson format discipline:** lessons stay short, single-win, and include a retrieval-practice or spacing element (quiz / recall prompt / scheduled review hint) where the topic is skill-based.
- **Learning-records discipline:** a learning record is written only on _demonstrated_ understanding / disclosed prior knowledge / corrected misconception / mission shift — NOT for mere coverage.

### (c) Skill triggering (user-invoked only)

- `teach` **fires** iff the user input contains an explicit teaching invocation signal: literal `/teach`, "teach me", "教我", "I want to learn", "help me learn", "show me how to learn", or equivalently explicit "be my teacher / mentor me on X".
- `teach` **must NOT auto-fire** on general Q&A, operational requests, chit-chat, or implicit topics.
- **Deployability requirement (finding):** the shipped `teach/SKILL.md` frontmatter currently declares only `name` / `description` / `metadata.hermes.tags`. To enforce user-invocation it MUST also declare `disable-model-invocation: true` in frontmatter. The harness flags a global FAIL if that key is absent. (This is the mechanism that makes "should not fire on its own" enforceable rather than advisory.)

### (d) Accuracy (no hallucination, PDF-aware)

- When a PDF knowledge base is seeded into the workspace, every factual claim in lessons/reference docs traces to the PDF or to a `RESOURCES.md` entry — verifiable by citation.
- When **no PDF is present**, `teach` must NOT invent PDF contents. If asked a PDF-dependent question without a PDF, it states the PDF is absent and either (i) answers only from explicitly gathered `RESOURCES.md` entries, or (ii) proposes to gather resources — never fabricates "the PDF says…".
- Citations point to real, named sources (book/article/community with a URL or skill path), not placeholder `example.com` invented facts.

### (e) Routing (correct sub-skill for operational tasks)

- **Resume rewrite / optimization** → `resume-optimization-v2` (operational), NOT `teach`.
- **Mock interview now** → `interview-mock-v2` (operational), NOT `teach`.
- **Pick/select a concrete project for me** → `project-selection-v2` (operational), NOT `teach`.
- If the user asks `teach` to perform an operational task, `teach` **declines** the operational work and **routes** to the correct operational skill (does not silently do it, does not reject the whole request).
- `teach` may _point-link_ to `ai-job-coaching-v2` as a learning resource but must not be **merged** with it (no duplication of that skill's curriculum into `teach`).

---

## 2. TEST SAMPLES (24)

Legend: `TRIG=teach fires`, `NO_TRIG=teach must not fire`.
Types: `pedagogical-trigger` | `operational-trigger` | `negative-no-trigger` | `boundary` | `multi-session-state`.

---

### P01 — Canonical: learn AI job-hunting · type: pedagogical-trigger

- **precondition:** empty workspace.
- **user_input:** "I want to learn AI application development job-hunting. Teach me what projects to build to pass interviews and what frameworks/basics I need, like a mentor who checks each session whether my skill depth is enough to pass."
- **trigger_expectation:** TRIG.
- **expected_files:** `MISSION.md` (draft/interview in progress), `RESOURCES.md` (seeded with AI-job-coaching pointers + high-trust resources), `NOTES.md` (records "mentor checks session readiness" preference). `./lessons/` may be empty until mission confirmed.
- **expected_message_checks:**
  - Asks 1–3 "why / what does passing look like for you" clarifying questions (mission-first).
  - Mentions it will track readiness via `./learning-records/` and a mission file.
  - References `ai-job-coaching-v2` **by pointer/path**, not by pasting its curriculum.
- **pass_if:** TRIG ∧ message interviews for mission ∧ ai-job-coaching referenced by pointer (no inline curriculum) ∧ no lesson emitted before mission captured.
- **fail_if:** teach inlines job-coaching project list as its own lesson content; OR emits a lesson before establishing mission.

### P02 — Chinese-language invocation · type: pedagogical-trigger

- **precondition:** empty workspace.
- **user_input:** "教我AI应用开发求职，我想通过面试拿到AI应用工程师的offer，你当我的老师，每次提醒我技能深度够不够。"
- **trigger_expectation:** TRIG.
- **expected_files:** `MISSION.md` (Chinese, follows template: 为什么 / 成功样子 / 约束 / 范围外), `NOTES.md` (records Chinese-language + mentor-readiness preference), `RESOURCES.md` (zh or bilingual entries fine).
- **expected_message_checks:** replies in Chinese; conducts mission interview in Chinese; same structure as P01.
- **pass_if:** TRIG ∧ MISSION.md present and template-conformant ∧ Chinese reply ∧ ai-job-coaching pointer (Chinese path ok) ∧ no premature lesson.
- **fail_if:** refuses Chinese; OR writes mission in English only; OR fires wrong skill.

### P03 — Explicit `/teach` command · type: pedagogical-trigger

- **precondition:** empty workspace.
- **user_input:** "/teach me how to build a RAG system that would impress an AI hiring manager"
- **trigger_expectation:** TRIG (explicit slash command).
- **expected_files:** `MISSION.md` (interview for why-RAG-for-job-hunting), `RESOURCES.md` (RAG high-trust sources).
- **expected_message_checks:** recognizes `/teach`; does mission interview; does not treat as a "build the code now" operational request.
- **pass_if:** TRIG ∧ mission-first ∧ RESOURCES gathering started.
- **fail_if:** teach immediately writes a code project instead of a lesson plan; OR does not fire.

### P04 — Community / wisdom delegation · type: pedagogical-trigger

- **precondition:** workspace has `MISSION.md` (AI job-hunting) and `RESOURCES.md` (Knowledge only).
- **user_input:** "How do I really know if my portfolio project is good enough to land an offer? I need real feedback from people in the field, not just you."
- **trigger_expectation:** TRIG (pedagogical question requiring wisdom).
- **expected_files:** `RESOURCES.md` gains/updates `## Wisdom (Communities)` with ≥1 high-reputation community (e.g. r/LocalLLaMA, a relevant forum, or a local meetup) each annotated "use for: portfolio critique / reality check".
- **expected_message_checks:** attempts a direct answer first, then **delegates** to a community for real-world validation; lists concrete communities; keeps teaching posture.
- **pass_if:** TRIG ∧ RESOURCES Wisdom section populated with real communities ∧ message delegates to community ∧ no hallucinated community URLs.
- **fail_if:** only answers from parametric knowledge with no community delegation; OR invents a fake community.

### P05 — Out-of-domain topic (domain independence) · type: pedagogical-trigger

- **precondition:** empty workspace.
- **user_input:** "Teach me to play the guitar — basic chords and a first song."
- **trigger_expectation:** TRIG (valid teach topic; outside AI-job-coaching domain).
- **expected_files:** `MISSION.md` (guitar mission), `./reference/*.html` (chord chart / fretboard reference), `./lessons/0001-*.html` (first chords lesson) once mission set.
- **expected_message_checks:** builds a proper teaching workspace for guitar; **does NOT** pull `ai-job-coaching-v2` knowledge; does not mention AI/job-hunting.
- **pass_if:** TRIG ∧ guitar workspace built ∧ zero references to ai-job-coaching/resume/interview content.
- **fail_if:** teach refuses because "not AI domain"; OR leaks job-coaching curriculum into guitar lessons.

### P06 — Very long / rambling context · type: pedagogical-trigger

- **precondition:** empty workspace.
- **user_input:** (≈1200-word ramble about the user's background, frustrations with tutorials, a half-finished project, worries about layoffs) ending with: "…so, given all that, please teach me AI Agent development so I can get hired."
- **trigger_expectation:** TRIG.
- **expected_files:** `MISSION.md` (distilled from the ramble — concrete why: get hired as AI Agent dev), `NOTES.md` (captures background signals: has partial project, worried about layoffs, frustrated by tutorials).
- **expected_message_checks:** extracts the teaching intent from the long message; does mission interview grounded in the extracted context; does not try to "fix" the half-finished project operationally.
- **pass_if:** TRIG ∧ mission distilled from context ∧ NOTES captures background ∧ no operational project-fix.
- **fail_if:** misses the teach intent buried in the ramble; OR treats the ramble as a coding request.

### P07 — Pedagogical "teach me to pass interviews" · type: pedagogical-trigger

- **precondition:** empty workspace.
- **user_input:** "Teach me everything I need to pass AI application engineer interviews — concepts, system design, the works."
- **trigger_expectation:** TRIG.
- **expected_files:** `MISSION.md` (mission = pass AI app engineer interviews), `RESOURCES.md` (interview-prep knowledge sources), `./learning-records/` (maybe an initial record of stated goal/level).
- **expected_message_checks:** scopes the broad request into a mission + a spaced sequence (not one giant lesson); mentions ZPD assessment.
- **pass_if:** TRIG ∧ mission captured ∧ proposes spaced/sequenced lessons ∧ references interview resources.
- **fail_if:** dumps one massive lesson; OR routes to interview-mock-v2 immediately (that's operational — should still be teach-led here since user said "teach me").

### O01 — Operational: rewrite my resume · type: operational-trigger

- **precondition:** empty workspace (or any).
- **user_input:** "Rewrite my resume for AI Agent jobs — reorder my skills and make my projects sound production-grade."
- **trigger_expectation:** NO_TRIG for teach. Route to `resume-optimization-v2`.
- **expected_files:** teach creates **nothing** teaching-related; the operational skill produces/modifies resume content.
- **expected_message_checks:** agent invokes `resume-optimization-v2` (or clearly states it will); does not open a teaching workspace.
- **pass_if:** NO_TRIG(teach) ∧ resume-optimization-v2 executed/routed.
- **fail_if:** teach fires and starts a MISSION.md; OR teach refuses and does nothing.

### O02 — Operational: run a mock interview now · type: operational-trigger

- **precondition:** any.
- **user_input:** "Run a mock interview with me right now for an AI Agent role."
- **trigger_expectation:** NO_TRIG for teach. Route to `interview-mock-v2`.
- **expected_files:** no teaching workspace; interview-mock session begins.
- **expected_message_checks:** agent starts mock interview (asks Q1), or routes to interview-mock-v2.
- **pass_if:** NO_TRIG(teach) ∧ interview-mock-v2 executed/routed.
- **fail_if:** teach fires and builds lessons instead of interviewing.

### O03 — Operational: pick a project for me · type: operational-trigger

- **precondition:** any.
- **user_input:** "Pick a concrete project I should build for my AI portfolio and tell me the tech stack."
- **trigger_expectation:** NO_TRIG for teach. Route to `project-selection-v2`.
- **expected_files:** no teaching workspace; project-selection output.
- **expected_message_checks:** agent recommends concrete project(s) + stack (operational), or routes to project-selection-v2.
- **pass_if:** NO_TRIG(teach) ∧ project-selection-v2 executed/routed.
- **fail_if:** teach fires and only "teaches about" project selection without recommending.

### O04 — "Use teach to do operational work" · type: operational-trigger

- **precondition:** any.
- **user_input:** "Use the teach skill to rewrite my resume and optimize it for AI jobs."
- **trigger_expectation:** teach is invoked by name but the _task_ is operational. Expected: teach **declines** the operational rewrite and **routes** to `resume-optimization-v2`.
- **expected_files:** teach creates no resume; optionally a brief NOTE that this is operational.
- **expected_message_checks:** agent says "teach doesn't rewrite resumes — that's resume-optimization-v2; routing you there" (or similar); does not silently do the rewrite under a teach banner.
- **pass_if:** teach declined operational work ∧ routed to resume-optimization-v2.
- **fail_if:** teach actually rewrites the resume itself; OR teach rejects the user entirely.

### N01 — Empty input · type: negative-no-trigger

- **precondition:** any.
- **user_input:** "" (empty string / no message).
- **trigger_expectation:** NO_TRIG.
- **expected_files:** none created by teach.
- **expected_message_checks:** agent asks for a request or does nothing teaching-related; does not assume a topic.
- **pass_if:** NO_TRIG(teach) ∧ no teaching files.
- **fail_if:** teach fires and guesses a topic.

### N02 — Garbage input · type: negative-no-trigger

- **precondition:** any.
- **user_input:** "asdf qwerty @@## $$%^ &*()"
- **trigger_expectation:** NO_TRIG (no teach intent).
- **expected_files:** none.
- **expected_message_checks:** agent asks for clarification; does not magic a teaching session.
- **pass_if:** NO_TRIG(teach).
- **fail_if:** teach fires.

### N03 — Unrelated non-teaching request · type: negative-no-trigger

- **precondition:** any.
- **user_input:** "What's the weather in Shanghai today? Also translate 'hello' to French."
- **trigger_expectation:** NO_TRIG (neither is a teach invocation).
- **expected_files:** none teaching-related.
- **expected_message_checks:** agent answers or routes to appropriate capability; teach does not engage.
- **pass_if:** NO_TRIG(teach).
- **fail_if:** teach fires.

### B01 — Vague mission "teach me AI" · type: boundary

- **precondition:** empty workspace.
- **user_input:** "teach me AI"
- **trigger_expectation:** TRIG (explicit teach signal) but mission is too vague.
- **expected_files:** `MISSION.md` NOT yet substantively written (or only a stub) — teach must interview first.
- **expected_message_checks:** teach pushes back on vagueness ("AI is huge — what's the concrete outcome you want?"); does **NOT** emit lessons yet.
- **pass_if:** TRIG ∧ mission interview happens ∧ no lesson emitted until mission clarified.
- **fail_if:** teach writes a generic "Intro to AI" lesson despite no mission; OR refuses to teach at all.

### B02 — Multi-topic in one request · type: boundary

- **precondition:** empty workspace.
- **user_input:** "Teach me AI Agent development and also teach me to play the piano."
- **trigger_expectation:** TRIG, but violates "one mission per workspace".
- **expected_files:** at most ONE `MISSION.md`; teach does not create two workspaces.
- **expected_message_checks:** teach says these are two separate missions/workspaces and asks the user to pick one to start (or to run a second workspace separately); does not silently merge.
- **pass_if:** TRIG ∧ exactly one mission pursued ∧ user asked to choose ∧ no piano+AI hybrid lesson.
- **fail_if:** teach creates a confused dual-topic lesson; OR refuses both.

### B03 — Skip mission, jump to lesson · type: boundary

- **precondition:** empty workspace.
- **user_input:** "Skip the mission stuff, just teach me RAG retrieval right now."
- **trigger_expectation:** TRIG, but user tries to bypass mission-first.
- **expected_files:** teach still creates/grounds `MISSION.md` (even if minimal/draft) before any lesson; OR clearly refuses to skip and interviews.
- **expected_message_checks:** teach explains lessons must tie to a mission; either (a) creates a draft MISSION.md and warns it's unvalidated, or (b) insists on a 1-question mission before proceeding. It does **NOT** emit a lesson with zero mission grounding.
- **pass_if:** TRIG ∧ mission grounding established (draft or interview) ∧ no ungrounded lesson.
- **fail_if:** teach emits `./lessons/0001-rag.html` with no MISSION.md and no warning.

### B04 — PDF-dependent question, no PDF present · type: boundary

- **precondition:** workspace has `MISSION.md` (AI job-hunting) but NO seeded PDF.
- **user_input:** "Based on the PDF you have, what chunk size and overlap does it recommend for RAG, and why?"
- **trigger_expectation:** TRIG (teaching context) — but the PDF doesn't exist.
- **expected_files:** no fabricated `./reference/` doc claiming PDF contents.
- **expected_message_checks:** teach states "no PDF is seeded in this workspace" and therefore cannot quote it; it either (a) answers only from `RESOURCES.md` entries it can name, or (b) proposes to gather that resource. It must NOT say "the PDF says…".
- **pass_if:** TRIG ∧ explicit "no PDF" statement ∧ no fabricated PDF facts.
- **fail_if:** teach hallucinates PDF recommendations ("the PDF recommends 512/64…").

### B05 — Change mission mid-way (state exists) · type: boundary (also multi-session-state)

- **precondition:** workspace has `MISSION.md` (AI job-hunting) + `./learning-records/0001-*.md` + a couple lessons.
- **user_input:** "I changed my mind — I don't care about job-hunting anymore, teach me prompt engineering instead."
- **trigger_expectation:** TRIG.
- **expected_files:** `MISSION.md` updated to prompt-engineering mission; a NEW `./learning-records/000X-mission-shift.md` recording the shift + cross-link to MISSION.md.
- **expected_message_checks:** teach **confirms** with the user before changing the mission; after confirmation, updates MISSION.md and writes the learning record; notes prior job-hunting records remain as history.
- **pass_if:** TRIG ∧ confirmation sought ∧ MISSION.md updated ∧ learning record of shift created ∧ old records not deleted.
- **fail_if:** teach silently overwrites mission with no confirmation; OR deletes prior learning-records; OR refuses to change.

### B06 — Opt out of community · type: boundary

- **precondition:** workspace has `MISSION.md` (AI job-hunting).
- **user_input:** "Teach me, but I don't want to join any communities or forums — just you."
- **trigger_expectation:** TRIG.
- **expected_files:** `NOTES.md` records "user opted out of communities"; `RESOURCES.md` `## Wisdom (Communities)` either absent or annotated "user opted out — do not propose".
- **expected_message_checks:** teach respects the opt-out; never proposes communities; still answers wisdom questions directly (attempt-then-delegate becomes attempt-only).
- **pass_if:** TRIG ∧ NOTES records opt-out ∧ no community proposed in message/RESOURCES.
- **fail_if:** teach keeps suggesting r/... or meetups despite opt-out.

### S01 — Repeated identical request (state exists) · type: multi-session-state

- **precondition:** workspace already has `MISSION.md` (AI job-hunting) + `RESOURCES.md` + `./lessons/0001-*.html` + `./learning-records/`.
- **user_input:** "Teach me AI application development job-hunting." (same as before)
- **trigger_expectation:** TRIG, but should recognize existing state.
- **expected_files:** NO second `MISSION.md` rewrite; teach reuses existing mission; may add a learning record noting resumption.
- **expected_message_checks:** teach says "I see we already started — your mission is X, you've done N lessons"; offers the next step / reviews ZPD instead of re-interviewing from scratch.
- **pass_if:** TRIG ∧ recognizes existing state ∧ no redundant mission interview ∧ offers continuation.
- **fail_if:** teach ignores existing MISSION.md and re-interviews from zero; OR refuses because "already exists".

### S02 — Continuation: next lesson (state exists) · type: multi-session-state

- **precondition:** `MISSION.md` + `./lessons/0001..0003-*.html` + `./learning-records/0001..0003-*.md`.
- **user_input:** "I finished lesson 0003. What should I learn next based on where I am?"
- **trigger_expectation:** TRIG.
- **expected_files:** new `./lessons/0004-*.html` whose topic is the ZPD-justified next step; possibly a `./learning-records/` entry if understanding was demonstrated.
- **expected_message_checks:** teach reads `./learning-records/` to compute ZPD; picks the "just-enough" next topic; new lesson cites resources and links back to 0001–0003.
- **pass_if:** TRIG ∧ lesson 0004 created ∧ topic justified by ZPD (references prior records/lessons) ∧ anchors link to earlier lessons.
- **fail_if:** teach picks a random/advanced topic; OR doesn't read learning-records; OR renumbers incorrectly.

### S03 — Spaced retrieval / "where did I leave off" (state exists) · type: multi-session-state

- **precondition:** `MISSION.md` + several lessons + learning-records; last activity was 3 weeks ago (simulate via NOTES timestamp).
- **user_input:** "I haven't studied in 3 weeks. Remind me where I left off and quiz me on what I already learned so it sticks."
- **trigger_expectation:** TRIG.
- **expected_files:** a retrieval-practice lesson/quiz in `./lessons/` (or `./reference/` quiz widget reused from `./assets/`); possibly a learning record noting the spacing review.
- **expected_message_checks:** teach applies **spacing** + **retrieval practice**: reviews prior topics, gives a recall quiz (answers equal length per SKILL rule), links to prior lessons.
- **pass_if:** TRIG ∧ retrieval-practice artifact created ∧ references prior lessons ∧ quiz answers equal word-count.
- **fail_if:** teach only lectures new material ignoring the spacing request; OR quiz answers give formatting clues.

---

## 3. Coverage matrix (required boundary/negative cases → sample)

| Required case                            | Sample(s) |
| ---------------------------------------- | --------- |
| vague mission ("teach me AI")            | B01       |
| non-teaching ("write my resume")         | O01       |
| ask teach to do operational work         | O04       |
| out-of-domain ("teach me guitar")        | P05       |
| empty / garbage input                    | N01, N02  |
| very long context                        | P06       |
| multi-topic                              | B02       |
| repeated session (state exists)          | S01       |
| change mission mid-way                   | B05       |
| skip mission, jump to lesson             | B03       |
| PDF-dependent question, no PDF           | B04       |
| Chinese-language input                   | P02       |
| community / wisdom delegation            | P04       |
| (routing: mock interview / project pick) | O02, O03  |

All 24 samples: P01–P07 (7) · O01–O04 (4) · N01–N03 (3) · B01–B06 (6) · S01–S03 (3) = **24**.

---

## 4. Aggregate pass/fail rollup

- **Global blocking (any FAIL = skill not shippable):** (c) trigger correctness on every sample + `disable-model-invocation: true` present in frontmatter + (d) no PDF hallucination on B04.
- **Quality gates (target ≥90% sample pass):** (a) output correctness, (b) structure adherence, (e) routing.
- Report per-sample: `PASS / FAIL / PARTIAL` with the failing check id (e.g. `fail_if@P01`, `c@N03`).

---

## 5. Findings / risks surfaced by this spec author

1. **Missing `disable-model-invocation: true`** in current `teach/SKILL.md` frontmatter — must be added or "user-invoked only" is unenforced (covered in criteria (c) + global blocking).
2. **No domain knowledge in `teach` by design** — the AI-job-hunting use case depends entirely on _pointer-linking_ to `ai-job-coaching-v2`. If a grader seeds a PDF, `teach` must learn from the PDF, not from the job-coaching skill's inline curriculum. Tests P01/P02/P05 enforce non-leakage.
3. **Mission-first is the critical gate** — B01/B03 verify teach refuses to emit lessons without a grounded mission; this is the single most likely failure mode.
4. **Routing is the second likely failure** — O01–O04 verify teach yields operational work to the correct sub-skill rather than absorbing it.
