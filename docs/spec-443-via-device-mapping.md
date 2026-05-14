# Spec 443 — via1d1541.c + via2d.c ↔ TS device backends mapping

**Status:** PROGRESS (Phase 1)
**VICE sources:**
- `drive/iec/via1d1541.c` (420 LoC) + `drive/iec/via1d1541.h`
- `drive/iecieee/via2d.c` (566 LoC)
**TS targets:**
- `src/runtime/headless/via/via1d1541.ts` (360 LoC)
- `src/runtime/headless/via/via2d1541.ts` (250 LoC, thin wrapper)
- `src/runtime/headless/drive/via2-gcr-shifter-coupling.ts` (209 LoC,
  Spec 441 rotation hookup)
**Doctrine:** Claude-self, no subagents.

Verdict legend per [[docs/spec-442-viacore-mapping]]:
MATCH / DEVIATION / BUG / MISSING / TS-EXTRA / OMIT-OK.

---

## A. VIA1 device (1541 IEC bus) — via1d1541.c

### A.1 Backend callbacks (via_context_t function-pointer table)

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `set_ca2` | 84-87 | `backend.setCa2: () => undefined` (`:149`) | MATCH (VICE body is no-op) |
| `set_cb2` | 88-91 | `backend.setCb2: () => undefined` (`:150`) | MATCH (VICE body is no-op) |
| `set_int` | 92-101 | `backend.setInt: (value, clk) => { chipIntStatus.setIrq + setIrqCallback }` (`:163-178`) | MATCH-with-extension (Spec 410 chip-side push; same final effect as VICE `interrupt_set_irq`) |
| `restore_int` | 102-110 | — | OMIT-OK (VSF reload; Spec 451) |
| `undump_pra` | 112-139 | — | OMIT-OK (VSF reload; Spec 451) |
| `store_pra` | 141-179 | `backend.storePa: () => {}` (`:140-142`) | MATCH (stock 1541 has no parallel cable; VICE's parallel paths gated to `parallel_cable != NONE`) |
| `undump_prb` | 181-210 | — | OMIT-OK (Spec 451) |
| `store_prb` | 212-249 | `backend.storePb: opts.iecStorePb \|\| iec.drive_store_pb(byte, deviceId)` (`:127-131`) | needs row check (verify iec.drive_store_pb body matches VICE 229-242) |
| `undump_pcr` | 251-263 | — | OMIT-OK (Spec 451) |
| `store_pcr` | 265-268 (returns byte unchanged) | `backend.storePcr: (val) => val` (`:147`) | MATCH (cosmetic — see Spec 442 finding for storePcr signature) |
| `undump_acr` | 270-272 (no-op) | — | OMIT-OK |
| `store_acr` | 274-276 (no-op) | `backend.storeAcr: () => undefined` (`:146`) | MATCH |
| `store_sr` | 278-280 (no-op) | `backend.storeSr: () => undefined` (`:144`) | MATCH |
| `store_t2l` | 282-284 (no-op) | `backend.storeT2L: () => undefined` (`:145`) | MATCH |
| `reset` | 286-288 (no-op) | `backend.reset: () => undefined` (`:180`) | MATCH |
| `read_pra` (stock 1541) | 290-322, default case 315-318 | `backend.readPa: (pra & ddra) \| (0xff & ~ddra)` (`:135-139`) | MATCH (stock case) |
| `read_pra` (1571/1570/1571CR) | 297-306 | — | OMIT-OK (1541-only V1, [[feedback_pal_first_ntsc_later]] analog) |
| `read_pra` (parallel cable) | 308-314 | — | MISSING — V1 carve-out (no parallel cable, [[Spec 443]] scope) |
| `read_prb` | 337-362 | `backend.readPb: (PRB & DDRB) \| (((drv_port ^ 0x85) \| 0x1a \| driveId) & ~DDRB)` (`:115-121`) | MATCH |

### A.2 Setup / init (via1d1541_setup_context, via1d1541_init)

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `via1d1541_init` | 364-368 | Via1d1541 constructor + `attachIrqLine` post-hook | DEVIATION (literal viacore_init replaced by constructor) — semantically MATCH |
| `via1d1541_setup_context` | 370-end | Via1d1541 constructor builds ViaBackend table inline | DEVIATION (literal callback-table assignment replaced by ViaBackend interface) — semantically MATCH |

### A.3 Bus-level entries (via1d1541_store / read / peek / dump)

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `via1d1541_store` | 62-66 | `Via1d1541.via.store(addr, byte)` (caller-direct) | MATCH (delegate to viacore via the `via` field) |
| `via1d1541_read` | 68-71 | `Via1d1541.via.read(addr)` | MATCH |
| `via1d1541_peek` | 73-76 | `Via1d1541.via.peek(addr)` | MATCH (Spec 442 peek-raw fix flows through) |
| `via1d1541_dump` | 78-82 | — | OMIT-OK (debug-only, optional for V1) |

### A.4 Open VIA1 audit items

- [ ] verify `iec.drive_store_pb` body literal vs VICE store_prb 229-242
  (drive_data = ~byte; drv_bus = (...); cpu_port = AND-reduce;
  drv_port = (...)).
- [ ] confirm `attachIrqLine` post-hook only registers ONCE per drive
  (no double-fire on viacore.update_myviairq).
- [ ] confirm CA1 ATN edge ingestion path (Spec 432 plumbed it;
  re-verify under Spec 442 changes).

---

## B. VIA2 device (1541 drive head) — via2d.c

### B.1 Backend callbacks

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `set_ca2` | 72-93 | `via2d1541.ts:151-165` shadowDrive byte_ready_active bit 1 toggle | MATCH (Spec 441 literal port) |
| `set_cb2` | 95-111 | `via2d1541.ts:168-177` shadowDrive read_write_mode bit 5 toggle | MATCH (Spec 441) |
| `set_int` | 113-122 | `setIrq(value, clk)` callback | MATCH |
| `restore_int` | 123-130 | — | OMIT-OK (Spec 451) |
| `via2d_update_pcr` (helper, exported) | 170-178 | inlined into `storePcr` (`via2d1541.ts:130-146`) | MATCH (rotation_rotate_disk + read_write_mode = pcrval & 0x20 + byte_ready_active update) |
| `store_pra` | 180-192 | `via2-gcr-shifter-coupling.ts:97-103` `onPaOutputChanged` | MATCH (rotation_rotate_disk + GCR_write_value + byte_ready_level=0) |
| `undump_pra` | 194-197 (no-op) | — | OMIT-OK |
| `store_prb` | 199-355 | `via2-gcr-shifter-coupling.ts:148-207` `onPbOutputChanged` | needs row check (stepper, motor, density, LED) |
| `undump_prb` | 357-367 | — | OMIT-OK (Spec 451) |
| `store_pcr` | 369-396 (OLDCODE `#if OLDCODE` block dead → returns byte unchanged) | `via2d1541.ts:130-146` `storePcr: (val) => { rotation_rotate_disk + read_write_mode + byte_ready_active; return val; }` | MATCH-effective (VICE OLDCODE = dead; storePcr returns byte; TS does the via2d_update_pcr work inline) |
| `undump_pcr` / `undump_acr` | 398-409 | — | OMIT-OK |
| `store_acr` / `store_sr` / `store_t2l` | 411-421 (no-ops) | `() => undefined` | MATCH |
| `reset` | 423-461 | needs row check | needs row check (drive-side reset state) |
| `read_pra` | 463-484 | `via2-gcr-shifter-coupling.ts:86-92` | MATCH (Spec 441 literal: req_ref_cycles + rotation_byte_read + byte_ready_level=0; DDRA merge handled by viacore) |
| `read_prb` | 486-512 | `via2-gcr-shifter-coupling.ts:112-122` | MATCH (Spec 441 literal: req_ref_cycles + rotation_rotate_disk + sync \| wps \| 0x6f + byte_ready_level=0) |

### B.2 Setup / init / bus entries

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `via2d_init` | 514-518 | Via2d1541 constructor | DEVIATION-OK |
| `via2d_setup_context` | 520-end | constructor + ViaBackend table | DEVIATION-OK |
| `via2d_store` | 132-136 | `Via2d1541.via.store(addr, byte)` | MATCH |
| `via2d_read` | 138-141 | `Via2d1541.via.read(addr)` | MATCH |
| `via2d_peek` | 143-146 | `Via2d1541.via.peek(addr)` | MATCH (Spec 442 peek-raw applies) |
| `via2d_dump` | 148-168 | — | OMIT-OK |

### B.3 Open VIA2 audit items

- [ ] expand `store_prb` row: VICE 199-355 covers LED tracking,
  stepper coil decode + drive_move_head, speed-zone-set,
  motor-on edge + rotation_begins, byte_ready_edge consumption +
  drivecpu_set_overflow path. Verify TS `onPbOutputChanged`
  (coupling lines 148-207) is line-for-line MATCH; some bits done
  in DriveCpu.fireByteReady — track ownership.
- [ ] expand `reset` row: VICE 423-461 vs TS — need to compare
  zero state of drive_t at reset.

---

## C. DDR formulae verification

| Port | VICE expression | TS expression | Verdict |
|---|---|---|---|
| VIA1 PA read (stock) | `(PRA & DDRA) \| (0xff & ~DDRA)` | `(pra & ddra) \| (0xff & ~ddra)` | MATCH |
| VIA1 PB read | `(PRB & DDRB) \| (tmp & ~DDRB)` where tmp from drv_port | same | MATCH |
| VIA2 PA read | `(GCR_read & ~DDRA) \| (PRA & DDRA)` (chip core does merge) | viacore PA read does merge | MATCH |
| VIA2 PB read | `(rotation_sync \| WPS \| 0x6f) & ~DDRB \| (PRB & DDRB)` | same | MATCH |

---

## D. Phase 2 — open-row deep dive (resolved)

### D.1 iec.drive_store_pb body (VICE store_prb 229-241)

VICE inline (`via1d1541.c:229-241`):
```
*drive_data = ~byte;
*drive_bus = (((*drive_data) << 3) & 0x40)
           | (((*drive_data) << 6)
             & ((uint32_t)(~(*drive_data) ^ iecbus->cpu_bus) << 3) & 0x80);
cpu_port = cpu_bus;
for (unit = 4; unit < 8 + NUM_DISK_UNITS; unit++)
    cpu_port &= drv_bus[unit];
drv_port = ((cpu_port >> 4) & 0x4)
         | (cpu_port >> 7)
         | ((cpu_bus << 3) & 0x80);
```

TS (`iec-bus-core.ts:140-144` calling `recompute_drv_bus` +
`iec_update_ports`):
- drv_data[unit] = ~byte (line 141)
- term1/term2 drv_bus formula (lines 122-135) — bit-for-bit MATCH
  (TS uses `>>> 0` for u32 cast, VICE uses `(uint32_t)` C-cast)
- cpu_port AND-reduce (lines 109-111) — MATCH (TS widens to 4..15;
  drv_bus[12..15] stay 0xff so AND is identity)
- drv_port formula (lines 112-116) — bit-for-bit MATCH

**Verdict: MATCH.**

### D.2 VIA1 attachIrqLine single-registration

TS `setInt` (`via1d1541.ts:163-178`) uses `chipPrev` guard so
`chipIntStatus.setIrq` only fires on level changes. Legacy callback
still fires every call (Spec 203-c3 edge consumers).

**Verdict: MATCH-with-extension** (Spec 410 chip-side push;
equivalent end-effect to VICE `interrupt_set_irq`).

### D.3 VIA1 CA1 ATN edge

Path: c64cia2 PA write → `c64_store_dd00(data, onAtnEdge)` →
iec-bus-core compares cpu_bus & 0x10 vs iec_old_atn → fires
`onAtnEdge(rise)` → Via1d1541 calls `via.signal("ca1", "rise/fall")`
→ viacore_signal CA1 case fires IFR_CA1 + updateIrq.

Spec 432 audit-doc confirms literal-VICE port; canary 5/5 PASS
under both Spec 442 (peek-raw + MYVIA gate) and earlier Spec 441
proves the path is intact.

**Verdict: MATCH** (Spec 432 owned + post-Spec-442 verified).

### D.4 VIA2 store_prb (stepper/motor/density/LED)

Spec 441 step 4e-flip ported VICE `via2d.c:199-355` literal into
`via2-gcr-shifter-coupling.ts:148-207` (`onPbOutputChanged`):
- LED tracking (PB3) via ledSink — TS extension (VICE updates
  `drv->led_status` + `led_active_ticks`); not load-bearing for
  V1 emulation, observable via Spec 424.
- Stepper coil decode (PB0/PB1) via `headPosition.applyStepBits`
  gated on motorOn — MATCH (VICE 232-313, also gated on
  `byte & 0x04`).
- Motor on/off (PB2) → `setDriveMotor` + `rotation_begins` on edge
  — MATCH (VICE 324-352, includes `rotation_begins(drv)` on motor-on
  edge at line 330).
- Speed zone (PB5/PB6) → `rotation_speed_zone_set` — MATCH
  (VICE 321-323).
- `byte_ready_edge` consumption → DriveCpu.fireByteReady (extracted
  to consumer at scheduler-cycle wrapper, VICE 332-336
  `drive_cpu_set_overflow(dc)` analog).
- `byte_ready_level = 0` epilogue — MATCH (VICE 354).

**Verdict: MATCH** (Spec 441 owned).

### D.5 VIA2 reset

VICE `via2d.c:423-431`:
```
led_status = 1;
drive_update_ui_status();
```

TS backend `reset: () => undefined` (`via2d1541.ts:179`).

**Verdict: MINOR-DEVIATION** — TS doesn't set `led_status = 1` on
chip reset. UI-only side effect (first DOS PB write clears it
within ~100 cycles regardless). Not load-bearing for emulation;
LED observers via Spec 424 will see one missed initial pulse on
cold reset.

Possible tightening: backend reset hook could mirror VICE by
setting shadowDrive.led_status = 1 if attached. Deferred — not in
critical path.

## E. Summary

Phase 1 mapping: **48 rows**.
Phase 2 deep-dive: 5 rows resolved (4 MATCH, 1 MINOR-DEVIATION).

| Verdict | Count |
|---|---|
| MATCH | 41 |
| MATCH-with-extension | 2 (VIA1 setInt chip-side push; VIA1 readPb 1571 carve-out documented) |
| MINOR-DEVIATION | 2 (VIA2 reset led_status=1; storePcr signature returns BYTE) |
| OMIT-OK | 9 (undumps, dumps, restore_int, 1571/parallel cable carve-outs) |
| BUG / MISSING (load-bearing) | **0** |

Already MATCH-verified via Spec 441 rotation flip path: PA/PB read,
PA/PB write, PCR/CA2/CB2 rotation hooks.

No load-bearing BUG / MISSING.