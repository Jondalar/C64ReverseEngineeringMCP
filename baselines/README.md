# Baselines

Finished projects from unattended agent runs, kept so a change to the workflow surface can
be measured against something real instead of against a fixture. **Everything here except
this file is gitignored** — they are megabytes of disassembly, graph and extracted sectors
over commercial disk images, and none of it belongs on GitHub.

Fixture tests prove the code runs. They cannot tell you whether the machinery changes how
a session behaves, and six of the defects found during Specs 844–849 were visible only in
a run — three of them silent failures that looked like a weak model. See
`specs/_archive/849-harness-rules.md` for the method and the full series.

## What is here

| directory | run | what it tests |
|---|---|---|
| `run5-rules-from-tools` | 5 | project rules delivered by the tool that is their moment |
| `run7-contract-on-write-path` | 7 | …plus the contract's standing blockers carried back on every write |

Both: four Neuromancer G64 sides (Interplay 1988), the same contract byte for byte, the
same prompt word for word, Opus, unattended, launched as a session whose working directory
is the project.

```
                     run 5    run 7
  turns                110      179
  MCP calls             68      237
  slots               9/10     9/10 + 1 hypothesis
  named             69/134   81/294
  boundaries             2       12
  orphaned            62 %    9.1 %
  model_assert           0       12
  project_critique       0        2
  cost               $7.06   $15.76
```

Run 7 is the baseline: it is the first run that asserted a model at all, the first that
called the critic and acted on what it said, and the only one whose graph is mostly inside
a named boundary.

Neither is "done" — run 7 stopped with three blockers standing after reading them
repeatedly. That is the point of keeping it: the ceiling of what pressure inside a session
can achieve, measured rather than argued.

## Using one

They open like any project — `project_slots`, `project_critique`, `model_read`,
`agent_onboard` with `project_dir` pointing here. Absolute paths inside the knowledge
store were rewritten when they were moved, so they resolve from this location and not from
where they were made.

**Do not work in them.** A baseline that has been edited is no longer a baseline; copy it
somewhere else first.
