# Spec 049: Hard-Refuse Phase Gate Interceptor

## Problem

Sprint 34 shipped the phase data model (`phase` per artifact,
`phaseGateStrict` flag in project profile, `isToolAllowedInPhase`
helper). Sprint 36 added `[Phase N]` description prefixes via the
Spec 039 wrapper. But no code path actually **invokes** the helper
on tool dispatch — agents can still call phase-bound tools out of
order, and the soft signal in `agent_propose_next` is opt-in.

## Goal

`phaseGatedHandler` wrapper that runs before `safeHandler`,
resolves the artifact id from tool args, looks up its current
phase, and either lets the tool proceed or returns the structured
"Phase Gate Refused" output from Spec 034. Active only when
`projectProfile.phaseGateStrict === true` (default false → no
behavior change for users who haven't opted in).

## Approach

### Wrapper layering

```
phaseGatedHandler(toolName, safeHandler(toolName, handler))
```

`phaseGatedHandler` runs first. If the gate refuses, the inner
`safeHandler` never runs; the wrapper returns a `ToolTextResult`
shaped like the Spec 034 example.

### Argument resolution

For each tool call, walk args looking for an artifact reference in
this order:

1. `artifact_id`
2. `payload_id` (resolve via service.listEntities → entity.payloadSourceArtifactId)
3. `recipe_id` (resolve via service.listPatchRecipes → recipe.targetArtifactId)
4. `prg_path` (resolve via service.listArtifacts where path matches)
5. `analysis_json` (resolve via service.listArtifacts where path matches)

If no artifact resolves → fall through allow (no hard refuse
without context).

### Phase lookup

```ts
const artifact = service.listArtifacts().find((a) => a.id === artifactId);
const currentPhase = artifact?.phase ?? 1;
```

If artifact not found in store → fall through allow.

### Refusal output

```
# Phase Gate Refused

Tool: save_finding
Artifact: 11_riv1.prg (phase 3)
Requested phase: 5+ (semantic analysis)
Why: phase 4 (segment analysis) is not yet complete on this
artifact. Findings written before phase 4 are usually
under-contextualised and need revision in phase 5.

Recommended next action:
  inspect_address_range(artifact_id="...", start=$1000, end=$1FFF)

Override:
  set projectProfile.phaseGateStrict to false, or
  call agent_advance_phase(artifactId="...", toPhase=4,
    evidence="phase 4 done out-of-band: ...").
```

### Coverage

All tools registered in `PHASE_TOOLS` (Spec 034 phase-tools.ts) get
the wrapper applied. `PHASE_AGNOSTIC_TOOLS` skip automatically
(the wrapper sees they are agnostic and falls through).

Tools that emit no artifact reference fall through too — the gate
is best-effort, not exhaustive. Coverage is most useful on
save_finding / save_entity / apply_patch_recipe / save_relation /
disasm_prg with annotations.

### Application

Wire `phaseGatedHandler` into `src/server.ts` similar to the Spec
039 description tagger: monkey-patch `server.tool()` so the
wrapper is applied to every registration. Existing safeHandler
calls inside the registration sites stay; the new wrapper is
outermost.

## Acceptance Criteria

- With `phaseGateStrict: false` (default), no behavior change.
  Existing smokes still pass.
- With `phaseGateStrict: true` and an artifact at phase 3, calling
  `save_finding(artifactIds: [<that-id>])` returns the structured
  refusal output instead of executing.
- Tools without resolvable artifact (e.g. `save_anti_pattern`
  project-wide) fall through allow.

## Tests

- Smoke: enable strict gate on fixture project, attempt phase-skip,
  assert refusal text + that finding store stayed unchanged.
- Smoke: phaseGateStrict=false, same call, assert finding saved.
- Smoke: agnostic tool (agent_propose_next) with strict gate,
  assert allowed.

## Out Of Scope

- Per-tool override of strict mode in v1.
- Auto-suggesting alternative tool calls beyond the doctrine
  reference.

## Dependencies

- Spec 034 phase data + `isToolAllowedInPhase`.
- Spec 045 nextStepError shape (refusal output reuses it).
- Spec 026 project profile (`phaseGateStrict`).
