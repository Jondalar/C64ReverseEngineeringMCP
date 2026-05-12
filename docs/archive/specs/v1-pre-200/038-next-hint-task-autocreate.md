# Spec 038: NEXT-Hint → Task Auto-Create

## Problem

Tools like `analyze_prg`, `disasm_prg`, `ram_report`, `pointer_report`,
`run_prg_reverse_workflow`, `extract_disk`, `extract_crt` print "NEXT
STEP: ..." hints to stdout and append to NEXT.md. The hint vanishes
on session resume — agent has to re-read NEXT.md and remember.
REQUIREMENTS R9.

## Goal

Every tool that emits a NEXT-hint also creates a tracked
`auto-suggested` task. Tasks auto-close when their follow-up tool
runs, kept in check by aggressive dedup, auto-close logic, and
cascade suppression so the list stays high-signal even when many
tools fire in sequence.

## Approach

### Schema

Extend `TaskRecord`:

```ts
producedByTool?: string;
artifactIds: z.array(IdSchema).default([]);
autoCloseHint?: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file-exists"), path: z.string() }),
  z.object({ kind: z.literal("artifact-registered"), role: z.string() }),
  z.object({ kind: z.literal("phase-reached"), artifactId: IdSchema, phase: z.number().int() }),
]).optional();
autoSuggested: z.boolean().optional();
```

### Helper

`emitNextStepTask(service, { producedByTool, artifactIds, title, description, autoCloseHint })`:

1. Compute id = `auto-task:<tool>:<artifactId>:<sha1(title)>`.
2. If task with same id exists and is open, no-op (dedup).
3. Otherwise `service.saveTask({ id, kind: "auto-suggested", ... })`.

### Tool integration

Every NEXT-hint emitter calls `emitNextStepTask` with the matching
auto-close hint:

| Tool | Suggested task | Auto-close hint |
|------|----------------|-----------------|
| `analyze_prg` | "Run disasm_prg on <stem>" | `file-exists: <stem>_disasm.asm` |
| `disasm_prg` (no annotations) | "Write <stem>_annotations.json" | `file-exists: <stem>_annotations.json` |
| `disasm_prg` (with annotations) | "Verify rebuild + save findings" | `phase-reached: artifact, phase=5` |
| `ram_report` | "Review RAM facts and link entities" | `phase-reached: artifact, phase=5` |
| `pointer_report` | "Review pointer table and label" | `phase-reached: artifact, phase=5` |
| `extract_disk` | "Inspect manifest, register files" | `artifact-registered: disk-manifest` |
| `extract_crt` | "Inspect chunks, create payloads" | `artifact-registered: cart-chunk` |
| `run_prg_reverse_workflow` | conditional based on result.status | varies |

### Auto-close-checker

Runs in `agent_onboard` and as standalone MCP tool
`close_completed_tasks(project_dir?)`:

1. List tasks with `kind: "auto-suggested"`, `status: "ready"`.
2. For each:
   - `file-exists`: check `existsSync(path)` → close if yes
   - `artifact-registered`: check `service.listArtifacts().some((a) => a.role === role)` → close if yes
   - `phase-reached`: check artifact phase ≥ target → close if yes
3. Closed tasks log `task.status.updated` to timeline.

### Cascade suppression

When a tool emits a NEXT-hint and an earlier auto-task on the same
artifact is satisfied by the same execution (e.g. analyze→disasm in
sequence), close the older auto-task before emitting the new one.
Implementation: helper checks for matching `producedByTool` task on
same artifact and closes it.

### UI / list output

`list_tasks` shows auto-suggested tasks with `[auto]` badge.
Default filter includes them.

## Acceptance Criteria

- Running `analyze_prg` against a fixture PRG creates a task
  "Run disasm_prg on sample".
- Subsequent `disasm_prg` cascade-closes the analyze task and
  emits a "Write sample_annotations.json" task.
- After writing the annotations file, `agent_onboard` auto-closes
  the annotations task.
- Re-running `analyze_prg` does not duplicate the task.

## Tests

- Smoke: simulate the analyze → disasm → annotation chain on a
  fixture; assert task ids, statuses, cascade closures.
- Smoke: dedup — call `emitNextStepTask` twice with identical
  args, assert one task remains.

## Out Of Scope

- Complex multi-condition auto-close hints (single-condition v1).
- UI drag-and-drop task management.

## Dependencies

- Spec 022 phase model for `phase-reached` hint.
- Spec 034 reminder loop already exposes `agent_onboard` which is
  the natural close point.
