# Spec 440 — Epic charter: 1541 full literal VICE port

**Status:** OPEN  
**Priority:** HIGH  
**Doctrine:** Charter spec for the 1541-vollständig epic. Owns the
status matrix, the sequence-of-specs (441–451), the validation-harness
goalpost, and the doctrine-rules (no subagent audits, no TS-OO
abstractions hiding VICE structs).

## Goal

Bring every chip and every function of VICE's stock-1541 emulation to
1:1 TypeScript shape. Sprint 430 closed the IEC/VIA/GCR-read path
only; this epic covers the rest.

## Source-of-truth

- `docs/epic-1541-full-vice-port.md` — epic master doc
- Sequence: 441 → 442 → 443 → 444 → 445 → 446 → 447 → 448 → 449 → 450 → 451

## Acceptance

1. Epic doc committed (`docs/epic-1541-full-vice-port.md`).
2. All 12 spec files (440–451) created with concrete VICE-source
   citations and per-spec acceptance.
3. Status matrix in epic doc captures the current state of every
   1541-related file in `src/`.
4. `PLAN.md` updated with the epic-440 row plus per-spec links.

## Output

- `docs/epic-1541-full-vice-port.md`
- `specs/440-...md` … `specs/451-...md`
- `PLAN.md` updated

## Do Not

- Do not start spec 441 in this spec. This is the charter only.
- Do not delegate audit work to subagents in any of the 441+
  specs (the gcr-audit subagent gave a false PASS and motivated
  this epic).
- Do not "merge" specs to save time. Each chip/module gets its own.
