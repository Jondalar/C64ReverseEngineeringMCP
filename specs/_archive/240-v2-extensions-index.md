# Spec 240 — V2.x extensions index

**Sprint:** 124+ (parallel to 230 core)
**Status:** PROPOSED 2026-05-08
**Master:** 230

## Goal

Track V2.x feature extensions beyond the 8 core sub-specs (231-238).
Index spec — refinement happens in 241-251.

## Sub-spec lineup

| Spec | Topic | Priority |
|------|-------|----------|
| 241 | Conditional breakpoints + watchpoints | High |
| 242 | Trace bookmarks / annotations | High |
| 243 | Rewind + interactive patch/poke + scenario iter | High |
| 244 | Taint analysis / dataflow tracking | High |
| 245 | Loader / protection profiling | High |
| 246 | Save-state semantic diff | High |
| 247 | Routine fingerprinting (library match) | High |
| 248 | VICE monitor parity + indirect r/w/jump tracking | High |
| 249 | Disasm-time annotation suggestions + table discovery | High |
| 250 | Regression vs known-good baselines | Mid |
| 251 | C64-main VSF completion (full snapshot interop) | High |

Spec 12 from feature brainstorm (distributed scenarios) deferred.
Audio capture (was #10) belongs to V3, not tracked here.

## Sequencing

Indices 241-251 are mostly independent. Suggested order:

1. **251** (VSF c64-main) — unblocks scenario interop with VICE.
2. **241 + 242 + 246** — debug primitives. Cheap, foundational.
3. **243** — rewind + patch (depends on 251 VSF + 231 replay).
4. **247 + 248 + 249** — RE-leverage: fingerprint + monitor + disasm.
5. **244 + 245** — heavier analytics on top of trace store.
6. **250** — last; depends on stable baselines.

## Refinement gate

Each sub-spec lands in PROPOSED with open questions. Implementation
starts only after open questions resolved + status flipped to
APPROVED.
