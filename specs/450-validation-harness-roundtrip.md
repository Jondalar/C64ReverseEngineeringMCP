# Spec 450 — Validation harness: read/write/verify roundtrip

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Specs 441–449

## Goal

End-to-end validation that the full literal-port chain produces
byte-identical output to VICE for representative disk images.

## Components

1. **Read roundtrip**: for each canary disk + every sector on track
   18 (BAM/dir track) — `gcr_read_sector` HL vs VICE. Compare 256
   data bytes byte-by-byte.
2. **Write roundtrip**: random data → `gcr_write_sector` → read back
   via HL → equal. Then dump the G64 to VICE and verify same bytes
   appear at the same track bit-positions.
3. **Cycle roundtrip**: capture HL trace + VICE trace under
   identical input sequence; trace-store diff on:
   - drive PC stream
   - VIA1/VIA2 IFR transitions
   - rotation byte-ready events
   - IEC bus state transitions
4. **Lorenz Disk1 100%**: existing `npm run test:lorenz:disk1` must
   stay at 100% pass throughout the epic.

## Acceptance

1. `scripts/spec-450-roundtrip.mjs` exists.
2. `npm run validate:1541` runs full harness and exits 0.
3. Report `docs/spec-450-validation-report.md` committed with
   per-canary, per-sector verdict table.
4. Specs 441–449 all marked DONE.
5. Epic 440 acceptance bullets 1–6 all checked.
6. No subagent invoked for verdicts.

## Do Not

- Don't replace VICE oracle (VICE remains the cross-reference).
- Don't skip the Lorenz suite "to save time".
