# Spec 008: BWC Reverse Pilot

## Goal

Use `/Users/alex/Development/C64/Cracking/BWC Reverse` as a real-world
validation project for the workflow.

## Steps

1. Run `project_audit`.
2. Record all high-severity findings.
3. Run `project_repair` in dry-run mode.
4. Apply safe repair operations.
5. Rebuild all views.
6. Pick one PRG/payload and run `run_prg_reverse_workflow`.
7. Store remaining unknowns as tasks or open questions.
8. Confirm `agent_onboard` can resume without chat context.

## Evidence To Capture

- before/after counts
- nested knowledge paths found
- artifacts registered
- analysis artifacts imported
- views rebuilt
- open questions that remain
- next recommended action

## Acceptance Criteria

- The project has one authoritative root knowledge store.
- The workspace UI shows the repaired counts.
- At least one target PRG has complete first-pass artifacts.
- No important next step exists only in chat.

## Notes

This pilot should drive implementation details. If the tool design does
not handle the real BWC project, adjust the tools rather than working
around the project manually.
