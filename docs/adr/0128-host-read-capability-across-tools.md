# 0128. Host read capability across agent tools

Date: 2026-09-28
Status: accepted

ADR-0092 defines global and workspace filesystem modes as broadly readable host views; workspace mode primarily tightens writes under home. Read-capable ACI tools currently impose separate task-root allowlists, producing inconsistent behavior for ordinary host files. The read_file, grep, and glob tools should support ordinary host-path reads in both modes under one canonical read policy; symbol tools remain project-indexed, but any direct file opening must use that policy. Protected credentials and other sensitive paths must retain at least the protections applied to shell reads before any tool's host reach is broadened; granting `/` as an unguarded read root is not an acceptable implementation. This decision does not expand the write_file or edit_file write roots, and a future project-only read mode would require a separate decision.

## Consequences

- The shared policy must be applied before file contents enter a tool result, including through symlinks and language-server file opening. Tool-local output masking alone is not a read authorization boundary.
- The downstream specification must define the protected-path inventory and tests for ordinary external files, protected files, symlink aliases, and both filesystem modes across each read-capable tool.
