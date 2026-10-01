# 0132. Permit bounded cleanup of the current identity's session scratch

Date: 2026-09-30
Status: accepted

ADR-0092 already assigns each main session or worker its own host-backed session tmp directory, exposed as `$TMPDIR`. Permit non-recursive `rm -f` file cleanup through the destructive-command wall when every target can be established as belonging inside the calling identity's scratch root; the command then continues through ordinary permission handling. This reconciles the instruction to create intermediate files there with the hard-wall denials reported in issue #1170. The allowance does not cover another identity's directory, the scratch root itself, recursive deletion, or a mixed command with an out-of-scope target, and does not grant additional read authorization or override protected-target enforcement.

The host must supply a trusted per-call scratch-root snapshot shared by permission admission and the Bash handler, without making permission depend on sandbox internals. Equivalent absolute paths and trusted `$TMPDIR` expansion use that same root. Containment needs filesystem-aware path handling; a textual prefix alone cannot establish authority through `..` or linked ancestors. Unresolved variables, globs, or path resolution do not inherit the cleanup allowance and require review or denial under the applicable existing contracts. This remains a pre-execution intent decision, not a guarantee against runtime races or arbitrary interpreter effects. The downstream specification owns the exact supported path forms and evidence cases.

Cleanup of files under `taskRoot`, including `rm -f tmp_pycheck.cjs` from issue #1170, requires a separate decision. A broad scratch exemption for reads and destructive operations was rejected because scratch ownership supplies a cleanup scope, not authority to bypass all other protection layers.
