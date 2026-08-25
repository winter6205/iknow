# Router maintenance

`hooks/pre-release-validate.ts` reads `using-agent-skills/SKILL.md` and checks `routerText.includes(<skill-dirname>)` for every sibling `skills/<name>/SKILL.md`. It does not read `quick-reference.md`.

Same change as the filesystem edit:

- **Add** — new `skills/<name>/SKILL.md`: add the basename to the Registered list in `SKILL.md` and a row in `quick-reference.md`.
- **Rename** — update the Registered list, `quick-reference.md`, and `flowchart.md` if the old name appears there.
- **Remove** — drop the Registered line and the table row; strip leftover prose.
- **Flow-placement** — update the phase column in `quick-reference.md` and the flowchart branch if the skill is named in the tree.

Drift surfaces as `[FAIL] router:missing-reference skills/<name>`.
