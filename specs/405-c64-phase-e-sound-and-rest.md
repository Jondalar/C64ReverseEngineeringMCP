# Spec 405 — C64 Phase E: Sound and the rest

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 404
**Doctrine:** 1:1 VICE x64sc port. Never deviate.

## Goal

Bring SID, datasette, I/O dispatch, snapshot, cartridge in line with
`docs/vice-c64-arch.md §12 Phase E` (steps 21–25).

## Doc anchor

- §12 Phase E (steps 21–25)
- §7 SID overview (§7.1 engines, §7.2 capture/playback)
- §8 I/O area dispatch (§8.1, §8.2, §8.3 cartridge I/O)
- §9 Datasette
- §10 Snapshot / save state (§10.1 module list, §10.2 alarm rescheduling)

## Canonical content (verbatim §12 Phase E)

21. SID engine: link or port ReSID. Capture writes via mem table.
    Audio thread or pull-mode sampler.
22. Datasette: alarm-driven pulse list. Bit 4 of $01 → CIA1 FLAG.
23. I/O area dispatch + open bus.
24. Snapshot save/restore in the §10.1 module order.
25. Cartridge support: at least Standard (16K), Ocean, Easyflash if
    games are the goal.

## VICE source cite

- SID: `src/sid/` (engine), `src/c64/c64sid.c` (wiring).
- Datasette: `src/c64/c64datasette.c`, `src/datasette/`.
- I/O dispatch: `src/c64io.c`, `src/c64/c64io.c`.
- Snapshot orchestrator: `src/c64/c64-snapshot.c`.
- Cartridge: `src/c64/cart/`.

## Audit — current TS state

Source files:

- `src/runtime/headless/sid/sid-6581.ts`
- `src/runtime/headless/datasette/*` (if exists)
- I/O routing: `src/runtime/headless/memory-bus.ts` +
  `src/runtime/headless/kernel/headless-machine-kernel.ts`
- Snapshot: VSF support exists per memos (Spec 309-H, vsf save/load
  MCP tools)
- Cartridge: `src/runtime/headless/cartridge/*.ts`

Known status:

- SID exists (`sid-6581.ts`). Audio export via MCP tool.
- Datasette: unknown — likely stub or absent.
- I/O dispatch: works for D000-DFFF (CIA, VIC, SID, color RAM).
- Snapshot: VSF save/load works (per memos). Module order = ?
- Cartridge: partial (CRT extractor exists; runtime install ?).

## Deviations to verify (file:line by fresh session)

1. **SID write capture** (§7.2):
   - Required: writes captured via mem table; engine drives audio.
   - **TODO**: confirm `sid-6581.ts` write path goes through
     memory-bus I/O handler at $D400-$D7FF.

2. **Datasette PULSE alarm + CIA1 FLAG** (§9, §12 step 22):
   - Required: alarm-driven pulse list; bit 4 of $01 → CIA1 FLAG bit.
   - **TODO**: implement or stub; mark `// TODO datasette` if no
     game requires it (memos do not list datasette-dependent games).

3. **I/O open-bus reads** (§8.1, §8.2):
   - Required: unmapped reads return open-bus; mirrors per §8.2.
   - **TODO**: audit read path for $DE00-$DFFF (cart I/O), $D040-
     $D3FF mirrors (VIC), $DC10-$DCFF mirrors (CIA1).

4. **Cartridge** (§12 step 25):
   - PAL game corpus (MM, Scramble Infinity) is disk-only, no
     cartridge needed. Cartridge wiring stays stub for now; full
     cart support is post-arch-port.
   - **TODO**: confirm GAME=EXROM=1 stub from spec 402.

5. **Snapshot module order** (§10.1, §10.2):
   - Required: write/read in fixed order; alarms re-armed relative
     to current clock on restore.
   - **TODO**: audit VSF save/load order; verify alarm rescheduling
     after load.

## TS extras to DELETE

- Audio abstraction layers not in VICE (= keep `sid-6581.ts` as the
  engine, drop any non-VICE driver wrappers).
- Snapshot-format converters that diverge from VICE VSF.

## NTSC stub

- SID engine is rate-aware via `cycles_per_second`; PAL constant.
  `// TODO NTSC` for SID clock derivative if any path hard-codes
  PAL.

## Producer changes

- Verify SID write capture path through I/O table.
- Stub datasette behind a clean `// not implemented; no game
  requires it` for now.
- Cement I/O open-bus return value.
- Verify VSF snapshot module order matches §10.1.

## Consumer changes

- None; this phase is mostly audit + verification.

## Acceptance

- Build clean.
- Existing audio-export smoke (if any) passes.
- New smoke `scripts/smoke-405-snapshot-roundtrip.mjs`: save VSF
  mid-MM-load, restore, advance same number of cycles, assert
  framebuffer identical.
- New smoke `scripts/smoke-405-io-mirror.mjs`: read $D040 + $D000
  return same VIC register value (mirroring per §8.2).
- MM + Scramble unchanged.

## Open Questions

- **OQ-405-1**: Datasette scope — is it required for any in-scope
  game? If no, defer to post-arch-port follow-up spec.
- **OQ-405-2**: SID engine fidelity — VICE has multiple engines
  (FastSID, ReSID, ReSIDfp). Which does headless target as 1:1?
  Doc §7.1 lists them but no canonical pick.
- **OQ-405-3**: VSF module order — list explicitly in
  `docs/vice-c64-arch.md §10.1` and pin TS save/load to it.

## Files touched

- `src/runtime/headless/sid/sid-6581.ts` (audit)
- `src/runtime/headless/memory-bus.ts` (open-bus + mirrors)
- `src/runtime/headless/datasette/*.ts` (stub or new)
- snapshot save/load TS sites (audit)
- 2 new smokes
- `specs/405-c64-phase-e-sound-and-rest.md` (this)

## Next spec

Spec 406 — C64 Phase F: Validation.
