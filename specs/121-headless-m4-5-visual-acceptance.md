# Spec 121 — Headless M4.5: Visual Acceptance

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 4, story M4.5
Depth: light
Predecessors: Spec 102 (M1.5), Spec 117 (M4.1), Spec 119 (M4.3)

## Motivation

Per target game, the runtime should record a small set of expected
visual states: BASIC READY, loading, title, first gameplay. These
become the visual acceptance gates plumbed into the M1.5 regression
matrix.

## Acceptance

- For each target game (initial set: MM, MOTM, IM2, LNR), store:
  - `samples/visual-acceptance/<game>/{ready,loading,title,gameplay}.png`
  - `samples/visual-acceptance/<game>/{ready,loading,title,gameplay}.json`
    with state hash + screen-text snippet.
- `assertVisualState(session, fixture)` compares current state against
  fixture. State-hash + screen-text are primary; PNG similarity is
  secondary (tolerance configurable).
- M1.5 regress matrix entries can declare expected visual states.

## Deliverables

- NEW `src/runtime/headless/regress/visual-acceptance.ts`
- Initial fixtures for MM at minimum
- Smoke per game where fixture exists.

## Dependencies

- Spec 102.
- Spec 117.
- Spec 119.

## Risks

- PNG flakiness from rendering differences across machines.
  Mitigation: state-hash + text-snippet primary; PNG secondary.
- Game ROM availability: gitignored. Mitigation: skip-with-reason
  when fixture missing, do not hard-fail.

## Out of scope

- OCR.
- Image-similarity beyond hash + tolerance window.
- Animation acceptance (multi-frame sequences).
