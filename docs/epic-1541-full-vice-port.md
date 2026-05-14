# Epic — 1541 vollständiger 1:1 VICE-port

**Stand:** 2026-05-13  
**Branch (Start):** `1541-literal-vice` (Sprint 430 abgeschlossen)  
**Status:** OFFEN — Sprint 430 war Teilarbeit  
**Doktrin:** Jede Zeile TS-code für 1541-emulation muss 1:1 einer
zeile in VICE source entsprechen. Keine "verbesserungen". Keine
weggelassenen funktionen. Keine TS-OO-abstraktionen die VICE-structs
verstecken.

## Klartext

Sprint 430 (Specs 430–437, Commits `bd4fb81` … `0562c9f`) hat einen
**Teil** der 1541-emulation auf VICE-shape gebracht:

- IEC bus ATN edge-tag pfad
- via1d1541 wrapper formeln
- drivecpu felder umbenannt (math equivalent, NICHT bit-identisch)
- viacore.c "audited" per subagent (Resultat unzuverlässig — siehe
  GCR-fail unten)
- gcr.c LESE-pfad (Table-invalid-marker + `gcr_decode_block`
  semantik post-Sprint korrigiert)

**Was Sprint 430 NICHT erreicht hat:** ein vollständiges 1:1 1541
mit allen chips, allen funktionen, allen tabellen, allen alarm-paths,
write-back, rotation, fdc, drivesync, parallel-cable, multi-drive.

Dieses Epic dokumentiert die echte Restarbeit und teilt sie in
sequenziell ausführbare Detail-Specs.

## Vertrauensbruch: Subagent audits

Der Subagent für gcr.c-audit gab "5 PASS 0 BUG" zurück. Manueller
gegen-check (User-frage) fand 2 echte divergenzen:
1. `GCR_DECODE` table invalid-marker 0xff vs VICE 0
2. `gcr_decode_block` export-signatur (num = bytes statt num = groups)

Damit ist auch das Resultat des viacore-audits ("33 fns MATCH")
nicht vertrauenswürdig. **Jeder audit in diesem Epic muss von Claude
selbst, Zeile für Zeile gegen VICE-source, gemacht werden — keine
Subagents.**

## Geltungsbereich

Stock-1541 only. 1571, 1581, CMD-HD bleiben aus dem Epic; sie werden
ggf. nach Abschluss in einem separaten Epic adressiert.

PAL-first ([[feedback_pal_first_ntsc_later]]). NTSC wird einmalig
am Ende validiert.

## Chip/Subsystem-Matrix

| Modul | VICE source | LoC | Heutiger TS-stand | Spec | Status |
|-------|------------|-----|--------------------|------|--------|
| 6502 CPU (drive-side) | `src/6510core.c` + `mainc64cpu.c` | ~2000 | `Cpu6510` + `Cpu65xxVice` (Spec 428) | – | TEIL |
| 6502 dispatcher | `drivecpu.c` | 737 | `drive-cpu.ts` | 444 | PARTIAL |
| VIA 6522 core | `core/viacore.c` | 2243 | `via6522-vice.ts` 1341 LOC | 442 | AUDITED (Spec 442 DONE 2026-05-14) |
| VIA1 device | `iec/via1d1541.c` | 420 | `via1d1541.ts` 360 LOC | 443 | AUDITED (Spec 443 DONE 2026-05-14) |
| VIA2 device | `iecieee/via2d.c` | 566 | `via2d1541.ts` 250 LOC + coupling 209 LOC | 443 | AUDITED (Spec 443 DONE 2026-05-14) |
| GCR encode/decode | `gcr.c` | 357 | `gcr.ts` 530 LOC | 445 | LESE OK / WRITE FEHLT |
| Disk rotation | `drive/rotation.c` | ~900 | `gcr-shifter.ts` 690 LOC | 441 | NIE AUDITED |
| Drive memory map | `drive/iec/memiec.c` | 177 | `drive-cpu.ts` memory part | 447 | TEIL |
| Drive ROM loader | `drive/driverom.c` | ~300 | `headless-machine-kernel.ts` ROM-load | 447 | TEIL |
| Drive sync (host↔drive clock) | `drive/drivesync.c` | ~350 | `drive-cpu.ts` `syncFactor` | 446 | NUR PAL-CONST |
| Alarm context | `alarm.c` + `alarm.h` | ~400 | `alarm/alarm-context.ts` | 448 | TEIL, NICHT LITERAL |
| FDC error codes + state | `drive/fdc.c` + `cbmdos.h` | ~400 | partial enum in `gcr.ts` | 449 | TEIL |
| IEC bus core | `iecbus/iecbus.c` | 570 | `iec-bus.ts` + `iec-bus-core.ts` 700 LOC | 430 | DONE (Sprint 430) |
| Parallel cable | `drive/iec/glue1571.c` + parallel | ? | ❌ | 450 | OUT (V1) |
| Multi-drive | per-unit context | – | unit 8 only | 451 | OUT (V1) |

## Sprint-cut (Detail-Specs 440-...)

Sequenziell zwingend ([[feedback_sequential_specs]]).

| # | Spec | Inhalt | Größe | Status |
|---|------|--------|-------|--------|
| 1 | **440** | Epic charter + 7-step workflow | klein | DONE |
| 2 | **441** | `rotation.c` literal port + p64 stubs + drive_t + VIA2 backend | groß | **DONE** (4f legacy delete deferred) |
| 3 | **442** | `viacore.c` Claude-eigener line-by-line re-audit | groß | **DONE** (MYVIA gate + peek-raw fix + 13 conformance tests) |
| 4 | **443** | `via1d1541.c` + `via2d1541.c` literal re-port | mittel | **DONE** (48-row audit, 0 patches, 8 conformance tests) |
| 5 | **444** | `drivecpu.c` true literal port (stop_clk field, exec body) | mittel | **NEXT** |
| 6 | **445** | `gcr.c` write-path + encode | mittel | OPEN |
| 7 | **446** | `drivesync.c` PAL/NTSC switch logic full | klein | OPEN |
| 8 | **447** | `memiec.c` + `driverom.c` literal | mittel | OPEN |
| 9 | **448** | `alarm.c` literal port | groß | OPEN |
| 10 | **449** | `fdc.c` + cbmdos error codes + state machine | mittel | OPEN |
| 11 | **450** | Validation harness: full read+write+verify | mittel | OPEN |
| 12 | **451** | NTSC sync regression check | klein | OPEN |

Phasen müssen einzeln durchlaufen → spec → audit-doc → fixes → gate.
Kein Sprint hat ein Subagent-audit als acceptance. Claude muss
selbst nachprüfen.

### Spec 441 closeout (2026-05-14)

- `rotation.ts` ist production primitive für 1541 disk-side
  bit-stream. VIA2 backend port literal gegen VICE via2d.c
  (read_pra, read_prb, store_pra, store_prb, store_pcr/via2d_update_pcr,
  set_ca2, set_cb2) committed.
- `drive_t` literal 50-felder-mirror in `drive-t.ts`. `rotation_t`
  module-internal in `rotation.ts`.
- p64 helpers throwing-stub + mount-gate (`isP64Image`).
- A/B harness `C64RE_ROTATION_DIFF=1` zero divergence über 20M
  motm instructions.
- Tests 15/15 PASS, Canary 5/5, Lorenz Disk1 83 tests 0 fails
  @ 600s.
- Perf: rotation overhead 0.3% CPU. Lorenz timeout out of
  Spec-441 scope.
- 4f (delete gcr-shifter + 82 grep hits) DEFERRED — A/B harness +
  mount notification sinks + test-only PA/PB fallback need
  re-wiring before deletion is safe. Cleanup spec after 442.

Docs: `docs/spec-441-production-proof.md` (final), -mapping,
-flip-result, -step-4-migration-plan, -overnight-halt.

### Spec 442 closeout (2026-05-14)

- `viacore.c` (2243 LoC) ↔ `via6522-vice.ts` (1341 LoC) line-by-
  line audited by Claude (no subagent). 220+ row mapping matrix
  across struct fields + functions (`docs/spec-442-viacore-mapping.md`).
  Supersedes invalidated Spec 434.
- Patches:
  - `via6522-vice.ts:197-203` — `const MYVIA_NEED_LATCHING = false`
    gates 7 latch sites (CA1/CB1 ila/ilb writes + PRA/PRA_NHS/PRB
    read/peek paths). Matches VICE drive build (`viacore.c:76`
    `/* #define MYVIA_NEED_LATCHING */` default-off).
  - `via6522-vice.ts:1035-1039` — `viacore_peek` IFR returns raw
    `ifr` (no bit-7 synthesis). Matches `viacore.c:1284-1285`.
    Bit-7 synthesis lives in `viacore_read` only.
- Tests:
  - `tests/unit/via/viacore-conformance.test.ts` (13/13 PASS) —
    13 spec-cited assertions including peek-no-clear, peek-raw-IFR,
    MYVIA-gate, viacoreSetSr burst hack, T2_irq_allowed, CA2
    polarity match, IER bit-7 store, IFR clear-on-mask.
  - `tests/unit/via/via-ila-ilb-latch.test.ts` rewritten to
    assert literal-VICE-drive (MYVIA=false). 5/5 PASS.
  - Total VIA suite 65/65 PASS across 7 files.
- Regression: rotation 15/15, canary 5/5 PASS.
- Ticketed out:
  - `viacore_disable` + `enabled` flag → Spec 444
  - `viacore_shutdown` → Spec 444
  - `viacore_snapshot_read_module` → Spec 451 (VSF cross-load)
  - `viacore_dump` → OUT (debug)
  - `read_clk` / `read_offset` → OMIT (write-only)

Docs: `docs/spec-442-viacore-mapping.md`,
       `docs/spec-442-production-proof.md`.

### Spec 443 closeout (2026-05-14)

`via1d1541.c` (420 LoC) + `via2d.c` (566 LoC) ↔ TS device wrappers
audited line-by-line. **Audit-only spec** — 0 patches needed
since paths already literal post-Spec-441/442.

48-row mapping (`docs/spec-443-via-device-mapping.md`):
- VIA1: 17 callbacks + 4 setup + 4 bus entries
- VIA2: 14 callbacks + 5 setup/bus
- DDR formulae: 4 rows

Verdict tally:
- 41 MATCH / 2 MATCH-with-extension / 2 MINOR-DEVIATION / 9 OMIT-OK
- **0 BUG / 0 load-bearing MISSING**

Phase 2 deep-dive (5 rows resolved):
- `iec.drive_store_pb` bit-for-bit MATCH vs VICE store_prb 229-241
- VIA1 attachIrqLine chipPrev guard MATCH-with-extension
- VIA1 CA1 ATN edge MATCH (Spec 432 owned, post-441/442 verified)
- VIA2 store_prb MATCH (Spec 441 owned)
- VIA2 reset MINOR-DEVIATION (TS no-op vs VICE `led_status=1`,
  UI-only, deferred to Spec 444)

Tests: `tests/unit/via/via-device-conformance.test.ts` (8/8 PASS).
Total VIA suite: 73/73 PASS across 8 files. Rotation 15/15, canary
5/5 PASS.

Docs: `docs/spec-443-via-device-mapping.md`,
       `docs/spec-443-production-proof.md`.

### Spec 444 starting point

`drivecpu.c` (737 LoC) ↔ TS `drive-cpu.ts`. Spec 430 renamed fields
(math-equivalent only). Spec 444 does true literal port:
- `stop_clk` field + exec body
- Alarm dispatch via PROCESS_ALARMS macro analog
- `viacore_shutdown` / `viacore_disable` integration (Spec 442
  ticketed)
- VIA2 reset led_status=1 tightening (Spec 443 ticketed)
- `storePcr` void-signature tightening (Spec 442/443 cosmetic finding)
- `attach_irq_line` chip-side push registration

## Acceptance Epic-level

Das Epic ist fertig wenn:

1. Alle Specs 440–451 mit Verdict "DONE" geschlossen sind.
2. Eine `docs/epic-1541-full-vice-port-validation.md` existiert die
   für JEDE VICE 1541-source-datei eine zeile hat:
   - Datei + LoC
   - TS-impl + LoC
   - Status: PORTED / AUDITED / UNTOUCHED
   - Last-audit-commit-sha
3. `npm run canary:spec-430` weiterhin grün auf den 5 canaries.
4. Neue canary `disk-roundtrip` (write sector → read back → byte-
   identical) grün auf motm + Lorenz-Disk1.
5. Trace-store snapshot diff (HL vs VICE) zeigt zero divergenz
   auf der `gcr_*`-event-family für mindestens motm + LNR-S1
   (frischer VICE-baseline-recapture vorausgesetzt).
6. LNR-S1 grünes Boot oder ein eindeutig dokumentierter
   Root-cause der außerhalb der 1541-emulation liegt.

## Doctrine recap

- **Keine Subagent-audits.** Subagent dürfen lookups machen, aber
  keine "MATCH/BUG"-verdicts liefern. Claude prüft selbst.
- **Keine TS-OO-abstraktionen** die VICE-structs verstecken.
  `iecbus_t` ist ein struct, kein `class IecBusCore`.
- **Kein "VICE-inspired"**. Entweder 1:1 oder klar als
  TS-eigenständig markiert + nicht im produktions-pfad.
- **Keine "Verbesserungen".** Wenn VICE silent-0 dekodiert,
  dekodiert TS silent-0. Diagnostic-flags dürfen daneben
  laufen, niemals den VICE-output verändern.
- **Keine "deferred parameters".** Wenn `cycleStepped`-arg sinnlos
  ist, wird er entfernt — nicht "always-false threaded".
- **Eine source of truth.** Wenn VICE was hat, TS hat das. Wenn
  VICE was nicht hat, TS hat das nicht.
- **Traces in DuckDB.** Niemals ad-hoc JSONL-dumps
  ([[feedback_trace_into_duckdb]]).
- **Headless first.** VICE ist oracle, nicht runtime
  ([[feedback_headless_over_vice]]).
- **Sequenziell.** Eine spec nach der anderen
  ([[feedback_sequential_specs]]).

## Begründung (warum dieses Epic, warum jetzt)

Sprint 430 wurde unter dem leichtfertigen claim "Sprint 430
abgeschlossen" beendet während mehrere kritische module entweder
gar nicht angefasst (rotation.c, drivesync.c full, alarm.c) oder
nur kosmetisch umbenannt (drivecpu.c, gcr.c) wurden. Die
audit-claims der Subagents waren falsch (GCR-divergenzen erst
NACH commit gefunden). Das Epic stellt die wirklich notwendige
arbeit transparent dar und teilt sie in spec-große häppchen für
sequenzielle ausführung.
