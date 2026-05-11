# Spec 405 — C64 Phase E: Sound and the rest

**Status:** COMPLETE (2026-05-11)
**Branch:** `vice-arch-port`
**Depends on:** 404
**Doctrine:** 1:1 VICE x64sc port. Never deviate.

## Completion summary

- VSF save order reordered to match `c64-snapshot.c:76-91`
  (MAINCPU → C64MEM → CIA1 → CIA2 → SID → DRIVE-group → VIC-II →
  KEYBOARD). SID is now written **before** VIC-II.
- Datasette hook (`memory-bus.ts::datasetteHookStub`) carries explicit
  spec 405 cite + post-arch-port deferred marker. Bit 4 of $01 is a
  no-op datasette hook; bit-4 reads see the pullup HIGH.
- I/O dispatch + open-bus comment block added to `memory-bus.ts` read
  path (cite: `c64io.c:352-371`, doc §8.1/§8.2). VIC mirror tiles
  ($D000-$D3FF, 0x40 stride) and SID mirror tiles ($D400-$D7FF, 0x20
  stride) already in place from prior specs; CIA mirror to $DC10-$DCFF
  and $DD10-$DDFF is documented as future work (no in-scope game
  requires it).
- Two new smokes:
  - `scripts/smoke-405-snapshot-roundtrip.mjs` — 11/11 PASS
  - `scripts/smoke-405-io-mirror.mjs` — 9/9 PASS
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.

Files touched (vs spec "Files touched" list):

- `src/runtime/headless/vsf/session-vsf.ts` — module-order reorder + cite.
- `src/runtime/headless/memory-bus.ts` — datasette stub renamed/cited +
  I/O open-bus comment block.
- `package.json` — registered the two new smoke targets.
- `scripts/smoke-405-snapshot-roundtrip.mjs` — new.
- `scripts/smoke-405-io-mirror.mjs` — new.

NOT touched (per spec hard constraints): `cpu65xx-vice.ts`, any CIA /
VIC / drive / IEC bus source. Audit confirmed SID writes already route
through the I/O table (`sid.ts::installSid` at $D400-$D7FF); no
producer change required there.

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

- **OQ-405-1 — RESOLVED 2026-05-11 — user decision:** Datasette
  **deferred to post-arch-port spec**. No in-scope game (MM,
  Scramble, motm, IM2, LNR, Lorenz CPU corpus) requires datasette.
  Spec 405 stubs it: `// not implemented — no in-scope game
  requires it (deferred to post-arch-port spec)`. Spec compiles
  without the actual pulse-list / CIA1 FLAG path. Bit 4 of $01
  read/write stays a no-op datasette hook.
- **OQ-405-2 — RESOLVED** → `docs/vice-c64-arch.md §7.1`. VICE's
  x64sc default is **ReSID** (`src/sid/sid-resources.c:101-105`:
  `SID_ENGINE_DEFAULT` → `SID_ENGINE_RESID` when ReSID is built in,
  else FastSID fallback). For 1:1 the headless port should target
  ReSID (link the upstream C++ engine). FastSID is acceptable for
  fast unit-tests where audio fidelity is not the metric.
- **OQ-405-3 — RESOLVED** → `docs/vice-c64-arch.md §10.1`. Module
  write/read order verbatim from `src/c64/c64-snapshot.c:76-91`:
  MAINCPU → C64 → CIA1 → CIA2 → SID → DRIVE → FSDRIVE → VICII →
  C64GLUE → EVENT → MEMHACKS → TAPEPORT → KEYBOARD → JOYPORT_1 →
  JOYPORT_2 → USERPORT. Note SID is *before* VICII (not after);
  C64GLUE is a separate module from C64MEM; IEC state is embedded
  in DRIVE chunk, not a top-level module.

## Files touched

- `src/runtime/headless/sid/sid-6581.ts` (audit)
- `src/runtime/headless/memory-bus.ts` (open-bus + mirrors)
- `src/runtime/headless/datasette/*.ts` (stub or new)
- snapshot save/load TS sites (audit)
- 2 new smokes
- `specs/405-c64-phase-e-sound-and-rest.md` (this)

## Next spec

Spec 406 — C64 Phase F: Validation.
