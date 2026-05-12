# Spec 044: `c64re setup` CLI

## Problem

Agent process discipline lives or dies based on whether the
agent's host (Claude Code, Gemini CLI, etc.) is configured to call
`c64re_whats_next` after every user message. Today users have to
hand-edit CLAUDE.md or agent settings, easy to forget, easy to drift.

## Goal

`c64re setup <agent>` writes the necessary configuration into the
target agent so `c64re_whats_next` is invoked after every user turn,
plus reads the doctrine prompts at session start.

## Approach

### CLI command

```
npx c64re setup <agent> [--project <path>] [--mode config|skill]
```

Supported agents in v1:

- `claude` — patches `CLAUDE.md` in the target project root.
- `claude-code-settings` — patches
  `~/.claude/settings.local.json` or project-local
  `.claude/settings.local.json`.
- `gemini` — patches `~/.gemini/...` (deferred to v2).
- `print` — print to stdout, no write.

### What gets patched

For `claude` (CLAUDE.md mode):

1. Top-of-file process block reminds the agent to call
   `c64re_whats_next` after every user turn.
2. References to `c64re_re_phases`, `c64re_agent_doctrine`,
   `c64re_cracker_doctrine` prompts so the agent reads them at
   start.
3. Marker comments `<!-- c64re-setup-start -->` /
   `<!-- c64re-setup-end -->` so re-running setup updates the
   block in-place.

For `claude-code-settings`:

1. Adds an `mcpServers.c64-re` entry pointing at the bundled
   server.
2. Adds an entry under `hooks.UserPromptSubmit` (or equivalent
   post-user-turn hook) that mentions `c64re_whats_next` in its
   guidance text.

### Idempotency

Re-running `setup` on an already-configured project replaces the
marker block in-place. Detects already-present block via the
markers; skips when no diff.

### Project profile interaction

Setup also writes a tiny `project-profile.json` skeleton if missing
(Spec 026), prompting the user to fill goals / non-goals.

## Acceptance Criteria

- `npx c64re setup claude --project /path` creates / updates the
  marker block in `<path>/CLAUDE.md`.
- Re-running is idempotent.
- `npx c64re setup print` outputs the block to stdout without
  modifying files.

## Tests

- Smoke: setup against a temp project, assert marker block
  present + reference to `c64re_whats_next`.
- Smoke: re-run setup, assert no diff.

## Out Of Scope

- Other agent platforms beyond Claude Code in v1.
- Auto-installing the npm package (assumes `npx` already works).

## Dependencies

- Spec 043 `c64re_whats_next` tool exists.
- Spec 026 project profile.
