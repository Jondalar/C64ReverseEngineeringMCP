# Spec 041: Per-Artifact Relevance Ranking (R25 + P2 fold-in)

## Problem

Cracker / port work focuses on a small subset of artifacts (loader,
protection, save, KERNAL replacement). Asset PRGs (sprite banks,
scene data) need only Phase-1. Today the dashboard ranks artifacts
alphabetically; the agent has no signal to prioritise.

REQUIREMENTS R25 (new) folds in P2 (per-PRG cracking-priority
tagging). `agent_freeze_artifact` (Sprint 34) is a binary skip;
this spec adds graded ranking for the artifacts that are not
frozen.

## Goal

Every artifact carries a `relevance` tag and a derived
`relevanceRank` (1 = most important, n = least). The dashboard
sorts by rank. `agent_propose_next` walks artifacts in rank order.
Cracker-mode workers see loader / protection / save first.

## Approach

### Schema

Extend `ArtifactRecord`:

```ts
relevance?: "loader" | "protection" | "save" | "kernal" | "asset" | "other";
relevanceRank?: number;   // computed; 1..n
```

`relevance` is a manual tag (set by user or via auto-classifier).
`relevanceRank` is computed by the service from multiple sources
priority-ordered:

1. **Manual `relevance` tag** (if set) → rank from a fixed map:
   - loader → 1
   - protection → 2
   - save → 3
   - kernal → 4
   - other → 5
   - asset → 6
2. **`load_sequence` flow position** (if no manual tag and load
   sequence exists) → rank in chain order (boot first, content
   later).
3. **`load_event` first-seen timestamp** (if traces exist) →
   earlier observed = lower rank.
4. **Fallback** → alphabetical by title (rank = sorted index).

The lower value of the available source wins. Ties broken by
artifact id sort.

### Auto-classifier (light)

`auto_tag_relevance(project_dir)` MCP tool walks artifacts and
suggests tags from heuristics:

- `loader` if title matches `boot|loader|sys` or artifact has a
  declared `loader-entrypoint`
- `protection` if any registered `anti-pattern` references the
  artifact, or if title matches `protect|copy|prot`
- `save` if title matches `save|store|hi.?score`
- `kernal` if any `loadContext` carries `kind: "runtime"` with
  `address >= $E000`
- `asset` if `payloadFormat` is `raw` and artifact role is
  `prg-asset` or title matches `sprite|charset|font|level|map`

The tool only suggests; the user / agent confirms by calling
`save_artifact(... relevance="...")`.

### MCP tools

- `set_artifact_relevance(artifact_id, relevance)` — manual tag.
- `auto_tag_relevance(project_dir, dry_run?)` — heuristic
  classifier.
- `get_per_artifact_status` (Spec 022) returns `relevance` +
  `relevanceRank` per row.

### Dashboard

Sort dropdown adds `relevance` option. Cracker mode (Spec 033)
default-sorts by relevance.

`agent_propose_next` walks artifacts in `relevanceRank` ascending
order, so phase-bound recommendations target the most important
artifacts first.

## Acceptance Criteria

- A fixture artifact tagged `relevance = "loader"` ranks above an
  untagged artifact.
- An untagged artifact with a `load_sequence` position 3 ranks
  above an untagged artifact at position 7.
- `auto_tag_relevance --dry_run` returns proposed tags without
  writing.
- Cracker-mode dashboard sorts loader → protection → save → ... by
  default.
- `agent_propose_next` lists phase-bound actions for the loader
  artifact before the asset PRG.

## Tests

- Smoke: register three artifacts (loader, asset, untagged),
  assert rank order matches the priority map.
- Smoke: auto_tag_relevance against a fixture with title-pattern
  matches, assert proposed tags.

## Out Of Scope

- Auto-applying suggestions without user confirmation.
- Custom user-defined relevance categories.

## Dependencies

- Spec 022 per-artifact status — surface relevance in the row.
- Spec 026 project profile — none direct; cracker-mode default
  sort lives here.
- Spec 033 cracker doctrine — the priority map mirrors the
  cracker priority order.
