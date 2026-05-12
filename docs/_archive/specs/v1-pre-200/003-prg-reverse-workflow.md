# Spec 003: PRG Reverse Workflow

## Problem

When a user asks an agent to disassemble a PRG, agents often run a local
or partial sequence. The result may create files but skip registration,
knowledge import, semantic follow-up, or view builds.

## Tool

Add MCP tool:

```text
run_prg_reverse_workflow(
  prg_path: string,
  project_dir?: string,
  mode?: "quick" | "full",
  output_dir?: string,
  rebuild_views?: boolean
)
```

Default mode should be `full` for user-facing "disassemble" requests.

## Workflow

The tool orchestrates:

1. Resolve project root.
2. Register input PRG as an artifact if needed.
3. Run deterministic analysis.
4. Generate disassembly.
5. Generate RAM and pointer reports where applicable.
6. Register all outputs.
7. Import analysis knowledge.
8. Build all views unless disabled.
9. Return done/incomplete/blocked with concrete next steps.

## Output

The tool returns:

- resolved root
- artifacts written
- imported counts
- views built
- skipped phases with reasons
- next required semantic actions

## Acceptance Criteria

- A single tool call creates a complete first-pass reverse-engineering
  state for a PRG.
- Every created file has a project-root-relative artifact record.
- Entities/findings/relations/open questions from analysis are imported.
- The UI dashboard counts change after the workflow finishes.
- A failure in one phase returns a blocked state instead of pretending
  the workflow is complete.

## Tests

- Use an example PRG fixture.
- Verify artifact registration count.
- Verify imported knowledge counts are nonzero for a known analysis.
- Verify views are newer than knowledge after the run.
