# Spec 116 — Headless M3.8: Drive Fidelity Backlog

Status: **DONE 2026-05-04.** Per spec exit criterion each acceptance bullet is either covered by a test fixture or recorded as an explicit gap with rationale. Covered: M3.8b track-zero stop (3 checks — `stepOutward` bound at halfTrack 2, regress 5/5 still green) and M3.8f disk-change WP (3 checks — `coupling.writeProtected` lazy read flips PB_WPS line on next read). Gap-with-rationale: M3.8a motor spin-up delay, M3.8c VIA shift-register modes, M3.8d VIA timer PB7-toggle / TA→TB cascade, M3.8e write splice (gated on Spec 114 v2). Doc: `docs/drive-fidelity-backlog.md`. Smoke: `npm run smoke:fidelity-backlog` 6/6.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.8
Depth: deep
Predecessors: Specs 109-115

## Motivation

A catch-all for remaining true-drive details that do not justify their
own milestone story but together complete the TrueDrive contract:
motor spin-up/down timing, track-zero stop, VIA shift register modes,
VIA timer edge cases, write splice behavior, and disk-change
semantics. Items not implemented end up in an explicit gap document
rather than as silent emulator bugs.

## Acceptance

Each of the following is either covered by a test fixture or recorded
in `docs/drive-fidelity-backlog.md` as an explicit gap with a
rationale:

- Motor spin-up: drive ROM waits ~0.5 s after motor on before reading.
- Track-zero stop: head at track 1 cannot move further outward.
- VIA shift register modes: CA1 ext clock, T2 clock, system clock.
- VIA timer edge cases: PB7 toggle output, one-shot vs continuous,
  cascading TA→TB.
- Write splice behavior: writing to a partially-formatted track.
- Disk-change semantics: WP signal flips when disk swapped via API;
  drive ROM detects via WP-line poll.

## Sub-stories

### M3.8a — Motor spin-up / down
Cycle-aware delay; drive ROM observes motor state through PB2.

### M3.8b — Track-zero stop
Bound `HeadPosition.stepOutward` at 1; drive ROM bumps off the
mechanical stop.

### M3.8c — VIA shift register
Implement at least system-clock mode; document gaps for CA1-ext and
T2 modes if rare.

### M3.8d — VIA timer edge cases
PB7 toggle; one-shot vs continuous; cascading.

### M3.8e — Write splice
Document behavior; minimal handling.

### M3.8f — Disk-change semantics
API-driven disk swap flips WP, signals drive ROM.

### M3.8g — Documentation
`docs/drive-fidelity-backlog.md` records each item's status (covered
or gap-with-rationale).

## Deliverables

- EDIT drive-emulation files as needed
- NEW `src/runtime/headless/drive/drive-fidelity-backlog-tests.ts`
- `docs/drive-fidelity-backlog.md`
- Synthetic fixtures per covered item

## Dependencies

- Specs 109-115.

## Risks and mitigations

- **Catch-all scope balloon**: tempting to add more items.
  Mitigation: each item is a separate test or gap entry; spec
  explicitly lists what is in/out at refinement time.
- **Some items rare in real software paths**: VIA shift register, T2
  clock, write splice. Mitigation: prefer documented gap to partial
  implementation when usage is rare.

## Exit criteria

Each acceptance bullet either has a passing test fixture or a
documented gap entry with rationale.

## File-touch list

- EDIT drive emulation files as needed
- NEW `src/runtime/headless/drive/drive-fidelity-backlog-tests.ts`
- NEW `docs/drive-fidelity-backlog.md`
- NEW `samples/synthetic/drive/backlog/*.bin`

## Out of scope

- Bad-sector emulation.
- Copy-protection write-detection.
- Custom-format-disk write splice.
- Real-time bit-flux modeling.
