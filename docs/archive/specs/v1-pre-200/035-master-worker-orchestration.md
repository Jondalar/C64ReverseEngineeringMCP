# Spec 035: Master + Worker Orchestration Pattern

## Problem

A single long-running LLM session is the C64RE drift surface: phase
ordering, doctrine, and per-artifact state all live in the agent's
context, which decays. Spec 034 makes the phase model first-class
in the data layer, but a single agent can still skip phases unless
something else enforces ordering.

A master + worker pattern moves the orchestration loop out of the
agent's monolithic context: a master agent reads project state and
dispatches a worker subagent for each narrow phase task. Workers
have no plan-level context — they only know their phase and target
artifact, and only have access to the tools that phase needs.

## Goal

Express the master + worker pattern as first-class C64RE machinery
so users can adopt it without inventing prompts each time:

1. A single parametrized MCP prompt `c64re_worker_phase` returns a
   worker briefing for `(phase, artifact_id, role?)`.
2. `agent_propose_next` output explicitly recommends spawning a
   worker subagent when the proposed action is phase-bound.
3. Workers see only the tools their phase allows (via the
   description-prefix tagging from Spec 034); the prompt doubles
   down by listing the allowed tools explicitly.
4. After a worker finishes, the master calls `agent_record_step`
   with the worker's results, and the loop continues.

## Approach

### Single parametrized worker prompt

`c64re_worker_phase` accepts:

```
phase: 1 | 2 | 3 | 4 | 5 | 6 | 7
artifact_id: string
role?: "analyst" | "cracker"   // default analyst
project_dir?: string
```

Returns a Markdown briefing:

```markdown
# Worker Briefing — Phase {N}: {phase title}

Target artifact: `{artifact_id}` ({title})
Active role: {role}

## Your scope

{phase narrative — what this phase does, what it produces}

## Allowed tools

- {tool A description}
- {tool B description}
- ...

## Required outputs before stopping

- {output 1}
- {output 2}
- ...

## Hand-off contract

When you finish, return ONE Markdown report with:
- "Phase {N} done" or "Phase {N} blocked: {reason}"
- Per-tool calls a 1-line summary
- A `recommended_next` block the master will pass to
  `agent_record_step`.

Do not spawn further subagents. Do not advance the phase. Do not
edit artifacts outside your target. The master decides next steps.
```

The Markdown can be inserted directly into a Claude Code Task agent
prompt.

### `agent_propose_next` master-mode output

When the proposal is phase-bound, the output gains a "Master+Worker
Pattern" section:

```
Spawn worker subagent for phase {N} on artifact {id}:

  Prompt: c64re_worker_phase(phase={N}, artifact_id="{id}",
                             role="{role}")
  Allowed tools: {explicit list}
  Stop condition: report sealed with `Phase {N} done` or
                  `Phase {N} blocked`

After the worker returns, call:
  agent_record_step(...result...)
  agent_propose_next(...)
```

When the proposal is small / cross-cutting (e.g. "save a
project-level finding"), no worker is spawned and the master
executes inline. Output omits the worker section.

### Tool allow-lists per phase

`src/agent-orchestrator/phase-tools.ts` exposes:

```ts
export const PHASE_TOOLS: Record<1|2|3|4|5|6|7, string[]>
```

Used by:

- the worker prompt (lists allowed tools to the subagent)
- the `propose_next` gate (filters candidate tools)
- the hard-refuse gate (rejects tool calls outside the phase set)

### Master loop convention

The master agent (the user's main Claude session) follows this
loop:

```
loop:
  proposal = agent_propose_next()
  if proposal.recommends_worker:
    result = spawn_task_subagent(proposal.worker_prompt)
    agent_record_step(...result...)
  else:
    execute proposal.tool_call inline
    agent_record_step(...result...)
  if user_requests_stop: break
```

The MCP server cannot enforce this loop client-side, but
`agent_record_step` returns a hint that the next call should be
`agent_propose_next` (Spec 034 reminder loop). Doctrine doc
documents the pattern.

## Acceptance Criteria

- `c64re_worker_phase(phase=4, artifact_id="X")` returns a
  Markdown briefing with the phase-4 tool allow-list and
  hand-off contract.
- `agent_propose_next` against a phase-3 artifact emits a
  "Master+Worker Pattern" section with the exact `Task` prompt
  invocation the master should run.
- A test that spawns a synthetic worker prompt against the fixture
  project produces the expected text.

## Tests

- Smoke: `service.buildWorkerPrompt(phase, artifactId)` returns a
  string containing the phase title, the allowed tools, and the
  hand-off contract.
- Smoke: propose_next on a phase-3 artifact mentions the
  c64re_worker_phase prompt.

## Out Of Scope

- Auto-spawning Task subagents from the MCP server (the MCP layer
  cannot drive the user's Claude Code session — it can only
  recommend).
- Multi-master / parallel workers in v1.

## Dependencies

- Spec 034 (seven-phase workflow) — phase metadata and tool
  tagging.
- Spec 026 (project profile) — `defaultRole` + `phaseGateStrict`.
- Spec 033 (cracker doctrine) — role-aware briefing.
