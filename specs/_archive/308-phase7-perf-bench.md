# Spec 308 — Phase 7 Perf Bench (Acceptance Met)

Status: open
Date: 2026-05-10
Predecessor: Spec 307 (tickLitVic refactor)
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 7

## Goal

Measure literal port runtime speed on M4 Mac. Migration plan
Phase 7 acceptance = "at least real-time PAL C64 performance in
Node" (= 985,248 cyc/sec).

## Result

**Bench (60 PAL frames, BASIC ready scenario):**

```
cycles run: 1,179,361
wall time:  327.3 ms
speed:      3,602,905 cyc/sec
realtime:   3.66× (182.8 fps PAL equivalent)
PASS: realtime PAL achieved
```

**Acceptance: PASS.** 3.66× realtime ≫ 1.0× target.

## Notes

- No code strip required to meet Phase 7 acceptance.
- VicIIVice's redundant per-cycle work (snapshot push, scanline
  capture, raster IRQ alarm setup) still runs alongside literal
  port — could be stripped for further speedup but isn't needed
  per migration plan acceptance.
- M4 Pro has plenty of headroom; if a sub-realtime case appears
  (= heavy game with full sprite + IRQ workload), a follow-up
  spec can re-bench + strip selectively.

## Deliverables

- `scripts/bench-vic-308-perf.mjs` (callable bench harness)
- `specs/308-phase7-perf-bench.md` (this)

## Migration plan status

| Phase | Spec | Status |
|---|---|---|
| 1 — stop drift | (existing comments) | ✓ |
| 2 — literal R/W authority | 300 | ✓ |
| 3 — literal raster IRQ | 301 | ✓ |
| 4 — literal BA/AEC | 302 | ✓ |
| 5 — literal framebuffer | 303 | ✓ |
| 6a — defaults on | 304 | ✓ |
| 6b1 — strip cycle-pumped + UI flip | 305 | ✓ |
| 6b2 — delete renderer files | 306 | ✓ |
| 6c — driver refactor | 307 | ✓ (refactor only; full inversion blocked by VicIIVice raster_y reads) |
| 7 — perf | 308 | ✓ (3.66× realtime) |
| 8 — Runtime-Core API stabilization | (later) | not started |
| 9 — Rust core spike | (later) | out of scope |

VicIIVice file (`src/runtime/headless/vic/vic-ii-vice.ts`) survives
as fast-trap mode fallback driver + raster_y/bad_line provider for
diff harnesses. Full deletion would require either dropping
fast-trap mode or migrating diff harnesses to literal-only — not
needed per Phase 6 acceptance ("in fidelity mode no path outside
literal decides X" — fast-trap is not fidelity).

## Next slice

Switch to forward-fix mode. Spec 309 = D016/D018 split bug for
motm (= ship doesn't appear, screen grey, charmap flickers behind
where ship should be). User-confirmed via UI test after Spec 305
flipped UI default to literal.
