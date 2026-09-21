# 0084. Non-empty writes check last-read; edit self-proves; grep defaults to paths only

Date: 2026-09-12
Status: accepted

A successful `read_file`, or a successful whitelisted `bash` whose single path can be extracted, records the canonical path into this conversation's **last-read ledger**. The table lives in **process memory** (`conversationId → path`), never persisted; resume starts empty. Whitelist: `cat` / `nl` / `bat` / `batcat` / `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`; must be single-file, no pipes, no redirection. `write_file` fails with a typed error and writes nothing only when the target already exists with **size>0** and the ledger has no entry. Unlogged overwrites are not loosened per model. New files and empty files are exempt. `edit_file` does **not** consult the ledger: its gate is a non-empty `old_str` matching contiguous on-disk text exactly, hitting exactly 1 occurrence by default; explicit `replace_all` replaces every occurrence, with no prohibition by line/character count. Conversation history is not scanned. Without a `conversationId`, a non-empty `write_file` fail-closes; `edit_file` is not rejected for the missing id. Process-level global tables are forbidden. No separate on-disk overwrite backup is made. Passing `validateReadonlyCommand` is not counted as ledger registration.

`read_file` without a `limit` reads from `offset` toward EOF as far as it can; the tool's full-read page is **16000** code points, with the body hinting how to continue. Still rejects `>1MB`. An explicit `limit` is hard-capped at 2000 lines. The executor's **20000**-character total gate is unchanged.

`grep` returns paths only by default; matched lines / counts are explicit output modes. The result-list count parameter is **`head_limit`** (default 50, hard cap 2000), deliberately not sharing the name `limit` with `read_file`'s line cap. Context lines, result-list paging, filename `glob`, language `type`, the line window, and the parser/sort/install-root-scan behavior of the bundled engine all belong to the search-surface contract.

**Amends** ADR-0004: `grep` no longer defaults to `path:line:content`; `read_file` without `limit` reads to EOF (the default 200 lines is retired). `edit_file`'s unique-match / `replace_all` behavior does not change ADR-0004. **Amends** ADR-0006: `grep` default count 200→50; `read_file`'s full read no longer uses 200/2000 lines as the default window (1MB and executor 20000 remain). PATH `rg` is no longer the production main path.

**Why not scan messages:** same-round tool_results are not yet in the handler snapshot at check time; the highest-frequency "just read, now edit" would never be seen.

**Why not hard-prerequisite edit:** an exact unique `old_str` already self-proves the on-disk state; a hard prerequisite cannot fix same-round message invisibility and would misfire on "anchor already correct, ledger not yet registered".

**Why not allow whole-file overwrite without registration:** a full `content` does not self-prove the old text; the whitelisted bash already reduces false blocks. Model-dependent permission would void the ledger per conversation.

**Why not still default to matched lines:** the first search is to discover files; lines are an explicit output mode. With paging, a default of 50 fills one page.
