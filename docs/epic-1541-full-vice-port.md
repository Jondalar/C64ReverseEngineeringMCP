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
| VIA 6522 core | `core/viacore.c` | 2243 | `via6522-vice.ts` 1341 LOC | 442 | UNGEPRÜFT-PER-CLAUDE |
| VIA1 device | `iec/via1d1541.c` | 420 | `via1d1541.ts` 383 LOC | 443 | PARTIAL |
| VIA2 device | `iec/via2d.c` (file?) | ? | `via2d1541.ts` 197 LOC | 443 | NIE AUDITED |
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

| # | Spec | Inhalt | Erwartete größe |
|---|------|--------|------------------|
| 1 | **440** | Epic charter (dieses doc + matrix). Status-baseline | klein |
| 2 | **441** | `rotation.c` literal port + audit `gcr-shifter.ts` | mittel |
| 3 | **442** | `viacore.c` Claude-eigener line-by-line re-audit | groß |
| 4 | **443** | `via1d1541.c` + `via2d1541.c` literal re-port | mittel |
| 5 | **444** | `drivecpu.c` true literal port (stop_clk field, exec body) | mittel |
| 6 | **445** | `gcr.c` write-path + encode (`gcr_write_sector`, `gcr_convert_4bytes_to_GCR`, `gcr_convert_sector_to_GCR`) | mittel |
| 7 | **446** | `drivesync.c` PAL/NTSC switch logic full | klein |
| 8 | **447** | `memiec.c` + `driverom.c` literal | mittel |
| 9 | **448** | `alarm.c` literal port (alarm_context_t, alarm_t, schedule) | groß |
| 10 | **449** | `fdc.c` + cbmdos error codes + state machine | mittel |
| 11 | **450** | Validation harness: full read+write+verify roundtrip vs VICE | mittel |
| 12 | **451** | NTSC sync regression check (PAL-first done) | klein |

Phasen müssen einzeln durchlaufen → spec → audit-doc → fixes → gate.
Kein Sprint hat ein Subagent-audit als acceptance. Claude muss
selbst nachprüfen.

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
