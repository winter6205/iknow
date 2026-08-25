# Pressure and anti-patterns

| Pressure                               | Why it fails                    | Do this                                |
| -------------------------------------- | ------------------------------- | -------------------------------------- |
| Dispatch a trivial task                | Setup cost exceeds the work     | Stay on the current agent              |
| "Workers can read each other's output" | That is a dependency → sequence | Sequence A then B                      |
| Dispatch to go faster, ignore shape    | N × context cost                | Count from module / compile boundaries |
| Skip REFERENCE                         | Blind edits                     | Force the REFERENCE field              |
| Skip cross-check                       | Silent overlap                  | Run `verification.md` before merge     |
| Treat commit as done                   | Review fan-out has no commit    | Synthesize the report                  |
