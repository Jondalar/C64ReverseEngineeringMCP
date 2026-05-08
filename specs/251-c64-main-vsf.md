# Spec 251 — C64-main VSF completion (full snapshot interop with VICE)

**Sprint:** 124+ (precedes 243 rewind)
**Status:** PROPOSED 2026-05-08
**Depends on:** existing src/runtime/headless/vsf/* drive-VSF
**Master:** 230 / 240

## Goal

Round-trip C64-main state through VICE Snapshot Format (VSF). Drive
VSF already shipped (`drive-vsf.ts`). Missing: c64 cpu, RAM, CIA1,
CIA2, VIC-II, SID, PLA. Once complete, headless can save → VICE
loads → continue, and vice versa.

This unblocks Spec 243 (rewind/branch needs serializable snapshots)
+ Spec 236 (VICE diff needs starting-state interop).

## Modules to add

Per VICE module-mapping table (`src/runtime/headless/vsf/module-mapping.ts`):

| VICE module | Headless source | Status |
|-------------|-----------------|--------|
| `MAINCPU`   | cpu6510 / cpu65xx-vice | partial (regs done, microcode state TBD) |
| `C64MEM`    | memory-bus.ts (ram + cpu-port + capacitor) | new |
| `CIA1`      | cia/cia6526-vice.ts | new |
| `CIA2`      | cia/cia6526-vice.ts | new |
| `VIC-II`    | vic/vic-ii-vice.ts | new |
| `SID`       | sid/sid.ts | new |
| `KEYBOARD`  | peripherals/keyboard.ts | new |
| `JOYPORT1/2`| peripherals/keyboard.ts | new |

VICE chunk binary format documented in `vice/src/c64/c64-snapshot.c`
+ each chip's `*_snapshot_write_module` + `_read_module` calls.

## API extension

```ts
// existing
saveDriveSnapshotToVsf(session): Uint8Array;
loadDriveSnapshotFromVsf(session, bytes): void;

// new
saveSessionSnapshotToVsf(session): Uint8Array;
loadSessionSnapshotFromVsf(session, bytes): void;
```

MCP tools:

```
headless_session_save_vsf <path>
headless_session_load_vsf <path>
```

## Compatibility constraints

- Match VICE 3.7+ chunk versioning; reject older.
- Bit-exact reproduction: capacitor decay state (Spec 219-c4) must
  serialize all 5 falloff fields.
- Round-trip test: HL → VSF → HL → VSF must be byte-identical.
- HL → VSF → VICE → save → HL: byte-identical required (= cross-
  emulator interop).

## Open questions

- **OQ1 [RESOLVED 2026-05-08]:** VICE 3.7+ only. No legacy overhead.
  Save always emits 3.7 format. Load version-checks; older versions
  rejected with clear error.
- **OQ2:** Optional modules (CRT, REU, SFX expander) — out-of-scope
  for V1, return empty chunks?
- **OQ3:** Microcode state for cpu65xx-vice — VICE serializes
  current micro-step; do we?
- **OQ4 [RESOLVED 2026-05-08]:** fastsid only for V2.x. Maps register
  state + envelope (~50 bytes). resid full state deferred to V3
  (audio playback territory). VICE-saved-with-resid chunks: import
  mode accepts chunk, recovers register state, ignores resid-internal
  envelope state.
- **OQ5:** Snapshot magic / header — exact VICE bytes or HL marker
  in optional metadata chunk?

## Acceptance

- Save+load HL→HL round-trip byte-equal for c64-ready, motm-stage-1,
  mm-s1 mid-boot scenarios.
- VICE accepts HL-saved VSF for at least one scenario.
- HL accepts VICE-saved VSF for at least one scenario.
- Round-trip preserves capacitor state, IEC line state, head
  position.
