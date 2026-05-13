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

## Mandatory per-spec workflow (7 steps)

Every spec from 441 onward MUST follow this sequence. No shortcuts,
no merged steps, no parallel execution within a spec:

1. **Mapping-Tabelle** — write the full row-per-VICE-function table
   first. Columns: VICE function, VICE file:line range, TS impl
   (or "MISSING"), TS file:line range (or `-`), state-shape diff
   notes, verdict-target (target = MATCH).
2. **Code portieren** — implement the literal TS counterpart for
   every row that is not already MATCH. Preserve function names,
   struct field names, call order. No "improvements".
3. **Alte produktionspfade entfernen** — delete every TS path that
   the new literal port replaces. No "@deprecated" fallbacks left
   alive in production. Tests that still exercise the old shape
   either get migrated or marked `@internal test-only`.
4. **Beweis** — produce a grep + trace report proving the
   production code path now goes through the new literal functions
   and ONLY through them. File: `docs/spec-<NNN>-production-proof.md`.
   Includes: greps for old symbol names (zero matches in `src/`),
   single-path trace with file:line cites.
5. **Tests** — unit tests covering every formula and every state
   transition the spec touched. Tests live in `tests/<spec>-*.test.ts`
   or `scripts/smoke-<spec>-*.mjs`. Vectors lifted from VICE source
   or harvested via `vice_trace_runtime_start` ONCE.
6. **Keine subagent-verdicts** — Claude reads VICE source itself
   for every verdict. Subagents may do lookups (find file, grep
   for symbol) but never produce a MATCH/BUG conclusion.
7. **Keine architektur-entscheidung ohne explizite rückfrage** —
   if a port forces a choice that wasn't pre-specified (rename a
   class, split a file, change a struct shape, introduce a new
   helper, defer a sub-task), STOP and ask the user before
   implementing.

Each spec from 441 onward must list at the top:

```
**Workflow gate:** 7-step (per Spec 440)
```

And its acceptance must include:
- ✅ Step 1 mapping doc committed
- ✅ Step 2 port code committed
- ✅ Step 3 old paths deleted (zero grep hits in `src/`)
- ✅ Step 4 production-proof doc committed
- ✅ Step 5 tests committed and green
- ✅ Step 6 no subagent verdicts recorded
- ✅ Step 7 every architecture call escalated to user

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
