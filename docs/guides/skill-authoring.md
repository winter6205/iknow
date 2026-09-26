# Skill authoring contract — keep the body lean, push details into `references/`

> For skill authors: how to write a usable skill, not the runtime implementation.
> Body-assembly SSOT = `src/harness/skill/body.ts`; scanning / indexing = `src/harness/skill/scanner.ts` + `src/harness/skill/catalog.ts`
> (where this page and the code disagree, the code wins).

---

## Summary

The `SKILL.md` body is **a complete program assembled into the context once and loaded on demand**; `references/` is a details repository that costs **nothing until read**.
Keeping the body lean is **author discipline**, not a runtime gate — the runtime imposes no size limit on the body, so nothing catches you.

---

## 1. Minimal anatomy of a skill

One skill = one directory that must contain a `SKILL.md`:

```
.iknow/skills/<name>/          # or <home>/.iknow/skills/<name>/
├── SKILL.md                   # required: frontmatter + body
├── references/                # optional: details (never listed in <skill_files>, see §2)
└── <other files or subdirs>   # optional: listed in <skill_files>
```

Install locations (scan roots, scanned in order; on a name collision the **later one wins**):

1. `<home>/.iknow/skills/<name>/`
2. `<projectIdentityRoot>/.iknow/skills/<name>/`
3. directories listed in `IKNOW_SKILL_DIRS` (`path.delimiter`-separated)

A `SKILL.md` without a `---` frontmatter block is **skipped entirely** (one warning line) and never indexed.

```markdown
---
name: my-skill # omit to take the directory name
description: one line stating when to use this skill # decides whether it appears in <available_skills>
when_to_use: the situations the model should pick this skill for # optional second selection signal
---

# write the body here
```

- A `description` longer than 1536 characters is truncated with a warning — **write one sentence**; don't turn the description into a body.
- `when_to_use` is an **optional second selection signal**: when the model should pick this skill. It renders as **its own line** under the description in the model index (frozen table and in-session deltas) and gets **its own 1536-char truncation with its own warning** — a long `when_to_use` never shortens the `description` and vice versa. Under index pressure (ADR-0046 index demotion) it is stripped **together with** the `description`, leaving the bare name. It never grants index entry by itself: entry still requires a `description`.
- Only skills that have a `description` and do not set `disable-model-invocation: true` enter the **model-facing skill index** — both the `<available_skills>` list (frozen at session start + in-session increments) and the model-side `skill({name})` honor only that qualification.
- **The human-side slash uses the loadable-skill surface, which is wider than the model index**: TUI `/` candidates, Web `GET /api/v1/skills`, and CLI `/` candidates all include entries **without a `description`** and with **`disable-model-invocation: true`** (one shared entry point for the three hosts); fetching a body by name rejects only "not found". So skills missing a description or marked disabled can still be loaded by a human via `/name`. ADR-0098 / `specs/skill-index-increment.md`.
- The two gates do not cross: model-side `skill({name})` returns a typed rejection for unqualified names (the message points to `/name`), and does **not** block `read_file` on the same SKILL.md.

---

## 2. What the model actually sees on load (assembled form)

All four load paths (TUI slash / Web `GET /api/v1/skills/:name` / CLI `/name` / ACI `skill({name})`) deliver the **same** `createSkillBody` product, fixed as three sections joined by blank lines:

1. **Body after frontmatter stripping** (omitted entirely if empty)
2. **`Base directory: <absolute path of the skill directory>`**
3. **The `<skill_files>` section**

Actual `<skill_files>` behavior:

- Lists **files** in the skill directory (absolute paths), **sorted lexicographically**;
- **At most 10 entries**; when truncated, one `file list is sampled` line is appended — the list is a sample, not the whole;
- `SKILL.md` itself never appears;
- **The whole `references/` subtree is excluded** (not recursed, not listed);
- `node_modules` / `.git` directories are skipped.

Two assemblies of the same input are **byte-identical** — so never put drifting content (timestamps, random numbers) in the body.

---

## 3. Author contract: lean body, details in `references/`

The body holds **only the program every execution must follow**: entry, step skeleton, decision gates, failure paths.
Details go to `references/`: long tables, templates, example sets, reference material, look-up lists.

**Point explicitly** in the body, or the model won't know where to read:

```markdown
Use the skeleton in `references/handoff-template.md`; fill paths only into the template's "finalized artifacts" table — no inline copies.
```

This discipline isn't stylistic; it follows directly from the load model: the body is a one-shot assembly carrying **complete meaning**, not a re-runnable query. A half-finished skill program is worse than none — the model executes the half as if it were the whole, and within a session there is no "re-invoke with a more precise input" recovery path. That is exactly why ADR-0083 exempts skill bodies from the general output cap: `docs/adr/0083-skill-body-exempt-from-executor-output-cap.md`.

---

## 4. The runtime sets no body-size limit (discipline is on you)

**No skill-specific body limit and no runtime size validation**:

- Scanning never checks `SKILL.md` body length — the only size truncations anywhere are the frontmatter `description` / `when_to_use` scalars (1536 characters each, each with its own warning);
- Assembly never trims by size: strip frontmatter, append two sections, no length checks anywhere;
- There are no `SKILL_MAX_*`-style skill-specific limit constants and no "over-limit → refuse to scan / load" decision;
- No skill-specific truncation / preview / read-more fallback.

**Don't count on the runtime to stop you.** A long body costs context on every load and squeezes everything else out; this is a deliberate trade-off (no mechanical limit, discipline on the author side), so you have to hold the line yourself.

**Delivery: bodies bypass the executor's general output cap.** A `skill()`-assembled body **arrives in full** — the executor's 20000-character fallback truncation (`OUTPUT_HARD_CAP`) does not apply, and no "truncated + re-invoke" marker ever appears. The exemption is a **static, assembly-time declaration**: only the built-in `skill` tool sets `exemptFromOutputCap` at assembly; all other built-in and MCP tools still pass through the general cap (the MCP conversion path structurally never sets it). In other words, once the body runs long there is no second fallback at runtime — which sharpens the author discipline above. Rationale: `docs/adr/0083-skill-body-exempt-from-executor-output-cap.md`.

---

## 5. How `references/` gets read

`references/` never appears in `<skill_files>`, so the model **cannot know its contents automatically**. The read path:

1. Take the relative path from the pointer sentence in the body;
2. join it with the absolute path given by `Base directory:`;
3. call `read_file`.

**Reachability depends on install location** (`read_file`'s fence constraints):

| Skill install location                | `references/` readable via `read_file`    |
| ------------------------------------- | ----------------------------------------- |
| `<projectIdentityRoot>/.iknow/skills` | yes                                       |
| `<home>/.iknow/skills`                | yes (`~/.iknow/` is a resident read root) |
| external dirs via `IKNOW_SKILL_DIRS`  | **no** (outside the fence; refused)       |

For skills installed to external directories, never put must-read content only in `references/`.

---

## 6. Don't

- Don't write the body as an encyclopedia — sink details into `references/`.
- Don't cram body content into the description — it only drives indexing and trigger decisions, and gets truncated at 1536.
- Don't assume `<skill_files>` is complete — it is a ≤10 sample and excludes `references/`.
- Don't assume `references/` loads automatically — it costs nothing until `read_file` reads it.
- Don't rely on the runtime to catch long bodies — the absence of limits is part of the contract; the fallback is the author.
