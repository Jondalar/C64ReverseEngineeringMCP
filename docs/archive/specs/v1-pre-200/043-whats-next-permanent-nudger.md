# Spec 043: `c64re_whats_next` Permanent Nudger

## Problem

`agent_propose_next` exists but is opt-in. The agent calls it only
when it remembers to. In long sessions or after context compaction,
that disciplined loop breaks down — agent free-styles, skips phases,
forgets the worker pattern. Sprint 34/35's reminder loop helps but
relies on the agent reading the tail of every tool output.

codemcp/workflows solves this with `whats_next()`: a single MCP tool
the user's IDE / CLI is configured to call **after every user
turn**. The convention lives in setup (Spec 044), not in agent
discipline. Result: process adherence is enforced by the integration
layer, not by hope.

## Goal

Ship `c64re_whats_next` as a single phase-aware "what should happen
next" tool that returns concrete instructions. Setup (Spec 044)
patches the agent config so this tool is called after every user
message.

## Approach

### Tool

```
c64re_whats_next(
  project_dir?: string,
  conversation_summary?: string,
  user_input?: string,
  context?: string
) -> Markdown text
```

Output sections:

1. **Active phase per artifact** (top 3 by relevance / unblocked).
2. **Next required action** (single recommended tool call with
   args).
3. **Worker spawn block** when the action is phase-bound (mirrors
   Spec 035 master/worker recommendation).
4. **Open questions surfaced** if any are tagged `human-review` and
   answered by the recent context.
5. **Audit warnings** if severity > low.
6. **Reminder line** at the end: "Call `agent_record_step` after
   acting, then `c64re_whats_next` again."

The tool internally calls `agent_propose_next` and reformats its
output for the post-user-turn cadence — concise, action-first,
without re-listing all artifacts.

### Setup integration

Spec 044 ships the CLI that patches the agent config so the
`whats_next` tool is called after every user message. The user does
not have to remember.

### Self-documenting on first call

If `whats_next` is called before `agent_onboard`, the response is:

```
# c64re session not initialised

Run `agent_onboard` first to load persistent project state.

Then re-run `c64re_whats_next` for the per-turn action plan.
```

(See Spec 045 self-documenting errors for the broader pattern.)

## Acceptance Criteria

- `c64re_whats_next` against a fixture project returns the active
  phase, the next required action, and a reminder line.
- Calling it before `agent_onboard` returns a structured "run
  agent_onboard first" message rather than a generic error.
- The output stays under ~30 lines so the agent can parse it on
  every turn without context bloat.

## Tests

- Smoke: call against the fixture project, assert sections present.
- Smoke: call without onboarding, assert structured guidance.

## Out Of Scope

- Auto-executing the recommended tool call (the agent decides).
- Multi-language output.

## Dependencies

- Spec 034/035 phase + worker pattern.
- Spec 044 setup CLI to make the per-turn convention real.
