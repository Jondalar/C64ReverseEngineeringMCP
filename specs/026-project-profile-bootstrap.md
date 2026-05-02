# Spec 026: Project Profile Bootstrap

## Problem

Real C64 RE projects need project-specific rules before useful work
starts: goals, non-goals, hardware constraints, loader model,
destructive-operation warnings, build commands, active workspace
folder, and known danger zones. In the Accolade Comics EF port these
emerged manually as `CLAUDE.md`, `docs/arc42.md`, `docs/GLOSSARY.md`,
`docs/ANTI_PATTERNS.md`. Every new agent session re-discovered them
from chat history. REQUIREMENTS R17.

## Goal

`project_init` and `agent_onboard` produce and consume a structured
project profile. Subsequent sessions load it without relying on chat
history. Onboarding surfaces the hard constraints before tool
suggestions.

## Approach

### Schema

Add structured records to the project knowledge layer:

```ts
interface ProjectProfile {
  goals: string[];
  nonGoals: string[];
  hardwareConstraints: Array<{ resource: string; constraint: string; reason?: string }>;
  loaderModel?: string;            // free-form pointer to docs/loader.md
  destructiveOperations: Array<{
    commandPattern: string;        // glob-style: "rm -rf*", "git push --force*"
    warning: string;
  }>;
  build?: { command: string; cwd?: string; outputs?: string[] };
  test?: { command: string; cwd?: string };
  activeWorkspace?: string;        // relative path that work currently focuses on
  dangerZones: Array<{ pathOrAddress: string; reason: string }>;
  glossary: Array<{ term: string; definition: string; aliases?: string[] }>;
  antiPatterns: Array<{ title: string; reason: string; refutationEvidence?: string }>;
}
```

Match strategy for `commandPattern`: glob-style with `*` and `?`.
Exact match when no wildcard. Used by `agent_propose_next` to
filter or block proposed actions whose serialised command matches.

Stored at `knowledge/project-profile.json`, mirrored as Markdown via
the doc renderer (Spec 031).

### Canonical docs

`project_init` scaffolds (when missing):

- `PROJECT_PROFILE.md` — auto-rendered from `project-profile.json`.
- `docs/GLOSSARY.md` — from `glossary[]`.
- `docs/ANTI_PATTERNS.md` — from `antiPatterns[]` plus negative
  knowledge findings (Spec 031).
- `docs/ARCHITECTURE.md` — optional, hand-edited.

### MCP tools

- `save_project_profile(patch)` — merge a partial update into
  `project-profile.json` and re-render the Markdown.
- `get_project_profile()` — return the structured record.
- `add_destructive_operation(command, warning)` shorthand.
- `add_anti_pattern(title, reason, evidence?)` shorthand.

### Onboarding integration

`agent_onboard`:

1. Load `project-profile.json`.
2. Surface a "Read these first" block at the top of the response:
   goals, non-goals, top 5 destructive operations, top 5 anti-patterns,
   top 5 danger zones.
3. Block tool suggestions that match registered destructive
   operations unless the agent explicitly acknowledges the warning.

### Scaffold generator

Optional `scaffold_project_profile(walkthrough_notes?)`:

1. Walk the project directory for clues (existing `CLAUDE.md`,
   `Makefile`, `package.json`, `.gitignore`, top-level docs).
2. Produce a draft profile with discovered build commands, test
   commands, doc references.
3. Leave goals / non-goals / constraints empty for the human to
   fill — the tool refuses to invent them.

## Acceptance Criteria

- A fresh project produces a compact `project-profile.json` and
  rendered `PROJECT_PROFILE.md` after `scaffold_project_profile`.
- A later session resumes via `agent_onboard` and quotes goals,
  non-goals, and the top destructive operations without reading
  chat history.
- `agent_propose_next` does not suggest a tool whose command matches
  a registered destructive-operation entry without explicit
  acknowledgement.

## Tests

- Smoke: scaffold against the fixture project, assert
  `project-profile.json` exists and `PROJECT_PROFILE.md` renders.
- Smoke: register a destructive op, assert `agent_propose_next`
  blocks the matching command.

## Out Of Scope

- Auto-detecting goals from code (cannot infer intent).
- LLM-driven profile completion.

## Dependencies

- Sprint 18 (knowledge tabs) for UI surface of profile + glossary.
- Spec 031 (anti-patterns / doc render) to share the Markdown
  renderer.
